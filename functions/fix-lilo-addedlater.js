// Einmal-Skript: setzt bei "Lilo" am Kegelabend vom 25.07.2026 das addedLater-Flag.
// Ausführen mit: node fix-lilo-addedlater.js
// Voraussetzung: im functions-Ordner ausführen (dort liegt firebase-admin bereits in node_modules),
// und vorher einmal `firebase login` gemacht haben (nutzt eure Standard-Zugangsdaten).

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp({ credential: applicationDefault(), projectId: 'die-pudolfs' });
const db = getFirestore();

const TARGET_DATE = '2026-07-25';
const TARGET_NAME = 'Lilo';

async function main() {
  const indexSnap = await db.collection('kegelbuch').doc('evenings-index').get();
  if (!indexSnap.exists) { console.error('evenings-index nicht gefunden.'); return; }
  const index = JSON.parse(indexSnap.data().value || '[]');
  const entry = index.find(e => e.date === TARGET_DATE);
  if (!entry) { console.error(`Kein Kegelabend mit Datum ${TARGET_DATE} gefunden.`); return; }

  const docId = 'evening-' + entry.id;
  const eveningSnap = await db.collection('kegelbuch').doc(docId).get();
  if (!eveningSnap.exists) { console.error(`${docId} nicht gefunden.`); return; }
  const detail = JSON.parse(eveningSnap.data().value || '{}');

  const seat = detail.seating.find(s => s.name === TARGET_NAME);
  if (!seat) {
    console.error(`Niemand mit Namen "${TARGET_NAME}" an diesem Abend gefunden.`);
    console.log('Vorhandene Namen:', detail.seating.filter(s => s.name).map(s => s.name));
    return;
  }

  seat.addedLater = true;
  await db.collection('kegelbuch').doc(docId).set({ value: JSON.stringify(detail) });
  console.log(`Fertig: addedLater bei "${TARGET_NAME}" (Sitzplatz ${seat.seatId}) am ${TARGET_DATE} gesetzt.`);
}

main().catch(err => { console.error(err); process.exit(1); });
