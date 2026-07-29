/**
 * Einmalige Migration: 'kegelbuch/members' (ein JSON-Array als Blob) -> eigene
 * Dokumente 'kegelbuch/member-<id>' pro Mitglied + Index-Dokument
 * 'kegelbuch/members-index' mit der Liste aller IDs.
 *
 * WARUM: Der alte Blob wurde bei jeder Mitglieds-Änderung komplett neu geschrieben
 * (kompletter Array-Überschrieb, kein Merge). Lief die App auf zwei Geräten/Tabs
 * gleichzeitig mit unterschiedlichem, veraltetem Stand im Speicher, konnte der
 * "spätere" Schreibvorgang die Änderungen des anderen kommentarlos überschreiben
 * (Last-Write-Wins). Mit einem Dokument pro Mitglied + Firestore-Transaktionen
 * kollidieren nur noch parallele Änderungen AM SELBEN Mitglied, und diese werden
 * von Firestore automatisch wiederholt statt Daten zu verlieren.
 *
 * WICHTIG: Dieses Script LÖSCHT den alten 'members'-Blob NICHT. Er bleibt als
 * Backup/Fallback in Firestore liegen. Ihr könnt ihn später manuell in der
 * Firebase Console löschen, sobald ihr ein paar Tage bestätigt habt, dass alles
 * stabil läuft. Der App-Code selbst nutzt den alten Blob ab dem zugehörigen
 * Deploy nicht mehr.
 *
 * Das Script ist idempotent: mehrfaches Ausführen richtet keinen Schaden an
 * (bestehende Mitglieder-Dokumente werden einfach erneut mit dem Blob-Stand
 * überschrieben, der Index wird neu aufgebaut).
 *
 * VORAUSSETZUNGEN:
 * 1. Node.js installiert
 * 2. Google-Cloud-Zugangsdaten für das Projekt 'die-pudolfs' vorhanden, z.B. via
 *      gcloud auth application-default login
 *    (Google Cloud CLI: https://cloud.google.com/sdk/docs/install)
 *    ODER: Umgebungsvariable GOOGLE_APPLICATION_CREDENTIALS auf einen Service-
 *    Account-Key (JSON-Datei) zeigen lassen.
 * 3. Im 'scripts'-Ordner einmalig: npm install
 *
 * AUSFÜHRUNG:
 *   cd scripts
 *   npm install
 *   node migrate-members.js            # Dry-Run: zeigt nur an, was passieren würde
 *   node migrate-members.js --apply     # führt die Migration wirklich aus
 */

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const PROJECT_ID = 'die-pudolfs';
const OLD_MEMBERS_KEY = 'members';
const MEMBERS_INDEX_KEY = 'members-index';

const apply = process.argv.includes('--apply');

async function main() {
  initializeApp({
    credential: applicationDefault(),
    projectId: PROJECT_ID
  });
  const db = getFirestore();

  console.log(`Projekt: ${PROJECT_ID}`);
  console.log(apply ? 'Modus: ECHTE AUSFÜHRUNG (--apply)' : 'Modus: DRY-RUN (keine Schreibvorgänge, --apply anhängen für echten Lauf)');
  console.log('');

  // ---- Alten Blob laden ----
  const oldDocRef = db.collection('kegelbuch').doc(OLD_MEMBERS_KEY);
  const oldSnap = await oldDocRef.get();

  if (!oldSnap.exists) {
    console.log(`Kein Dokument 'kegelbuch/${OLD_MEMBERS_KEY}' gefunden. Nichts zu migrieren.`);
    return;
  }

  let members;
  try {
    members = JSON.parse(oldSnap.data().value);
  } catch (e) {
    console.error('Konnte den Inhalt von kegelbuch/members nicht als JSON parsen:', e.message);
    process.exitCode = 1;
    return;
  }

  if (!Array.isArray(members)) {
    console.error('Erwarteter Inhalt war ein Array, gefunden wurde:', typeof members);
    process.exitCode = 1;
    return;
  }

  console.log(`${members.length} Mitglied(er) im alten Blob gefunden:`);
  for (const m of members) {
    const name = [m.firstName, m.lastName].filter(Boolean).join(' ') || '(kein Name)';
    console.log(`  - ${m.id}  ${name}`);
  }
  console.log('');

  // ---- Bereits bestehenden Index prüfen (für Idempotenz-Hinweis) ----
  const indexRef = db.collection('kegelbuch').doc(MEMBERS_INDEX_KEY);
  const indexSnap = await indexRef.get();
  if (indexSnap.exists) {
    const existingIndex = JSON.parse(indexSnap.data().value);
    console.log(`Hinweis: Es existiert bereits ein Index mit ${existingIndex.length} ID(s). Wird überschrieben/ergänzt.`);
    console.log('');
  }

  const ids = members.map(m => m.id);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicates.length > 0) {
    console.error('ABBRUCH: Doppelte IDs im alten Blob gefunden, das darf nicht sein:', duplicates);
    process.exitCode = 1;
    return;
  }

  if (!apply) {
    console.log(`Würde ${members.length} Dokument(e) unter 'kegelbuch/member-<id>' anlegen/aktualisieren`);
    console.log(`und 'kegelbuch/${MEMBERS_INDEX_KEY}' mit ${ids.length} ID(s) schreiben.`);
    console.log('');
    console.log('Der alte Blob kegelbuch/members bleibt unverändert erhalten.');
    console.log('Zum echten Ausführen: node migrate-members.js --apply');
    return;
  }

  // ---- Echte Migration: Batch-Write (bis zu 500 Operationen pro Batch) ----
  console.log('Schreibe Mitglieder-Dokumente...');
  const batches = [];
  let batch = db.batch();
  let opsInBatch = 0;

  for (const member of members) {
    const ref = db.collection('kegelbuch').doc('member-' + member.id);
    batch.set(ref, { value: JSON.stringify(member) });
    opsInBatch++;
    if (opsInBatch >= 450) {
      batches.push(batch);
      batch = db.batch();
      opsInBatch = 0;
    }
  }
  batch.set(indexRef, { value: JSON.stringify(ids) });
  batches.push(batch);

  for (const b of batches) {
    await b.commit();
  }

  console.log(`Fertig. ${members.length} Mitglied(er) migriert, Index geschrieben.`);
  console.log('');
  console.log('Der alte Blob kegelbuch/members wurde NICHT gelöscht (Backup).');
  console.log('Ihr könnt ihn nach ein paar Tagen stabilem Betrieb manuell in der');
  console.log('Firebase Console löschen (Firestore -> Sammlung kegelbuch -> Dokument members).');
}

main().catch(e => {
  console.error('Migration fehlgeschlagen:', e);
  process.exitCode = 1;
});
