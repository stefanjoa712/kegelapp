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

const { onDocumentUpdated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError, onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
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
  const seat = detail.seating.find(s => s.seatId === seatId);
  if (seat && seat.invalid) {
    if (seat.invalidAmount !== undefined) return seat.invalidAmount;
    // Dynamisch berechnet (sollte nach Abschluss nicht mehr vorkommen)
    const validTotals = detail.seating
      .filter(s => s.name && !s.invalid && s.seatId !== seatId)
      .map(s => roundUpToFullEuro(fineTotalForSeat(detail, s.seatId)));
    return validTotals.length > 0 ? roundUpToFullEuro(validTotals.reduce((a, b) => a + b, 0) / validTotals.length) : 0;
  }
  const entries = (detail.finesBySeat && detail.finesBySeat[seatId]) || {};
  const catalog = detail.finesCatalogSnapshot || [];
  let total = 0;

  catalog.forEach(f => {
    if (f.type === 'fremdstrafe') return;
    if (f.type === 'runde') return; // Runden haben keinen Euro-Betrag
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
    if (f.type === 'runde') return; // Runden haben keinen Euro-Betrag
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
const LOGO_DATA_URI = 'data:image/png;base64,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';

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

function buildEmailHtml(name, dateStr, catalogLines, fremdstrafeLines, adHocLines, exactEveningTotal, roundedEveningTotal, priorArrears) {
  const hasAnyLines = catalogLines.length + fremdstrafeLines.length + adHocLines.length > 0;
  const emptyHtml = hasAnyLines ? '' : '<p>Keine Strafen für diesen Abend.</p>';
  const hasArrears = priorArrears > 0;
  const combinedExact = exactEveningTotal + priorArrears;
  const combinedRounded = roundUpToFullEuro(combinedExact);
  const paypalLink = buildPaypalLink(combinedRounded);

  const totalsRowsHtml = hasArrears ? `
    <tr>
      <td style="padding:6px 0; border-bottom:1px dashed #e5e1d8;">Strafen vom heutigen Abend</td>
      <td style="padding:6px 0; border-bottom:1px dashed #e5e1d8; text-align:right; white-space:nowrap;">${fmtEuro(roundedEveningTotal)}</td>
    </tr>
    <tr>
      <td style="padding:6px 0; border-bottom:1px dashed #e5e1d8;">Bisheriger Rückstand</td>
      <td style="padding:6px 0; border-bottom:1px dashed #e5e1d8; text-align:right; white-space:nowrap;">${fmtEuro(priorArrears)}</td>
    </tr>
  ` : '';

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
          ${totalsRowsHtml}
          <tr>
            <td style="font-size:13px; color:#9a9186; padding:2px 0;">Gesamt (genau)</td>
            <td style="font-size:13px; color:#9a9186; padding:2px 0; text-align:right;">${fmtEuro(combinedExact)}</td>
          </tr>
          <tr>
            <td style="font-size:18px; font-weight:800; padding:4px 0;">Gesamt (gerundet)</td>
            <td style="font-size:18px; font-weight:800; padding:4px 0; text-align:right;">${fmtEuro(combinedRounded)}</td>
          </tr>
        </table>
      </div>

      <p style="margin-top:22px;">
        <a href="${paypalLink}" style="display:inline-block; background:#E3421F; color:#fff; font-weight:800; text-decoration:none; padding:12px 22px; border-radius:8px;">
          Jetzt ${fmtEuro(combinedRounded)} per PayPal bezahlen
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

// Mitglieder liegen seit der Multi-Club-Migration unter 'clubs/<clubId>/members/<id>' (ein
// Dokument pro Mitglied + ein Index-Dokument 'clubs/<clubId>/members/_index' mit der Liste aller
// IDs) statt im alten gemeinsamen Blob 'kegelbuch/members'. Der alte Blob existiert zwar noch
// (nie automatisch gelöscht), ist aber seit der Migration nicht mehr aktuell - neue/geänderte
// Mitglieder würden hier sonst fehlen bzw. veraltet sein. Alle Functions unten sind
// multi-club-fähig: clubId kommt je nach Function aus einem Firestore-Trigger-Wildcard
// (sendFineEmailsOnClose), einem expliziten Parameter vom Client (inviteMember,
// unlinkMemberAccount) oder wird durch Iteration über alle existierenden Clubs ermittelt
// (shareGuestBill, calendarFeed, processRecurringBookings) - es gibt bewusst keine feste,
// hart codierte Club-ID mehr.

// Lädt alle Einträge einer "Einzeldokument pro Eintrag + Index"-Collection unter einem Club
// (z.B. clubs/<clubId>/events, clubs/<clubId>/occurrence-edits) - spiegelt exakt das Client-
// seitige Muster aus makeClubEntityStore()/getAll() in index.html.
async function loadClubEntityCollection(clubRef, collectionName) {
  const collectionRef = clubRef.collection(collectionName);
  const indexSnap = await collectionRef.doc('_index').get();
  if (!indexSnap.exists) return [];
  let ids;
  try { ids = JSON.parse(indexSnap.data().value || '[]'); } catch (e) { return []; }
  if (ids.length === 0) return [];
  const snaps = await Promise.all(ids.map(id => collectionRef.doc(id).get()));
  const items = [];
  snaps.forEach(snap => {
    if (!snap.exists) return;
    try { items.push(JSON.parse(snap.data().value)); } catch (e) { /* einzelnes defektes Dokument ignorieren */ }
  });
  return items;
}

// Schreibt einen neuen Eintrag in eine "Einzeldokument pro Eintrag + Index"-Collection unter
// einem Club - spiegelt exakt das Client-seitige Muster aus makeClubEntityStore()/save() in
// index.html (Transaktion: Dokument setzen + Index aktualisieren, falls die ID neu ist). Wird
// hier für die automatisch erzeugten Buchungen aus processRecurringBookings gebraucht - schreibt
// gezielt NUR das eine neue Buchungs-Dokument statt den kompletten transactions-Blob zu
// überschreiben, damit ein zeitgleicher manueller Schreibvorgang im Client nicht überschrieben wird.
async function saveClubEntity(clubRef, collectionName, entry) {
  const collectionRef = clubRef.collection(collectionName);
  const indexRef = collectionRef.doc('_index');
  await db.runTransaction(async (tx) => {
    const indexSnap = await tx.get(indexRef);
    const index = indexSnap.exists ? JSON.parse(indexSnap.data().value || '[]') : [];
    tx.set(collectionRef.doc(entry.id), { value: JSON.stringify(entry) });
    if (!index.includes(entry.id)) {
      index.push(entry.id);
      tx.set(indexRef, { value: JSON.stringify(index) });
    }
  });
}

async function loadMembers(clubId) {
  const indexSnap = await db.collection('clubs').doc(clubId).collection('members').doc('_index').get();
  if (!indexSnap.exists) { logger.warn(`Kein Mitglieder-Index gefunden für Club ${clubId}.`); return null; }
  let ids;
  try { ids = JSON.parse(indexSnap.data().value || '[]'); } catch (e) {
    logger.error('Konnte Mitglieder-Index nicht parsen', e);
    return null;
  }
  if (ids.length === 0) return [];
  const membersCollection = db.collection('clubs').doc(clubId).collection('members');
  const snaps = await Promise.all(ids.map(id => membersCollection.doc(id).get()));
  const members = [];
  snaps.forEach(snap => {
    if (!snap.exists) return;
    try { members.push(JSON.parse(snap.data().value)); } catch (e) { /* einzelnes defektes Dokument ignorieren */ }
  });
  return members;
}

// Kegelabende liegen seit der Multi-Club-Migration unter 'clubs/<clubId>/evenings/<eveningId>'
// (Hauptdokument: Datum, Sitzordnung, Strafenkatalog-Snapshot, Notizen, Abschluss-Status) statt im
// alten 'kegelbuch/evening-<id>'. Die eigentlichen Strafen-Zähler (finesBySeat/adHocFinesBySeat)
// liegen NICHT mehr im Hauptdokument, sondern in einer Unter-Collection mit einem Dokument PRO
// SITZPLATZ ('clubs/<clubId>/evenings/<eveningId>/seats/<seatId>') - Grund: mehrere Personen
// tragen während des Abends gleichzeitig auf unterschiedlichen Geräten Strafen für
// unterschiedliche Sitzplätze ein, ein kompletter Überschrieb des ganzen Abend-Dokuments hätte
// hier ein Last-Write-Wins-Risiko gehabt. Der Firestore-Update-Trigger unten reagiert weiterhin
// nur auf Änderungen am HAUPTDOKUMENT (z.B. den closed-Übergang) - die Sitzplatz-Strafen müssen
// für den Mailversand separat nachgeladen und ins Objekt gemischt werden, bevor die bestehende
// Berechnungslogik (fineTotalForSeat, buildCatalogLines, ...) darauf zugreifen kann.
async function enrichEveningWithSeatFines(clubId, detail) {
  if (!detail) return detail;
  const seatsRef = db.collection('clubs').doc(clubId).collection('evenings').doc(detail.id).collection('seats');
  const snaps = await seatsRef.get();
  detail.finesBySeat = {};
  detail.adHocFinesBySeat = {};
  snaps.forEach(snap => {
    let seatData;
    try { seatData = JSON.parse(snap.data().value); } catch (e) { return; }
    if (seatData.finesBySeat) detail.finesBySeat[snap.id] = seatData.finesBySeat;
    if (seatData.adHocFinesBySeat) detail.adHocFinesBySeat[snap.id] = seatData.adHocFinesBySeat;
  });
  return detail;
}

function formatEveningDate(detail) {
  return new Date(detail.date + 'T12:00:00').toLocaleDateString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric'
  });
}

// Ausgeschriebenes Datumsformat ("30. Juli 2026") wie formatDateDE im Client - wird für
// History-Notizen gebraucht, die exakt im gewohnten Format bleiben sollen (im Unterschied zu
// formatEveningDate oben, das für die E-Mail-Betreffzeile numerisch formatiert).
function formatDateDEServer(iso) {
  const parts = iso.split('-').map(Number);
  const months = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  return `${parts[2]}. ${months[parts[1] - 1]} ${parts[0]}`;
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

async function handleEveningClosed(clubId, after, docId) {
  const members = await loadMembers(clubId);
  if (!members) return;

  const resend = new Resend(resendApiKey.value());
  const dateStr = formatEveningDate(after);
  const recipients = [];

  const presentSeats = after.seating.filter(s => s.name && !s.isGuest);
  presentSeats.forEach(s => {
    const member = members.find(m => displayName(m) === s.name);
    if (member && member.email) {
      if (s.invalid) {
        // Invalide: alle gepflegten Strafen ignorieren, nur der Durchschnittsbetrag zählt.
        const avgAmount = s.invalidAmount !== undefined ? s.invalidAmount : fineTotalForSeat(after, s.seatId);
        recipients.push({
          email: member.email,
          name: s.name,
          catalogLines: [],
          fremdstrafeLines: [],
          adHocLines: [{ label: 'Durchschnittsbetrag (als invalide markiert)', amount: avgAmount }],
          total: avgAmount,
        });
      } else {
        recipients.push({
          email: member.email,
          name: s.name,
          catalogLines: buildCatalogLines(after, s.seatId),
          fremdstrafeLines: buildFremdstrafeChargeLines(after, s.seatId),
          adHocLines: buildAdHocLines(after, s.seatId),
          total: fineTotalForSeat(after, s.seatId),
        });
      }
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
    const priorArrears = (after.priorArrearsSnapshot && after.priorArrearsSnapshot[r.name]) || 0;
    const html = buildEmailHtml(r.name, dateStr, r.catalogLines, r.fremdstrafeLines, r.adHocLines, r.total, roundedTotal, priorArrears);
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

async function handleEveningReopened(clubId, before, docId) {
  const members = await loadMembers(clubId);
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

// -------- Kegelabend abschließen (closeEvening) --------
// Läuft serverseitig statt im Client, damit die Firestore Rules für arrears/transactions eng
// gefasst bleiben können (nur Kassenwart/Admin) OHNE den automatischen Rückstands-Zuwachs beim
// Abschließen eines Abends zu blockieren - diese Function läuft mit Admin-SDK-Rechten und umgeht
// die Rules, exakt wie deleteClub/inviteMember es bereits tun. Bildet 1:1 die bisherige
// Client-Logik aus dem 'confirm-close-evening-yes'-Handler in index.html nach - siehe dort für
// den ursprünglichen, Zeile für Zeile äquivalenten Ablauf.

// Pool für Durchschnittsberechnungen: anwesende, gültige (nicht invalide) Mitglieder - ohne Gäste.
// Identisch zur Client-Funktion gleichen Namens.
function validPresentMemberTotals(detail, excludeSeatId) {
  return detail.seating
    .filter(s => s.name && !s.invalid && s.seatId !== excludeSeatId)
    .map(s => roundUpToFullEuro(fineTotalForSeat(detail, s.seatId)));
}
function averageOfTotalsRounded(totals) {
  if (totals.length === 0) return 0;
  return roundUpToFullEuro(totals.reduce((a, b) => a + b, 0) / totals.length);
}

// Für die Übersichtsliste: kompakte Kennzahlen eines Abends. Identisch zur Client-Funktion
// computeEveningSummaryFields, benötigt hier zusätzlich die Mitgliederanzahl als Parameter (der
// Client liest sie aus state.members, hier gibt es keinen globalen State).
function computeEveningSummaryFields(detail, memberCount) {
  const occupied = detail.seating.filter(s => s.name);
  const presentCount = occupied.filter(s => !s.isGuest).length;
  const guestCount = occupied.filter(s => s.isGuest).length;
  const absentList = detail.closed ? (detail.absentMembersFines || []) : [];
  const absentCount = detail.closed ? absentList.length : Math.max(0, memberCount - presentCount);
  let income = 0;
  occupied.forEach(s => { income += roundUpToFullEuro(fineTotalForSeat(detail, s.seatId)); });
  absentList.forEach(a => { income += a.amount; });
  return { presentCount, guestCount, absentCount, income };
}

// ID-Auflösung für Rückstands-Dokumente: bevorzugt die Mitglieds-ID, damit eine spätere
// Umbenennung den Rückstand nicht "verwaist" lässt. Identisch zur Client-Funktion
// resolveArrearsDocId in index.html.
function resolveArrearsDocIdServer(name, members) {
  const member = members.find(m => displayName(m) === name);
  if (member) return member.id;
  const transliterated = name
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue');
  return 'guest-' + transliterated.replace(/[^a-zA-Z0-9_-]/g, '_');
}

// Serverseitiges Äquivalent zu updateAttendanceStatsForEvening in index.html - aktualisiert die
// vorab aggregierte Anwesenheitsstatistik (clubs/{clubId}/data/attendance-stats) um einen Abend.
async function updateAttendanceStatsForEveningServer(clubRef, detail, direction) {
  const statsRef = clubRef.collection('data').doc('attendance-stats');
  const statsSnap = await statsRef.get();
  let stats = { totalsByYear: {}, attendanceByMember: {} };
  if (statsSnap.exists) {
    try { stats = JSON.parse(statsSnap.data().value || '{}'); } catch (e) { /* Fallback bleibt leer */ }
  }
  if (!stats.totalsByYear) stats.totalsByYear = {};
  if (!stats.attendanceByMember) stats.attendanceByMember = {};

  const year = detail.date.slice(0, 4);
  const newTotal = (stats.totalsByYear[year] || 0) + direction;
  if (newTotal > 0) stats.totalsByYear[year] = newTotal; else delete stats.totalsByYear[year];

  const presentMemberNames = new Set(detail.seating.filter(s => s.name && !s.isGuest).map(s => s.name));
  presentMemberNames.forEach(name => {
    if (!stats.attendanceByMember[name]) stats.attendanceByMember[name] = {};
    const newCount = (stats.attendanceByMember[name][year] || 0) + direction;
    if (newCount > 0) stats.attendanceByMember[name][year] = newCount; else delete stats.attendanceByMember[name][year];
  });
  await statsRef.set({ value: JSON.stringify(stats) });
}

exports.closeEvening = onCall({}, async (request) => {
  // Enger gefasst als canManageMembers(): hier nur Kassenwart oder Admin, bewusst nicht
  // Präsident - dieselbe Berechtigung wie die übrige Finanzverwaltung
  // (siehe canManageFinances() in firestore.rules und index.html).
  requireFinanceRole(request);

  const { clubId, eveningId, skipNotificationEmail } = request.data || {};
  if (!clubId || typeof clubId !== 'string') {
    throw new HttpsError('invalid-argument', 'Club-ID fehlt.');
  }
  if (!eveningId || typeof eveningId !== 'string') {
    throw new HttpsError('invalid-argument', 'Abend-ID fehlt.');
  }

  const clubRef = db.collection('clubs').doc(clubId);
  const eveningRef = clubRef.collection('evenings').doc(eveningId);

  // Frisch aus Firestore lesen (nicht vom Client übernehmen) - das ist der zentrale Punkt für
  // "Daten müssen aktuell sein": egal was der Client lokal denkt, hier zählt ausschließlich der
  // Stand, der tatsächlich in der Datenbank steht. Der Client wartet vor diesem Aufruf zusätzlich
  // selbst auf offene Speichervorgänge (siehe attachDetailListeners in index.html), aber auch
  // ohne das wäre diese Function korrekt, weil sie nie mit veralteten Werten rechnet.
  const eveningSnap = await eveningRef.get();
  if (!eveningSnap.exists) {
    throw new HttpsError('not-found', 'Kegelabend wurde nicht gefunden.');
  }
  let detail;
  try {
    detail = JSON.parse(eveningSnap.data().value);
  } catch (e) {
    throw new HttpsError('internal', 'Abend-Dokument konnte nicht gelesen werden.');
  }
  if (detail.closed) {
    throw new HttpsError('failed-precondition', 'Dieser Abend ist bereits abgeschlossen.');
  }

  await enrichEveningWithSeatFines(clubId, detail);

  const members = await loadMembers(clubId);
  if (!members) {
    throw new HttpsError('internal', 'Mitgliederliste konnte nicht geladen werden.');
  }

  detail.skipNotificationEmail = !!skipNotificationEmail;

  const presentSeats = detail.seating.filter(s => s.name && !s.isGuest);
  const presentNames = new Set(presentSeats.map(s => s.name));
  const avgRounded = averageOfTotalsRounded(validPresentMemberTotals(detail));

  // Invalide markierte Personen: Durchschnitt jetzt fest einfrieren.
  detail.seating.forEach(s => {
    if (s.invalid && s.invalidAmount === undefined) s.invalidAmount = avgRounded;
  });

  const absentMembers = members.filter(m => !presentNames.has(displayName(m)));
  detail.absentMembersFines = absentMembers.map(m => ({ name: displayName(m), amount: avgRounded }));
  detail.closed = true;

  // Aktuelle Rückstände laden (arrears-Subcollection, ein Dokument pro Person).
  const arrearsSnap = await clubRef.collection('arrears').get();
  const arrears = [];
  arrearsSnap.forEach(snap => {
    try { arrears.push(JSON.parse(snap.data().value)); } catch (e) { /* einzelnes defektes Dokument ignorieren */ }
  });

  // Snapshot des Rückstands VOR der heutigen Erhöhung - direkt auf dem Abend gespeichert, damit
  // sendFineEmailsOnClose beim Mailversand keinen separaten, potenziell inkonsistenten Zugriff
  // braucht.
  const priorArrearsSnapshot = {};
  detail.seating.filter(s => s.name).forEach(s => {
    const existing = arrears.find(a => a.name === s.name);
    priorArrearsSnapshot[s.name] = existing ? existing.amount : 0;
  });
  detail.absentMembersFines.forEach(a => {
    if (priorArrearsSnapshot[a.name] === undefined) {
      const existing = arrears.find(x => x.name === a.name);
      priorArrearsSnapshot[a.name] = existing ? existing.amount : 0;
    }
  });
  detail.priorArrearsSnapshot = priorArrearsSnapshot;

  const touchedArrearsEntries = [];
  function addToArrears(name, amount, seatId) {
    if (!amount) return;
    let entry = arrears.find(a => a.name === name);
    if (!entry) { entry = { id: resolveArrearsDocIdServer(name, members), name, amount: 0, history: [] }; arrears.push(entry); }
    if (!entry.id) entry.id = resolveArrearsDocIdServer(name, members);
    if (!entry.history) entry.history = [];
    entry.amount = Math.round((entry.amount + amount) * 100) / 100;
    entry.history.push({
      id: `hist-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, date: detail.date, type: 'increase', delta: amount,
      note: `Strafen vom Kegelabend am ${formatDateDEServer(detail.date)}`, balanceAfter: entry.amount, createdAt: Date.now(),
      eveningId: detail.id, seatId: seatId || undefined,
    });
    if (!touchedArrearsEntries.includes(entry)) touchedArrearsEntries.push(entry);
  }
  detail.seating.filter(s => s.name).forEach(s => {
    addToArrears(s.name, roundUpToFullEuro(fineTotalForSeat(detail, s.seatId)), s.seatId);
  });
  detail.absentMembersFines.forEach(a => { addToArrears(a.name, a.amount); });

  // Index-Eintrag (evenings-index, liegt unter clubs/{clubId}/data/evenings-index) aktualisieren -
  // dieselbe Kennzahlen-Logik wie computeEveningSummaryFields im Client.
  const dataRef = clubRef.collection('data').doc('evenings-index');
  const indexSnap = await dataRef.get();
  let eveningsIndex = [];
  if (indexSnap.exists) {
    try { eveningsIndex = JSON.parse(indexSnap.data().value || '[]'); } catch (e) { eveningsIndex = []; }
  }
  const idx = eveningsIndex.findIndex(e => e.id === detail.id);
  const summaryFields = computeEveningSummaryFields(detail, members.length);
  if (idx >= 0) eveningsIndex[idx] = { ...eveningsIndex[idx], closed: true, ...summaryFields };

  // Alle Schreibvorgänge (Hauptdokument, Index, jeder betroffene Rückstands-Eintrag) in EINEM
  // atomaren Batch - entweder alles oder nichts, kein Teilfehler-Risiko wie bei einem einfachen
  // Promise.all. Firestore erlaubt bis zu 500 Schreiboperationen pro Batch, das reicht für jeden
  // realistischen Kegelclub-Abend deutlich.
  const { finesBySeat, adHocFinesBySeat, ...mainFields } = detail;
  const batch = db.batch();
  batch.set(eveningRef, { value: JSON.stringify(mainFields) });
  batch.set(dataRef, { value: JSON.stringify(eveningsIndex) });
  touchedArrearsEntries.forEach(entry => {
    batch.set(clubRef.collection('arrears').doc(entry.id), { value: JSON.stringify(entry) });
  });
  await batch.commit();

  // Anwesenheitsstatistik aktualisieren (attendance-stats unter clubs/{clubId}/data) - separat vom
  // Batch, da diese Funktion bereits ihre eigene, unabhängige Lese-Schreib-Logik hat und nicht Teil
  // der Kernbuchung ist (ein Fehlschlag hier soll den restlichen Abschluss nicht verhindern).
  try {
    await updateAttendanceStatsForEveningServer(clubRef, detail, 1);
  } catch (e) {
    logger.error(`Anwesenheitsstatistik für Abend ${eveningId} konnte nicht aktualisiert werden:`, e);
  }

  return { success: true };
});

// Serverseitiges Äquivalent zu reverseArrearsForEvening im Client - nimmt die beim Abschließen
// eines Abends gebuchten Rückstands-Erhöhungen wieder zurück. Gibt KEINE Promises zurück (anders
// als die Client-Version), sondern nur die aktualisierten Arrears-Entries - das Schreiben passiert
// beim Aufrufer einheitlich über einen Batch, analog zu closeEvening.
function reverseArrearsForEveningServer(detail, arrears, members, noteText) {
  const touchedArrearsEntries = [];
  function subtractFromArrears(name, amount) {
    if (!amount) return;
    let entry = arrears.find(a => a.name === name);
    if (!entry) { entry = { id: resolveArrearsDocIdServer(name, members), name, amount: 0, history: [] }; arrears.push(entry); }
    if (!entry.id) entry.id = resolveArrearsDocIdServer(name, members);
    if (!entry.history) entry.history = [];
    // Der ursprüngliche "Strafen"-Eintrag dieses Abends verweist auf die Sitzplatz-Strafen - die
    // sind jetzt veraltet (Abend wird wieder geöffnet/gelöscht), daher den Link kappen.
    entry.history.forEach(h => {
      if (h.type === 'increase' && h.eveningId === detail.id) { delete h.eveningId; delete h.seatId; }
    });
    entry.amount = Math.round((entry.amount - amount) * 100) / 100;
    entry.history.push({
      id: `hist-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, date: getTodayInBerlin(), type: 'correction', delta: -amount,
      note: noteText, balanceAfter: entry.amount, createdAt: Date.now(),
    });
    if (!touchedArrearsEntries.includes(entry)) touchedArrearsEntries.push(entry);
  }
  detail.seating.filter(s => s.name).forEach(s => {
    subtractFromArrears(s.name, roundUpToFullEuro(fineTotalForSeat(detail, s.seatId)));
  });
  (detail.absentMembersFines || []).forEach(a => { subtractFromArrears(a.name, a.amount); });
  return touchedArrearsEntries;
}

// Prüft, ob der Aufrufer die Rolle Kassenwart oder den Admin-Account hat - dieselbe Berechtigung
// wie canManageFinances() in firestore.rules und index.html. Wirft bei fehlender Berechtigung.
function requireFinanceRole(request) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Bitte zuerst anmelden.');
  }
  const callerRole = request.auth.token.role || 'Mitglied';
  const isCallerAdmin = request.auth.token.email === 'admin@die-pudolfs.internal';
  if (!isCallerAdmin && callerRole !== 'Kassenwart') {
    throw new HttpsError('permission-denied', 'Nur Kassenwart oder Admin dürfen diese Aktion ausführen.');
  }
}

exports.reopenEvening = onCall({}, async (request) => {
  requireFinanceRole(request);

  const { clubId, eveningId, skipNotificationEmail } = request.data || {};
  if (!clubId || typeof clubId !== 'string') {
    throw new HttpsError('invalid-argument', 'Club-ID fehlt.');
  }
  if (!eveningId || typeof eveningId !== 'string') {
    throw new HttpsError('invalid-argument', 'Abend-ID fehlt.');
  }

  const clubRef = db.collection('clubs').doc(clubId);
  const eveningRef = clubRef.collection('evenings').doc(eveningId);

  const eveningSnap = await eveningRef.get();
  if (!eveningSnap.exists) {
    throw new HttpsError('not-found', 'Kegelabend wurde nicht gefunden.');
  }
  let detail;
  try {
    detail = JSON.parse(eveningSnap.data().value);
  } catch (e) {
    throw new HttpsError('internal', 'Abend-Dokument konnte nicht gelesen werden.');
  }
  if (!detail.closed) {
    throw new HttpsError('failed-precondition', 'Dieser Abend ist nicht abgeschlossen.');
  }

  await enrichEveningWithSeatFines(clubId, detail);
  const members = await loadMembers(clubId);
  if (!members) {
    throw new HttpsError('internal', 'Mitgliederliste konnte nicht geladen werden.');
  }

  detail.closed = false;
  detail.skipNotificationEmail = !!skipNotificationEmail;

  const arrearsSnap = await clubRef.collection('arrears').get();
  const arrears = [];
  arrearsSnap.forEach(snap => {
    try { arrears.push(JSON.parse(snap.data().value)); } catch (e) { /* einzelnes defektes Dokument ignorieren */ }
  });
  const noteText = `Kegelabend vom ${formatDateDEServer(detail.date)} wieder geöffnet`;
  const touchedArrearsEntries = reverseArrearsForEveningServer(detail, arrears, members, noteText);

  const dataRef = clubRef.collection('data').doc('evenings-index');
  const indexSnap = await dataRef.get();
  let eveningsIndex = [];
  if (indexSnap.exists) {
    try { eveningsIndex = JSON.parse(indexSnap.data().value || '[]'); } catch (e) { eveningsIndex = []; }
  }
  const idx = eveningsIndex.findIndex(e => e.id === detail.id);
  const summaryFields = computeEveningSummaryFields(detail, members.length);
  if (idx >= 0) eveningsIndex[idx] = { ...eveningsIndex[idx], closed: false, ...summaryFields };

  const { finesBySeat, adHocFinesBySeat, ...mainFields } = detail;
  const batch = db.batch();
  batch.set(eveningRef, { value: JSON.stringify(mainFields) });
  batch.set(dataRef, { value: JSON.stringify(eveningsIndex) });
  touchedArrearsEntries.forEach(entry => {
    const isGuest = entry.id && entry.id.startsWith('guest-');
    const entryRef = clubRef.collection('arrears').doc(entry.id);
    // Gast-Einträge, die durch die Korrektur auf 0 gefallen sind, werden gelöscht statt mit
    // amount:0 gespeichert - identisch zu saveArrearsEntry() im Client.
    if (isGuest && Math.round((entry.amount || 0) * 100) === 0) {
      batch.delete(entryRef);
    } else {
      batch.set(entryRef, { value: JSON.stringify(entry) });
    }
  });
  await batch.commit();

  try {
    await updateAttendanceStatsForEveningServer(clubRef, detail, -1);
  } catch (e) {
    logger.error(`Anwesenheitsstatistik für Abend ${eveningId} (Wiedereröffnung) konnte nicht aktualisiert werden:`, e);
  }

  return { success: true };
});

exports.deleteEvening = onCall({}, async (request) => {
  requireFinanceRole(request);

  const { clubId, eveningId } = request.data || {};
  if (!clubId || typeof clubId !== 'string') {
    throw new HttpsError('invalid-argument', 'Club-ID fehlt.');
  }
  if (!eveningId || typeof eveningId !== 'string') {
    throw new HttpsError('invalid-argument', 'Abend-ID fehlt.');
  }

  const clubRef = db.collection('clubs').doc(clubId);
  const eveningRef = clubRef.collection('evenings').doc(eveningId);

  const eveningSnap = await eveningRef.get();
  if (!eveningSnap.exists) {
    throw new HttpsError('not-found', 'Kegelabend wurde nicht gefunden.');
  }
  let detail;
  try {
    detail = JSON.parse(eveningSnap.data().value);
  } catch (e) {
    throw new HttpsError('internal', 'Abend-Dokument konnte nicht gelesen werden.');
  }
  await enrichEveningWithSeatFines(clubId, detail);

  const wasClosed = !!detail.closed;
  let touchedArrearsEntries = [];
  let members = null;
  if (wasClosed) {
    members = await loadMembers(clubId);
    if (!members) {
      throw new HttpsError('internal', 'Mitgliederliste konnte nicht geladen werden.');
    }
    const arrearsSnap = await clubRef.collection('arrears').get();
    const arrears = [];
    arrearsSnap.forEach(snap => {
      try { arrears.push(JSON.parse(snap.data().value)); } catch (e) { /* einzelnes defektes Dokument ignorieren */ }
    });
    const noteText = `Kegelabend vom ${formatDateDEServer(detail.date)} gelöscht`;
    touchedArrearsEntries = reverseArrearsForEveningServer(detail, arrears, members, noteText);
  }

  const dataRef = clubRef.collection('data').doc('evenings-index');
  const indexSnap = await dataRef.get();
  let eveningsIndex = [];
  if (indexSnap.exists) {
    try { eveningsIndex = JSON.parse(indexSnap.data().value || '[]'); } catch (e) { eveningsIndex = []; }
  }
  eveningsIndex = eveningsIndex.filter(e => e.id !== eveningId);

  // Alle Sitzplatz-Unterdokumente + Hauptdokument löschen, Index aktualisieren, betroffene
  // Rückstände korrigieren - alles in einem Batch.
  const seatsSnap = await eveningRef.collection('seats').get();
  const batch = db.batch();
  seatsSnap.forEach(seatDoc => { batch.delete(seatDoc.ref); });
  batch.delete(eveningRef);
  batch.set(dataRef, { value: JSON.stringify(eveningsIndex) });
  touchedArrearsEntries.forEach(entry => {
    const isGuest = entry.id && entry.id.startsWith('guest-');
    const entryRef = clubRef.collection('arrears').doc(entry.id);
    if (isGuest && Math.round((entry.amount || 0) * 100) === 0) {
      batch.delete(entryRef);
    } else {
      batch.set(entryRef, { value: JSON.stringify(entry) });
    }
  });
  await batch.commit();

  if (wasClosed) {
    try {
      await updateAttendanceStatsForEveningServer(clubRef, detail, -1);
    } catch (e) {
      logger.error(`Anwesenheitsstatistik für gelöschten Abend ${eveningId} konnte nicht aktualisiert werden:`, e);
    }
  }

  return { success: true };
});

// -------- Die eigentliche Cloud Function --------
// Trigger-Pfad mit Wildcard {clubId} statt fest verdrahteter CLUB_ID: reagiert auf
// Kegelabend-Änderungen in JEDEM Club, nicht nur dem einen aktuell existierenden. clubId kommt
// aus event.params und wird an alle Helper (loadMembers, enrichEveningWithSeatFines,
// handleEveningClosed/Reopened) durchgereicht, statt implizit eine feste Club-ID zu verwenden.
exports.sendFineEmailsOnClose = onDocumentUpdated(
  {
    document: 'clubs/{clubId}/evenings/{docId}',
    secrets: [resendApiKey],
  },
  async (event) => {
    const clubId = event.params.clubId;
    const docId = event.params.docId;

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
    const skipEmail = !!(after && after.skipNotificationEmail);

    if (skipEmail) {
      logger.info(`Mailversand für Abend ${docId} (Club ${clubId}) übersprungen (Checkbox deaktiviert).`);
    } else if (isClosed && !wasClosed) {
      await enrichEveningWithSeatFines(clubId, after);
      await handleEveningClosed(clubId, after, docId);
    } else if (!isClosed && wasClosed) {
      await enrichEveningWithSeatFines(clubId, before);
      await handleEveningReopened(clubId, before, docId);
    }
    // Sonst: keine für E-Mails relevante Änderung (z.B. nur eine Strafe angepasst - löst hier
    // ohnehin kein Update aus, da Strafen jetzt in eigenen Sitzplatz-Dokumenten liegen) - nichts tun.
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
  const { email, name, clubId } = request.data || {};
  if (!email || typeof email !== 'string') {
    throw new HttpsError('invalid-argument', 'E-Mail-Adresse fehlt.');
  }
  if (!clubId || typeof clubId !== 'string') {
    throw new HttpsError('invalid-argument', 'Club-ID fehlt.');
  }

  const adminAuth = getAuth();
  let userRecord;
  try {
    userRecord = await adminAuth.getUserByEmail(email);
  } catch (e) {
    // Nutzer existiert noch nicht -> Account anlegen (ohne Passwort, das setzt das Mitglied selbst).
    userRecord = await adminAuth.createUser({ email, emailVerified: false });
  }

  // Aktuelle Rolle aus dem Mitgliedsdokument lesen, um den Rollen-Claim sofort zu setzen -
  // ohne darauf zu warten, dass syncMemberRoleClaim (Firestore-Trigger) separat feuert.
  let currentRole = 'Mitglied';
  try {
    const membersSnap = await db.collection('clubs').doc(clubId).collection('members').get();
    membersSnap.forEach((docSnap) => {
      if (docSnap.id === MEMBERS_INDEX_ID) return;
      const m = JSON.parse(docSnap.data().value);
      if (m && m.email && m.email.toLowerCase() === email.toLowerCase()) {
        currentRole = m.role || 'Mitglied';
      }
    });
  } catch (e) {
    logger.error(`Rolle für ${email} konnte beim Einladen nicht ermittelt werden:`, e);
  }

  // Custom Claim 'clubIds' (Array) ordnet den Auth-Account einem oder mehreren Clubs zu - nach
  // dem Login liest der Client daraus, welche(n) Club(s) dieser Nutzer sehen darf (bei genau
  // einem Eintrag direkt, bei mehreren über eine Auswahl). WICHTIG: den bestehenden Claim lesen
  // und die neue clubId nur ERGÄNZEN, nie überschreiben - sonst würde ein zweiter Invite (z.B. in
  // einem anderen Club) die Zugehörigkeit zu allen bisherigen Clubs löschen. clubId kommt vom
  // Client (dessen aktuell aktiver Club, CURRENT_CLUB_ID) statt einer fest verdrahteten Konstante,
  // damit das Einladen auch für künftige, weitere Clubs funktioniert. 'role' wird bei jedem Invite
  // aktualisiert (nicht nur ergänzt), da es sich - anders als clubIds - pro Club nicht summiert.
  const existingClaims = userRecord.customClaims || {};
  const existingClubIds = Array.isArray(existingClaims.clubIds) ? existingClaims.clubIds : [];
  const nextClubIds = existingClubIds.includes(clubId) ? existingClubIds : [...existingClubIds, clubId];
  if (!existingClubIds.includes(clubId) || existingClaims.role !== currentRole) {
    await adminAuth.setCustomUserClaims(userRecord.uid, {
      ...existingClaims,
      clubIds: nextClubIds,
      role: currentRole,
    });
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

// -------- Neuen Kegelclub anlegen (v2, KEIN Login nötig - Aufruf von der öffentlichen "Kegelclub anlegen"-Seite) --------
// Bewusst ohne Kennwort/Schutzmechanismus - die URL wird nirgends beworben oder verlinkt,
// nur an Personen weitergegeben, die tatsächlich einen neuen Club anlegen sollen.

const MEMBERS_INDEX_ID = '_index';

function slugifyClubName(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[äöüß]/g, c => ({ 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss' }[c]))
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // übrige Akzente entfernen
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'club';
}

function buildClubInviteEmailHtml(name) {
  return `
    <div style="font-family:sans-serif; color:#161616; max-width:480px;">
      <p>Hallo ${escapeHtml(name || '')},</p>
      <p>dein neuer Kegelclub wurde angelegt und du wurdest als Kassenwart eingetragen.</p>
      <p>
        <a href="RESET_LINK_PLACEHOLDER" style="display:inline-block; background:#E3421F; color:#fff; font-weight:800; text-decoration:none; padding:12px 22px; border-radius:8px;">
          Passwort festlegen
        </a>
      </p>
      <p>Danach kannst du dich mit deiner E-Mail-Adresse und deinem neuen Passwort in der App anmelden.</p>
      <p>Kegelgruß,<br>Die Pudolfs</p>
    </div>
  `;
}

exports.createClub = onCall({ secrets: [resendApiKey] }, async (request) => {
  const { clubName, foundedOn, paypalName, firstName, lastName, nickname, email } = request.data || {};

  if (!clubName || typeof clubName !== 'string' || !clubName.trim()) {
    throw new HttpsError('invalid-argument', 'Clubname fehlt.');
  }
  if (!foundedOn || typeof foundedOn !== 'string') {
    throw new HttpsError('invalid-argument', 'Gründungsdatum fehlt.');
  }
  if (!firstName || !lastName || !email) {
    throw new HttpsError('invalid-argument', 'Angaben zum Kassenwart unvollständig.');
  }

  // Eindeutige, lesbare Club-ID aus dem Namen ableiten - bei Kollision Zahl anhängen (club-name,
  // club-name-2, club-name-3, ...), analog zum Vorgehen bei Mitglieds-IDs an anderer Stelle.
  const baseId = slugifyClubName(clubName);
  let clubId = baseId;
  let suffix = 1;
  while ((await db.collection('clubs').doc(clubId).get()).exists) {
    suffix += 1;
    clubId = `${baseId}-${suffix}`;
  }

  const clubData = { name: clubName.trim(), foundedOn };
  if (paypalName && typeof paypalName === 'string' && paypalName.trim()) {
    clubData.paypalName = paypalName.trim();
  }
  await db.collection('clubs').doc(clubId).set(clubData);

  const memberId = 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const member = {
    id: memberId,
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    nickname: (nickname || '').trim(),
    email: email.trim(),
    role: 'Kassenwart',
  };
  const membersCollection = db.collection('clubs').doc(clubId).collection('members');
  await membersCollection.doc(memberId).set({ value: JSON.stringify(member) });
  await membersCollection.doc(MEMBERS_INDEX_ID).set({ value: JSON.stringify([memberId]) });

  // Auth-Account für den Kassenwart anlegen und dem neuen Club per Custom Claim zuordnen
  // (gleiche Logik wie in inviteMember, hier eigenständig gehalten - siehe Notiz oben).
  const adminAuth = getAuth();
  let userRecord;
  try {
    userRecord = await adminAuth.getUserByEmail(member.email);
  } catch (e) {
    userRecord = await adminAuth.createUser({ email: member.email, emailVerified: false });
  }
  const existingClaims = userRecord.customClaims || {};
  const existingClubIds = Array.isArray(existingClaims.clubIds) ? existingClaims.clubIds : [];
  if (!existingClubIds.includes(clubId) || existingClaims.role !== member.role) {
    await adminAuth.setCustomUserClaims(userRecord.uid, {
      ...existingClaims,
      clubIds: existingClubIds.includes(clubId) ? existingClubIds : [...existingClubIds, clubId],
      role: member.role,
    });
  }

  const resetLink = await adminAuth.generatePasswordResetLink(member.email, {
    url: HOSTING_URL,
    handleCodeInApp: false,
  });
  const html = buildClubInviteEmailHtml(member.firstName).replace('RESET_LINK_PLACEHOLDER', resetLink);

  const resend = new Resend(resendApiKey.value());
  try {
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: member.email,
      subject: `Dein neuer Kegelclub "${clubData.name}" wurde angelegt`,
      html,
    });
  } catch (err) {
    logger.error(`Fehler beim Senden der Club-Einladung an ${member.email}:`, err);
    throw new HttpsError('internal', 'Club wurde angelegt, aber die Einladungs-E-Mail konnte nicht gesendet werden.');
  }

  return { success: true, clubId };
});

// -------- Account-Verknüpfung eines Mitglieds aufheben (v2) --------

// -------- Club vollständig löschen (nur eingeloggte Nutzer, aus der Clubverwaltung) --------
// Löscht den kompletten Firestore-Dokumentbaum unter clubs/<clubId> (inkl. aller Subcollections
// wie members, evenings/<id>/seats, transactions, arrears, ...) und bereinigt anschließend bei
// JEDEM ehemaligen Mitglied mit Auth-Account den 'clubIds'-Claim: Ist der Club danach der einzige
// verbleibende Eintrag, wird der Account komplett gelöscht (analog zu unlinkMemberAccount), sonst
// wird nur die clubId aus dem Array entfernt. Muss als Cloud Function laufen, weil der Client
// selbst keine Auth-Custom-Claims anderer Nutzer ändern kann (nur das Admin SDK darf das).
exports.deleteClub = onCall({}, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Bitte zuerst anmelden.');
  }
  // Nur Admin, Kassenwart oder Präsident dürfen einen Club löschen - dieselbe Berechtigung wie
  // die Mitglieder-/Clubverwaltung (siehe canManageMembers() in firestore.rules). onCall-Functions
  // laufen mit Admin-SDK-Rechten und umgehen die Firestore Rules komplett, deshalb muss diese
  // Prüfung hier eigenständig erfolgen - der Custom Claim 'role' steht direkt in request.auth.token.
  const callerRole = request.auth.token.role || 'Mitglied';
  const isCallerAdmin = request.auth.token.email === 'admin@die-pudolfs.internal';
  if (!isCallerAdmin && callerRole !== 'Kassenwart' && callerRole !== 'Präsident') {
    throw new HttpsError('permission-denied', 'Nur Kassenwart, Präsident oder Admin dürfen einen Club löschen.');
  }
  const { clubId } = request.data || {};
  if (!clubId || typeof clubId !== 'string') {
    throw new HttpsError('invalid-argument', 'Club-ID fehlt.');
  }

  const clubRef = db.collection('clubs').doc(clubId);
  const clubSnap = await clubRef.get();
  if (!clubSnap.exists) {
    throw new HttpsError('not-found', 'Club wurde nicht gefunden.');
  }

  // Mitglieder-E-Mails VOR dem Löschen einsammeln, um danach die zugehörigen Auth-Accounts
  // bereinigen zu können - nach recursiveDelete() sind die Member-Dokumente weg.
  const membersSnap = await clubRef.collection('members').get();
  const memberEmails = [];
  membersSnap.forEach((doc) => {
    if (doc.id === MEMBERS_INDEX_ID) return;
    try {
      const member = JSON.parse(doc.data().value);
      if (member && member.email) memberEmails.push(member.email);
    } catch (e) {
      logger.error(`Mitglied ${doc.id} in Club ${clubId} konnte beim Löschen nicht gelesen werden:`, e);
    }
  });

  await db.recursiveDelete(clubRef);

  const adminAuth = getAuth();
  await Promise.all(memberEmails.map(async (email) => {
    try {
      const userRecord = await adminAuth.getUserByEmail(email);
      const existingClaims = userRecord.customClaims || {};
      const existingClubIds = Array.isArray(existingClaims.clubIds) ? existingClaims.clubIds : [];
      const remainingClubIds = existingClubIds.filter((id) => id !== clubId);
      if (remainingClubIds.length > 0) {
        await adminAuth.setCustomUserClaims(userRecord.uid, {
          ...existingClaims,
          clubIds: remainingClubIds,
        });
      } else {
        await adminAuth.deleteUser(userRecord.uid);
      }
    } catch (e) {
      if (e.code !== 'auth/user-not-found') {
        logger.error(`Fehler beim Bereinigen des Accounts für ${email} nach Club-Löschung:`, e);
      }
      // Account existierte bereits nicht mehr - für uns trotzdem kein Fehlerfall.
    }
  }));

  return { success: true };
});

exports.unlinkMemberAccount = onCall({}, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Bitte zuerst anmelden.');
  }
  const { email, clubId } = request.data || {};
  if (!email || typeof email !== 'string') {
    throw new HttpsError('invalid-argument', 'E-Mail-Adresse fehlt.');
  }
  if (!clubId || typeof clubId !== 'string') {
    throw new HttpsError('invalid-argument', 'Club-ID fehlt.');
  }

  const adminAuth = getAuth();
  try {
    const userRecord = await adminAuth.getUserByEmail(email);
    // Ein Nutzer kann Mitglied in mehreren Clubs sein - beim Entfernen darf NICHT der ganze
    // Account gelöscht werden, sondern nur die eine clubId aus dem Claim-Array entfernt werden.
    // Erst wenn danach keine Club-Zugehörigkeit mehr übrig ist, wird der Account wirklich gelöscht.
    const existingClaims = userRecord.customClaims || {};
    const existingClubIds = Array.isArray(existingClaims.clubIds) ? existingClaims.clubIds : [];
    const remainingClubIds = existingClubIds.filter((id) => id !== clubId);

    if (remainingClubIds.length > 0) {
      await adminAuth.setCustomUserClaims(userRecord.uid, {
        ...existingClaims,
        clubIds: remainingClubIds,
      });
    } else {
      await adminAuth.deleteUser(userRecord.uid);
    }
  } catch (e) {
    if (e.code !== 'auth/user-not-found') {
      logger.error(`Fehler beim Entfernen des Accounts für ${email}:`, e);
      throw new HttpsError('internal', 'Account konnte nicht entfernt werden.');
    }
    // Account existierte bereits nicht mehr - für uns trotzdem ein Erfolg (idempotent).
  }

  return { success: true };
});

// -------- Rollen-Rechte: Custom Claim 'role' synchron zum Mitgliedsdokument halten --------
// Die Firestore Rules können die Rolle eines eingeloggten Nutzers nicht direkt aus dem
// Mitgliedsdokument lesen (das würde für JEDE Regel-Auswertung einen extra Read kosten) -
// stattdessen wird die Rolle als Custom Claim im Auth-Token gespiegelt, genau wie 'clubIds'.
// Dieser Trigger feuert bei jedem Schreiben auf ein Mitgliedsdokument (angelegt, geändert,
// gelöscht) und gleicht den Claim des zugehörigen Auth-Accounts (per E-Mail verknüpft) ab.
// Wichtig: Ein gecachtes ID-Token auf dem Client kann bis zu 1h alt sein, d.h. eine gerade erst
// heruntergestufte Rolle greift serverseitig etwas verzögert - für Rollenwechsel in einem
// Kegelclub unkritisch. inviteMember und createClub setzen den Claim zusätzlich sofort beim
// Erstanlegen, damit ein frisch eingeladenes Mitglied nicht auf diesen Trigger warten muss.
exports.syncMemberRoleClaim = onDocumentWritten('clubs/{clubId}/members/{memberId}', async (event) => {
  const { memberId } = event.params;
  if (memberId === MEMBERS_INDEX_ID) return; // Index-Dokument, kein echtes Mitglied

  const beforeData = event.data.before.exists ? JSON.parse(event.data.before.data().value) : null;
  const afterData = event.data.after.exists ? JSON.parse(event.data.after.data().value) : null;

  const adminAuth = getAuth();

  // Mitglied gelöscht oder E-Mail entfernt: alten Auth-Account (falls vorhanden) auf die
  // Standardrolle 'Mitglied' zurücksetzen, statt ihm eine veraltete Rolle zu lassen.
  const oldEmail = beforeData && beforeData.email;
  const newEmail = afterData && afterData.email;
  const newRole = (afterData && afterData.role) || 'Mitglied';

  if (oldEmail && oldEmail !== newEmail) {
    try {
      const oldUser = await adminAuth.getUserByEmail(oldEmail);
      const existingClaims = oldUser.customClaims || {};
      if (existingClaims.role !== 'Mitglied') {
        await adminAuth.setCustomUserClaims(oldUser.uid, { ...existingClaims, role: 'Mitglied' });
      }
    } catch (e) {
      if (e.code !== 'auth/user-not-found') {
        logger.error(`Rollen-Reset für alte E-Mail ${oldEmail} fehlgeschlagen:`, e);
      }
    }
  }

  if (!newEmail) return; // kein aktueller Account zum Aktualisieren

  try {
    const userRecord = await adminAuth.getUserByEmail(newEmail);
    const existingClaims = userRecord.customClaims || {};
    if (existingClaims.role !== newRole) {
      await adminAuth.setCustomUserClaims(userRecord.uid, { ...existingClaims, role: newRole });
    }
  } catch (e) {
    if (e.code !== 'auth/user-not-found') {
      logger.error(`Rollen-Claim-Sync für ${newEmail} fehlgeschlagen:`, e);
    }
    // Noch kein Auth-Account (Mitglied wurde noch nicht eingeladen) - beim Einladen setzt
    // inviteMember den Claim direkt, hier gibt es nichts zu tun.
  }
});

// -------- Öffentliche Strafen-Übersicht für Gäste (kein Login nötig) --------

function buildShareGuestBillHtml(name, dateStr, catalogLines, fremdstrafeLines, adHocLines, exactTotal, roundedTotal, paypalLink) {
  const hasAnyLines = catalogLines.length + fremdstrafeLines.length + adHocLines.length > 0;
  const emptyHtml = hasAnyLines ? '' : '<p>Keine Strafen für diesen Abend.</p>';
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Strafen vom Kegelabend</title>
<style>
  body{margin:0; background:#F6F6F4; color:#161616; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}
  .header{background:#161616; border-bottom:4px solid #E3421F; padding:22px 20px; text-align:center;}
  .header img{height:56px; display:block; margin:0 auto;}
  .container{max-width:480px; margin:0 auto; padding:20px 16px 60px;}
  .card{background:#fff; border-radius:14px; padding:18px 20px; margin-bottom:16px; box-shadow:0 2px 8px rgba(0,0,0,0.06);}
  h3{margin:0 0 10px; font-size:15px; text-transform:uppercase; letter-spacing:0.04em; color:#9A9186;}
  table{width:100%; border-collapse:collapse;}
  td{padding:6px 0; border-bottom:1px dashed #e5e1d8;}
  .total-card{background:#E3421F; color:#fff; text-align:center; padding:22px 20px;}
  .total-amount{font-size:30px; font-weight:800;}
  .total-label{font-size:12px; text-transform:uppercase; letter-spacing:0.06em; opacity:0.9; margin-top:4px;}
  .paypal-btn{display:block; text-align:center; background:#161616; color:#fff; font-weight:800; text-decoration:none; padding:14px 22px; border-radius:10px; margin-top:6px;}
  .totals-summary{text-align:right; margin-top:8px;}
  .totals-summary .exact{font-size:13px; color:#9A9186;}
  .totals-summary .rounded{font-size:16px; font-weight:800; margin-top:2px;}
</style>
</head>
<body>
  <div class="header"><img src="${LOGO_DATA_URI}" alt="Die Pudolfs"></div>
  <div class="container">
    <div class="card total-card">
      <div class="total-amount">${fmtEuro(roundedTotal)}</div>
      <div class="total-label">Strafen von ${escapeHtml(name)} · ${dateStr}</div>
    </div>
    ${emptyHtml}
    ${buildSectionHtml('Strafen', catalogLines)}
    ${buildSectionHtml('Fremdstrafen', fremdstrafeLines)}
    ${buildSectionHtml('Geldstrafen', adHocLines)}
    <div class="totals-summary">
      <div class="exact">Gesamt (genau): ${fmtEuro(exactTotal)}</div>
      <div class="rounded">Gesamt (gerundet): ${fmtEuro(roundedTotal)}</div>
    </div>
    <a class="paypal-btn" href="${paypalLink}">Jetzt ${fmtEuro(roundedTotal)} per PayPal bezahlen</a>
  </div>
</body>
</html>`;
}

function buildShareNotFoundHtml() {
  return `<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Link ungültig</title>
<style>body{font-family:-apple-system,sans-serif; background:#F6F6F4; color:#161616; text-align:center; padding:60px 20px;}</style>
</head><body><h2>Link ungültig oder abgelaufen</h2><p>Bitte wende dich an die Person, die dir diesen Link geschickt hat.</p></body></html>`;
}

exports.shareGuestBill = onRequest(async (req, res) => {
  const token = req.query.token;
  if (!token || typeof token !== 'string') {
    res.status(400).set('Content-Type', 'text/html; charset=utf-8').send(buildShareNotFoundHtml());
    return;
  }

  const db = getFirestore();
  // Der Gast-Link enthält bewusst KEINEN Club-Bezug (nur den Token) - solche Links werden an
  // Gäste ohne Login verschickt und sollen auch nach der Multi-Club-Umstellung unverändert
  // funktionieren. Da der Token selbst schon eindeutig ist, wird über alle existierenden Clubs
  // iteriert, bis der passende Sitzplatz gefunden ist, statt einen Club fest anzunehmen.
  const clubsSnapshot = await db.collection('clubs').get();
  let foundDetail = null, foundSeat = null, foundClubId = null;
  for (const clubDoc of clubsSnapshot.docs) {
    const eveningsSnapshot = await db.collection('clubs').doc(clubDoc.id).collection('evenings').get();
    for (const doc of eveningsSnapshot.docs) {
      let detail;
      try { detail = JSON.parse(doc.data().value || '{}'); } catch (e) { continue; }
      const seat = (detail.seating || []).find(s => s.shareToken === token);
      if (seat) { foundDetail = detail; foundSeat = seat; foundClubId = clubDoc.id; break; }
    }
    if (foundDetail) break;
  }

  if (!foundDetail || !foundSeat) {
    res.status(404).set('Content-Type', 'text/html; charset=utf-8').send(buildShareNotFoundHtml());
    return;
  }

  await enrichEveningWithSeatFines(foundClubId, foundDetail);

  const dateStr = formatEveningDate(foundDetail);
  const catalogLines = buildCatalogLines(foundDetail, foundSeat.seatId);
  const fremdstrafeLines = buildFremdstrafeChargeLines(foundDetail, foundSeat.seatId);
  const adHocLines = buildAdHocLines(foundDetail, foundSeat.seatId);
  const total = fineTotalForSeat(foundDetail, foundSeat.seatId);
  const roundedTotal = roundUpToFullEuro(total);
  const paypalLink = buildPaypalLink(roundedTotal);

  const html = buildShareGuestBillHtml(foundSeat.name, dateStr, catalogLines, fremdstrafeLines, adHocLines, total, roundedTotal, paypalLink);
  res.set('Content-Type', 'text/html; charset=utf-8').send(html);
});

// -------- Monatliche Buchungen automatisch verbuchen (täglich um Mitternacht) --------

const MONTH_NAMES_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

function getTodayInBerlin() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return formatter.format(new Date()); // liefert YYYY-MM-DD
}

// Gibt das gleiche Datum im nächsten Monat zurück. Existiert der Tag im Zielmonat nicht
// (z.B. 31. bei einem 30-Tage-Monat), wird stattdessen der letzte Tag des Zielmonats genutzt.
function addOneMonthSameDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const next = new Date(Date.UTC(y, m, d)); // m ist 1-indiziert -> +1 Monat gegenüber dem Original
  if (next.getUTCDate() !== d) {
    next.setUTCDate(0); // letzter Tag des Vormonats von "next" = letzter Tag des eigentlichen Zielmonats
  }
  return next.toISOString().slice(0, 10);
}

// Verarbeitet die fälligen Daueraufträge EINES Clubs. Ausgelagert aus dem eigentlichen Scheduler-
// Handler, damit dieser einfach über alle existierenden Clubs iterieren kann (ein onSchedule-
// Trigger läuft nicht "pro Club", sondern einmal insgesamt - anders als die Firestore-Trigger mit
// Wildcard-Pfad oben).
async function processRecurringBookingsForClub(clubId) {
  const clubRef = db.collection('clubs').doc(clubId);
  const recurringDoc = await clubRef.collection('data').doc('finance-recurring').get();
  if (!recurringDoc.exists) return;

  let recurring;
  try { recurring = JSON.parse(recurringDoc.data().value || '[]'); } catch (e) {
    logger.error(`Konnte finance-recurring für Club ${clubId} nicht parsen`, e);
    return;
  }

  const todayStr = getTodayInBerlin();
  const dueBookings = recurring.filter(r => r.nextDate === todayStr);
  if (dueBookings.length === 0) return;

  const [year, month] = todayStr.split('-').map(Number);
  const monthLabel = `${MONTH_NAMES_DE[month - 1]} ${year}`;

  const newTransactions = [];
  dueBookings.forEach(r => {
    const description = `${r.description} (${monthLabel})`;
    const transaction = {
      id: 'tx-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      accountId: r.accountId,
      description,
      date: todayStr,
      amount: r.amount,
      createdAt: Date.now(),
    };
    if (r.potId) transaction.potId = r.potId;
    newTransactions.push(transaction);
    r.nextDate = addOneMonthSameDay(r.nextDate);
    logger.info(`Club ${clubId}: monatliche Buchung verbucht: "${description}", Betrag ${r.amount}, nächste Ausführung ${r.nextDate}`);
  });

  // finance-recurring bleibt ein Blob (kleine, selten parallel bearbeitete Liste), aber jede
  // neue Buchung wird als EIGENES Dokument geschrieben statt den kompletten transactions-Blob
  // zu überschreiben - sonst könnte dieser nächtliche Lauf eine zeitgleiche manuelle Änderung
  // im Client überschreiben (das genau zu vermeiden war der Grund für die Migration).
  await Promise.all([
    clubRef.collection('data').doc('finance-recurring').set({ value: JSON.stringify(recurring) }),
    ...newTransactions.map(tx => saveClubEntity(clubRef, 'transactions', tx)),
  ]);
}

exports.processRecurringBookings = onSchedule(
  { schedule: '0 0 * * *', timeZone: 'Europe/Berlin' },
  async () => {
    const clubsSnapshot = await db.collection('clubs').get();
    for (const clubDoc of clubsSnapshot.docs) {
      try {
        await processRecurringBookingsForClub(clubDoc.id);
      } catch (e) {
        // Ein Fehler in einem Club darf die Verarbeitung der anderen Clubs nicht verhindern.
        logger.error(`Fehler bei processRecurringBookings für Club ${clubDoc.id}:`, e);
      }
    }
  }
);

// -------- Kalender-Abo (iCalendar-Feed) --------
//
// Liefert eine .ics-Datei mit allen Terminen zum Abonnieren (z.B. auf dem
// iPhone via "webcal://"). Enthält KEINE Geburtstage.
//
// - Einzeltermine (ohne Wiederholung) werden IMMER aufgenommen, egal wie
//   weit sie in der Zukunft liegen.
// - Serien-Termine werden nur für die nächsten 12 Monate ab heute expandiert
//   (das Fenster wandert bei jedem Abruf automatisch mit "heute" mit).
// - Der Zugriff ist über einen zufälligen Token geschützt (?t=...), der
//   einmalig beim ersten Klick auf "Kalender abonnieren" in der App erzeugt
//   und in Firestore unter clubs/<clubId>/data/calendar-feed-token abgelegt wird.
// - Da bei jedem Abruf frisch aus Firestore gelesen wird, sind neue/geänderte
//   Termine sofort im Feed enthalten, unabhängig davon wie oft iOS abruft.

function pad2(n) { return String(n).padStart(2, '0'); }

function isoDateFeed(y, m, d) { return `${y}-${pad2(m)}-${pad2(d)}`; }

function addDaysISOFeed(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return isoDateFeed(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function dateOnlyFeed(datetimeStr) { return datetimeStr.slice(0, 10); }
function timeOnlyFeed(datetimeStr) { return datetimeStr.slice(11, 16); }
function combineDatetimeFeed(dateStr, timeStr) { return `${dateStr}T${timeStr}`; }

// Spiegelt getEventSpanDays aus der App.
function getEventSpanDaysFeed(event) {
  const [sy, sm, sd] = dateOnlyFeed(event.start).split('-').map(Number);
  const [ey, em, ed] = dateOnlyFeed(event.end).split('-').map(Number);
  const s = Date.UTC(sy, sm - 1, sd);
  const e = Date.UTC(ey, em - 1, ed);
  return Math.max(0, Math.round((e - s) / 86400000));
}

// Spiegelt getRecurrenceStartsInMonth aus der App.
function getRecurrenceStartsInMonthFeed(event, year, month) {
  let occurrences = [];
  const daysInMonth = new Date(year, month, 0).getDate();
  const baseDateStr = dateOnlyFeed(event.start);
  const [by, bm, bd] = baseDateStr.split('-').map(Number);
  const baseUTC = Date.UTC(by, bm - 1, bd);

  if (event.recurrence === 'none' || !event.recurrence) {
    if (by === year && bm === month) occurrences.push(baseDateStr);
  } else if (event.recurrence === 'weekly' || event.recurrence === 'biweekly' || event.recurrence === 'every4weeks') {
    const intervalDays = event.recurrence === 'weekly' ? 7 : event.recurrence === 'biweekly' ? 14 : 28;
    for (let d = 1; d <= daysInMonth; d++) {
      const currentUTC = Date.UTC(year, month - 1, d);
      if (currentUTC < baseUTC) continue;
      const diffDays = Math.round((currentUTC - baseUTC) / 86400000);
      if (diffDays % intervalDays === 0) occurrences.push(isoDateFeed(year, month, d));
    }
  } else if (event.recurrence === 'monthly') {
    if (year > by || (year === by && month >= bm)) {
      const targetDay = Math.min(bd, daysInMonth);
      occurrences.push(isoDateFeed(year, month, targetDay));
    }
  } else if (event.recurrence === 'yearly') {
    if (month === bm && year >= by) {
      const targetDay = Math.min(bd, daysInMonth);
      occurrences.push(isoDateFeed(year, month, targetDay));
    }
  }

  if (event.recurrenceEndDate) {
    occurrences = occurrences.filter(d => d <= event.recurrenceEndDate);
  }
  return occurrences;
}

// Spiegelt getOccurrenceStartsOverlappingMonth aus der App.
function getOccurrenceStartsOverlappingMonthFeed(event, year, month) {
  const span = getEventSpanDaysFeed(event);
  const monthsBack = Math.min(6, Math.ceil((span + 1) / 28) + 1);
  const starts = new Set();
  let y = year, m = month;
  for (let i = 0; i <= monthsBack; i++) {
    getRecurrenceStartsInMonthFeed(event, y, m).forEach(d => starts.add(d));
    m--; if (m < 1) { m = 12; y--; }
  }
  const monthStart = isoDateFeed(year, month, 1);
  const monthEnd = isoDateFeed(year, month, new Date(year, month, 0).getDate());
  return Array.from(starts).filter(startDate => {
    const endDate = addDaysISOFeed(startDate, span);
    return endDate >= monthStart && startDate <= monthEnd;
  });
}

// Spiegelt buildOccurrenceObject aus der App (inkl. Ausnahmen/Verschiebungen).
function buildOccurrenceObjectFeed(ev, occurrenceDate, occurrenceEdits) {
  const edit = occurrenceEdits.find(e => e.seriesId === ev.id && e.occurrenceDate === occurrenceDate) || null;
  if (edit && edit.deleted) return null;
  const span = getEventSpanDaysFeed(ev);
  const defaultStart = combineDatetimeFeed(occurrenceDate, timeOnlyFeed(ev.start));
  const defaultEnd = combineDatetimeFeed(addDaysISOFeed(occurrenceDate, span), timeOnlyFeed(ev.end));
  if (edit) {
    return {
      seriesId: ev.id, occurrenceDate,
      title: edit.title !== undefined ? edit.title : ev.title,
      location: edit.location !== undefined ? edit.location : ev.location,
      start: edit.start !== undefined ? edit.start : defaultStart,
      end: edit.end !== undefined ? edit.end : defaultEnd,
    };
  }
  return {
    seriesId: ev.id, occurrenceDate,
    title: ev.title, location: ev.location,
    start: defaultStart, end: defaultEnd,
  };
}

// Baut alle Vorkommen für ein einzelnes Event über ein Monatsfenster [startYear/Month .. monthCount Monate].
function expandEventOverMonths(ev, occurrenceEdits, startYear, startMonth, monthCount) {
  const results = [];
  const seen = new Set();
  let y = startYear, m = startMonth;
  for (let i = 0; i < monthCount; i++) {
    getOccurrenceStartsOverlappingMonthFeed(ev, y, m).forEach(startDate => {
      if (seen.has(startDate)) return;
      seen.add(startDate);
      const occ = buildOccurrenceObjectFeed(ev, startDate, occurrenceEdits);
      if (occ) results.push(occ);
    });
    m++; if (m > 12) { m = 1; y++; }
  }
  return results;
}

function icsEscape(str) {
  return String(str || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

// Formatiert "YYYY-MM-DDTHH:mm" als lokale iCal-Zeit mit TZID=Europe/Berlin.
function icsLocalDateTime(datetimeStr) {
  return datetimeStr.replace(/[-:]/g, '') + '00';
}

// Faltet eine iCal-Zeile nach RFC 5545 (max. 75 Byte pro Zeile,
// Fortsetzungszeilen beginnen mit einem Leerzeichen).
function icsFoldLine(line) {
  const maxLen = 75;
  if (line.length <= maxLen) return line;
  const parts = [];
  let rest = line;
  parts.push(rest.slice(0, maxLen));
  rest = rest.slice(maxLen);
  while (rest.length > 0) {
    parts.push(' ' + rest.slice(0, maxLen - 1));
    rest = rest.slice(maxLen - 1);
  }
  return parts.join('\r\n');
}

function buildIcsFeed(occurrences) {
  const now = new Date();
  const dtstamp = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const lines = [];
  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push('PRODID:-//Die Pudolfs Kegelclub//Kalender-Feed//DE');
  lines.push('CALSCALE:GREGORIAN');
  lines.push('METHOD:PUBLISH');
  lines.push('X-WR-CALNAME:Die Pudolfs Kegelclub');
  lines.push('X-WR-TIMEZONE:Europe/Berlin');
  lines.push('REFRESH-INTERVAL;VALUE=DURATION:P1W');
  lines.push('X-PUBLISHED-TTL:P1W');

  occurrences.forEach(occ => {
    const uid = `${occ.seriesId}-${occ.occurrenceDate}@die-pudolfs.de`;
    const detailUrl = `https://app.die-pudolfs.de/?event=${encodeURIComponent(occ.seriesId)}&date=${encodeURIComponent(occ.occurrenceDate)}`;
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(icsFoldLine(`DTSTART;TZID=Europe/Berlin:${icsLocalDateTime(occ.start)}`));
    lines.push(icsFoldLine(`DTEND;TZID=Europe/Berlin:${icsLocalDateTime(occ.end)}`));
    lines.push(icsFoldLine(`SUMMARY:${icsEscape(occ.title)}`));
    if (occ.location) lines.push(icsFoldLine(`LOCATION:${icsEscape(occ.location)}`));
    lines.push(icsFoldLine(`DESCRIPTION:${icsEscape(detailUrl)}`));
    lines.push(icsFoldLine(`URL:${detailUrl}`));
    lines.push('END:VEVENT');
  });

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

exports.calendarFeed = onRequest(async (req, res) => {
  const token = req.query.t;
  if (!token || typeof token !== 'string') {
    res.status(403).send('Ungültiger Link.');
    return;
  }

  // Der Feed-Link enthält bewusst KEINEN Club-Bezug (nur den Token) - dieser Link wird als
  // Kalender-Abo eingerichtet und soll auch nach der Multi-Club-Umstellung unverändert
  // funktionieren. Da der Token selbst schon eindeutig ist, wird über alle existierenden Clubs
  // iteriert, bis der passende Token gefunden ist, statt einen Club fest anzunehmen.
  const clubsSnapshot = await db.collection('clubs').get();
  let matchedClubRef = null;
  for (const clubDoc of clubsSnapshot.docs) {
    const candidateClubRef = db.collection('clubs').doc(clubDoc.id);
    const tokenDoc = await candidateClubRef.collection('data').doc('calendar-feed-token').get();
    const storedToken = tokenDoc.exists ? JSON.parse(tokenDoc.data().value || 'null') : null;
    if (storedToken && storedToken === token) { matchedClubRef = candidateClubRef; break; }
  }
  if (!matchedClubRef) {
    res.status(403).send('Ungültiger Link.');
    return;
  }

  const events = await loadClubEntityCollection(matchedClubRef, 'events');
  const occurrenceEdits = await loadClubEntityCollection(matchedClubRef, 'occurrence-edits');

  const today = new Date();
  const startYear = today.getUTCFullYear();
  const startMonth = today.getUTCMonth() + 1;

  let allOccurrences = [];
  events.forEach(ev => {
    const isRecurring = ev.recurrence && ev.recurrence !== 'none';
    if (isRecurring) {
      // Serien: nur die nächsten 12 Monate ab heute.
      allOccurrences = allOccurrences.concat(expandEventOverMonths(ev, occurrenceEdits, startYear, startMonth, 12));
    } else {
      // Einzeltermine: immer aufnehmen, unabhängig vom Datum.
      const occ = buildOccurrenceObjectFeed(ev, dateOnlyFeed(ev.start), occurrenceEdits);
      if (occ) allOccurrences.push(occ);
    }
  });

  allOccurrences.sort((a, b) => a.start.localeCompare(b.start));

  const ics = buildIcsFeed(allOccurrences);
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', 'inline; filename="pudolfs-kalender.ics"');
  res.send(ics);
});
