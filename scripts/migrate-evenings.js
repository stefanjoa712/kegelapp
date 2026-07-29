/**
 * Einmalige Migration der Kegelabende zu clubs/<clubId>/...:
 *
 * 1. Jedes 'kegelbuch/evening-<id>'-Dokument wird aufgeteilt in:
 *    a) Hauptdokument 'clubs/<clubId>/evenings/<id>' - alle Felder AUSSER finesBySeat und
 *       adHocFinesBySeat (Datum, Sitzordnung, Strafenkatalog-Snapshot, Notizen, Abschluss-Status).
 *    b) Ein Unterdokument PRO SITZPLATZ, der Strafen hat:
 *       'clubs/<clubId>/evenings/<id>/seats/<seatId>' mit
 *       { finesBySeat: {...}, adHocFinesBySeat: [...] } für genau diesen Sitzplatz.
 * 2. 'kegelbuch/evenings-index' (ein JSON-Array als Blob) -> EIN Blob-Dokument
 *    'clubs/<clubId>/data/evenings-index'.
 *
 * WARUM diese Aufteilung: Anders als bei den anderen bisher migrierten Bereichen können bei
 * einem Kegelabend mehrere Personen GLEICHZEITIG auf unterschiedlichen Geräten Strafen für
 * unterschiedliche Sitzplätze eintragen (z.B. Anzahl "Pudel" pro Person mitzählen). Lag das
 * ganze Abend-Dokument als ein Blob vor, hätte ein kompletter Überschrieb genau dasselbe
 * Last-Write-Wins-Risiko wie ursprünglich bei den Mitgliedern gehabt - Person A trägt an
 * Sitzplatz 1 eine Strafe ein, während Person B an Sitzplatz 3 zählt; wer zuletzt speichert,
 * überschreibt die Änderung der/des anderen. Mit einem Unterdokument pro Sitzplatz betrifft das
 * nur noch Änderungen AM SELBEN Sitzplatz (dort läuft es im App-Code über eine Transaktion).
 * Sitzordnung und Strafenkatalog-Snapshot sind dagegen nach dem Anlegen des Abends praktisch fix
 * und bleiben im Hauptdokument - eine Aufteilung würde dort keinen Nutzen bringen.
 *
 * 'evenings-index' bleibt bewusst EIN Blob-Dokument (wie bei Strafen-/Spiele-Katalog) - neue
 * Abende werden selten genug angelegt, dass das Last-Write-Wins-Risiko dort vernachlässigbar ist.
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
 *   node migrate-evenings.js            # Dry-Run: zeigt nur an, was passieren würde
 *   node migrate-evenings.js --apply    # führt die Migration wirklich aus
 */

const { getFirebaseCliAccessToken } = require('./firebase-cli-credentials');
const { FirestoreRestClient } = require('./firestore-rest-client');

const PROJECT_ID = 'die-pudolfs';
const CLUB_ID = 'die-pudolfs';

const apply = process.argv.includes('--apply');

async function migrateEvenings(db) {
  console.log('Suche Kegelabende unter kegelbuch/...');
  const allDocs = await db.listDocuments('kegelbuch');
  const eveningDocs = allDocs.filter((d) => d.id.startsWith('evening-'));

  if (eveningDocs.length === 0) {
    console.log('Keine Kegelabende gefunden. Wird übersprungen.');
    return;
  }

  console.log(`${eveningDocs.length} Kegelabend(e) gefunden:`);

  const parsed = [];
  for (const doc of eveningDocs) {
    let detail;
    try {
      detail = JSON.parse(doc.value);
    } catch (e) {
      console.error(`  ABBRUCH bei ${doc.id}: konnte Inhalt nicht als JSON parsen:`, e.message);
      process.exitCode = 1;
      continue;
    }
    const seatCount = Object.keys(detail.finesBySeat || {}).length + Object.keys(detail.adHocFinesBySeat || {}).length;
    console.log(`  - ${doc.id}  ${detail.date || ''}  (${seatCount > 0 ? 'Sitzplätze mit Strafen: ' + new Set([...Object.keys(detail.finesBySeat || {}), ...Object.keys(detail.adHocFinesBySeat || {})]).size : 'keine Strafen'})`);
    parsed.push(detail);
  }
  console.log('');

  if (!apply) {
    for (const detail of parsed) {
      const seatIds = new Set([...Object.keys(detail.finesBySeat || {}), ...Object.keys(detail.adHocFinesBySeat || {})]);
      console.log(`Würde 'clubs/${CLUB_ID}/evenings/${detail.id}' (Hauptdokument, ohne finesBySeat/adHocFinesBySeat) schreiben.`);
      if (seatIds.size > 0) {
        console.log(`Würde ${seatIds.size} Sitzplatz-Unterdokument(e) unter 'clubs/${CLUB_ID}/evenings/${detail.id}/seats/<seatId>' schreiben.`);
      }
    }
    console.log('');
    console.log('Die alten Dokumente unter kegelbuch/evening-* bleiben unverändert erhalten.');
    return;
  }

  for (const detail of parsed) {
    const { finesBySeat, adHocFinesBySeat, ...mainFields } = detail;
    const mainPath = `clubs/${CLUB_ID}/evenings/${detail.id}`;
    await db.setDoc(mainPath, { value: JSON.stringify(mainFields) });

    const seatIds = new Set([...Object.keys(finesBySeat || {}), ...Object.keys(adHocFinesBySeat || {})]);
    for (const seatId of seatIds) {
      const seatData = {
        finesBySeat: (finesBySeat || {})[seatId] || {},
        adHocFinesBySeat: (adHocFinesBySeat || {})[seatId] || []
      };
      await db.setDoc(`${mainPath}/seats/${seatId}`, { value: JSON.stringify(seatData) });
    }
    console.log(`Geschrieben: ${mainPath} (+ ${seatIds.size} Sitzplatz-Unterdokument(e)).`);
  }
}

async function migrateEveningsIndex(db) {
  const oldDoc = await db.getDoc('kegelbuch/evenings-index');
  if (!oldDoc) {
    console.log(`Kein Dokument 'kegelbuch/evenings-index' gefunden. Wird übersprungen.`);
    return;
  }

  let list;
  try {
    list = JSON.parse(oldDoc.value);
  } catch (e) {
    console.error(`Konnte 'kegelbuch/evenings-index' nicht als JSON parsen:`, e.message);
    process.exitCode = 1;
    return;
  }

  const newPath = `clubs/${CLUB_ID}/data/evenings-index`;
  console.log(`evenings-index: ${Array.isArray(list) ? list.length : '?'} Einträge gefunden.`);

  if (!apply) {
    console.log(`Würde '${newPath}' schreiben.`);
    console.log(`Der alte Blob 'kegelbuch/evenings-index' bleibt unverändert erhalten.`);
    console.log('');
    return;
  }

  await db.setDoc(newPath, { value: JSON.stringify(list) });
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

  await migrateEvenings(db);
  await migrateEveningsIndex(db);

  if (!apply) {
    console.log('Zum echten Ausführen: node migrate-evenings.js --apply');
  } else {
    console.log('Fertig. Die alten Dokumente unter kegelbuch/ wurden NICHT gelöscht (Backup).');
    console.log('Ihr könnt sie nach ein paar Tagen stabilem Betrieb manuell in der');
    console.log('Firebase Console löschen (Firestore -> Sammlung kegelbuch -> evening-* / evenings-index).');
  }
}

main().catch((e) => {
  console.error('Migration fehlgeschlagen:', e);
  process.exitCode = 1;
});
