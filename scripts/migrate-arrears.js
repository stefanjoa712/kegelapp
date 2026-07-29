/**
 * Einmalige Migration: verschiebt die Finanz-Rückstände (kegelbuch/finance-arrears, ein
 * JSON-Array als Blob) zu eigenen Dokumenten 'clubs/<clubId>/arrears/<docId>' pro Mitglied/Gast
 * + Index-Dokument 'clubs/<clubId>/arrears/_index' mit der Liste aller IDs.
 *
 * WARUM eigene Dokumente statt Blob: Rückstände werden an vielen, oft zeitlich nahen Stellen
 * aktualisiert (Abend abschließen/wiederöffnen/löschen, Zahlung erfassen, Umsatz stornieren,
 * manuelle Korrektur) - ein kompletter Array-Überschrieb hätte hier dasselbe Last-Write-Wins-
 * Risiko wie ursprünglich bei den Mitgliedern gehabt, z.B. wenn fast gleichzeitig ein Abend
 * abgeschlossen und eine Zahlung für ein anderes Mitglied erfasst wird.
 *
 * WARUM die Dokument-ID möglichst die Mitglieds-ID ist, nicht der Name: Ändert sich später der
 * Spitzname eines Mitglieds, bleibt der Rückstand über die stabile ID trotzdem korrekt
 * zugeordnet - mit dem Namen als Schlüssel (wie bisher) wäre er nach einer Umbenennung
 * "verwaist" gewesen. Nur wenn kein passendes Mitglied gefunden wird (Gast, oder ehemaliges
 * Mitglied ohne aktuellen Datensatz), dient der Name selbst als Fallback-ID (mit 'guest-'-Präfix
 * und escapten Schrägstrichen, da Namen aus einem freien Texteingabefeld kommen können und
 * Firestore-Dokument-IDs kein '/' enthalten dürfen - spiegelt exakt resolveArrearsDocId() im
 * Client-Code, index.html).
 *
 * WICHTIG: Dieses Script LÖSCHT den alten 'kegelbuch/finance-arrears'-Blob NICHT. Er bleibt als
 * Backup/Fallback in Firestore liegen. Der App-Code selbst nutzt ihn ab dem zugehörigen Deploy
 * nicht mehr.
 *
 * Das Script ist idempotent: mehrfaches Ausführen richtet keinen Schaden an.
 *
 * VORAUSSETZUNGEN:
 * 1. Node.js installiert
 * 2. Einmal `firebase login` ausgeführt (falls ihr schon `firebase deploy` nutzt, ist das
 *    bereits passiert). Das Script liest das dabei gespeicherte Firebase-CLI-Login und holt sich
 *    darüber ein Zugriffs-Token - kein separates Google-Cloud-SDK/gcloud nötig.
 * 3. Die Mitglieder-Migration (migrate-members.js) muss bereits gelaufen sein, da dieses Script
 *    die aktuelle Mitgliederliste unter clubs/<clubId>/members/ braucht, um Namen zu IDs
 *    aufzulösen.
 *
 * AUSFÜHRUNG:
 *   cd scripts
 *   node migrate-arrears.js            # Dry-Run: zeigt nur an, was passieren würde
 *   node migrate-arrears.js --apply    # führt die Migration wirklich aus
 */

const { getFirebaseCliAccessToken } = require('./firebase-cli-credentials');
const { FirestoreRestClient } = require('./firestore-rest-client');

const PROJECT_ID = 'die-pudolfs';
const CLUB_ID = 'die-pudolfs';
const INDEX_DOC_ID = '_index';

const apply = process.argv.includes('--apply');

// Spiegelt displayName() aus index.html.
function displayName(m) {
  return (m.nickname && m.nickname.trim()) ? m.nickname.trim() : m.firstName;
}

// Spiegelt resolveArrearsDocId() aus index.html.
function resolveArrearsDocId(name, members) {
  const member = members.find((m) => displayName(m) === name);
  if (member) return member.id;
  return 'guest-' + name.replace(/\//g, '_');
}

async function loadMembers(db) {
  const docs = await db.listDocuments(`clubs/${CLUB_ID}/members`);
  const members = [];
  for (const doc of docs) {
    if (doc.id === INDEX_DOC_ID) continue;
    if (!doc.value) continue;
    try {
      members.push(JSON.parse(doc.value));
    } catch (e) {
      console.error(`  Warnung: Mitglied '${doc.id}' konnte nicht geparst werden, wird ignoriert.`);
    }
  }
  return members;
}

async function main() {
  console.log('Hole Zugriffs-Token über bestehendes Firebase-CLI-Login...');
  const accessToken = await getFirebaseCliAccessToken();
  const db = new FirestoreRestClient(PROJECT_ID, accessToken);

  console.log(`Projekt: ${PROJECT_ID}`);
  console.log(apply ? 'Modus: ECHTE AUSFÜHRUNG (--apply)' : 'Modus: DRY-RUN (keine Schreibvorgänge, --apply anhängen für echten Lauf)');
  console.log('');

  console.log('Lade aktuelle Mitgliederliste (für Name -> ID-Auflösung)...');
  const members = await loadMembers(db);
  console.log(`${members.length} Mitglied(er) gefunden.`);
  console.log('');

  const oldDoc = await db.getDoc('kegelbuch/finance-arrears');
  if (!oldDoc) {
    console.log(`Kein Dokument 'kegelbuch/finance-arrears' gefunden. Nichts zu tun.`);
    return;
  }

  let arrears;
  try {
    arrears = JSON.parse(oldDoc.value);
  } catch (e) {
    console.error(`Konnte 'kegelbuch/finance-arrears' nicht als JSON parsen:`, e.message);
    process.exitCode = 1;
    return;
  }
  if (!Array.isArray(arrears)) {
    console.error(`Erwarteter Inhalt war ein Array, gefunden wurde:`, typeof arrears);
    process.exitCode = 1;
    return;
  }

  console.log(`${arrears.length} Rückstands-Eintrag/Einträge gefunden:`);
  const enriched = arrears.map((entry) => {
    const docId = resolveArrearsDocId(entry.name, members);
    return { ...entry, id: docId };
  });
  for (const entry of enriched) {
    console.log(`  - ${entry.id}  ${entry.name}  ${entry.amount}€`);
  }
  console.log('');

  const ids = enriched.map((e) => e.id);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicates.length > 0) {
    console.error('ABBRUCH: Mehrere Rückstands-Einträge lösen zur selben ID auf (z.B. zwei Mitglieder mit');
    console.error('demselben angezeigten Namen), das darf nicht sein:', duplicates);
    console.error('Bitte erst die betroffenen Namen (Spitznamen) eindeutig machen und erneut versuchen.');
    process.exitCode = 1;
    return;
  }

  const basePath = `clubs/${CLUB_ID}/arrears`;

  if (!apply) {
    console.log(`Würde ${enriched.length} Dokument(e) unter '${basePath}/<id>' anlegen/aktualisieren`);
    console.log(`und '${basePath}/${INDEX_DOC_ID}' mit ${ids.length} ID(s) schreiben.`);
    console.log('');
    console.log('Der alte Blob kegelbuch/finance-arrears bleibt unverändert erhalten.');
    console.log('Zum echten Ausführen: node migrate-arrears.js --apply');
    return;
  }

  for (const entry of enriched) {
    await db.setDoc(`${basePath}/${entry.id}`, { value: JSON.stringify(entry) });
  }
  await db.setDoc(`${basePath}/${INDEX_DOC_ID}`, { value: JSON.stringify(ids) });

  console.log(`Fertig. ${enriched.length} Rückstands-Eintrag/Einträge migriert, Index geschrieben.`);
  console.log('');
  console.log('Der alte Blob kegelbuch/finance-arrears wurde NICHT gelöscht (Backup).');
  console.log('Ihr könnt ihn nach ein paar Tagen stabilem Betrieb manuell in der');
  console.log('Firebase Console löschen (Firestore -> Sammlung kegelbuch -> finance-arrears).');
}

main().catch((e) => {
  console.error('Migration fehlgeschlagen:', e);
  process.exitCode = 1;
});
