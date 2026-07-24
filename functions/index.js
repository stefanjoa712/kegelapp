/**
 * Die Pudolfs Kegelapp – Cloud Function für Strafen-E-Mails
 * ------------------------------------------------------------
 * Feuert immer dann, wenn ein Kegelabend-Dokument in Firestore geändert wird.
 * Sobald ein Abend von "offen" auf "abgeschlossen" wechselt, werden allen
 * Mitgliedern mit gepflegter E-Mail-Adresse ihre individuellen Strafen für
 * diesen Abend per Mail (über Resend) zugeschickt.
 *
 * WICHTIG: Der RESEND_API_KEY wird als Secret verwaltet, NIEMALS im Code
 * oder im Client sichtbar. Einrichtung siehe DEPLOY.md im gleichen Ordner.
 */

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { Resend } = require('resend');
const logger = require('firebase-functions/logger');

initializeApp();
const db = getFirestore();

const resendApiKey = defineSecret('RESEND_API_KEY');

// -------- Absenderadresse --------
// Solange keine eigene Domain in Resend verifiziert ist, funktioniert nur
// die Resend-Sandbox-Adresse "onboarding@resend.dev" (Zustellung an eigene,
// bei Resend verifizierte Test-Adressen). Für echten Versand an alle
// Mitglieder muss eine eigene Domain verifiziert und hier eingetragen werden.
const FROM_ADDRESS = 'Die Pudolfs <strafen@die-pudolfs.de>';

// -------- Hilfsfunktionen (spiegeln exakt die Logik der App) --------

function fmtEuro(n) {
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function displayName(m) {
  return (m.nickname && m.nickname.trim()) ? m.nickname.trim() : m.firstName;
}

function roundUpToFullEuro(amount) {
  const cents = Math.round(amount * 100);
  return Math.ceil(cents / 100);
}

// Gesamtbetrag für einen Sitzplatz - inkl. Geldstrafen und umgelegter Fremdstrafen anderer.
function fineTotalForSeat(detail, seatId) {
  const entries = (detail.finesBySeat && detail.finesBySeat[seatId]) || {};
  const catalog = detail.finesCatalogSnapshot || [];
  let total = 0;

  catalog.forEach(f => {
    if (f.type === 'fremdstrafe') return;
    const count = entries[f.id] || 0;
    total += count * f.amount;
  });

  const adHocList = (detail.adHocFinesBySeat && detail.adHocFinesBySeat[seatId]) || [];
  adHocList.forEach(a => { total += a.amount; });

  const fremdstrafeFines = catalog.filter(f => f.type === 'fremdstrafe');
  if (fremdstrafeFines.length > 0) {
    const otherPresentSeats = detail.seating.filter(s => s.name && s.seatId !== seatId);
    fremdstrafeFines.forEach(f => {
      otherPresentSeats.forEach(s => {
        const otherEntries = (detail.finesBySeat && detail.finesBySeat[s.seatId]) || {};
        const count = otherEntries[f.id] || 0;
        total += count * f.amount;
      });
    });
  }
  return total;
}

// Drei Bereiche - exakt wie auf der Strafenseite pro Person in der App.

function buildCatalogLines(detail, seatId) {
  const entries = (detail.finesBySeat && detail.finesBySeat[seatId]) || {};
  const catalog = detail.finesCatalogSnapshot || [];
  const lines = [];
  catalog.forEach(f => {
    if (f.type === 'fremdstrafe') return;
    const count = entries[f.id] || 0;
    if (count > 0) lines.push({ label: `${f.name} (${count}×)`, amount: count * f.amount });
  });
  return lines;
}

function buildFremdstrafeChargeLines(detail, seatId) {
  const catalog = detail.finesCatalogSnapshot || [];
  const otherPresentSeats = detail.seating.filter(s => s.name && s.seatId !== seatId);
  const lines = [];
  catalog.filter(f => f.type === 'fremdstrafe').forEach(f => {
    otherPresentSeats.forEach(s => {
      const otherEntries = (detail.finesBySeat && detail.finesBySeat[s.seatId]) || {};
      const count = otherEntries[f.id] || 0;
      if (count > 0) lines.push({ label: `${f.name} durch ${s.name} (${count}×)`, amount: count * f.amount });
    });
  });
  return lines;
}

function buildAdHocLines(detail, seatId) {
  const adHocList = (detail.adHocFinesBySeat && detail.adHocFinesBySeat[seatId]) || [];
  return adHocList.map(a => ({ label: a.name, amount: a.amount }));
}

const PAYPAL_ME_USERNAME = 'diepudolfs';

function buildPaypalLink(amount) {
  // PayPal.me erwartet einen Punkt als Dezimaltrennzeichen, kein Komma.
  const amountStr = amount.toFixed(2);
  return `https://paypal.com/paypalme/${PAYPAL_ME_USERNAME}/${amountStr}`;
}

function buildSectionHtml(title, lines) {
  if (lines.length === 0) return '';
  const rows = lines.map(l => `
    <tr>
      <td style="padding:6px 0; border-bottom:1px dashed #e5e1d8;">${escapeHtml(l.label)}</td>
      <td style="padding:6px 0; border-bottom:1px dashed #e5e1d8; text-align:right; white-space:nowrap;">${fmtEuro(l.amount)}</td>
    </tr>
  `).join('');
  return `
    <h3 style="font-size:14px; text-transform:uppercase; letter-spacing:0.04em; color:#4a4642; margin:20px 0 6px;">${title}</h3>
    <table style="width:100%; border-collapse:collapse; font-size:15px;">${rows}</table>
  `;
}

function buildEmailHtml(name, dateStr, catalogLines, fremdstrafeLines, adHocLines, exactTotal, roundedTotal) {
  const hasAnyLines = catalogLines.length + fremdstrafeLines.length + adHocLines.length > 0;
  const emptyHtml = hasAnyLines ? '' : '<p>Keine Strafen für diesen Abend.</p>';
  const paypalLink = buildPaypalLink(roundedTotal);

  return `
    <div style="font-family:sans-serif; color:#161616; max-width:480px;">
      <p>Hallo ${escapeHtml(name)},</p>
      <p>hier deine Strafen vom Kegelabend am <strong>${dateStr}</strong>:</p>
      ${emptyHtml}
      ${buildSectionHtml('Strafen', catalogLines)}
      ${buildSectionHtml('Fremdstrafen', fremdstrafeLines)}
      ${buildSectionHtml('Geldstrafen', adHocLines)}

      <div style="margin-top:18px; padding-top:10px; border-top:2px solid #161616;">
        <table style="width:100%; border-collapse:collapse;">
          <tr>
            <td style="font-size:13px; color:#9a9186; padding:2px 0;">Gesamt (genau)</td>
            <td style="font-size:13px; color:#9a9186; padding:2px 0; text-align:right;">${fmtEuro(exactTotal)}</td>
          </tr>
          <tr>
            <td style="font-size:18px; font-weight:800; padding:4px 0;">Gesamt (gerundet)</td>
            <td style="font-size:18px; font-weight:800; padding:4px 0; text-align:right;">${fmtEuro(roundedTotal)}</td>
          </tr>
        </table>
      </div>

      <p style="margin-top:22px;">
        <a href="${paypalLink}" style="display:inline-block; background:#E3421F; color:#fff; font-weight:800; text-decoration:none; padding:12px 22px; border-radius:8px;">
          Jetzt ${fmtEuro(roundedTotal)} per PayPal bezahlen
        </a>
      </p>

      <p>Kegelgruß,<br>Die Pudolfs</p>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildReopenEmailHtml(name, dateStr) {
  return `
    <div style="font-family:sans-serif; color:#161616; max-width:480px;">
      <p>Hallo ${escapeHtml(name)},</p>
      <p>beim Kegelabend am <strong>${dateStr}</strong> gab es scheinbar einen Fehler in der Strafenberechnung.</p>
      <p><strong>Du kannst die vorherige E-Mail zu diesem Abend ignorieren – aktuell muss nichts bezahlt werden.</strong></p>
      <p>Sobald der Abend erneut abgeschlossen wird, bekommst du eine neue, korrigierte E-Mail mit den aktuellen Strafen.</p>
      <p>Kegelgruß,<br>Die Pudolfs</p>
    </div>
  `;
}

async function loadMembers() {
  const membersSnap = await db.collection('kegelbuch').doc('members').get();
  if (!membersSnap.exists) { logger.warn('Keine Mitgliederliste gefunden.'); return null; }
  try { return JSON.parse(membersSnap.data().value || '[]'); } catch (e) {
    logger.error('Konnte Mitgliederliste nicht parsen', e);
    return null;
  }
}

function formatEveningDate(detail) {
  return new Date(detail.date + 'T12:00:00').toLocaleDateString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric'
  });
}

// Sammelt alle Empfänger (Anwesende + Abwesende mit Durchschnittsbetrag) mit gepflegter E-Mail.
function collectRecipientNames(detail, members) {
  const names = [];
  detail.seating.filter(s => s.name && !s.isGuest).forEach(s => { names.push(s.name); });
  (detail.absentMembersFines || []).forEach(a => { names.push(a.name); });
  const result = [];
  names.forEach(name => {
    const member = members.find(m => displayName(m) === name);
    if (member && member.email) result.push({ name, email: member.email });
  });
  return result;
}

async function handleEveningClosed(after, docId) {
  const members = await loadMembers();
  if (!members) return;

  const resend = new Resend(resendApiKey.value());
  const dateStr = formatEveningDate(after);
  const recipients = [];

  const presentSeats = after.seating.filter(s => s.name && !s.isGuest);
  presentSeats.forEach(s => {
    const member = members.find(m => displayName(m) === s.name);
    if (member && member.email) {
      recipients.push({
        email: member.email,
        name: s.name,
        catalogLines: buildCatalogLines(after, s.seatId),
        fremdstrafeLines: buildFremdstrafeChargeLines(after, s.seatId),
        adHocLines: buildAdHocLines(after, s.seatId),
        total: fineTotalForSeat(after, s.seatId),
      });
    }
  });

  (after.absentMembersFines || []).forEach(a => {
    const member = members.find(m => displayName(m) === a.name);
    if (member && member.email) {
      recipients.push({
        email: member.email,
        name: a.name,
        catalogLines: [],
        fremdstrafeLines: [],
        adHocLines: [{ label: 'Durchschnittsbetrag (nicht anwesend)', amount: a.amount }],
        total: a.amount,
      });
    }
  });

  logger.info(`Sende Strafen-E-Mails für Abend ${docId} an ${recipients.length} Empfänger.`);

  for (const r of recipients) {
    const roundedTotal = roundUpToFullEuro(r.total);
    const html = buildEmailHtml(r.name, dateStr, r.catalogLines, r.fremdstrafeLines, r.adHocLines, r.total, roundedTotal);
    try {
      await resend.emails.send({
        from: FROM_ADDRESS,
        to: r.email,
        subject: `Deine Strafen vom Kegelabend am ${dateStr}`,
        html,
      });
    } catch (err) {
      logger.error(`Fehler beim Senden an ${r.email}:`, err);
    }
  }
}

async function handleEveningReopened(before, docId) {
  const members = await loadMembers();
  if (!members) return;

  const resend = new Resend(resendApiKey.value());
  const dateStr = formatEveningDate(before);
  const recipients = collectRecipientNames(before, members);

  logger.info(`Sende Korrektur-E-Mails (Wiedereröffnung) für Abend ${docId} an ${recipients.length} Empfänger.`);

  for (const r of recipients) {
    const html = buildReopenEmailHtml(r.name, dateStr);
    try {
      await resend.emails.send({
        from: FROM_ADDRESS,
        to: r.email,
        subject: `Kegelabend am ${dateStr} wurde erneut geöffnet`,
        html,
      });
    } catch (err) {
      logger.error(`Fehler beim Senden an ${r.email}:`, err);
    }
  }
}

// -------- Die eigentliche Cloud Function --------

exports.sendFineEmailsOnClose = onDocumentUpdated(
  {
    document: 'kegelbuch/{docId}',
    secrets: [resendApiKey],
  },
  async (event) => {
    const docId = event.params.docId;
    if (!docId.startsWith('evening-')) return;

    const beforeRaw = event.data.before.data();
    const afterRaw = event.data.after.data();
    if (!afterRaw || !afterRaw.value) return;

    let before = null, after = null;
    try { before = beforeRaw && beforeRaw.value ? JSON.parse(beforeRaw.value) : null; } catch (e) { /* ignorieren */ }
    try { after = JSON.parse(afterRaw.value); } catch (e) {
      logger.error('Konnte Abend-Dokument nicht parsen', e);
      return;
    }

    const wasClosed = !!(before && before.closed);
    const isClosed = !!(after && after.closed);

    if (isClosed && !wasClosed) {
      await handleEveningClosed(after, docId);
    } else if (!isClosed && wasClosed) {
      await handleEveningReopened(before, docId);
    }
    // Sonst: keine für E-Mails relevante Änderung (z.B. nur eine Strafe angepasst) - nichts tun.
  }
);


// -------- Mitglied einladen (legt Firebase-Auth-Account an, verschickt Passwort-Link) --------
// Marker zum Erzwingen eines echten Redeploys (v2), falls ein vorheriger Deploy-Versuch
// die Function auf Google-Seite in einem kaputten Zwischenzustand hinterlassen hat.

const HOSTING_URL = 'https://app.die-pudolfs.de/';

exports.inviteMember = onCall({ secrets: [resendApiKey] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Bitte zuerst anmelden.');
  }
  const { email, name } = request.data || {};
  if (!email || typeof email !== 'string') {
    throw new HttpsError('invalid-argument', 'E-Mail-Adresse fehlt.');
  }

  const adminAuth = getAuth();
  try {
    await adminAuth.getUserByEmail(email);
  } catch (e) {
    // Nutzer existiert noch nicht -> Account anlegen (ohne Passwort, das setzt das Mitglied selbst).
    await adminAuth.createUser({ email, emailVerified: false });
  }

  const resetLink = await adminAuth.generatePasswordResetLink(email, {
    url: HOSTING_URL,
    handleCodeInApp: false,
  });

  const resend = new Resend(resendApiKey.value());
  const html = `
    <div style="font-family:sans-serif; color:#161616; max-width:480px;">
      <p>Hallo ${escapeHtml(name || '')},</p>
      <p>du wurdest eingeladen, dich in der Kegelbuch-App der Pudolfs anzumelden.</p>
      <p>
        <a href="${resetLink}" style="display:inline-block; background:#E3421F; color:#fff; font-weight:800; text-decoration:none; padding:12px 22px; border-radius:8px;">
          Passwort festlegen
        </a>
      </p>
      <p>Danach kannst du dich mit deiner E-Mail-Adresse und deinem neuen Passwort in der App anmelden.</p>
      <p>Kegelgruß,<br>Die Pudolfs</p>
    </div>
  `;

  try {
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: email,
      subject: 'Einladung: Die Pudolfs Kegelbuch',
      html,
    });
  } catch (err) {
    logger.error(`Fehler beim Senden der Einladung an ${email}:`, err);
    throw new HttpsError('internal', 'E-Mail konnte nicht gesendet werden.');
  }

  return { success: true };
});

// -------- Account-Verknüpfung eines Mitglieds aufheben (v2) --------

exports.unlinkMemberAccount = onCall({}, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Bitte zuerst anmelden.');
  }
  const { email } = request.data || {};
  if (!email || typeof email !== 'string') {
    throw new HttpsError('invalid-argument', 'E-Mail-Adresse fehlt.');
  }

  const adminAuth = getAuth();
  try {
    const userRecord = await adminAuth.getUserByEmail(email);
    await adminAuth.deleteUser(userRecord.uid);
  } catch (e) {
    if (e.code !== 'auth/user-not-found') {
      logger.error(`Fehler beim Entfernen des Accounts für ${email}:`, e);
      throw new HttpsError('internal', 'Account konnte nicht entfernt werden.');
    }
    // Account existierte bereits nicht mehr - für uns trotzdem ein Erfolg (idempotent).
  }

  return { success: true };
});
