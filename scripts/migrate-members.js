/**
 * Einmalige Migration:
 * 1. Legt das Club-Stammdaten-Dokument 'clubs/<clubId>' an (Name, PayPal-Name, Gründungsdatum).
 * 2. Migriert 'kegelbuch/members' (ein JSON-Array als Blob) zu eigenen Dokumenten
 *    'clubs/<clubId>/members/<id>' pro Mitglied + Index-Dokument
 *    'clubs/<clubId>/members/_index' mit der Liste aller IDs.
 *
 * WARUM eigene Dokumente statt Blob: Der alte Blob wurde bei jeder Mitglieds-Änderung komplett
 * neu geschrieben (kompletter Array-Überschrieb, kein Merge). Lief die App auf zwei Geräten/Tabs
 * gleichzeitig mit unterschiedlichem, veraltetem Stand im Speicher, konnte der "spätere"
 * Schreibvorgang die Änderungen des anderen kommentarlos überschreiben (Last-Write-Wins). Mit
 * einem Dokument pro Mitglied + Firestore-Transaktionen kollidieren nur noch parallele Änderungen
 * AM SELBEN Mitglied, und diese werden von Firestore automatisch wiederholt statt Daten zu verlieren.
 *
 * WARUM der Pfad 'clubs/<clubId>/...' statt weiter unter 'kegelbuch/': Vorbereitung, damit die App
 * später mehrere Kegelclubs verwalten kann. Jeder Club bekommt einen eigenen, strukturell getrennten
 * Datenbaum - das macht spätere Firestore-Sicherheitsregeln ("Club A darf Club B's Daten nicht sehen")
 * robust, weil sie einfach am Pfad greifen statt an einem Feld-Wert in jedem einzelnen Dokument.
 * Andere Collections (Kegelabende, Finanzen, Kalender) bleiben bewusst vorerst unter 'kegelbuch/' -
 * das ist ein eigener, späterer Schritt.
 *
 * WICHTIG: Dieses Script LÖSCHT den alten 'kegelbuch/members'-Blob NICHT. Er bleibt als
 * Backup/Fallback in Firestore liegen. Ihr könnt ihn später manuell in der Firebase Console
 * löschen, sobald ihr ein paar Tage bestätigt habt, dass alles stabil läuft. Der App-Code selbst
 * nutzt den alten Blob ab dem zugehörigen Deploy nicht mehr.
 *
 * Das Script ist idempotent: mehrfaches Ausführen richtet keinen Schaden an (bestehende
 * Mitglieder-Dokumente werden einfach erneut mit dem Blob-Stand überschrieben, der Index wird neu
 * aufgebaut, das Club-Dokument wird per merge geschrieben und damit nicht platt gemacht, falls ihr
 * dort inzwischen manuell etwas geändert habt).
 *
 * VORAUSSETZUNGEN:
 * 1. Node.js installiert
 * 2. Einmal `firebase login` ausgeführt (falls ihr schon `firebase deploy` nutzt, ist das
 *    bereits passiert). Das Script liest das dabei gespeicherte Firebase-CLI-Login und holt sich
 *    darüber ein Zugriffs-Token - kein separates Google-Cloud-SDK/gcloud nötig.
 * 3. Im 'scripts'-Ordner einmalig: npm install (aktuell keine externen Abhängigkeiten nötig,
 *    das Script nutzt nur Node-Bordmittel - der Befehl schadet trotzdem nicht)
 *
 * AUSFÜHRUNG:
 *   cd scripts
 *   node migrate-members.js            # Dry-Run: zeigt nur an, was passieren würde
 *   node migrate-members.js --apply     # führt die Migration wirklich aus
 */

const { getFirebaseCliAccessToken } = require('./firebase-cli-credentials');
const { FirestoreRestClient } = require('./firestore-rest-client');

const PROJECT_ID = 'die-pudolfs';
const OLD_MEMBERS_KEY = 'members';
const MEMBERS_INDEX_ID = '_index';

// Der aktuelle (und bislang einzige) Club. Feste ID, unter der die Club-Stammdaten und die
// Mitglieder-Subcollection künftig liegen.
const CLUB_ID = 'die-pudolfs';
const CLUB_DATA = {
  name: 'Die Pudolfs',
  paypalName: 'diepudolfs',
  // ISO-Format (YYYY-MM-DD), damit es sich wie die restlichen Datumsfelder in der App verhält.
  foundedOn: '2008-08-30'
};

const apply = process.argv.includes('--apply');

async function main() {
  console.log('Hole Zugriffs-Token über bestehendes Firebase-CLI-Login...');
  const accessToken = await getFirebaseCliAccessToken();
  const db = new FirestoreRestClient(PROJECT_ID, accessToken);

  console.log(`Projekt: ${PROJECT_ID}`);
  console.log(apply ? 'Modus: ECHTE AUSFÜHRUNG (--apply)' : 'Modus: DRY-RUN (keine Schreibvorgänge, --apply anhängen für echten Lauf)');
  console.log('');

  // ---- Club-Stammdaten ----
  console.log(`Club '${CLUB_ID}' anlegen/aktualisieren mit:`);
  console.log(`  Name:          ${CLUB_DATA.name}`);
  console.log(`  PayPal-Name:   ${CLUB_DATA.paypalName}`);
  console.log(`  Gründungsdatum: ${CLUB_DATA.foundedOn}`);
  console.log('');

  const clubPath = `clubs/${CLUB_ID}`;
  const membersPath = `${clubPath}/members`;

  // ---- Alten Blob laden ----
  const oldMembersDoc = await db.getDoc(`kegelbuch/${OLD_MEMBERS_KEY}`);

  if (!oldMembersDoc) {
    console.log(`Kein Dokument 'kegelbuch/${OLD_MEMBERS_KEY}' gefunden. Mitglieder-Migration wird übersprungen.`);
    if (apply) {
      await db.setDocMerge(clubPath, CLUB_DATA);
      console.log('Club-Stammdaten wurden trotzdem geschrieben.');
    } else {
      console.log('Würde Club-Stammdaten schreiben. Zum echten Ausführen: node migrate-members.js --apply');
    }
    return;
  }

  let members;
  try {
    members = JSON.parse(oldMembersDoc.value);
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
  const existingIndexDoc = await db.getDoc(`${membersPath}/${MEMBERS_INDEX_ID}`);
  if (existingIndexDoc) {
    const existingIndex = JSON.parse(existingIndexDoc.value);
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
  if (ids.includes(MEMBERS_INDEX_ID)) {
    console.error(`ABBRUCH: Ein Mitglied hat die ID '${MEMBERS_INDEX_ID}', die ist für das Index-Dokument reserviert.`);
    process.exitCode = 1;
    return;
  }

  if (!apply) {
    console.log(`Würde ${members.length} Dokument(e) unter '${membersPath}/<id>' anlegen/aktualisieren`);
    console.log(`und '${membersPath}/${MEMBERS_INDEX_ID}' mit ${ids.length} ID(s) schreiben.`);
    console.log(`Würde '${clubPath}' mit den Club-Stammdaten schreiben.`);
    console.log('');
    console.log('Der alte Blob kegelbuch/members bleibt unverändert erhalten.');
    console.log('Zum echten Ausführen: node migrate-members.js --apply');
    return;
  }

  // ---- Echte Migration ----
  console.log('Schreibe Club-Stammdaten...');
  await db.setDocMerge(clubPath, CLUB_DATA);

  console.log('Schreibe Mitglieder-Dokumente...');
  for (const member of members) {
    await db.setDoc(`${membersPath}/${member.id}`, { value: JSON.stringify(member) });
  }
  await db.setDoc(`${membersPath}/${MEMBERS_INDEX_ID}`, { value: JSON.stringify(ids) });

  console.log(`Fertig. Club '${CLUB_ID}' angelegt, ${members.length} Mitglied(er) migriert, Index geschrieben.`);
  console.log('');
  console.log('Der alte Blob kegelbuch/members wurde NICHT gelöscht (Backup).');
  console.log('Ihr könnt ihn nach ein paar Tagen stabilem Betrieb manuell in der');
  console.log('Firebase Console löschen (Firestore -> Sammlung kegelbuch -> Dokument members).');
}

main().catch(e => {
  console.error('Migration fehlgeschlagen:', e);
  process.exitCode = 1;
});
