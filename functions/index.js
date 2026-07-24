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
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
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

function roundUpToFiftyCents(amount) {
  const cents = Math.round(amount * 100);
  return Math.ceil(cents / 50) * 50 / 100;
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

// Liste der einzelnen Strafen-Zeilen für die E-Mail (Name + Betrag).
function buildFineLines(detail, seatId) {
  const entries = (detail.finesBySeat && detail.finesBySeat[seatId]) || {};
  const catalog = detail.finesCatalogSnapshot || [];
  const lines = [];

  catalog.forEach(f => {
    if (f.type === 'fremdstrafe') return;
    const count = entries[f.id] || 0;
    if (count > 0) lines.push({ label: `${f.name} (${count}×)`, amount: count * f.amount });
  });

  const adHocList = (detail.adHocFinesBySeat && detail.adHocFinesBySeat[seatId]) || [];
  adHocList.forEach(a => { lines.push({ label: a.name, amount: a.amount }); });

  const otherPresentSeats = detail.seating.filter(s => s.name && s.seatId !== seatId);
  catalog.filter(f => f.type === 'fremdstrafe').forEach(f => {
    otherPresentSeats.forEach(s => {
      const otherEntries = (detail.finesBySeat && detail.finesBySeat[s.seatId]) || {};
      const count = otherEntries[f.id] || 0;
      if (count > 0) lines.push({ label: `${f.name} durch ${s.name} (${count}×)`, amount: count * f.amount });
    });
  });

  return lines;
}

function buildEmailHtml(name, dateStr, lines, roundedTotal) {
  const linesHtml = lines.length
    ? lines.map(l => `<li>${escapeHtml(l.label)}: ${fmtEuro(l.amount)}</li>`).join('')
    : '<li>Keine Strafen für diesen Abend.</li>';
  return `
    <div style="font-family:sans-serif; color:#161616; max-width:480px;">
      <p>Hallo ${escapeHtml(name)},</p>
      <p>hier deine Strafen vom Kegelabend am <strong>${dateStr}</strong>:</p>
      <ul style="padding-left:18px;">${linesHtml}</ul>
      <p style="font-size:17px;"><strong>Gesamt: ${fmtEuro(roundedTotal)}</strong></p>
      <p>Kegelgruß,<br>Die Pudolfs</p>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
    // Nur beim Übergang offen -> abgeschlossen aktiv werden (nicht bei jeder Änderung).
    if (!isClosed || wasClosed) return;

    const membersSnap = await db.collection('kegelbuch').doc('members').get();
    if (!membersSnap.exists) { logger.warn('Keine Mitgliederliste gefunden.'); return; }
    let members = [];
    try { members = JSON.parse(membersSnap.data().value || '[]'); } catch (e) {
      logger.error('Konnte Mitgliederliste nicht parsen', e);
      return;
    }

    const resend = new Resend(resendApiKey.value());
    const dateStr = new Date(after.date + 'T12:00:00').toLocaleDateString('de-DE', {
      day: '2-digit', month: '2-digit', year: 'numeric'
    });

    const recipients = [];

    const presentSeats = after.seating.filter(s => s.name && !s.isGuest);
    presentSeats.forEach(s => {
      const member = members.find(m => displayName(m) === s.name);
      if (member && member.email) {
        recipients.push({
          email: member.email,
          name: s.name,
          lines: buildFineLines(after, s.seatId),
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
          lines: [{ label: 'Durchschnittsbetrag (nicht anwesend)', amount: a.amount }],
          total: a.amount,
        });
      }
    });

    logger.info(`Sende Strafen-E-Mails für Abend ${docId} an ${recipients.length} Empfänger.`);

    for (const r of recipients) {
      const roundedTotal = roundUpToFiftyCents(r.total);
      const html = buildEmailHtml(r.name, dateStr, r.lines, roundedTotal);
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
);
