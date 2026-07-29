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
 * 3. Im 'scripts'-Ordner einmalig: npm install
 *
 * AUSFÜHRUNG:
 *   cd scripts
 *   npm install
 *   node migrate-members.js            # Dry-Run: zeigt nur an, was passieren würde
 *   node migrate-members.js --apply     # führt die Migration wirklich aus
 */

const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getFirebaseCliAccessToken } = require('./firebase-cli-credentials');

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
  const accessToken = await getFirebaseCliAccessToken();
  initializeApp({
    credential: {
      getAccessToken: async () => ({
        access_token: accessToken,
        // Kurzlebiges Token (Firebase-CLI-Zugriffstoken sind i.d.R. ~1h gültig) - für ein
        // einmaliges kurzes Migrations-Script reicht das, es wird pro Lauf frisch geholt.
        expires_in: 3000
      })
    },
    projectId: PROJECT_ID
  });
  const db = getFirestore();

  console.log(`Projekt: ${PROJECT_ID}`);
  console.log(apply ? 'Modus: ECHTE AUSFÜHRUNG (--apply)' : 'Modus: DRY-RUN (keine Schreibvorgänge, --apply anhängen für echten Lauf)');
  console.log('');

  // ---- Club-Stammdaten ----
  console.log(`Club '${CLUB_ID}' anlegen/aktualisieren mit:`);
  console.log(`  Name:          ${CLUB_DATA.name}`);
  console.log(`  PayPal-Name:   ${CLUB_DATA.paypalName}`);
  console.log(`  Gründungsdatum: ${CLUB_DATA.foundedOn}`);
  console.log('');

  const clubRef = db.collection('clubs').doc(CLUB_ID);
  const membersCollection = clubRef.collection('members');

  // ---- Alten Blob laden ----
  const oldDocRef = db.collection('kegelbuch').doc(OLD_MEMBERS_KEY);
  const oldSnap = await oldDocRef.get();

  if (!oldSnap.exists) {
    console.log(`Kein Dokument 'kegelbuch/${OLD_MEMBERS_KEY}' gefunden. Mitglieder-Migration wird übersprungen.`);
    if (apply) {
      await clubRef.set(CLUB_DATA, { merge: true });
      console.log('Club-Stammdaten wurden trotzdem geschrieben.');
    } else {
      console.log('Würde Club-Stammdaten schreiben. Zum echten Ausführen: node migrate-members.js --apply');
    }
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
  const indexRef = membersCollection.doc(MEMBERS_INDEX_ID);
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
  if (ids.includes(MEMBERS_INDEX_ID)) {
    console.error(`ABBRUCH: Ein Mitglied hat die ID '${MEMBERS_INDEX_ID}', die ist für das Index-Dokument reserviert.`);
    process.exitCode = 1;
    return;
  }

  if (!apply) {
    console.log(`Würde ${members.length} Dokument(e) unter 'clubs/${CLUB_ID}/members/<id>' anlegen/aktualisieren`);
    console.log(`und 'clubs/${CLUB_ID}/members/${MEMBERS_INDEX_ID}' mit ${ids.length} ID(s) schreiben.`);
    console.log(`Würde 'clubs/${CLUB_ID}' mit den Club-Stammdaten schreiben.`);
    console.log('');
    console.log('Der alte Blob kegelbuch/members bleibt unverändert erhalten.');
    console.log('Zum echten Ausführen: node migrate-members.js --apply');
    return;
  }

  // ---- Echte Migration ----
  console.log('Schreibe Club-Stammdaten...');
  await clubRef.set(CLUB_DATA, { merge: true });

  console.log('Schreibe Mitglieder-Dokumente...');
  const batches = [];
  let batch = db.batch();
  let opsInBatch = 0;

  for (const member of members) {
    const ref = membersCollection.doc(member.id);
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

