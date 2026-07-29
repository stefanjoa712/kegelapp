/**
 * Einmalige Migration: verschiebt den Strafen-Katalog (kegelbuch/fines-catalog) und den
 * Spiele-Katalog (kegelbuch/games-catalog) zu 'clubs/<clubId>/data/fines-catalog' bzw.
 * 'clubs/<clubId>/data/games-catalog'.
 *
 * WARUM der Pfad 'clubs/<clubId>/data/<key>' statt 'clubs/<clubId>/<key>': Firestore-
 * Dokumentpfade brauchen eine GERADE Anzahl Segmente (collection/doc/collection/doc/...).
 * 'clubs/<clubId>/<key>' hat nur 3 Segmente und ist kein gültiger Dokumentpfad (das schlug im
 * ersten Anlauf mit 'HTTP 400: lacks /' fehl) - der feste Zwischenschritt 'data' als
 * Collection-Name macht daraus 4 Segmente, ein gültiges Dokument.
 *
 * WARUM überhaupt verschieben: Vorbereitung, damit die App mehrere Kegelclubs verwalten kann
 * (siehe bereits durchgeführte Mitglieder-Migration in migrate-members.js). Anders als bei den
 * Mitgliedern bleiben Strafen- und Spiele-Katalog bewusst als EIN Blob-Dokument pro Club - es
 * sind kleine, selten parallel bearbeitete Listen, bei denen sich eine Aufteilung in
 * Einzeldokumente nicht lohnt. Nur der Speicherort ändert sich, das Datenformat bleibt exakt
 * gleich (ein JSON-Array als String im Feld 'value').
 *
 * WICHTIG: Dieses Script LÖSCHT die alten Dokumente 'kegelbuch/fines-catalog' und
 * 'kegelbuch/games-catalog' NICHT. Sie bleiben als Backup/Fallback in Firestore liegen. Der
 * App-Code selbst nutzt sie ab dem zugehörigen Deploy nicht mehr.
 *
 * Das Script ist idempotent: mehrfaches Ausführen richtet keinen Schaden an (die neuen
 * Dokumente werden einfach erneut mit dem aktuellen Blob-Stand überschrieben).
 *
 * VORAUSSETZUNGEN:
 * 1. Node.js installiert
 * 2. Einmal `firebase login` ausgeführt (falls ihr schon `firebase deploy` nutzt, ist das
 *    bereits passiert). Das Script liest das dabei gespeicherte Firebase-CLI-Login und holt sich
 *    darüber ein Zugriffs-Token - kein separates Google-Cloud-SDK/gcloud nötig.
 *
 * AUSFÜHRUNG:
 *   cd scripts
 *   node migrate-fines-games.js            # Dry-Run: zeigt nur an, was passieren würde
 *   node migrate-fines-games.js --apply     # führt die Migration wirklich aus
 */

const { getFirebaseCliAccessToken } = require('./firebase-cli-credentials');
const { FirestoreRestClient } = require('./firestore-rest-client');

const PROJECT_ID = 'die-pudolfs';
const CLUB_ID = 'die-pudolfs';

// key = alter/neuer Dokumentname (identisch, nur der übergeordnete Pfad ändert sich),
// label = für die Konsolen-Ausgabe.
const CATALOGS = [
  { key: 'fines-catalog', label: 'Strafen-Katalog' },
  { key: 'games-catalog', label: 'Spiele-Katalog' }
];

const apply = process.argv.includes('--apply');

async function main() {
  console.log('Hole Zugriffs-Token über bestehendes Firebase-CLI-Login...');
  const accessToken = await getFirebaseCliAccessToken();
  const db = new FirestoreRestClient(PROJECT_ID, accessToken);

  console.log(`Projekt: ${PROJECT_ID}`);
  console.log(apply ? 'Modus: ECHTE AUSFÜHRUNG (--apply)' : 'Modus: DRY-RUN (keine Schreibvorgänge, --apply anhängen für echten Lauf)');
  console.log('');

  const clubDataPath = `clubs/${CLUB_ID}/data`;
  let anyFound = false;

  for (const { key, label } of CATALOGS) {
    const oldDoc = await db.getDoc(`kegelbuch/${key}`);
    if (!oldDoc) {
      console.log(`Kein Dokument 'kegelbuch/${key}' (${label}) gefunden. Wird übersprungen.`);
      continue;
    }

    let list;
    try {
      list = JSON.parse(oldDoc.value);
    } catch (e) {
      console.error(`Konnte 'kegelbuch/${key}' nicht als JSON parsen:`, e.message);
      process.exitCode = 1;
      continue;
    }
    if (!Array.isArray(list)) {
      console.error(`Erwarteter Inhalt von 'kegelbuch/${key}' war ein Array, gefunden wurde:`, typeof list);
      process.exitCode = 1;
      continue;
    }

    anyFound = true;
    console.log(`${label}: ${list.length} Einträg(e) gefunden.`);
    for (const item of list) {
      console.log(`  - ${item.id}  ${item.name}`);
    }
    console.log('');

    if (!apply) {
      console.log(`Würde 'clubs/${CLUB_ID}/data/${key}' mit diesen ${list.length} Einträgen schreiben.`);
      console.log(`Der alte 'kegelbuch/${key}' bleibt unverändert erhalten.`);
      console.log('');
      continue;
    }

    await db.setDoc(`${clubDataPath}/${key}`, { value: JSON.stringify(list) });
    console.log(`Geschrieben: clubs/${CLUB_ID}/data/${key} (${list.length} Einträge).`);
    console.log('');
  }

  if (!anyFound) {
    console.log('Keine der beiden Kataloge im alten kegelbuch/-Pfad gefunden. Nichts zu tun.');
    return;
  }

  if (!apply) {
    console.log('Zum echten Ausführen: node migrate-fines-games.js --apply');
  } else {
    console.log('Fertig. Die alten Dokumente unter kegelbuch/ wurden NICHT gelöscht (Backup).');
    console.log('Ihr könnt sie nach ein paar Tagen stabilem Betrieb manuell in der');
    console.log('Firebase Console löschen (Firestore -> Sammlung kegelbuch -> fines-catalog / games-catalog).');
  }
}

main().catch(e => {
  console.error('Migration fehlgeschlagen:', e);
  process.exitCode = 1;
});
