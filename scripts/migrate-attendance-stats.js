/**
 * Einmalige Migration: verschiebt die vorab aggregierte Anwesenheits-Statistik
 * (kegelbuch/attendance-stats) zu 'clubs/<clubId>/data/attendance-stats'.
 *
 * WARUM: Vorbereitung, damit die App mehrere Kegelclubs verwalten kann (siehe bereits
 * durchgeführte Migrationen für Mitglieder, Strafen-/Spiele-Katalog, Kalender und
 * Kegelabende). attendance-stats bleibt bewusst als EIN Blob-Dokument pro Club - es ist ein
 * einziges Aggregat-Objekt (Jahres-Totals + Anwesenheit pro Mitglied), keine Liste, und wird nur
 * beim Abschließen/Wiederöffnen eines Abends aktualisiert - deutlich seltener und mit geringerem
 * Kollisionsrisiko als z.B. die Sitzplatz-Strafen der Kegelabende, eine Aufteilung in
 * Einzeldokumente lohnt sich hier nicht. Nur der Speicherort ändert sich (kegelbuch/... ->
 * clubs/<clubId>/data/...), das Datenformat bleibt exakt gleich (ein JSON-Objekt als String im
 * Feld 'value').
 *
 * WICHTIG: Dieses Script LÖSCHT das alte Dokument 'kegelbuch/attendance-stats' NICHT. Es bleibt
 * als Backup/Fallback in Firestore liegen. Der App-Code selbst nutzt es ab dem zugehörigen
 * Deploy nicht mehr.
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
 *   node migrate-attendance-stats.js            # Dry-Run: zeigt nur an, was passieren würde
 *   node migrate-attendance-stats.js --apply    # führt die Migration wirklich aus
 */

const { getFirebaseCliAccessToken } = require('./firebase-cli-credentials');
const { FirestoreRestClient } = require('./firestore-rest-client');

const PROJECT_ID = 'die-pudolfs';
const CLUB_ID = 'die-pudolfs';
const KEY = 'attendance-stats';

const apply = process.argv.includes('--apply');

async function main() {
  console.log('Hole Zugriffs-Token über bestehendes Firebase-CLI-Login...');
  const accessToken = await getFirebaseCliAccessToken();
  const db = new FirestoreRestClient(PROJECT_ID, accessToken);

  console.log(`Projekt: ${PROJECT_ID}`);
  console.log(apply ? 'Modus: ECHTE AUSFÜHRUNG (--apply)' : 'Modus: DRY-RUN (keine Schreibvorgänge, --apply anhängen für echten Lauf)');
  console.log('');

  const oldDoc = await db.getDoc(`kegelbuch/${KEY}`);
  if (!oldDoc) {
    console.log(`Kein Dokument 'kegelbuch/${KEY}' gefunden. Nichts zu tun.`);
    return;
  }

  let stats;
  try {
    stats = JSON.parse(oldDoc.value);
  } catch (e) {
    console.error(`Konnte 'kegelbuch/${KEY}' nicht als JSON parsen:`, e.message);
    process.exitCode = 1;
    return;
  }

  const years = Object.keys(stats.totalsByYear || {});
  const members = Object.keys(stats.attendanceByMember || {});
  console.log(`Gefunden: Jahres-Totals für ${years.length} Jahr(e) (${years.join(', ') || '-'}),`);
  console.log(`Anwesenheitsdaten für ${members.length} Mitglied(er).`);
  console.log('');

  const newPath = `clubs/${CLUB_ID}/data/${KEY}`;

  if (!apply) {
    console.log(`Würde '${newPath}' schreiben.`);
    console.log(`Der alte Blob 'kegelbuch/${KEY}' bleibt unverändert erhalten.`);
    console.log('');
    console.log('Zum echten Ausführen: node migrate-attendance-stats.js --apply');
    return;
  }

  await db.setDoc(newPath, { value: JSON.stringify(stats) });
  console.log(`Geschrieben: ${newPath}.`);
  console.log('');
  console.log('Fertig. Der alte Blob kegelbuch/attendance-stats wurde NICHT gelöscht (Backup).');
  console.log('Ihr könnt ihn nach ein paar Tagen stabilem Betrieb manuell in der');
  console.log('Firebase Console löschen (Firestore -> Sammlung kegelbuch -> attendance-stats).');
}

main().catch((e) => {
  console.error('Migration fehlgeschlagen:', e);
  process.exitCode = 1;
});
