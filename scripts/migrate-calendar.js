/**
 * Einmalige Migration der Kalender-Daten zu clubs/<clubId>/...:
 *
 * 1. calendar-events (kegelbuch/calendar-events, ein JSON-Array als Blob)
 *    -> eigene Dokumente 'clubs/<clubId>/events/<id>' pro Termin + Index-Dokument
 *       'clubs/<clubId>/events/_index' mit der Liste aller IDs.
 * 2. calendar-rsvps (kegelbuch/calendar-rsvps, ein JSON-Array als Blob)
 *    -> eigene Dokumente 'clubs/<clubId>/rsvps/<id>' pro Rückmeldung + Index-Dokument
 *       'clubs/<clubId>/rsvps/_index'.
 * 3. calendar-occurrence-edits (kegelbuch/calendar-occurrence-edits, ein JSON-Array als Blob)
 *    -> eigene Dokumente 'clubs/<clubId>/occurrence-edits/<id>' pro Ausnahme + Index-Dokument
 *       'clubs/<clubId>/occurrence-edits/_index'.
 * 4. calendar-feed-token (kegelbuch/calendar-feed-token)
 *    -> EIN Blob-Dokument 'clubs/<clubId>/data/calendar-feed-token'.
 *
 * WARUM Events, RSVPs UND Occurrence-Edits als Einzeldokumente, aber der Feed-Token als Blob:
 * Bei Terminen, Rückmeldungen und Serien-Ausnahmen können mehrere Personen gleichzeitig auf
 * unterschiedlichen Geräten etwas ändern - z.B. jemand legt einen Termin an, während jemand
 * anders zu einem anderen Termin zusagt, oder zwei Personen passen gleichzeitig unterschiedliche
 * Einzeltermine EINER Serie an. Das komplette Array zurückzuschreiben hätte hier ein
 * Last-Write-Wins-Risiko wie beim ursprünglichen Mitglieder-Bug. Der Feed-Token ist dagegen ein
 * einzelner Wert, der praktisch nie parallel von mehreren Personen geschrieben wird - der
 * Aufwand einer Aufteilung lohnt sich dort nicht.
 *
 * WICHTIG: Dieses Script LÖSCHT keine der alten Dokumente unter 'kegelbuch/'. Sie bleiben als
 * Backup/Fallback in Firestore liegen. Der App-Code selbst nutzt sie ab dem zugehörigen Deploy
 * nicht mehr.
 *
 * Das Script ist idempotent: mehrfaches Ausführen richtet keinen Schaden an.
 *
 * VORAUSSETZUNGEN:
 * 1. Node.js installiert
 * 2. Einmal `firebase login` ausgeführt (falls ihr schon `firebase deploy` nutzt, ist das
 *    bereits passiert). Das Script liest das dabei gespeicherte Firebase-CLI-Login und holt sich
 *    darüber ein Zugriffs-Token - kein separates Google-Cloud-SDK/gcloud nötig.
 *
 * AUSFÜHRUNG:
 *   cd scripts
 *   node migrate-calendar.js            # Dry-Run: zeigt nur an, was passieren würde
 *   node migrate-calendar.js --apply    # führt die Migration wirklich aus
 */

const { getFirebaseCliAccessToken } = require('./firebase-cli-credentials');
const { FirestoreRestClient } = require('./firestore-rest-client');

const PROJECT_ID = 'die-pudolfs';
const CLUB_ID = 'die-pudolfs';
const INDEX_DOC_ID = '_index';

const apply = process.argv.includes('--apply');

// ---- Migration für eine "Einzeldokument pro Eintrag"-Collection (Events, RSVPs) ----
async function migrateEntityCollection(db, oldKey, collectionName, label) {
  const oldDoc = await db.getDoc(`kegelbuch/${oldKey}`);
  if (!oldDoc) {
    console.log(`Kein Dokument 'kegelbuch/${oldKey}' (${label}) gefunden. Wird übersprungen.`);
    return;
  }

  let list;
  try {
    list = JSON.parse(oldDoc.value);
  } catch (e) {
    console.error(`Konnte 'kegelbuch/${oldKey}' nicht als JSON parsen:`, e.message);
    process.exitCode = 1;
    return;
  }
  if (!Array.isArray(list)) {
    console.error(`Erwarteter Inhalt von 'kegelbuch/${oldKey}' war ein Array, gefunden wurde:`, typeof list);
    process.exitCode = 1;
    return;
  }

  console.log(`${label}: ${list.length} Einträg(e) gefunden.`);
  for (const item of list) {
    const desc = item.title || item.memberName || item.occurrenceDate || '';
    console.log(`  - ${item.id}  ${desc}`);
  }
  console.log('');

  const ids = list.map((item) => item.id);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicates.length > 0) {
    console.error(`ABBRUCH bei ${label}: doppelte IDs gefunden, das darf nicht sein:`, duplicates);
    process.exitCode = 1;
    return;
  }
  if (ids.includes(INDEX_DOC_ID)) {
    console.error(`ABBRUCH bei ${label}: ein Eintrag hat die ID '${INDEX_DOC_ID}', die ist für das Index-Dokument reserviert.`);
    process.exitCode = 1;
    return;
  }

  const basePath = `clubs/${CLUB_ID}/${collectionName}`;

  if (!apply) {
    console.log(`Würde ${list.length} Dokument(e) unter '${basePath}/<id>' anlegen/aktualisieren`);
    console.log(`und '${basePath}/${INDEX_DOC_ID}' mit ${ids.length} ID(s) schreiben.`);
    console.log(`Der alte Blob 'kegelbuch/${oldKey}' bleibt unverändert erhalten.`);
    console.log('');
    return;
  }

  for (const item of list) {
    await db.setDoc(`${basePath}/${item.id}`, { value: JSON.stringify(item) });
  }
  await db.setDoc(`${basePath}/${INDEX_DOC_ID}`, { value: JSON.stringify(ids) });
  console.log(`Geschrieben: ${basePath}/<id> für ${list.length} Einträge + Index.`);
  console.log('');
}

// ---- Migration für ein einfaches Blob-Dokument (Occurrence-Edits, Feed-Token) ----
async function migrateBlob(db, key, label) {
  const oldDoc = await db.getDoc(`kegelbuch/${key}`);
  if (!oldDoc) {
    console.log(`Kein Dokument 'kegelbuch/${key}' (${label}) gefunden. Wird übersprungen.`);
    return;
  }

  let value;
  try {
    value = JSON.parse(oldDoc.value);
  } catch (e) {
    console.error(`Konnte 'kegelbuch/${key}' nicht als JSON parsen:`, e.message);
    process.exitCode = 1;
    return;
  }

  const newPath = `clubs/${CLUB_ID}/data/${key}`;
  const count = Array.isArray(value) ? `${value.length} Einträge` : 'ein Wert';
  console.log(`${label}: ${count} gefunden.`);

  if (!apply) {
    console.log(`Würde '${newPath}' schreiben.`);
    console.log(`Der alte Blob 'kegelbuch/${key}' bleibt unverändert erhalten.`);
    console.log('');
    return;
  }

  await db.setDoc(newPath, { value: JSON.stringify(value) });
  console.log(`Geschrieben: ${newPath}.`);
  console.log('');
}

async function main() {
  console.log('Hole Zugriffs-Token über bestehendes Firebase-CLI-Login...');
  const accessToken = await getFirebaseCliAccessToken();
  const db = new FirestoreRestClient(PROJECT_ID, accessToken);

  console.log(`Projekt: ${PROJECT_ID}`);
  console.log(apply ? 'Modus: ECHTE AUSFÜHRUNG (--apply)' : 'Modus: DRY-RUN (keine Schreibvorgänge, --apply anhängen für echten Lauf)');
  console.log('');

  await migrateEntityCollection(db, 'calendar-events', 'events', 'Termine');
  await migrateEntityCollection(db, 'calendar-rsvps', 'rsvps', 'Rückmeldungen');
  await migrateEntityCollection(db, 'calendar-occurrence-edits', 'occurrence-edits', 'Serien-Ausnahmen');
  await migrateBlob(db, 'calendar-feed-token', 'Kalender-Feed-Token');

  if (!apply) {
    console.log('Zum echten Ausführen: node migrate-calendar.js --apply');
  } else {
    console.log('Fertig. Die alten Dokumente unter kegelbuch/ wurden NICHT gelöscht (Backup).');
    console.log('Ihr könnt sie nach ein paar Tagen stabilem Betrieb manuell in der');
    console.log('Firebase Console löschen (Firestore -> Sammlung kegelbuch -> calendar-*).');
  }
}

main().catch((e) => {
  console.error('Migration fehlgeschlagen:', e);
  process.exitCode = 1;
});
