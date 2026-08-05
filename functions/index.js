/**
 * Kegelapp – Cloud Functions für Strafen-E-Mails, Einladungen und Club-Verwaltung
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
const QRCode = require('qrcode');
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

// Prüft, ob eine Strafenart sich wie eine Fremdstrafe verhält (andere Anwesende zahlen statt
// des Verursachers). Umfasst 'fremdstrafe' und die kombinierte Art 'fremdstrafe_runde'.
function isFremdstrafeType(type) {
  return type === 'fremdstrafe' || type === 'fremdstrafe_runde';
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
    if (isFremdstrafeType(f.type)) return;
    if (f.type === 'runde') return; // Runden haben keinen Euro-Betrag
    const count = entries[f.id] || 0;
    total += count * f.amount;
  });

  const adHocList = (detail.adHocFinesBySeat && detail.adHocFinesBySeat[seatId]) || [];
  adHocList.forEach(a => { total += a.amount; });

  const fremdstrafeFines = catalog.filter(f => isFremdstrafeType(f.type));
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

// Ermittelt alle NOCH OFFENEN Runden-Instanzen eines Abends (Pendant zu computeRoundEntries im
// Client, aber ohne Sitzplatz-Reihenfolge - die ist nur für die Anzeige relevant, nicht für den
// Pool-Übertrag). Wird ausschließlich beim Abschließen eines Abends aufgerufen (closeEvening),
// um die noch offenen Runden in den zentralen Pool (open-rounds-pool) zu verschieben - bereits
// gegebene Runden fließen bewusst NICHT mit ein, sie sind bereits erledigt.
function computeOpenRoundEntriesServer(detail) {
  const catalog = detail.finesCatalogSnapshot || [];
  const roundFines = catalog.filter(f => f.type === 'runde' || f.type === 'fremdstrafe_runde');
  if (roundFines.length === 0) return [];
  const occupied = detail.seating.filter(s => s.name);
  const entries = [];
  occupied.forEach(seat => {
    const seatEntries = (detail.finesBySeat && detail.finesBySeat[seat.seatId]) || {};
    const givenMap = (detail.roundsGivenBySeat && detail.roundsGivenBySeat[seat.seatId]) || {};
    roundFines.forEach(fine => {
      const count = seatEntries[fine.id] || 0;
      if (count <= 0) return;
      const givenIndices = new Set(givenMap[fine.id] || []);
      for (let i = 0; i < count; i++) {
        if (givenIndices.has(i)) continue;
        entries.push({ name: seat.name, memberId: seat.memberId, fineId: fine.id, fineName: fine.name });
      }
    });
  });
  return entries;
}

function buildCatalogLines(detail, seatId) {
  const entries = (detail.finesBySeat && detail.finesBySeat[seatId]) || {};
  const catalog = detail.finesCatalogSnapshot || [];
  const lines = [];
  catalog.forEach(f => {
    if (isFremdstrafeType(f.type)) return;
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
  catalog.filter(f => isFremdstrafeType(f.type)).forEach(f => {
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

function buildPaypalLink(paypalName, amount) {
  if (!paypalName) return null;
  // PayPal.me erwartet einen Punkt als Dezimaltrennzeichen, kein Komma.
  const amountStr = amount.toFixed(2);
  return `https://paypal.com/paypalme/${paypalName}/${amountStr}`;
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

function buildEmailHtml(name, dateStr, catalogLines, fremdstrafeLines, adHocLines, exactEveningTotal, roundedEveningTotal, priorArrears, paypalName, clubName) {
  const hasAnyLines = catalogLines.length + fremdstrafeLines.length + adHocLines.length > 0;
  const emptyHtml = hasAnyLines ? '' : '<p>Keine Strafen für diesen Abend.</p>';
  const hasArrears = priorArrears > 0;
  const combinedExact = exactEveningTotal + priorArrears;
  const combinedRounded = roundUpToFullEuro(combinedExact);
  const paypalLink = buildPaypalLink(paypalName, combinedRounded);

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

  const paypalButtonHtml = paypalLink ? `
      <p style="margin-top:22px;">
        <a href="${paypalLink}" style="display:inline-block; background:#E3421F; color:#fff; font-weight:800; text-decoration:none; padding:12px 22px; border-radius:8px;">
          Jetzt ${fmtEuro(combinedRounded)} per PayPal bezahlen
        </a>
      </p>
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
      ${paypalButtonHtml}

      <p>Kegelgruß,<br>${escapeHtml(clubName)}</p>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildReopenEmailHtml(name, dateStr, clubName) {
  return `
    <div style="font-family:sans-serif; color:#161616; max-width:480px;">
      <p>Hallo ${escapeHtml(name)},</p>
      <p>beim Kegelabend am <strong>${dateStr}</strong> gab es scheinbar einen Fehler in der Strafenberechnung.</p>
      <p><strong>Du kannst die vorherige E-Mail zu diesem Abend ignorieren – aktuell muss nichts bezahlt werden.</strong></p>
      <p>Sobald der Abend erneut abgeschlossen wird, bekommst du eine neue, korrigierte E-Mail mit den aktuellen Strafen.</p>
      <p>Kegelgruß,<br>${escapeHtml(clubName)}</p>
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

// Pflegt den 'arrears/_index' innerhalb eines bereits vorhandenen Batches mit, wenn Einträge
// gesetzt oder gelöscht werden - arrears folgt demselben "Einzeldokument pro Eintrag + Index"-
// Muster wie members/events/etc. (siehe loadClubEntityCollection), die Schreibpfade in
// closeEvening/reopenEvening/deleteEvening haben den Index bisher nicht gepflegt, sodass der
// Client (makeClubEntityStore('arrears').getAll(), liest NUR über den Index) neu angelegte
// Einträge nie zu sehen bekam, obwohl das Dokument selbst korrekt in Firestore stand.
async function applyArrearsIndexUpdates(clubRef, batch, setIds, deleteIds) {
  if (setIds.length === 0 && deleteIds.length === 0) return;
  const indexRef = clubRef.collection('arrears').doc('_index');
  const indexSnap = await indexRef.get();
  let index = indexSnap.exists ? JSON.parse(indexSnap.data().value || '[]') : [];
  let changed = false;
  setIds.forEach(id => {
    if (!index.includes(id)) { index.push(id); changed = true; }
  });
  if (deleteIds.length > 0) {
    const before = index.length;
    index = index.filter(id => !deleteIds.includes(id));
    if (index.length !== before) changed = true;
  }
  if (changed) batch.set(indexRef, { value: JSON.stringify(index) });
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
  detail.roundsGivenBySeat = {};
  snaps.forEach(snap => {
    let seatData;
    try { seatData = JSON.parse(snap.data().value); } catch (e) { return; }
    if (seatData.finesBySeat) detail.finesBySeat[snap.id] = seatData.finesBySeat;
    if (seatData.adHocFinesBySeat) detail.adHocFinesBySeat[snap.id] = seatData.adHocFinesBySeat;
    if (seatData.roundsGivenBySeat) detail.roundsGivenBySeat[snap.id] = seatData.roundsGivenBySeat;
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
  const entries = [];
  detail.seating.filter(s => s.name && !s.isGuest).forEach(s => { entries.push({ name: s.name, memberId: s.memberId }); });
  (detail.absentMembersFines || []).forEach(a => { entries.push({ name: a.name, memberId: a.memberId }); });
  const result = [];
  entries.forEach(({ name, memberId }) => {
    const member = members.find(m => m.id === memberId);
    if (member && member.email) result.push({ name, email: member.email });
  });
  return result;
}

async function handleEveningClosed(clubId, after, docId) {
  const members = await loadMembers(clubId);
  if (!members) return;

  const clubSnap = await db.collection('clubs').doc(clubId).get();
  const paypalName = clubSnap.exists ? clubSnap.data().paypalName : undefined;
  const clubName = (clubSnap.exists && clubSnap.data().name) || 'Dein Kegelclub';

  const resend = new Resend(resendApiKey.value());
  const dateStr = formatEveningDate(after);
  const recipients = [];

  const presentSeats = after.seating.filter(s => s.name && !s.isGuest);
  presentSeats.forEach(s => {
    const member = members.find(m => m.id === s.memberId);
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
    const member = members.find(m => m.id === a.memberId);
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
    const html = buildEmailHtml(r.name, dateStr, r.catalogLines, r.fremdstrafeLines, r.adHocLines, r.total, roundedTotal, priorArrears, paypalName, clubName);
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

  const clubSnap = await db.collection('clubs').doc(clubId).get();
  const clubName = (clubSnap.exists && clubSnap.data().name) || 'Dein Kegelclub';

  const resend = new Resend(resendApiKey.value());
  const dateStr = formatEveningDate(before);
  const recipients = collectRecipientNames(before, members);

  logger.info(`Sende Korrektur-E-Mails (Wiedereröffnung) für Abend ${docId} an ${recipients.length} Empfänger.`);

  for (const r of recipients) {
    const html = buildReopenEmailHtml(r.name, dateStr, clubName);
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

// ID-Auflösung für Rückstands-Dokumente: seit dem ID-Umbau ist die memberId (echte
// Mitglieds-ID oder generierte 'guest-<uuid>', siehe seat.memberId) immer schon die
// Dokument-ID - keine Namensauflösung mehr nötig. Identisch zur Client-Funktion
// resolveArrearsDocId in index.html.
function resolveArrearsDocIdServer(memberId) {
  return memberId;
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

  const presentMemberIds = new Set(detail.seating.filter(s => s.name && !s.isGuest).map(s => s.memberId));
  presentMemberIds.forEach(memberId => {
    if (!stats.attendanceByMember[memberId]) stats.attendanceByMember[memberId] = {};
    const newCount = (stats.attendanceByMember[memberId][year] || 0) + direction;
    if (newCount > 0) stats.attendanceByMember[memberId][year] = newCount; else delete stats.attendanceByMember[memberId][year];
  });
  await statsRef.set({ value: JSON.stringify(stats) });
}

exports.closeEvening = onCall({}, async (request) => {
  const { clubId, eveningId, skipNotificationEmail } = request.data || {};
  if (!clubId || typeof clubId !== 'string') {
    throw new HttpsError('invalid-argument', 'Club-ID fehlt.');
  }
  if (!eveningId || typeof eveningId !== 'string') {
    throw new HttpsError('invalid-argument', 'Abend-ID fehlt.');
  }

  // Enger gefasst als canManageMembers(): hier nur Kassenwart oder Admin, bewusst nicht
  // Präsident - dieselbe Berechtigung wie die übrige Finanzverwaltung
  // (siehe canManageFinances() in firestore.rules und index.html). Prüft auch Club-Zugehörigkeit.
  requireFinanceRole(request, clubId);
  await requireClubAccessNotBlocked(clubId);

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
  const presentMemberIds = new Set(presentSeats.map(s => s.memberId));
  const avgRounded = averageOfTotalsRounded(validPresentMemberTotals(detail));

  // Invalide markierte Personen: Durchschnitt jetzt fest einfrieren.
  detail.seating.forEach(s => {
    if (s.invalid && s.invalidAmount === undefined) s.invalidAmount = avgRounded;
  });

  const absentMembers = members.filter(m => !presentMemberIds.has(m.id));
  detail.absentMembersFines = absentMembers.map(m => ({ name: displayName(m), memberId: m.id, amount: avgRounded }));
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
    const existing = arrears.find(a => a.memberId === s.memberId);
    priorArrearsSnapshot[s.memberId] = existing ? existing.amount : 0;
  });
  detail.absentMembersFines.forEach(a => {
    if (priorArrearsSnapshot[a.memberId] === undefined) {
      const existing = arrears.find(x => x.memberId === a.memberId);
      priorArrearsSnapshot[a.memberId] = existing ? existing.amount : 0;
    }
  });
  detail.priorArrearsSnapshot = priorArrearsSnapshot;

  const touchedArrearsEntries = [];
  function addToArrears(name, memberId, amount, seatId) {
    if (!amount) return;
    // Absicherung gegen die Deploy/Migration-Reihenfolge: Sitzplätze aus VOR dem ID-Umbau
    // angelegten Abenden haben noch keine memberId (siehe scripts/migrate-to-member-ids.js).
    // Ohne memberId würde hier sonst ein Sammel-Dokument mit der Firestore-ID 'undefined'
    // entstehen, in dem sich mehrere Personen einen Rückstand teilen - lieber überspringen
    // und den Betrag verwerfen, als Daten unbemerkt zu vermischen. Nach erfolgter Migration
    // tritt dieser Fall nicht mehr auf.
    if (!memberId) {
      console.error(`addToArrears: keine memberId für '${name}' - Eintrag übersprungen (Migration noch nicht gelaufen?)`);
      return;
    }
    let entry = arrears.find(a => a.memberId === memberId);
    if (!entry) { entry = { id: resolveArrearsDocIdServer(memberId), memberId, name, amount: 0, history: [] }; arrears.push(entry); }
    if (!entry.id) entry.id = resolveArrearsDocIdServer(memberId);
    if (!entry.memberId) entry.memberId = memberId;
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
    addToArrears(s.name, s.memberId, roundUpToFullEuro(fineTotalForSeat(detail, s.seatId)), s.seatId);
  });
  detail.absentMembersFines.forEach(a => { addToArrears(a.name, a.memberId, a.amount); });

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

  // Noch offene Runden (nicht "gegeben") wandern beim Abschließen in den zentralen Pool
  // (clubs/{clubId}/data/open-rounds-pool) - von dort werden sie beim Anlegen eines neuen Abends
  // gelesen (siehe carryOverOpenRoundsFromPool im Client), statt bei jedem neuen Abend alle
  // vergangenen Abende einzeln durchsuchen zu müssen. Bereits gegebene Runden fließen NICHT mit
  // ein - sie sind erledigt und werden beim Abschluss verworfen.
  const openRoundsRef = clubRef.collection('data').doc('open-rounds-pool');
  const openRoundEntries = computeOpenRoundEntriesServer(detail);
  let poolEntries = [];
  if (openRoundEntries.length > 0) {
    const poolSnap = await openRoundsRef.get();
    if (poolSnap.exists) {
      try { poolEntries = JSON.parse(poolSnap.data().value || '[]'); } catch (e) { poolEntries = []; }
    }
    openRoundEntries.forEach(e => {
      poolEntries.push({
        id: `or-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name: e.name, memberId: e.memberId, fineId: e.fineId, fineName: e.fineName,
        sourceEveningId: detail.id, sourceDate: detail.date,
      });
    });
  }

  // Alle Schreibvorgänge (Hauptdokument, Index, Runden-Pool, jeder betroffene Rückstands-Eintrag)
  // in EINEM atomaren Batch - entweder alles oder nichts, kein Teilfehler-Risiko wie bei einem
  // einfachen Promise.all. Firestore erlaubt bis zu 500 Schreiboperationen pro Batch, das reicht
  // für jeden realistischen Kegelclub-Abend deutlich.
  const { finesBySeat, adHocFinesBySeat, roundsGivenBySeat, ...mainFields } = detail;
  const batch = db.batch();
  batch.set(eveningRef, { value: JSON.stringify(mainFields) });
  batch.set(dataRef, { value: JSON.stringify(eveningsIndex) });
  if (openRoundEntries.length > 0) {
    batch.set(openRoundsRef, { value: JSON.stringify(poolEntries) });
  }
  touchedArrearsEntries.forEach(entry => {
    batch.set(clubRef.collection('arrears').doc(entry.id), { value: JSON.stringify(entry) });
  });
  await applyArrearsIndexUpdates(clubRef, batch, touchedArrearsEntries.map(e => e.id), []);
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
  function subtractFromArrears(name, memberId, amount) {
    if (!amount) return;
    if (!memberId) {
      console.error(`subtractFromArrears: keine memberId für '${name}' - Eintrag übersprungen (Migration noch nicht gelaufen?)`);
      return;
    }
    let entry = arrears.find(a => a.memberId === memberId);
    if (!entry) { entry = { id: resolveArrearsDocIdServer(memberId), memberId, name, amount: 0, history: [] }; arrears.push(entry); }
    if (!entry.id) entry.id = resolveArrearsDocIdServer(memberId);
    if (!entry.memberId) entry.memberId = memberId;
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
    subtractFromArrears(s.name, s.memberId, roundUpToFullEuro(fineTotalForSeat(detail, s.seatId)));
  });
  (detail.absentMembersFines || []).forEach(a => { subtractFromArrears(a.name, a.memberId, a.amount); });
  return touchedArrearsEntries;
}

// Prüft, ob der Aufrufer selbst zu clubId gehört (custom claim 'clubIds'), oder der
// Admin-Account ist. Cloud Functions mit Admin-SDK-Rechten umgehen die Firestore Rules
// vollständig - ohne diese Prüfung könnte jeder eingeloggte Nutzer (unabhängig von Rolle oder
// Club-Zugehörigkeit) die Function mit einer beliebigen fremden clubId aufrufen. Wirft bei
// fehlender Zugehörigkeit.
function requireCallerBelongsToClub(request, clubId) {
  const isCallerAdmin = request.auth.token.email === 'admin@die-pudolfs.internal';
  const callerClubIds = request.auth.token.clubIds || [];
  if (!isCallerAdmin && !callerClubIds.includes(clubId)) {
    throw new HttpsError('permission-denied', 'Kein Zugriff auf diesen Club.');
  }
}

// Liest die Rolle des Aufrufers für GENAU DIESEN Club aus dem Custom Claim 'roles' (Objekt,
// { [clubId]: 'Kassenwart' } - siehe syncMemberRoleClaim). Vorher gab es nur einen globalen
// role-String, der fälschlich für alle Clubs des Nutzers gleichzeitig galt. Fehlt der Eintrag
// (z.B. Account noch nicht synchronisiert, oder Nutzer gehört gar nicht zu diesem Club),
// wird sicherheitshalber 'Mitglied' angenommen.
function callerRoleForClub(request, clubId) {
  const roles = request.auth.token.roles;
  if (roles && typeof roles === 'object' && roles[clubId]) return roles[clubId];
  return 'Mitglied';
}

// Prüft, ob der Aufrufer für DIESEN clubId die Rolle Kassenwart hat oder der Admin-Account ist -
// dieselbe Berechtigung wie canManageFinances() in firestore.rules und index.html. Prüft
// zusätzlich die Club-Zugehörigkeit (requireCallerBelongsToClub) - ohne die könnte die Rolle aus
// einem anderen Club sonst nicht greifen, aber ein Nutzer ohne jede Zugehörigkeit zu clubId
// müsste trotzdem abgewiesen werden. Wirft bei fehlender Berechtigung.
function requireFinanceRole(request, clubId) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Bitte zuerst anmelden.');
  }
  requireCallerBelongsToClub(request, clubId);
  const isCallerAdmin = request.auth.token.email === 'admin@die-pudolfs.internal';
  if (!isCallerAdmin && callerRoleForClub(request, clubId) !== 'Kassenwart') {
    throw new HttpsError('permission-denied', 'Nur Kassenwart oder Admin dürfen diese Aktion ausführen.');
  }
}

// Prüft, ob der Club im Read-Only-Modus ist (abgelaufener Free-Zeitraum, subscription.
// accessBlocked - siehe updateSubscriptionAccessStatus oben und clubAccessBlocked() in
// firestore.rules). Cloud Functions mit Admin-SDK-Rechten umgehen die Firestore Rules
// vollständig, deshalb müssen schreibende Functions (closeEvening, reopenEvening,
// deleteEvening, inviteMember, unlinkMemberAccount) diese Prüfung selbst vornehmen - sonst
// wäre die Read-Only-Sperre über diese Functions aushebelbar. deleteClub ist bewusst
// AUSGENOMMEN: ein blockierter Club muss weiterhin vollständig gelöscht werden können.
async function requireClubAccessNotBlocked(clubId) {
  const clubSnap = await db.collection('clubs').doc(clubId).get();
  const subscription = clubSnap.exists ? clubSnap.data().subscription : null;
  if (subscription && subscription.accessBlocked) {
    throw new HttpsError('permission-denied', 'Der kostenlose Testzeitraum ist abgelaufen. Die App kann nur noch gelesen werden.');
  }
}

exports.reopenEvening = onCall({}, async (request) => {
  const { clubId, eveningId, skipNotificationEmail } = request.data || {};
  if (!clubId || typeof clubId !== 'string') {
    throw new HttpsError('invalid-argument', 'Club-ID fehlt.');
  }
  if (!eveningId || typeof eveningId !== 'string') {
    throw new HttpsError('invalid-argument', 'Abend-ID fehlt.');
  }

  requireFinanceRole(request, clubId);
  await requireClubAccessNotBlocked(clubId);

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

  // Beim Abschließen (siehe closeEvening) wanderten die damals offenen Runden dieses Abends in
  // den zentralen Pool (open-rounds-pool) - bei einer Wiedereröffnung leben sie wieder direkt am
  // Abend (roundsGivenBySeat/finesBySeat), müssen also aus dem Pool entfernt werden, sonst gäbe
  // es die Rundenpflicht doppelt (einmal im Pool, einmal wieder aktiv im Abend).
  //
  // Sonderfall: eine dieser Runden könnte inzwischen von einem SPÄTEREN Abend bereits übernommen
  // worden sein (liegt dann nicht mehr im Pool, sondern in dessen carriedOverRounds) - in diesem
  // Fall würde die Wiedereröffnung die Runde ein zweites Mal aktiv machen (einmal hier, einmal im
  // übernehmenden Abend). Das wird VOR jeder Schreibaktion geprüft und bei Konflikt abgebrochen,
  // damit der Nutzer bewusst entscheiden kann (z.B. den übernehmenden Abend zuerst korrigieren).
  const openRoundsRef = clubRef.collection('data').doc('open-rounds-pool');
  const poolSnap = await openRoundsRef.get();
  let poolEntries = [];
  if (poolSnap.exists) {
    try { poolEntries = JSON.parse(poolSnap.data().value || '[]'); } catch (e) { poolEntries = []; }
  }
  const entriesFromThisEvening = poolEntries.filter(e => e.sourceEveningId === detail.id);
  const expectedOpenCount = computeOpenRoundEntriesServer(detail).length;
  // Wenn beim Abschluss mehr offene Runden in den Pool wanderten, als jetzt noch im Pool auf
  // diesen Abend verweisen, wurde mindestens eine davon bereits übernommen (aus dem Pool entfernt
  // und in carriedOverRounds eines anderen Abends verschoben) - dann abbrechen.
  if (expectedOpenCount > 0 && entriesFromThisEvening.length < expectedOpenCount) {
    throw new HttpsError('failed-precondition', 'Mindestens eine offene Runde dieses Abends wurde bereits von einem späteren Abend übernommen. Bitte zuerst dort prüfen, bevor dieser Abend wieder geöffnet wird.');
  }
  const poolChanged = entriesFromThisEvening.length > 0;
  if (poolChanged) {
    poolEntries = poolEntries.filter(e => e.sourceEveningId !== detail.id);
  }

  const { finesBySeat, adHocFinesBySeat, roundsGivenBySeat, ...mainFields } = detail;
  const batch = db.batch();
  batch.set(eveningRef, { value: JSON.stringify(mainFields) });
  batch.set(dataRef, { value: JSON.stringify(eveningsIndex) });
  if (poolChanged) {
    batch.set(openRoundsRef, { value: JSON.stringify(poolEntries) });
  }
  const arrearsSetIds = [];
  const arrearsDeleteIds = [];
  touchedArrearsEntries.forEach(entry => {
    const isGuest = entry.id && entry.id.startsWith('guest-');
    const entryRef = clubRef.collection('arrears').doc(entry.id);
    // Gast-Einträge, die durch die Korrektur auf 0 gefallen sind, werden gelöscht statt mit
    // amount:0 gespeichert - identisch zu saveArrearsEntry() im Client.
    if (isGuest && Math.round((entry.amount || 0) * 100) === 0) {
      batch.delete(entryRef);
      arrearsDeleteIds.push(entry.id);
    } else {
      batch.set(entryRef, { value: JSON.stringify(entry) });
      arrearsSetIds.push(entry.id);
    }
  });
  await applyArrearsIndexUpdates(clubRef, batch, arrearsSetIds, arrearsDeleteIds);
  await batch.commit();

  try {
    await updateAttendanceStatsForEveningServer(clubRef, detail, -1);
  } catch (e) {
    logger.error(`Anwesenheitsstatistik für Abend ${eveningId} (Wiedereröffnung) konnte nicht aktualisiert werden:`, e);
  }

  return { success: true };
});

exports.deleteEvening = onCall({}, async (request) => {
  const { clubId, eveningId } = request.data || {};
  if (!clubId || typeof clubId !== 'string') {
    throw new HttpsError('invalid-argument', 'Club-ID fehlt.');
  }
  if (!eveningId || typeof eveningId !== 'string') {
    throw new HttpsError('invalid-argument', 'Abend-ID fehlt.');
  }

  requireFinanceRole(request, clubId);
  await requireClubAccessNotBlocked(clubId);

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

  // Pool-Bereinigung (open-rounds-pool):
  // 1) War dieser Abend abgeschlossen, liegen seine damals offenen Runden im Pool - der Abend
  //    verschwindet komplett, diese Rundenpflichten werden bewusst NICHT irgendwo anders
  //    wiederhergestellt (siehe Absprache: "Pflicht komplett verworfen, Abend ist weg").
  // 2) Hatte dieser Abend selbst offene Runden aus dem Pool übernommen (carriedOverRounds), die
  //    noch nicht gegeben wurden, müssen diese zurück in den Pool - sonst ginge die Pflicht
  //    verloren, nur weil der übernehmende Abend gelöscht wird.
  const openRoundsRef = clubRef.collection('data').doc('open-rounds-pool');
  const poolSnap = await openRoundsRef.get();
  let poolEntries = [];
  if (poolSnap.exists) {
    try { poolEntries = JSON.parse(poolSnap.data().value || '[]'); } catch (e) { poolEntries = []; }
  }
  let poolChanged = false;
  if (wasClosed) {
    const filtered = poolEntries.filter(e => e.sourceEveningId !== eveningId);
    if (filtered.length !== poolEntries.length) { poolEntries = filtered; poolChanged = true; }
  }
  // Bewusst NICHT auf c.sourceEveningId geprüft: Geburtstagsrunden (fineId 'birthday', siehe
  // getBirthdayMembersSinceLastEvening() im Client) haben sourceEveningId=null, weil sie nicht aus
  // einer Übernahme aus dem Pool stammen, sondern direkt beim Anlegen dieses Abends erzeugt
  // wurden - sie müssen beim Löschen des Abends trotzdem zurück in den Pool wandern, sonst ginge
  // die Rundenpflicht ersatzlos verloren.
  const openCarriedToReturn = (detail.carriedOverRounds || []).filter(c => !c.given);
  if (openCarriedToReturn.length > 0) {
    openCarriedToReturn.forEach(c => {
      poolEntries.push({
        id: `or-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name: c.name, memberId: c.memberId, fineId: c.fineId, fineName: c.fineName,
        sourceEveningId: c.sourceEveningId, sourceDate: c.sourceDate,
      });
    });
    poolChanged = true;
  }

  // Alle Sitzplatz-Unterdokumente + Hauptdokument löschen, Index aktualisieren, betroffene
  // Rückstände korrigieren - alles in einem Batch.
  const seatsSnap = await eveningRef.collection('seats').get();
  const batch = db.batch();
  seatsSnap.forEach(seatDoc => { batch.delete(seatDoc.ref); });
  batch.delete(eveningRef);
  batch.set(dataRef, { value: JSON.stringify(eveningsIndex) });
  if (poolChanged) {
    batch.set(openRoundsRef, { value: JSON.stringify(poolEntries) });
  }
  const arrearsSetIds = [];
  const arrearsDeleteIds = [];
  touchedArrearsEntries.forEach(entry => {
    const isGuest = entry.id && entry.id.startsWith('guest-');
    const entryRef = clubRef.collection('arrears').doc(entry.id);
    if (isGuest && Math.round((entry.amount || 0) * 100) === 0) {
      batch.delete(entryRef);
      arrearsDeleteIds.push(entry.id);
    } else {
      batch.set(entryRef, { value: JSON.stringify(entry) });
      arrearsSetIds.push(entry.id);
    }
  });
  await applyArrearsIndexUpdates(clubRef, batch, arrearsSetIds, arrearsDeleteIds);
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

// Wie canManageMembers() im Client: Kassenwart und Präsident dürfen Mitglieder verwalten
// (löschen/archivieren), bewusst weiter gefasst als requireFinanceRole() (nur Kassenwart).
// Prüft die Rolle für GENAU DIESEN clubId (Custom Claim 'roles', siehe callerRoleForClub) und
// zusätzlich die Club-Zugehörigkeit (requireCallerBelongsToClub).
function requireManageMembersRole(request, clubId) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Bitte zuerst anmelden.');
  }
  requireCallerBelongsToClub(request, clubId);
  const isCallerAdmin = request.auth.token.email === 'admin@die-pudolfs.internal';
  const callerRole = callerRoleForClub(request, clubId);
  if (!isCallerAdmin && callerRole !== 'Kassenwart' && callerRole !== 'Präsident') {
    throw new HttpsError('permission-denied', 'Nur Kassenwart, Präsident oder Admin dürfen diese Aktion ausführen.');
  }
}

// Prüft, ob eine memberId noch irgendwo referenziert wird, wo sie beim Löschen verwaisen würde:
// - Sitzplan eines Kegelabends (evenings/{id}.seating[].memberId) - dafür müssen ALLE
//   Kegelabend-Hauptdokumente des Clubs gescannt werden, da es dafür keinen Index gibt.
// - Offener Rückstand (arrears/{memberId}.amount > 0)
// - Kalender-Zusage/Absage (calendar-rsvps/*.memberId)
// - Offene Rundenpflicht im zentralen Pool (data/open-rounds-pool)
// Gibt { deletable: boolean, reasons: string[] } zurück.
async function findMemberReferences(clubRef, memberId) {
  const reasons = [];

  const eveningsSnap = await clubRef.collection('evenings').get();
  let inEvening = false;
  eveningsSnap.forEach(snap => {
    if (inEvening) return;
    let detail;
    try { detail = JSON.parse(snap.data().value); } catch (e) { return; }
    if (Array.isArray(detail.seating) && detail.seating.some(s => s.memberId === memberId)) {
      inEvening = true;
    }
  });
  if (inEvening) reasons.push('evening');

  const arrearsSnap = await clubRef.collection('arrears').doc(memberId).get();
  if (arrearsSnap.exists) {
    try {
      const entry = JSON.parse(arrearsSnap.data().value);
      if (entry && Math.round((entry.amount || 0) * 100) !== 0) reasons.push('arrears');
    } catch (e) { /* defektes Dokument ignorieren */ }
  }

  const rsvpsSnap = await clubRef.collection('rsvps').get();
  const hasRsvp = rsvpsSnap.docs.some(snap => {
    try { return JSON.parse(snap.data().value).memberId === memberId; } catch (e) { return false; }
  });
  if (hasRsvp) reasons.push('calendar');

  const poolSnap = await clubRef.collection('data').doc('open-rounds-pool').get();
  if (poolSnap.exists) {
    try {
      const pool = JSON.parse(poolSnap.data().value || '[]');
      if (pool.some(entry => entry.memberId === memberId)) reasons.push('rounds');
    } catch (e) { /* defektes Dokument ignorieren */ }
  }

  return { deletable: reasons.length === 0, reasons };
}

// Reiner Lese-Check für das Löschen-Popup im Client: liefert nur das Ergebnis, ohne etwas zu
// verändern - deleteOrArchiveMember() führt denselben Check danach nochmal serverseitig aus,
// direkt vor der eigentlichen Aktion (falls sich der Stand zwischen Popup-Öffnen und Bestätigen
// geändert hat, z.B. paralleler Kegelabend-Abschluss auf einem anderen Gerät).
exports.checkMemberDeletable = onCall({}, async (request) => {
  const { clubId, memberId } = request.data || {};
  if (!clubId || typeof clubId !== 'string') {
    throw new HttpsError('invalid-argument', 'Club-ID fehlt.');
  }
  if (!memberId || typeof memberId !== 'string') {
    throw new HttpsError('invalid-argument', 'Mitglieds-ID fehlt.');
  }

  requireManageMembersRole(request, clubId);

  const clubRef = db.collection('clubs').doc(clubId);
  const { deletable, reasons } = await findMemberReferences(clubRef, memberId);
  return { deletable, reasons };
});

// Löscht ein Mitglied nur, wenn es nirgends mehr referenziert wird (siehe
// findMemberReferences) - sonst wird es stattdessen archiviert (member.archived = true), damit
// Kegelabend-Historie, Rückstände, Kalender-Einträge und offene Rundenpflichten nicht verwaisen.
// Archivierte Mitglieder bleiben im Index, tauchen aber clientseitig (activeMembers()) nicht
// mehr in Auswahllisten auf.
// Entfernt die Auth-Berechtigung eines Mitglieds für GENAU EINEN Club: entfernt die clubId aus
// dessen 'clubIds'-Custom-Claim-Array. Ist der Nutzer danach in KEINEM Club mehr Mitglied, wird
// der komplette Auth-Account gelöscht (kein "Karteileichen"-Account ohne jede Zugehörigkeit).
// Gemeinsam genutzt von unlinkMemberAccount (manuelles Entfernen der Verknüpfung) und
// deleteOrArchiveMember (Login soll nach Archivieren/Löschen in diesem Club nicht mehr möglich
// sein). Idempotent: fehlt der Auth-Account bereits, ist das für uns trotzdem ein Erfolg.
async function removeMemberClubAuthAccess(email, clubId) {
  if (!email) return;
  const adminAuth = getAuth();
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
      logger.error(`Fehler beim Entfernen der Club-Zugehörigkeit für ${email}:`, e);
      throw new HttpsError('internal', 'Account-Zugriff konnte nicht entfernt werden.');
    }
    // Account existierte bereits nicht mehr - für uns trotzdem ein Erfolg (idempotent).
  }
}

exports.deleteOrArchiveMember = onCall({}, async (request) => {
  const { clubId, memberId } = request.data || {};
  if (!clubId || typeof clubId !== 'string') {
    throw new HttpsError('invalid-argument', 'Club-ID fehlt.');
  }
  if (!memberId || typeof memberId !== 'string') {
    throw new HttpsError('invalid-argument', 'Mitglieds-ID fehlt.');
  }

  requireManageMembersRole(request, clubId);
  await requireClubAccessNotBlocked(clubId);

  const clubRef = db.collection('clubs').doc(clubId);
  const memberRef = clubRef.collection('members').doc(memberId);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists) {
    throw new HttpsError('not-found', 'Mitglied wurde nicht gefunden.');
  }
  let member;
  try { member = JSON.parse(memberSnap.data().value); } catch (e) {
    throw new HttpsError('internal', 'Mitglieds-Dokument konnte nicht gelesen werden.');
  }

  const { deletable, reasons } = await findMemberReferences(clubRef, memberId);

  // Login-Zugriff für DIESEN Club entfernen - sowohl beim Archivieren als auch beim endgültigen
  // Löschen, in beiden Fällen darf sich die Person hier nicht mehr einloggen können. War sie in
  // weiteren Clubs Mitglied, bleibt der Auth-Account für diese bestehen (siehe
  // removeMemberClubAuthAccess), nur diese eine Club-Zugehörigkeit fällt weg.
  if (member.email) {
    await removeMemberClubAuthAccess(member.email, clubId);
  }

  if (!deletable) {
    member.archived = true;
    if (member.email) { member.hasAccount = false; member.lastLogin = null; }
    await memberRef.set({ value: JSON.stringify(member) });
    return { success: true, archived: true, reasons };
  }

  await db.runTransaction(async (tx) => {
    const indexRef = clubRef.collection('members').doc('_index');
    const indexSnap = await tx.get(indexRef);
    const index = indexSnap.exists ? JSON.parse(indexSnap.data().value) : [];
    tx.delete(memberRef);
    tx.set(indexRef, { value: JSON.stringify(index.filter(id => id !== memberId)) });
  });

  return { success: true, archived: false };
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
  const { email, name, clubId } = request.data || {};
  if (!email || typeof email !== 'string') {
    throw new HttpsError('invalid-argument', 'E-Mail-Adresse fehlt.');
  }
  if (!clubId || typeof clubId !== 'string') {
    throw new HttpsError('invalid-argument', 'Club-ID fehlt.');
  }
  // requireManageMembersRole prüft bereits Rolle UND Club-Zugehörigkeit (requireCallerBelongsToClub).
  requireManageMembersRole(request, clubId);
  await requireClubAccessNotBlocked(clubId);

  const adminAuth = getAuth();
  let userRecord;
  let accountAlreadyExisted = true;
  try {
    userRecord = await adminAuth.getUserByEmail(email);
  } catch (e) {
    // Nutzer existiert noch nicht -> Account anlegen (ohne Passwort, das setzt das Mitglied selbst).
    accountAlreadyExisted = false;
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

  const clubSnapForInvite = await db.collection('clubs').doc(clubId).get();
  const clubName = (clubSnapForInvite.exists && clubSnapForInvite.data().name) || 'Dein Kegelclub';

  // Custom Claim 'clubIds' (Array) ordnet den Auth-Account einem oder mehreren Clubs zu - nach
  // dem Login liest der Client daraus, welche(n) Club(s) dieser Nutzer sehen darf (bei genau
  // einem Eintrag direkt, bei mehreren über eine Auswahl). WICHTIG: den bestehenden Claim lesen
  // und die neue clubId nur ERGÄNZEN, nie überschreiben - sonst würde ein zweiter Invite (z.B. in
  // einem anderen Club) die Zugehörigkeit zu allen bisherigen Clubs löschen. clubId kommt vom
  // Client (dessen aktuell aktiver Club, CURRENT_CLUB_ID) statt einer fest verdrahteten Konstante,
  // damit das Einladen auch für künftige, weitere Clubs funktioniert.
  // 'roles' ist ein Objekt { [clubId]: 'Kassenwart' } - nur der Eintrag für DIESEN clubId wird
  // aktualisiert, alle anderen Clubs im Objekt bleiben unverändert (anders als früher mit einem
  // einzigen globalen role-String, der fälschlich für alle Clubs des Nutzers gegolten hätte).
  const existingClaims = userRecord.customClaims || {};
  const existingClubIds = Array.isArray(existingClaims.clubIds) ? existingClaims.clubIds : [];
  const nextClubIds = existingClubIds.includes(clubId) ? existingClubIds : [...existingClubIds, clubId];
  const existingRoles = (existingClaims.roles && typeof existingClaims.roles === 'object') ? existingClaims.roles : {};
  if (!existingClubIds.includes(clubId) || existingRoles[clubId] !== currentRole) {
    await adminAuth.setCustomUserClaims(userRecord.uid, {
      ...existingClaims,
      clubIds: nextClubIds,
      roles: { ...existingRoles, [clubId]: currentRole },
    });
  }

  const resend = new Resend(resendApiKey.value());
  let html;
  let subject;
  if (accountAlreadyExisted) {
    html = buildAddedToClubEmailHtml(name, clubName);
    subject = `Du wurdest zu ${clubName} hinzugefügt`;
  } else {
    const resetLink = await adminAuth.generatePasswordResetLink(email, {
      url: HOSTING_URL,
      handleCodeInApp: false,
    });
    html = `
    <div style="font-family:sans-serif; color:#161616; max-width:480px;">
      <p>Hallo ${escapeHtml(name || '')},</p>
      <p>du wurdest eingeladen, dich in der Kegelbuch-App von ${escapeHtml(clubName)} anzumelden.</p>
      <p>
        <a href="${resetLink}" style="display:inline-block; background:#E3421F; color:#fff; font-weight:800; text-decoration:none; padding:12px 22px; border-radius:8px;">
          Passwort festlegen
        </a>
      </p>
      <p>Danach kannst du dich mit deiner E-Mail-Adresse und deinem neuen Passwort in der App anmelden.</p>
      <p>Kegelgruß,<br>${escapeHtml(clubName)}</p>
    </div>
  `;
    subject = `Einladung: ${clubName} Kegelbuch`;
  }

  try {
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: email,
      subject,
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

// Für Accounts, die bereits existieren (z.B. schon Mitglied in einem anderen Club) - kein
// Passwort-Link, da bereits ein Passwort gesetzt ist. Reine Info-Mail.
function buildAddedToClubEmailHtml(name, clubName) {
  return `
    <div style="font-family:sans-serif; color:#161616; max-width:480px;">
      <p>Hallo ${escapeHtml(name || '')},</p>
      <p>du wurdest dem Kegelclub "${escapeHtml(clubName)}" hinzugefügt.</p>
      <p>Du kannst dich mit deiner bestehenden E-Mail-Adresse und deinem bisherigen Passwort in der App anmelden und den Club dort auswählen.</p>
      <p>Kegelgruß,<br>${escapeHtml(clubName)}</p>
    </div>
  `;
}

function buildClubInviteEmailHtml(name, clubName) {
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
      <p>Kegelgruß,<br>${escapeHtml(clubName)}</p>
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
  // Neuer Club startet automatisch mit 3 Monaten kostenlosem Testzeitraum (reine Anzeige/Tracking
  // in der Clubverwaltung, siehe formatSubscriptionLabel() im Frontend - kein Sperrmechanismus).
  const freeUntilDate = new Date();
  freeUntilDate.setMonth(freeUntilDate.getMonth() + 3);
  clubData.subscription = {
    plan: 'free',
    freeUntil: freeUntilDate.toISOString().slice(0, 10),
    accessBlocked: false,
  };
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
  let accountAlreadyExisted = true;
  try {
    userRecord = await adminAuth.getUserByEmail(member.email);
  } catch (e) {
    accountAlreadyExisted = false;
    userRecord = await adminAuth.createUser({ email: member.email, emailVerified: false });
  }
  const existingClaims = userRecord.customClaims || {};
  const existingClubIds = Array.isArray(existingClaims.clubIds) ? existingClaims.clubIds : [];
  const existingRoles = (existingClaims.roles && typeof existingClaims.roles === 'object') ? existingClaims.roles : {};
  if (!existingClubIds.includes(clubId) || existingRoles[clubId] !== member.role) {
    await adminAuth.setCustomUserClaims(userRecord.uid, {
      ...existingClaims,
      clubIds: existingClubIds.includes(clubId) ? existingClubIds : [...existingClubIds, clubId],
      roles: { ...existingRoles, [clubId]: member.role },
    });
  }

  let html;
  if (accountAlreadyExisted) {
    html = buildAddedToClubEmailHtml(member.firstName, clubData.name);
  } else {
    const resetLink = await adminAuth.generatePasswordResetLink(member.email, {
      url: HOSTING_URL,
      handleCodeInApp: false,
    });
    html = buildClubInviteEmailHtml(member.firstName, clubData.name).replace('RESET_LINK_PLACEHOLDER', resetLink);
  }

  const resend = new Resend(resendApiKey.value());
  try {
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: member.email,
      subject: accountAlreadyExisted
        ? `Du wurdest zu ${clubData.name} hinzugefügt`
        : `Dein neuer Kegelclub "${clubData.name}" wurde angelegt`,
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
  const { clubId } = request.data || {};
  if (!clubId || typeof clubId !== 'string') {
    throw new HttpsError('invalid-argument', 'Club-ID fehlt.');
  }
  // Nur Admin, Kassenwart oder Präsident DIESES Clubs dürfen ihn löschen - dieselbe Berechtigung
  // wie die Mitglieder-/Clubverwaltung (siehe canManageMembers() in firestore.rules). onCall-
  // Functions laufen mit Admin-SDK-Rechten und umgehen die Firestore Rules komplett, deshalb muss
  // diese Prüfung hier eigenständig erfolgen. requireManageMembersRole prüft sowohl die Rolle für
  // GENAU DIESEN clubId (Custom Claim 'roles') als auch die Club-Zugehörigkeit - vorher fehlte
  // dieser Zugehörigkeits-Check komplett, ein Kassenwart aus Club A hätte mit seiner (damals
  // globalen) Rolle auch Club B löschen können.
  requireManageMembersRole(request, clubId);

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
  const { email, clubId } = request.data || {};
  if (!email || typeof email !== 'string') {
    throw new HttpsError('invalid-argument', 'E-Mail-Adresse fehlt.');
  }
  if (!clubId || typeof clubId !== 'string') {
    throw new HttpsError('invalid-argument', 'Club-ID fehlt.');
  }
  // War bisher nur auf "eingeloggt" beschränkt - jeder eingeloggte Nutzer hätte damit die
  // Club-Zugehörigkeit eines fremden Mitglieds entfernen können. requireManageMembersRole prüft
  // sowohl die Rolle für DIESEN clubId als auch die Club-Zugehörigkeit des Aufrufers.
  requireManageMembersRole(request, clubId);
  await requireClubAccessNotBlocked(clubId);

  await removeMemberClubAuthAccess(email, clubId);

  return { success: true };
});

// -------- Rollen-Rechte: Custom Claim 'roles' synchron zum Mitgliedsdokument halten --------
// Die Firestore Rules können die Rolle eines eingeloggten Nutzers nicht direkt aus dem
// Mitgliedsdokument lesen (das würde für JEDE Regel-Auswertung einen extra Read kosten) -
// stattdessen wird die Rolle als Custom Claim im Auth-Token gespiegelt, genau wie 'clubIds'.
// WICHTIG: 'roles' ist ein Objekt { [clubId]: 'Kassenwart' }, EIN Eintrag pro Club - nicht mehr
// ein einziger globaler String wie früher ('role'). Ist ein Nutzer Mitglied in mehreren Clubs
// (z.B. Kassenwart in Club A, einfaches Mitglied in Club B), betrifft ein Update nur den Eintrag
// für das clubId, in dem der Trigger gefeuert hat - alle anderen Clubs im roles-Objekt bleiben
// unverändert. Vorher hätte ein Kassenwart-Update in Club A den globalen role-Claim gesetzt und
// damit fälschlich auch Kassenwart-Rechte in Club B vorgetäuscht.
// Dieser Trigger feuert bei jedem Schreiben auf ein Mitgliedsdokument (angelegt, geändert,
// gelöscht) und gleicht den Claim des zugehörigen Auth-Accounts (per E-Mail verknüpft) ab.
// Wichtig: Ein gecachtes ID-Token auf dem Client kann bis zu 1h alt sein, d.h. eine gerade erst
// heruntergestufte Rolle greift serverseitig etwas verzögert - für Rollenwechsel in einem
// Kegelclub unkritisch. inviteMember und createClub setzen den Claim zusätzlich sofort beim
// Erstanlegen, damit ein frisch eingeladenes Mitglied nicht auf diesen Trigger warten muss.
exports.syncMemberRoleClaim = onDocumentWritten('clubs/{clubId}/members/{memberId}', async (event) => {
  const { clubId, memberId } = event.params;
  if (memberId === MEMBERS_INDEX_ID) return; // Index-Dokument, kein echtes Mitglied

  const beforeData = event.data.before.exists ? JSON.parse(event.data.before.data().value) : null;
  const afterData = event.data.after.exists ? JSON.parse(event.data.after.data().value) : null;

  const adminAuth = getAuth();

  // Mitglied gelöscht oder E-Mail entfernt: alten Auth-Account (falls vorhanden) für DIESEN Club
  // auf die Standardrolle 'Mitglied' zurücksetzen, statt ihm eine veraltete Rolle zu lassen.
  // Andere Clubs im roles-Objekt bleiben unangetastet.
  const oldEmail = beforeData && beforeData.email;
  const newEmail = afterData && afterData.email;
  const newRole = (afterData && afterData.role) || 'Mitglied';

  if (oldEmail && oldEmail !== newEmail) {
    try {
      const oldUser = await adminAuth.getUserByEmail(oldEmail);
      const existingClaims = oldUser.customClaims || {};
      const existingRoles = (existingClaims.roles && typeof existingClaims.roles === 'object') ? existingClaims.roles : {};
      if (existingRoles[clubId] !== 'Mitglied') {
        await adminAuth.setCustomUserClaims(oldUser.uid, {
          ...existingClaims,
          roles: { ...existingRoles, [clubId]: 'Mitglied' },
        });
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
    const existingRoles = (existingClaims.roles && typeof existingClaims.roles === 'object') ? existingClaims.roles : {};
    if (existingRoles[clubId] !== newRole) {
      await adminAuth.setCustomUserClaims(userRecord.uid, {
        ...existingClaims,
        roles: { ...existingRoles, [clubId]: newRole },
      });
    }
  } catch (e) {
    if (e.code !== 'auth/user-not-found') {
      logger.error(`Rollen-Claim-Sync für ${newEmail} fehlgeschlagen:`, e);
    }
    // Noch kein Auth-Account (Mitglied wurde noch nicht eingeladen) - beim Einladen setzt
    // inviteMember den Claim direkt, hier gibt es nichts zu tun.
  }
});

// -------- Überweisung per QR-Code (EPC069-12 / "GiroCode") --------
//
// Erzeugt den standardisierten Text-Payload für SEPA-Überweisungen per QR-Code. Das Format wird
// von praktisch allen deutschen Banking-Apps über deren integrierten QR-Scanner gelesen (Feld
// "Überweisung" -> Scanner-Symbol) und übernimmt IBAN, Empfänger, Betrag und Verwendungszweck
// automatisch - eine Bestätigung durch den Zahler bleibt aber immer nötig, es gibt (bewusst,
// aus Sicherheitsgründen) keinen Link, der eine Überweisung ohne Interaktion in der Banking-App
// auslöst. Referenz: https://en.wikipedia.org/wiki/EPC_QR_code
function buildEpcQrPayload(accountHolder, iban, amount, remittanceText) {
  const lines = [
    'BCD',              // Service Tag
    '002',              // Versionsnummer
    '1',                // Zeichensatz (1 = UTF-8)
    'SCT',              // Identifikation (SEPA Credit Transfer)
    '',                 // BIC (optional, seit 2016 im EWR nicht mehr erforderlich)
    accountHolder.slice(0, 70),
    iban,
    `EUR${amount.toFixed(2)}`,
    '',                 // Verwendungszweck-Kennung (leer)
    '',                 // Referenznummer (leer, stattdessen unstrukturierter Verwendungszweck)
    remittanceText.slice(0, 140),
  ];
  return lines.join('\n');
}

// Formatiert eine IBAN für die Anzeige in 4er-Blöcken (rein kosmetisch, kein Einfluss auf den
// QR-Payload, der die IBAN ohne Leerzeichen erwartet).
function formatIbanForDisplay(iban) {
  return iban.replace(/(.{4})/g, '$1 ').trim();
}

// Rendert den EPC-Payload als quadratisches Inline-SVG (kein externer QR-Dienst, keine
// Bilddaten verlassen diese Function).
async function buildEpcQrSvg(payload) {
  return QRCode.toString(payload, { type: 'svg', margin: 1, width: 220 });
}

function buildShareGuestBillHtml(name, dateStr, catalogLines, fremdstrafeLines, adHocLines, exactTotal, roundedTotal, paypalLink, transferInfo, clubName, clubLogoUrl) {
  const hasAnyLines = catalogLines.length + fremdstrafeLines.length + adHocLines.length > 0;
  const emptyHtml = hasAnyLines ? '' : '<p>Keine Strafen für diesen Abend.</p>';

  const paypalHtml = paypalLink ? `<a class="paypal-btn" href="${paypalLink}">Jetzt ${fmtEuro(roundedTotal)} per PayPal bezahlen</a>` : '';

  const transferHtml = transferInfo ? `
    <div class="transfer-block">
      <div class="qr-wrap">${transferInfo.svg}</div>
      <table class="transfer-details">
        <tr><td>Empfänger</td><td>${escapeHtml(transferInfo.accountHolder)}</td></tr>
        <tr><td>IBAN</td><td>${escapeHtml(transferInfo.ibanDisplay)}</td></tr>
        <tr><td>Betrag</td><td>${fmtEuro(roundedTotal)}</td></tr>
        <tr><td>Verwendungszweck</td><td>${escapeHtml(transferInfo.remittanceText)}</td></tr>
      </table>
      <p class="hint">QR-Code mit der Banking-App scannen (meist über den Menüpunkt „Überweisung" &rarr; Kamera-/Scan-Symbol) - Empfänger, IBAN, Betrag und Verwendungszweck werden automatisch übernommen, die Überweisung selbst muss noch bestätigt werden.</p>
    </div>
  ` : '';

  // "oder"-Trenner nur zwischen zwei tatsächlich vorhandenen Optionen - ist nur eine oder keine
  // konfiguriert, entfällt er.
  const dividerHtml = (paypalLink && transferInfo) ? '<div class="divider"><span>oder</span></div>' : '';

  // Payment-Card komplett weglassen, wenn weder PayPal.Me-Name noch IBAN/Kontoinhaber gepflegt sind -
  // sonst stünde nur eine leere "Bezahlen mit"-Überschrift auf der Seite.
  const paymentSectionHtml = (paypalLink || transferInfo) ? `
    <div class="card payment-card">
      <h3>Bezahlen mit</h3>
      ${paypalHtml}
      ${dividerHtml}
      ${transferHtml}
    </div>
  ` : '';

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
  .paypal-btn{display:block; text-align:center; background:#161616; color:#fff; font-weight:800; text-decoration:none; padding:14px 22px; border-radius:10px;}
  .totals-summary{text-align:right; margin-top:8px;}
  .totals-summary .exact{font-size:13px; color:#9A9186;}
  .totals-summary .rounded{font-size:16px; font-weight:800; margin-top:2px;}
  .payment-card{margin-top:8px;}
  .payment-card h3{text-align:center;}
  .divider{display:flex; align-items:center; text-align:center; margin:18px 0; color:#9A9186; font-size:12px; text-transform:uppercase; letter-spacing:0.06em;}
  .divider::before, .divider::after{content:''; flex:1; border-bottom:1px solid #e5e1d8;}
  .divider span{padding:0 10px;}
  .qr-wrap{text-align:center; padding:6px 0 14px;}
  .qr-wrap svg{width:180px; height:180px;}
  .transfer-details td:first-child{color:#9A9186; padding-right:10px; white-space:nowrap;}
  .transfer-details td:last-child{text-align:right; word-break:break-word;}
  .hint{font-size:12px; color:#9A9186; margin:12px 0 0;}
  .header-club-name{color:#fff; font-family:inherit; font-size:20px; font-weight:800; margin:0;}
</style>
</head>
<body>
  <div class="header">${clubLogoUrl
    ? `<img src="${escapeHtml(clubLogoUrl)}" alt="${escapeHtml(clubName)}">`
    : `<p class="header-club-name">${escapeHtml(clubName)}</p>`}</div>
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
    ${paymentSectionHtml}
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
  // Globaler Mapping-Eintrag (siehe Review-Issue #52): der Gast-Link enthält bewusst KEINEN
  // Club-Bezug (nur den Token), damit er auch nach der Multi-Club-Umstellung unverändert
  // funktioniert. Statt über alle Clubs × alle Evenings zu iterieren, wird der Token jetzt direkt
  // per Dokument-ID in shareTokens/{token} aufgelöst (siehe Erzeugung in index.html,
  // header-share-guest-btn-Listener). Bereits vor dieser Umstellung erzeugte Links ohne
  // Mapping-Eintrag funktionieren nicht mehr (bewusst kein Fallback/Migration).
  const tokenDoc = await db.collection('shareTokens').doc(token).get();
  if (!tokenDoc.exists) {
    res.status(404).set('Content-Type', 'text/html; charset=utf-8').send(buildShareNotFoundHtml());
    return;
  }
  const { clubId: foundClubId, eveningId, seatId } = tokenDoc.data();
  const clubDoc = await db.collection('clubs').doc(foundClubId).get();
  const eveningDoc = await db.collection('clubs').doc(foundClubId).collection('evenings').doc(eveningId).get();
  let foundDetail = null, foundSeat = null;
  if (eveningDoc.exists) {
    try { foundDetail = JSON.parse(eveningDoc.data().value || '{}'); } catch (e) { foundDetail = null; }
    if (foundDetail) foundSeat = (foundDetail.seating || []).find(s => s.seatId === seatId) || null;
  }
  const foundClubData = clubDoc.exists ? clubDoc.data() : null;

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
  const paypalLink = buildPaypalLink(foundClubData && foundClubData.paypalName, roundedTotal);

  // Überweisungs-Info nur aufbauen, wenn Club sowohl IBAN als auch Kontoinhaber gepflegt hat.
  let transferInfo = null;
  if (foundClubData && foundClubData.iban && foundClubData.accountHolder) {
    const remittanceText = `Kegelabend ${dateStr} – ${foundSeat.name}`;
    const payload = buildEpcQrPayload(foundClubData.accountHolder, foundClubData.iban, roundedTotal, remittanceText);
    const svg = await buildEpcQrSvg(payload);
    transferInfo = {
      svg,
      accountHolder: foundClubData.accountHolder,
      ibanDisplay: formatIbanForDisplay(foundClubData.iban),
      remittanceText,
    };
  }

  const clubName = (foundClubData && foundClubData.name) || 'Dein Kegelclub';
  const clubLogoUrl = foundClubData && foundClubData.logoUrl;
  const html = buildShareGuestBillHtml(foundSeat.name, dateStr, catalogLines, fremdstrafeLines, adHocLines, total, roundedTotal, paypalLink, transferInfo, clubName, clubLogoUrl);
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

// -------- Abo-Zugriffsstatus täglich aktualisieren --------
//
// subscription.accessBlocked ist das Feld, gegen das die Firestore Rules bei JEDEM Schreibzugriff
// prüfen (siehe firestore.rules, clubAccessBlocked()) - Rules können kein "heutiges Datum" selbst
// berechnen, deshalb wird der Status hier einmal täglich serverseitig vorberechnet und im
// Club-Dokument abgelegt, statt bei jedem Request neu zu vergleichen.
//
// Blockiert wird NUR bei plan 'free' mit abgelaufenem freeUntil. Ein 'pro'-Plan blockiert nie
// (Zahlungsausfälle/Downgrades sind noch nicht implementiert, siehe Stripe-Planung). Fehlt
// subscription komplett (z.B. bei sehr alten Clubs vor Einführung dieses Felds), wird ebenfalls
// NICHT blockiert - sicherheitshalber kein rückwirkendes Aussperren durch reine Datenlücken.
// Berechnet, ob ein Club aktuell blockiert sein sollte. Siehe computeAccessBlocked() oben für
// die Blockier-Logik selbst (nur plan 'free' + abgelaufenes freeUntil).
//
// subscription.plan: 'free' | 'pro'
// subscription.priceEUR: Preis/Monat, nur relevant wenn plan !== 'free'
// subscription.freeUntil: ISO-Datum (YYYY-MM-DD), Ende des Free-Zeitraums
// subscription.accessBlocked: von dieser Function vorberechnet
async function computeAccessBlocked(subscription, todayStr) {
  if (!subscription || subscription.plan !== 'free') return false;
  if (!subscription.freeUntil) return false;
  return subscription.freeUntil < todayStr;
}

exports.updateSubscriptionAccessStatus = onSchedule(
  { schedule: '30 0 * * *', timeZone: 'Europe/Berlin' },
  async () => {
    const todayStr = getTodayInBerlin();
    const clubsSnapshot = await db.collection('clubs').get();
    for (const clubDoc of clubsSnapshot.docs) {
      try {
        const subscription = clubDoc.data().subscription;
        const shouldBlock = await computeAccessBlocked(subscription, todayStr);
        const currentlyBlocked = !!(subscription && subscription.accessBlocked);
        // Bugfix: Clubs OHNE subscription-Feld (z.B. angelegt vor Einführung dieses Features)
        // wurden hier vorher NIE aktualisiert, weil shouldBlock (false) === currentlyBlocked
        // (auch false, da subscription undefined ist) - das Feld 'accessBlocked' fehlte dadurch
        // dauerhaft im Dokument. firestore.rules/clubAccessBlocked() wertet ein fehlendes Feld
        // als Fehler, was ALLE Schreibvorgänge in diesen Clubs mit "permission-denied" blockiert
        // hätte (siehe Bugreport: Kassenwart konnte keine Mitglieder mehr bearbeiten). Deshalb
        // jetzt zusätzliche Bedingung: auch schreiben, wenn subscription komplett fehlt.
        const needsInit = !subscription;
        if (shouldBlock !== currentlyBlocked || needsInit) {
          const base = subscription || { plan: 'free' };
          await clubDoc.ref.set({ subscription: { ...base, accessBlocked: shouldBlock } }, { merge: true });
          logger.info(`Club ${clubDoc.id}: subscription.accessBlocked auf ${shouldBlock} gesetzt${needsInit ? ' (subscription-Feld initialisiert)' : ''}.`);
        }
      } catch (e) {
        logger.error(`Fehler bei updateSubscriptionAccessStatus für Club ${clubDoc.id}:`, e);
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

  // Globaler Mapping-Eintrag (siehe Review-Issue #52): der Feed-Link enthält bewusst KEINEN
  // Club-Bezug (nur den Token), damit er auch nach der Multi-Club-Umstellung unverändert
  // funktioniert. Statt über alle Clubs zu iterieren, wird der Token jetzt direkt per
  // Dokument-ID in calendarFeedTokens/{token} aufgelöst (siehe Erzeugung in index.html,
  // getOrCreateCalendarFeedToken()). Bereits vor dieser Umstellung erzeugte Abos ohne
  // Mapping-Eintrag funktionieren nicht mehr (bewusst kein Fallback/Migration).
  const tokenDoc = await db.collection('calendarFeedTokens').doc(token).get();
  if (!tokenDoc.exists) {
    res.status(403).send('Ungültiger Link.');
    return;
  }
  const matchedClubRef = db.collection('clubs').doc(tokenDoc.data().clubId);

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
