/**
 * Einmalige Migration der Finanz-Daten zu clubs/<clubId>/...:
 *
 * 1. finance-transactions (kegelbuch/finance-transactions, ein JSON-Array als Blob)
 *    -> eigene Dokumente 'clubs/<clubId>/transactions/<id>' pro Buchung + Index-Dokument
 *       'clubs/<clubId>/transactions/_index' mit der Liste aller IDs.
 * 2. finance-accounts, finance-recurring, finance-savings-pots
 *    -> jeweils EIN Blob-Dokument 'clubs/<clubId>/data/<key>'.
 *
 * WARUM finance-transactions als Einzeldokumente, aber die anderen drei als Blob:
 * Bei Buchungen können zwei unabhängige Schreibquellen kollidieren - ein Nutzer legt/bearbeitet/
 * löscht händisch eine Buchung, während die tägliche Cloud Function processRecurringBookings
 * (läuft nachts um Mitternacht) automatisch neue Buchungen für fällige Daueraufträge schreibt.
 * Ein kompletter Array-Überschrieb hätte hier dasselbe Last-Write-Wins-Risiko wie ursprünglich
 * bei den Mitgliedern gehabt. Konten, Daueraufträge und Sparziele sind dagegen kleine, selten
 * parallel bearbeitete Listen - eine Aufteilung in Einzeldokumente lohnt sich dort nicht.
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
 *   node migrate-finance.js            # Dry-Run: zeigt nur an, was passieren würde
 *   node migrate-finance.js --apply    # führt die Migration wirklich aus
 */

const { getFirebaseCliAccessToken } = require('./firebase-cli-credentials');
const { FirestoreRestClient } = require('./firestore-rest-client');

const PROJECT_ID = 'die-pudolfs';
const CLUB_ID = 'die-pudolfs';
const INDEX_DOC_ID = '_index';

const apply = process.argv.includes('--apply');

// ---- Migration für eine "Einzeldokument pro Eintrag"-Collection (Buchungen) ----
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
    const desc = item.description || '';
    const amount = item.amount !== undefined ? `${item.amount}€` : '';
    console.log(`  - ${item.id}  ${item.date || ''}  ${desc}  ${amount}`);
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

// ---- Migration für ein einfaches Blob-Dokument (Konten, Daueraufträge, Sparziele) ----
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

  await migrateEntityCollection(db, 'finance-transactions', 'transactions', 'Buchungen');
  await migrateBlob(db, 'finance-accounts', 'Konten');
  await migrateBlob(db, 'finance-recurring', 'Daueraufträge');
  await migrateBlob(db, 'finance-savings-pots', 'Sparziele');

  if (!apply) {
    console.log('Zum echten Ausführen: node migrate-finance.js --apply');
  } else {
    console.log('Fertig. Die alten Dokumente unter kegelbuch/ wurden NICHT gelöscht (Backup).');
    console.log('Ihr könnt sie nach ein paar Tagen stabilem Betrieb manuell in der');
    console.log('Firebase Console löschen (Firestore -> Sammlung kegelbuch -> finance-*).');
    console.log('');
    console.log('WICHTIG: Nach diesem Deploy verbucht die Cloud Function processRecurringBookings');
    console.log('neue Daueraufträge nur noch unter clubs/<clubId>/... - stellt sicher, dass die');
    console.log('Migration lief, BEVOR der nächste nächtliche Lauf (Mitternacht) fällig wird.');
  }
}

main().catch((e) => {
  console.error('Migration fehlgeschlagen:', e);
  process.exitCode = 1;
});
