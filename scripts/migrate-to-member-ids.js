/**
 * Einmaliges Migrationsscript: Umbau von namensbasierter auf memberId-basierte
 * Referenzierung (siehe Analyse "Name vs. ID" - resolveArrearsDocId, attendanceByMember,
 * calendarRsvps.memberName, canEditEvening, seating[].name).
 *
 * WICHTIG: Läuft NUR EINMAL pro Club, danach kennt der App-Code (index.html +
 * functions/index.js) keine namensbasierte Auflösung mehr - siehe Commit
 * "Umbau auf memberId-Referenzierung". Ohne diese Migration fehlt bestehenden
 * Abenden/Rückständen/RSVPs/Statistiken die memberId, und sie werden vom neuen
 * Code nicht mehr gefunden (bewusst keine Rückwärtskompatibilität, siehe Absprache).
 *
 * Was wird migriert (pro Club):
 *   1. clubs/{clubId}/evenings/{id}          - seating[].memberId ergänzen
 *      (Gäste bekommen eine neue, stabile UUID statt künftig namensbasiert zu sein)
 *      + absentMembersFines[].memberId, priorArrearsSnapshot (Name-Keys -> memberId-Keys)
 *   2. clubs/{clubId}/data/open-rounds-pool  - Pool-Einträge (value-JSON, Array) -> memberId
 *   3. clubs/{clubId}/arrears/*              - Dokument-ID + memberId-Feld, alte
 *      namensbasierte/guest-<name>-Dokumente werden durch neue guest-<uuid>- bzw.
 *      memberId-Dokumente ersetzt; _index wird neu geschrieben
 *   4. clubs/{clubId}/rsvps/*                - memberName-Feld -> memberId
 *   5. clubs/{clubId}/data/attendance-stats  - attendanceByMember Name-Keys -> memberId-Keys
 *   6. clubs/{clubId}/calendarEvents (falls als eigene Collection geführt) bzw. Feld
 *      createdBy in calendarEvents -> createdById ergänzt
 *
 * Nicht auflösbare Namen (ehemalige, bereits gelöschte Mitglieder) werden ÜBERSPRUNGEN,
 * kein Log (siehe Absprache) - solche seating-Einträge behalten nur ihren Namen, ohne
 * memberId. Der App-Code zeigt sie weiterhin an (name bleibt Anzeige-Snapshot), sie
 * tauchen aber in memberId-basierten Auswertungen (Rückstände, Statistik) nicht mehr auf,
 * genau wie vor der Migration auch schon (kein passendes Mitglied mehr vorhanden).
 *
 * Aufruf:
 *   node scripts/migrate-to-member-ids.js <clubId> [--dry-run]
 *
 * Voraussetzung: GOOGLE_APPLICATION_CREDENTIALS zeigt auf einen Service-Account-Key
 * mit Firestore-Zugriff (gleiches Projekt wie die App), ODER Ausführung in einer
 * Umgebung mit Application Default Credentials (z.B. Cloud Shell).
 */

const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const crypto = require('crypto');

const clubId = process.argv[2];
const dryRun = process.argv.includes('--dry-run');

if (!clubId) {
  console.error('Bitte Club-ID angeben: node scripts/migrate-to-member-ids.js <clubId> [--dry-run]');
  process.exit(1);
}

initializeApp();
const db = getFirestore();

function displayName(m) {
  return (m.nickname && m.nickname.trim()) ? m.nickname.trim() : m.firstName;
}

function newGuestId() {
  return 'guest-' + crypto.randomUUID();
}

// Baut eine Name -> memberId Lookup-Tabelle aus den AKTUELL existierenden Mitgliedern.
// Mehrere Mitglieder mit demselben Namen: das erste gefundene gewinnt (deterministisch nach
// Dokument-Reihenfolge) - das ist exakt das bisherige, bereits bekannte Kollisionsverhalten;
// die Migration verbessert das für die Zukunft, kann es aber für die Vergangenheit nicht
// rückwirkend auflösen, da im Altbestand keine Information mehr existiert, WELCHES der beiden
// Mitglieder tatsächlich gemeint war.
async function loadMembersAndNameIndex() {
  const indexSnap = await db.doc(`clubs/${clubId}/members/_index`).get();
  const ids = indexSnap.exists ? JSON.parse(indexSnap.data().value || '[]') : [];
  const members = [];
  for (const id of ids) {
    const snap = await db.doc(`clubs/${clubId}/members/${id}`).get();
    if (snap.exists) members.push(JSON.parse(snap.data().value));
  }
  const byName = new Map();
  members.forEach(m => {
    const name = displayName(m);
    if (!byName.has(name)) byName.set(name, m.id);
  });
  return { members, byName };
}

async function migrateEvenings(byName) {
  console.log('\n--- Kegelabende (evenings) ---');
  const eveningsIndexSnap = await db.doc(`clubs/${clubId}/data/evenings-index`).get();
  const eveningsIndex = eveningsIndexSnap.exists ? JSON.parse(eveningsIndexSnap.data().value || '[]') : [];
  let touched = 0, skippedNames = 0;

  for (const entry of eveningsIndex) {
    const ref = db.doc(`clubs/${clubId}/evenings/${entry.id}`);
    const snap = await ref.get();
    if (!snap.exists) continue;
    const detail = JSON.parse(snap.data().value);
    let changed = false;

    // seating[]: memberId ergänzen, falls noch nicht gesetzt.
    (detail.seating || []).forEach(seat => {
      if (!seat.name || seat.memberId) return;
      if (seat.isGuest) {
        seat.memberId = newGuestId();
      } else {
        const memberId = byName.get(seat.name);
        if (memberId) seat.memberId = memberId;
        else skippedNames++;
      }
      changed = true;
    });

    // absentMembersFines[]: memberId ergänzen.
    (detail.absentMembersFines || []).forEach(a => {
      if (a.memberId) return;
      const memberId = byName.get(a.name);
      if (memberId) { a.memberId = memberId; changed = true; }
      else skippedNames++;
    });

    // priorArrearsSnapshot: Name-Keys -> memberId-Keys (nur wenn noch im alten Format,
    // erkennbar daran, dass ein Key nicht auf ein bekanntes seating-memberId passt).
    if (detail.priorArrearsSnapshot) {
      const remapped = {};
      const seatByName = {};
      (detail.seating || []).forEach(s => { if (s.name && s.memberId) seatByName[s.name] = s.memberId; });
      Object.entries(detail.priorArrearsSnapshot).forEach(([key, val]) => {
        const mappedId = seatByName[key] || byName.get(key);
        remapped[mappedId || key] = val;
      });
      detail.priorArrearsSnapshot = remapped;
      changed = true;
    }

    if (changed) {
      touched++;
      console.log(`  Abend ${entry.date} (${entry.id}): ${dryRun ? '[dry-run] würde geschrieben' : 'geschrieben'}`);
      if (!dryRun) await ref.set({ value: JSON.stringify(detail) });
    }
  }
  console.log(`Kegelabende: ${touched} geändert, ${skippedNames} nicht auflösbare Namen übersprungen.`);
}

async function migrateOpenRoundsPool(byName) {
  console.log('\n--- Offene-Runden-Pool ---');
  const ref = db.doc(`clubs/${clubId}/data/open-rounds-pool`);
  const snap = await ref.get();
  if (!snap.exists) { console.log('Kein Pool vorhanden, nichts zu tun.'); return; }
  const pool = JSON.parse(snap.data().value || '[]');
  let changed = false, skipped = 0;
  pool.forEach(entry => {
    if (entry.memberId) return;
    const memberId = byName.get(entry.name);
    if (memberId) { entry.memberId = memberId; changed = true; }
    else skipped++;
  });
  console.log(`Pool: ${changed ? 'geändert' : 'unverändert'}, ${skipped} nicht auflösbare Namen übersprungen.`);
  if (changed && !dryRun) await ref.set({ value: JSON.stringify(pool) });
}

async function migrateArrears(byName) {
  console.log('\n--- Rückstände (arrears) ---');
  const indexRef = db.doc(`clubs/${clubId}/arrears/_index`);
  const indexSnap = await indexRef.get();
  const oldIndex = indexSnap.exists ? JSON.parse(indexSnap.data().value || '[]') : [];
  const newIndex = [];
  let migrated = 0, skipped = 0, unchanged = 0;

  for (const oldId of oldIndex) {
    const oldRef = db.doc(`clubs/${clubId}/arrears/${oldId}`);
    const snap = await oldRef.get();
    if (!snap.exists) continue;
    const entry = JSON.parse(snap.data().value);

    if (entry.memberId) {
      // Schon migriert (Dokument-ID ist bereits eine memberId/guest-uuid) - unverändert lassen.
      newIndex.push(oldId);
      unchanged++;
      continue;
    }

    // Alte Dokument-ID ist entweder bereits eine Mitglieds-ID (resolveArrearsDocId fand ein
    // Mitglied) oder 'guest-<transliterierter Name>'. Im ersten Fall stimmt die ID schon,
    // im zweiten Fall brauchen wir eine neue guest-<uuid>-ID.
    const member = byName.get(entry.name);
    let newId;
    if (member) {
      newId = member; // oldId war vermutlich bereits member (resolveArrearsDocId), aber sicher ist sicher
    } else if (oldId.startsWith('guest-')) {
      newId = newGuestId();
    } else {
      // Nicht auflösbar (ehemaliges Mitglied) - Dokument bleibt unter seiner alten ID liegen,
      // bekommt aber kein memberId-Feld. Wird von memberId-basierten Lookups künftig nicht
      // mehr gefunden - das ist beabsichtigt (kein Name-Fallback mehr).
      newIndex.push(oldId);
      skipped++;
      continue;
    }

    entry.memberId = newId;
    console.log(`  ${entry.name}: ${oldId} -> ${newId} ${dryRun ? '[dry-run]' : ''}`);
    if (!dryRun) {
      await db.doc(`clubs/${clubId}/arrears/${newId}`).set({ value: JSON.stringify({ ...entry, id: newId }) });
      if (newId !== oldId) await oldRef.delete();
    }
    newIndex.push(newId);
    migrated++;
  }

  console.log(`Rückstände: ${migrated} migriert, ${unchanged} bereits ok, ${skipped} nicht auflösbar (unverändert gelassen).`);
  if (!dryRun) await indexRef.set({ value: JSON.stringify(newIndex) });
}

async function migrateRsvps(byName) {
  console.log('\n--- RSVPs (calendarRsvps) ---');
  const indexRef = db.doc(`clubs/${clubId}/rsvps/_index`);
  const indexSnap = await indexRef.get();
  const ids = indexSnap.exists ? JSON.parse(indexSnap.data().value || '[]') : [];
  let migrated = 0, skipped = 0;

  for (const id of ids) {
    const ref = db.doc(`clubs/${clubId}/rsvps/${id}`);
    const snap = await ref.get();
    if (!snap.exists) continue;
    const entry = JSON.parse(snap.data().value);
    if (entry.memberId) continue;
    const memberId = byName.get(entry.memberName);
    if (!memberId) { skipped++; continue; }
    entry.memberId = memberId;
    delete entry.memberName;
    migrated++;
    if (!dryRun) await ref.set({ value: JSON.stringify(entry) });
  }
  console.log(`RSVPs: ${migrated} migriert, ${skipped} nicht auflösbare Namen übersprungen.`);
}

async function migrateAttendanceStats(byName) {
  console.log('\n--- Anwesenheitsstatistik (attendance-stats) ---');
  const ref = db.doc(`clubs/${clubId}/data/attendance-stats`);
  const snap = await ref.get();
  if (!snap.exists) { console.log('Keine Statistik vorhanden, nichts zu tun.'); return; }
  const stats = JSON.parse(snap.data().value || '{}');
  if (!stats.attendanceByMember) { console.log('Kein attendanceByMember, nichts zu tun.'); return; }

  const remapped = {};
  let migrated = 0, skipped = 0;
  Object.entries(stats.attendanceByMember).forEach(([name, byYear]) => {
    const memberId = byName.get(name);
    if (!memberId) { skipped++; return; } // ehemaliges Mitglied - Statistik geht hier verloren
    if (remapped[memberId]) {
      // Zwei Namen (z.B. alter + neuer Spitzname im Bestand) lösen auf dieselbe memberId auf -
      // Jahreswerte zusammenführen statt überschreiben.
      Object.entries(byYear).forEach(([year, count]) => {
        remapped[memberId][year] = (remapped[memberId][year] || 0) + count;
      });
    } else {
      remapped[memberId] = { ...byYear };
    }
    migrated++;
  });
  stats.attendanceByMember = remapped;
  console.log(`Statistik: ${migrated} Namen migriert, ${skipped} nicht auflösbar übersprungen.`);
  if (!dryRun) await ref.set({ value: JSON.stringify(stats) });
}

async function migrateCalendarEventCreators(byName) {
  console.log('\n--- Termin-Ersteller (calendarEvents.createdBy) ---');
  const indexRef = db.doc(`clubs/${clubId}/events/_index`);
  const indexSnap = await indexRef.get();
  const ids = indexSnap.exists ? JSON.parse(indexSnap.data().value || '[]') : [];
  let migrated = 0, skipped = 0;

  for (const id of ids) {
    const ref = db.doc(`clubs/${clubId}/events/${id}`);
    const snap = await ref.get();
    if (!snap.exists) continue;
    const ev = JSON.parse(snap.data().value);
    if (!ev.createdBy || ev.createdById) continue;
    const memberId = byName.get(ev.createdBy);
    if (!memberId) { skipped++; continue; }
    ev.createdById = memberId;
    migrated++;
    if (!dryRun) await ref.set({ value: JSON.stringify(ev) });
  }
  console.log(`Termine: ${migrated} migriert, ${skipped} nicht auflösbar übersprungen.`);
}

async function main() {
  console.log(`Migration für Club '${clubId}'${dryRun ? ' (DRY RUN - es wird nichts geschrieben)' : ''}`);
  const { members, byName } = await loadMembersAndNameIndex();
  console.log(`${members.length} Mitglieder geladen, ${byName.size} eindeutige Namen.`);

  await migrateEvenings(byName);
  await migrateOpenRoundsPool(byName);
  await migrateArrears(byName);
  await migrateRsvps(byName);
  await migrateAttendanceStats(byName);
  await migrateCalendarEventCreators(byName);

  console.log('\nMigration abgeschlossen.' + (dryRun ? ' (dry-run, nichts wurde geschrieben)' : ''));
}

main().catch(err => {
  console.error('Migration fehlgeschlagen:', err);
  process.exit(1);
});
