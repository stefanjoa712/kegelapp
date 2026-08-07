# Design: Umbuchungen zwischen Konten/Kassen — Issue #83

## Kontext

`state.financeTransactions` kennt aktuell nur Einnahme (positiver
`amount`) und Ausgabe (negativer `amount`), jeweils einem einzelnen
`accountId` zugeordnet. Eine Bewegung *zwischen* zwei eigenen Konten
(z. B. Bargeld von der Kegelkasse aufs Vereinskonto) lässt sich nur über
zwei unabhängige, unverknüpfte Buchungen abbilden — Fehlerquelle
(abweichende Beträge/Daten) und verzerrt die Einnahme/Ausgabe-Summen der
Kassenprüfung.

Betroffene bestehende Bausteine:
- `transactionsStore` / `makeClubEntityStore()` (`index.html:1503-1547`,
  `index.html:1654-1657`) — Storage-Layer, ein Firestore-Dokument pro
  Transaction + Index-Dokument
- `financeAccountBalance()` (`index.html:3355-3360`)
- `buildFinanceTransactionsTab()` (`index.html:3362-3405`)
- `viewFinance()` (`index.html:3681-3702`, `totalAmount`-Berechnung)
- `viewTransactionDetail()` / `attachTransactionDetailListeners()`
  (`index.html:8735-8846`)
- `showDeleteTransactionModal()` (`index.html:8499-8538`)
- `goToTransactionDetail()` (`index.html:8729-8733`)

Nur relevant wenn `state.financeAccounts.length > 1` — bei genau einem
Konto ist eine Umbuchung sinnlos, die Option erscheint dann gar nicht.

## Entschiedene Eckpunkte

- **Datenmodell:** Option B (zwei gekoppelte Transaktionen), nicht Option
  A (ein Dokument mit `type:'transfer'`). Grund: `financeAccountBalance()`
  und `totalAmount` bleiben dadurch unverändert korrekt, da weiterhin
  jede Transaction genau ein Konto und einen Betrag hat — kein
  Sonderfall in der Saldo-Logik nötig.
- **Bearbeiten einer bestehenden Umbuchung:** Nur Betrag/Datum/
  Bezeichnung änderbar. Von-/Nach-Konto sind nach dem Anlegen fix
  (analog zur bestehenden Sperre bei `fromArrears`-Transaktionen) — kein
  Nachziehen von Konten-Saldi bei nachträglichem Kontowechsel nötig,
  kein Risiko von Von=Nach nach dem Bearbeiten.
- **Hinweistext beim Bearbeiten:** Kurzer erklärender Text, warum
  Von/Nach gesperrt sind (analog zum bestehenden `fromArrears`-Hinweis).
- **Lösch-Dialog:** Bleibt unverändert/generisch (kein Sonderhinweis auf
  die zweite gekoppelte Buchung) — beide Seiten werden im Hintergrund
  gemeinsam gelöscht, ohne das im Dialogtext extra zu erläutern.
- **Firestore-Rules:** Keine Änderung. Die Atomarität der zwei
  gekoppelten Dokumente kommt aus einer einzelnen Firestore-
  `runTransaction()` auf Client-Seite — konsistent mit dem bestehenden
  `save()`/`remove()`-Pattern in `makeClubEntityStore()`, das ebenfalls
  keine serverseitige Kopplungsprüfung hat.
- **Berechtigungen:** Unverändert `canManageFinances()`, keine neue
  Rolle.

## Technisches Design

### Datenmodell

```js
// Ausgehende Buchung
{ id, accountId: fromAccountId, amount: -betrag, description, date,
  transferId, transferRole:'out', createdAt }
// Eingehende Buchung
{ id, accountId: toAccountId, amount: +betrag, description, date,
  transferId, transferRole:'in', createdAt }
```

`transferId` (`uid('transfer')`) verknüpft beide Dokumente. Beide teilen
dieselbe `description` — Default `Umbuchung {Von} → {Nach}`, falls das
Feld beim Anlegen leer gelassen wird, damit in der Liste nie ein leerer
Text steht.

`financeAccountBalance()` (Filter auf `accountId`, Summe über `amount`)
und die `totalAmount`-Berechnung in `viewFinance()` (Summe über *alle*
Transaktionen) bleiben unverändert — bei einer Umbuchung heben sich
`-betrag` und `+betrag` in der Gesamtsumme automatisch auf, während sie
pro Konto korrekt verbucht werden.

### Storage-Layer: `saveMany`/`removeMany`

`makeClubEntityStore()` (`index.html:1503-1547`) bekommt zwei neue
Methoden, die mehrere Dokumente + das Index-Dokument in **einer**
`runTransaction()` schreiben bzw. löschen (analog zu `save()`/`remove()`,
nur mit mehreren Docs statt einem):

```js
async function saveMany(entries){
  assertNotAccessBlocked();
  await withTimeout(runTransaction(db, async (tx)=>{
    const iRef = indexRef();
    const indexSnap = await tx.get(iRef);
    const index = indexSnap.exists() ? JSON.parse(indexSnap.data().value) : [];
    let indexChanged = false;
    entries.forEach(entry=>{
      tx.set(docRef(entry.id), { value: JSON.stringify(entry) });
      if(!index.includes(entry.id)){ index.push(entry.id); indexChanged = true; }
    });
    if(indexChanged) tx.set(iRef, { value: JSON.stringify(index) });
  }), STORAGE_TIMEOUT_MS);
  if(cacheKey) invalidate(cacheKey);
}

async function removeMany(ids){
  assertNotAccessBlocked();
  await withTimeout(runTransaction(db, async (tx)=>{
    const iRef = indexRef();
    const indexSnap = await tx.get(iRef);
    const index = indexSnap.exists() ? JSON.parse(indexSnap.data().value) : [];
    ids.forEach(id=> tx.delete(docRef(id)));
    const newIndex = index.filter(existingId=> !ids.includes(existingId));
    tx.set(iRef, { value: JSON.stringify(newIndex) });
  }), STORAGE_TIMEOUT_MS);
  if(cacheKey) invalidate(cacheKey);
}

return { getAll, save, remove, saveMany, removeMany };
```

Neue Wrapper neben `saveTransaction`/`deleteTransaction`
(`index.html:1655-1657`):

```js
async function saveTransactions(txs){ return transactionsStore.saveMany(txs); }
async function deleteTransactions(ids){ return transactionsStore.removeMany(ids); }
```

### Formular: Segmented Control statt Einnahme/Ausgabe-Doppelfeld

`viewTransactionDetail()` bekommt oben ein Segmented Control
(wiederverwendet `.tab-bar`/`.tab-btn`-Styles, neue Wrapper-Klasse
`.tx-type-bar` nur für Abstand):

```
[ Einnahme ]  [ Ausgabe ]  [ Umbuchung ]   ← Umbuchung nur wenn financeAccounts.length > 1
```

Ausgewählter Typ steckt in `state.newTxSegment`
(`'income' | 'expense' | 'transfer'`), Wechsel löst `render()` aus —
gleiches Muster wie die bestehenden Finance-Tab-Buttons
(`index.html:7715-7720`). `goToTransactionDetail()` initialisiert
`state.newTxSegment` beim Öffnen der Ansicht:

```js
function goToTransactionDetail(transactionId){
  state.currentTransactionId = transactionId || null;
  const t = transactionId ? state.financeTransactions.find(x=>x.id===transactionId) : null;
  state.newTxSegment = t ? (t.amount>=0 ? 'income' : 'expense') : 'income';
  state.view = 'transactionDetail';
  render();
}
```

Bewusster Scope-Cut: Beim Segment-Wechsel werden bereits getippte Felder
(Bezeichnung/Datum) zurückgesetzt, es gibt keine Draft-Erhaltung über
den Re-Render hinweg — das Segmented Control steht deshalb ganz oben im
Formular, damit der Typ vor der restlichen Eingabe gewählt wird. Kein
neuer partieller-DOM-Diff-Mechanismus, konsistent mit dem
`render()`-Vollneuaufbau, den die App überall sonst für State-Wechsel
nutzt.

`viewTransactionDetail()`-Zweige (Reihenfolge der Prüfung):

1. `financeAccounts.length===0` → unverändert (Empty State).
2. `isLocked` (`fromArrears`) → unverändert.
3. **Neu:** `isTransfer` (`isEdit && existingTransaction.transferId`) →
   gesperrter Zweig analog `fromArrears`: Von-Konto/Nach-Konto als
   deaktivierte Text-Felder, Hinweistext („Diese Umbuchung verschiebt
   Geld zwischen zwei Konten. Von/Nach sind nach dem Anlegen nicht mehr
   änderbar."), Betrag/Datum/Bezeichnung editierbar.
4. Sonst (neue Transaction ODER Bearbeiten einer bestehenden
   Einnahme/Ausgabe): Segmented Control + je nach `state.newTxSegment`:
   - `income`/`expense`: Konto/Kasse-Select, Bezeichnung, Datum, **ein**
     Betragsfeld (`new-tx-amount`, `min="0"`) — ersetzt die bisherigen
     zwei Felder `new-tx-income`/`new-tx-expense` samt der
     `(income>0) === (expense>0)`-Sonderregel. Beim Bearbeiten einer
     bestehenden Einnahme/Ausgabe zeigt das Segmented Control nur
     Einnahme/Ausgabe (kein nachträgliches Umwandeln in eine Umbuchung).
   - `transfer` (nur bei neuer Transaction wählbar): Von-Konto-Select
     (`new-tx-from-account`), Nach-Konto-Select (`new-tx-to-account`),
     Betrag (`new-tx-transfer-amount`, `> 0`), Datum, Bezeichnung
     (optional, Platzhalter „z. B. Bargeld einzahlen").

Nach-Konto-Select wird beim Öffnen mit allen Konten außer dem aktuell
gewählten Von-Konto befüllt; ein `change`-Listener auf dem Von-Select
baut die `<option>`-Liste des Nach-Selects direkt neu auf (gezieltes
DOM-Update, kein `render()`), damit das zuvor gewählte Von-Konto dort
gar nicht erst anwählbar ist. Bei genau 2 Konten bleibt nach der
Von-Auswahl automatisch nur ein Nach-Konto übrig (Browser wählt das
einzige `<option>` automatisch).

### `attachTransactionDetailListeners()` — Speichern

Drei Pfade beim Klick auf „Speichern":

1. `isLocked` (`fromArrears`) — unverändert.
2. `isTransfer` (Bearbeiten): liest Betrag/Datum/Bezeichnung, aktualisiert
   beide gekoppelten Transactions (`out`: `-betrag`, `in`: `+betrag`,
   gleiche `description`/`date`), `await saveTransactions([outTx, inTx])`.
3. Sonst:
   - `newTxSegment !== 'transfer'`: wie bisher, aber mit einem
     Betragsfeld statt zwei; Vorzeichen ergibt sich aus dem Segment
     (`income` → positiv, `expense` → negativ). Validierung: Betrag
     `> 0`, Bezeichnung, Datum Pflicht (ersetzt die alte
     `(income>0) === (expense>0)`-Prüfung).
   - `newTxSegment === 'transfer'` (nur `!isEdit`): validiert Von ≠ Nach
     (defensiv, UI verhindert das bereits), Betrag `> 0`, Datum;
     Bezeichnung fällt auf `Umbuchung {Von} → {Nach}` zurück, falls leer.
     Baut `outTx`/`inTx` mit gemeinsamer `transferId: uid('transfer')`,
     pusht beide in `state.financeTransactions`, `await
     saveTransactions([outTx, inTx])`.

### Liste (`buildFinanceTransactionsTab()`)

Vor dem bestehenden Zeilen-Mapping wird gefiltert:
`byYear`-Gruppierung nur über Transaktionen, bei denen
`!t.transferId || t.transferRole==='out'` gilt — die `'in'`-Seite einer
Umbuchung wird nicht separat gerendert, pro Umbuchung erscheint genau
eine Zeile.

Zeilen-Darstellung für Umbuchungen (statt +/‑ Farbcodierung):
- Neues Icon `ICON_TRANSFER` (zwei gegenläufige Pfeile, gleiches
  Stroke-Muster wie `ICON_ACCOUNT_*`, `index.html:3009-3020`) anstelle
  der Konto-Icon-Zeile.
- Meta-Zeile: „{Datum} · Von {Konto A} nach {Konto B}" statt „{Datum} ·
  {Konto-Icon}{Kontoname}".
- Betrag neutral (`fmtEuro(Math.abs(amount))`, ohne `+`/`-`-Vorzeichen),
  neue CSS-Klasse `.transaction-amount.transfer{color:var(--muted);}`
  statt `.positive`/`.negative`.

`data-id` der Zeile bleibt die `id` der `'out'`-Transaction; Klick ruft
weiterhin `goToTransactionDetail(row.dataset.id)` — `viewTransactionDetail()`
findet die gekoppelte `'in'`-Seite bei Bedarf über
`state.financeTransactions.find(x=>x.transferId===t.transferId && x.id!==t.id)`.

### Löschen (`showDeleteTransactionModal()`)

Erkennt `transaction.transferId`, sucht die gekoppelte Transaction
(`transferRole` umgekehrt), Dialogtext bleibt generisch (wie entschieden).
Im Confirm-Handler:

```js
if(transaction.transferId){
  const paired = state.financeTransactions.find(t=>t.transferId===transaction.transferId && t.id!==transaction.id);
  state.financeTransactions = state.financeTransactions.filter(t=>t.id!==transaction.id && t.id!==(paired&&paired.id));
  await deleteTransactions(paired ? [transaction.id, paired.id] : [transaction.id]);
}else{
  // bestehender Einzel-Lösch-Pfad unverändert
}
```

Der bestehende `fromArrears`-Rückbuchungs-Pfad bleibt unverändert
(Umbuchung und `fromArrears` schließen sich gegenseitig aus — eine
Transaction ist nie beides).

## Testplan (manuell, da kein automatisiertes Test-Setup im Projekt)

- Genau 1 Konto vorhanden: Segmented Control zeigt nur Einnahme/Ausgabe,
  „Umbuchung" erscheint nicht.
- 2 Konten: „Umbuchung" wählen → Von-Konto wählen → Nach-Konto ist
  automatisch das verbleibende Konto vorbelegt.
- 3+ Konten: Von-Konto wählen → gewähltes Konto verschwindet aus der
  Nach-Liste; Von erneut ändern → Nach-Liste aktualisiert sich korrekt,
  vorherige Nach-Auswahl bleibt erhalten falls noch gültig.
- Umbuchung anlegen mit leerer Bezeichnung → Default-Text „Umbuchung
  {Von} → {Nach}" erscheint in Liste und Detailansicht.
- Nach dem Anlegen: `financeAccountBalance()` beider beteiligten Konten
  korrekt (Von -Betrag, Nach +Betrag), `Gesamtbetrag` in `viewFinance()`
  unverändert (Umbuchung netto null).
- Umsätze-Liste: Umbuchung erscheint als **eine** Zeile mit Transfer-Icon
  und „Von X nach Y", keine zweite Zeile für die Gegenbuchung, kein
  Einfluss auf sonstige Einnahme/Ausgabe-Zeilen.
- Umbuchung bearbeiten: Von/Nach gesperrt mit Hinweistext, Betrag/Datum/
  Bezeichnung änderbar, Änderung wirkt auf beide Konten-Salden korrekt.
- Umbuchung löschen: beide gekoppelten Buchungen verschwinden aus der
  Liste und aus beiden Konto-Salden.
- Bestehende Einnahme/Ausgabe anlegen/bearbeiten funktioniert weiterhin
  mit dem neuen Ein-Feld-Betrag; Segmented Control Einnahme↔Ausgabe beim
  Bearbeiten schaltet das Vorzeichen korrekt um.
- Read-Only-Nutzer (kein `canManageFinances()`): Formular weiterhin
  komplett deaktiviert, keine neuen interaktiven Elemente durchbrechen
  die Sperre.
- Netzwerk-Unterbrechung/Fehler während `saveMany`/`removeMany`: keine
  Halbbuchung sichtbar (Firestore-`runTransaction` schlägt komplett fehl
  oder committet komplett).
