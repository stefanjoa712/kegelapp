# Umbuchungen zwischen Konten/Kassen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third booking type "Umbuchung" (transfer) to the Finanzverwaltung's Umsätze so club treasurers can move money between two of their own accounts/cash boxes without it inflating real Einnahme/Ausgabe totals — replacing the current double-Ausgabe/Einnahme-on-two-separate-transactions workaround.

**Architecture:** A transfer is stored as two coupled `financeTransactions` documents sharing a `transferId` (one `transferRole:'out'` with a negative amount, one `transferRole:'in'` with a positive amount), written/deleted together in a single Firestore `runTransaction` via new `saveMany()`/`removeMany()` methods on the existing `makeClubEntityStore()`. Because every transaction still has exactly one `accountId` and one `amount`, `financeAccountBalance()` and the `totalAmount` sum in `viewFinance()` need no changes — the two amounts net to zero across all accounts combined while crediting/debiting each account correctly. The transaction form gets a Fluent-2 segmented control (Einnahme/Ausgabe/Umbuchung, reusing the existing `.finance-tab-bar` styling) replacing the old two-field Einnahme/Ausgabe input; the Umsätze list collapses each transfer pair into a single row with a dedicated icon instead of +/- color coding.

**Tech Stack:** Vanilla JS (ES modules, no build step), Firebase Auth + Firestore, single `index.html` (one `<script type="module">` block, no separate frontend files).

## Global Constraints

- No build step: all changes go directly into `index.html`'s single `<script type="module">` block. Do not introduce new files or frameworks.
- German UI text and German comments (only where the WHY is non-obvious), matching the surrounding code's tone and 2-space indentation.
- No automated test setup exists anywhere in this repo (no root `package.json`, no test runner). Verification is manual: extract the module script and run `node --check` on it for syntax, plus a browser click-through (console free of errors) for behavior.
- **Windows/Git-Bash note:** `/tmp/...` paths do not resolve correctly for the Windows `node` binary in this environment (it treats `/tmp` as `C:\tmp`, which does not exist). Write the extracted module script to a **relative** path in the current working directory instead (e.g. `module-check.mjs`), then delete it after the check. Every verification step below already uses this relative-path form — do not substitute `/tmp`.
- Per the approved design (`docs/superpowers/specs/2026-08-07-umbuchungen-design.md`): Option B data model (two coupled transactions, not a single `type:'transfer'` document); "Umbuchung" only appears in the segmented control when `state.financeAccounts.length > 1`; editing an existing transfer only allows changing amount/date/description (Von/Nach stay locked, with an explanatory hint); editing an existing income/expense transaction never offers "Umbuchung" as an option; the delete confirmation dialog stays generic (no special transfer wording); no Firestore Rules changes — atomicity comes from the client-side `runTransaction`.
- Reuse existing patterns exactly: `.finance-tab-bar`/`.tab-btn` styling for the segmented control (not `.evening-tab-bar`, which is the dark header variant), the `state.<x> = ...; render();` pattern used by the existing Finance-Tab buttons for segment switching, and the `fromArrears`-locked branch in `viewTransactionDetail()` as the template for the new transfer-locked-edit branch.

---

### Task 1: Storage layer — `saveMany`/`removeMany`, transfer icon, CSS

**Files:**
- Modify: `index.html:1503-1547` (`makeClubEntityStore()`)
- Modify: `index.html:1654-1657` (transaction store wrappers)
- Modify: `index.html:3016-3017` (finance icon constants)
- Modify: `index.html:446-448` (`.finance-tab-bar` CSS)
- Modify: `index.html:534-536` (`.transaction-amount` CSS)

**Interfaces:**
- Produces: `makeClubEntityStore()` return value gains `saveMany(entries: object[]): Promise<void>` and `removeMany(ids: string[]): Promise<void>`, each writing/deleting all given documents plus the index document in one Firestore `runTransaction`. New module functions `saveTransactions(txs: object[]): Promise<void>` and `deleteTransactions(ids: string[]): Promise<void>` wrap `transactionsStore.saveMany`/`removeMany`. New constant `ICON_TRANSFER` (SVG markup string, same shape as `ICON_ACCOUNT_EURO`). New CSS classes `.tx-type-bar` and `.transaction-amount.transfer`.
- Consumes: existing `docRef`/`indexRef`/`assertNotAccessBlocked`/`withTimeout`/`runTransaction`/`STORAGE_TIMEOUT_MS`/`invalidate`/`cacheKey` closures already defined inside `makeClubEntityStore()`.

- [ ] **Step 1: Add `saveMany`/`removeMany` to `makeClubEntityStore()`**

Find this exact block:

```js
    async function remove(id){
      assertNotAccessBlocked();
      await withTimeout(runTransaction(db, async (tx)=>{
        const iRef = indexRef();
        const indexSnap = await tx.get(iRef);
        const index = indexSnap.exists() ? JSON.parse(indexSnap.data().value) : [];
        tx.delete(docRef(id));
        const newIndex = index.filter(existingId=>existingId!==id);
        tx.set(iRef, { value: JSON.stringify(newIndex) });
      }), STORAGE_TIMEOUT_MS);
      if(cacheKey) invalidate(cacheKey);
    }

    return { getAll, save, remove };
  }
```

Replace it with:

```js
    async function remove(id){
      assertNotAccessBlocked();
      await withTimeout(runTransaction(db, async (tx)=>{
        const iRef = indexRef();
        const indexSnap = await tx.get(iRef);
        const index = indexSnap.exists() ? JSON.parse(indexSnap.data().value) : [];
        tx.delete(docRef(id));
        const newIndex = index.filter(existingId=>existingId!==id);
        tx.set(iRef, { value: JSON.stringify(newIndex) });
      }), STORAGE_TIMEOUT_MS);
      if(cacheKey) invalidate(cacheKey);
    }

    // saveMany/removeMany schreiben bzw. löschen mehrere Dokumente + das Index-Dokument in EINER
    // runTransaction (Issue #83, Umbuchungen: zwei per transferId gekoppelte Transaktionen, die
    // nie nur einseitig existieren dürfen). Gleiches Muster wie save()/remove(), nur mit einer
    // Schleife über mehrere Doc-Refs statt einem einzelnen.
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
  }
```

- [ ] **Step 2: Add `saveTransactions`/`deleteTransactions` wrappers**

Find this exact block:

```js
  const transactionsStore = makeClubEntityStore('transactions', 'financeTransactions');
  async function getAllTransactions(){ return transactionsStore.getAll(); }
  async function saveTransaction(tx){ return transactionsStore.save(tx); }
  async function deleteTransaction(id){ return transactionsStore.remove(id); }
```

Replace it with:

```js
  const transactionsStore = makeClubEntityStore('transactions', 'financeTransactions');
  async function getAllTransactions(){ return transactionsStore.getAll(); }
  async function saveTransaction(tx){ return transactionsStore.save(tx); }
  async function deleteTransaction(id){ return transactionsStore.remove(id); }
  // Umbuchungen (Issue #83) bestehen aus zwei per transferId gekoppelten Transaktionen, die immer
  // gemeinsam geschrieben/gelöscht werden müssen, damit nie nur eine Seite existiert - nutzt
  // saveMany()/removeMany() (eine einzelne Firestore-runTransaction für beide Dokumente).
  async function saveTransactions(txs){ return transactionsStore.saveMany(txs); }
  async function deleteTransactions(ids){ return transactionsStore.removeMany(ids); }
```

- [ ] **Step 3: Add the `ICON_TRANSFER` constant**

Find this exact block:

```js
  const ICON_ACCOUNT_EURO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 7a6.5 6.5 0 1 0 0 10"/><path d="M4 10h9M4 14h7"/></svg>`;
  const FINANCE_ACCOUNT_ICONS = {
```

Replace it with:

```js
  const ICON_ACCOUNT_EURO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 7a6.5 6.5 0 1 0 0 10"/><path d="M4 10h9M4 14h7"/></svg>`;
  // Icon für Umbuchungs-Zeilen in der Umsätze-Liste (Issue #83): zwei gegenläufige Pfeile statt
  // der Konto-Icons, ersetzt dort auch die +/- Farbcodierung des Betrags (siehe
  // buildFinanceTransactionsTab()) - eine Umbuchung ist weder Einnahme noch Ausgabe.
  const ICON_TRANSFER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h11l-3-3"/><path d="M18 7l-3 3"/><path d="M17 17H6l3 3"/><path d="M6 17l3-3"/></svg>`;
  const FINANCE_ACCOUNT_ICONS = {
```

- [ ] **Step 4: Add the segmented-control and transfer-amount CSS**

Find this exact block:

```css
  .finance-tab-bar{padding:0; margin:14px 0 16px; background:var(--surface); border:2px solid var(--ink); border-radius:10px; overflow:hidden;}
  .finance-tab-bar .tab-btn{color:var(--ink); background:none; border-radius:0;}
  .finance-tab-bar .tab-btn.active{background:var(--wood); color:#fff;}
```

Replace it with:

```css
  .finance-tab-bar{padding:0; margin:14px 0 16px; background:var(--surface); border:2px solid var(--ink); border-radius:10px; overflow:hidden;}
  .finance-tab-bar .tab-btn{color:var(--ink); background:none; border-radius:0;}
  .finance-tab-bar .tab-btn.active{background:var(--wood); color:#fff;}
  /* Segmented Control Einnahme/Ausgabe/Umbuchung im Umsatz-Formular (Issue #83) - wiederverwendet
     .finance-tab-bar, nur ohne den oberen Card-Abstand, da sie das erste Element der Karte ist. */
  .tx-type-bar{margin-top:0;}
```

Find this exact block:

```css
  .transaction-amount{font-family:var(--font-mono); font-weight:700; white-space:nowrap; flex-shrink:0;}
  .transaction-amount.positive{color:#1a7a3c;}
  .transaction-amount.negative{color:var(--wine);}
```

Replace it with:

```css
  .transaction-amount{font-family:var(--font-mono); font-weight:700; white-space:nowrap; flex-shrink:0;}
  .transaction-amount.positive{color:#1a7a3c;}
  .transaction-amount.negative{color:var(--wine);}
  .transaction-amount.transfer{color:var(--muted);}
```

- [ ] **Step 5: Syntax-check the module script**

Run:
```bash
node -e "const fs=require('fs');const html=fs.readFileSync('index.html','utf8');const m=html.match(/<script type=\"module\">([\s\S]*?)<\/script>/);fs.writeFileSync('module-check.mjs', m[1]);"
node --check module-check.mjs && rm module-check.mjs
```
Expected: no output from `node --check`, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "Add saveMany/removeMany storage layer and transfer icon/CSS for Umbuchungen (Issue #83)"
```

---

### Task 2: Segmented-control state — `state.newTxSegment` + `goToTransactionDetail()`

**Files:**
- Modify: `index.html:1272` (initial `state` object)
- Modify: `index.html:8729-8733` (`goToTransactionDetail()`)

**Interfaces:**
- Produces: `state.newTxSegment` (`'income' | 'expense' | 'transfer'`), initialized to `'income'` and re-set by `goToTransactionDetail(transactionId)` every time the transaction-detail view is opened (based on the existing transaction's amount sign, or `'income'` for a new one). Read by `viewTransactionDetail()`/`attachTransactionDetailListeners()` in Task 3.
- Consumes: `state.financeTransactions` (existing).

- [ ] **Step 1: Add the initial state field**

Find this exact block:

```js
    currentArrearsName:'',
    currentArrearsMemberId:null,
    currentTransactionId:null,
```

Replace it with:

```js
    currentArrearsName:'',
    currentArrearsMemberId:null,
    currentTransactionId:null,
    // Ausgewählter Reiter im Umsatz-Formular ('income'/'expense'/'transfer', Issue #83) - wird von
    // goToTransactionDetail() beim Öffnen gesetzt und von den Segment-Buttons in
    // attachTransactionDetailListeners() aktualisiert (siehe viewTransactionDetail()).
    newTxSegment:'income',
```

- [ ] **Step 2: Update `goToTransactionDetail()`**

Find this exact block:

```js
  function goToTransactionDetail(transactionId){
    state.currentTransactionId = transactionId || null;
    state.view = 'transactionDetail';
    render();
  }
```

Replace it with:

```js
  function goToTransactionDetail(transactionId){
    state.currentTransactionId = transactionId || null;
    // Segmented Control (Issue #83): Startzustand richtet sich nach dem Vorzeichen einer
    // bestehenden Transaktion, sonst Default "Einnahme".
    const t = transactionId ? state.financeTransactions.find(x=>x.id===transactionId) : null;
    state.newTxSegment = t ? (t.amount>=0 ? 'income' : 'expense') : 'income';
    state.view = 'transactionDetail';
    render();
  }
```

- [ ] **Step 3: Syntax-check the module script**

Run:
```bash
node -e "const fs=require('fs');const html=fs.readFileSync('index.html','utf8');const m=html.match(/<script type=\"module\">([\s\S]*?)<\/script>/);fs.writeFileSync('module-check.mjs', m[1]);"
node --check module-check.mjs && rm module-check.mjs
```
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Add newTxSegment state for the transaction-type segmented control (Issue #83)"
```

---

### Task 3: Transaction form — segmented control, single amount field, transfer sub-form, wiring

**Files:**
- Modify: `index.html:8735-8846` (`viewTransactionDetail()` and `attachTransactionDetailListeners()`)

**Interfaces:**
- Consumes: `state.newTxSegment` (Task 2), `saveTransactions()` (Task 1), `ICON_TRANSFER`/`.tx-type-bar` (Task 1, used in Task 4), `financeAccountNameById()` (existing, `index.html:3338`), `canManageFinances()` (existing), `uid()` (existing, `index.html:1847`).
- Produces: transfer-creation writes two `financeTransactions` entries shaped `{id, accountId, amount, description, date, transferId, transferRole:'out'|'in', createdAt}` — the exact shape `buildFinanceTransactionsTab()` (Task 4) and `showDeleteTransactionModal()` (Task 5) rely on (`t.transferId`, `t.transferRole`).

- [ ] **Step 1: Replace `viewTransactionDetail()`**

Find this exact block:

```js
  function viewTransactionDetail(){
    const existingTransaction = state.currentTransactionId ? state.financeTransactions.find(t=>t.id===state.currentTransactionId) : null;
    const isEdit = !!existingTransaction;
    const isLocked = isEdit && !!existingTransaction.fromArrears;
    // Read-Only für Nutzer ohne Finanz-Verwaltungsrechte (siehe canManageFinances()) - enger
    // gefasst als canManageMembers(): hier nur Kassenwart oder Admin, kein Präsident.
    const readOnly = !canManageFinances();
    const disabledAttr = readOnly ? ' disabled' : '';
    if(state.financeAccounts.length===0){
      return `<div class="card"><p class="empty-state">Noch kein Konto/Kasse angelegt. Lege zuerst in den Einstellungen unter „Finanzverwaltung" eines an.</p></div>`;
    }
    if(isLocked){
      return `
        <div class="card">
          ${readOnly ? `<p class="hint" style="margin-top:0;">Nur Kassenwart oder Admin können Umsätze bearbeiten.</p>` : `<p class="hint">Dieser Umsatz stammt aus einer Rückstandszahlung. Betrag, Konto und Datum sind nicht mehr änderbar, die Bezeichnung schon.</p>`}
          <label for="new-tx-description">Bezeichnung</label>
          <input type="text" id="new-tx-description" value="${escapeHtml(existingTransaction.description)}"${disabledAttr}>
          <label>Konto/Kasse</label>
          <input type="text" value="${escapeHtml(financeAccountNameById(existingTransaction.accountId))}" disabled>
          <label>Datum</label>
          <input type="text" value="${formatDateDE(existingTransaction.date)}" disabled>
          <label>${existingTransaction.amount>=0?'Einnahme':'Ausgabe'} (€)</label>
          <input type="text" value="${fmtEuro(Math.abs(existingTransaction.amount))}" disabled>
          ${readOnly ? '' : `<p class="form-error" id="tx-form-error"></p>
          <button type="button" class="btn-primary" id="save-tx-btn" style="width:100%;">Speichern</button>`}
        </div>
      `;
    }
    const isExpenseEdit = isEdit && existingTransaction.amount<0;
    const accountOptionsHtml = state.financeAccounts.map(a=>`<option value="${a.id}"${(isEdit && existingTransaction.accountId===a.id)?' selected':''}>${escapeHtml(a.name)}</option>`).join('');
    return `
      <div class="card">
        ${readOnly ? `<p class="hint" style="margin-top:0;">Nur Kassenwart oder Admin können Umsätze bearbeiten.</p>` : ''}
        <label for="new-tx-account">Konto/Kasse</label>
        <select id="new-tx-account"${disabledAttr}>${accountOptionsHtml}</select>
        <label for="new-tx-description">Bezeichnung</label>
        <input type="text" id="new-tx-description" placeholder="z. B. Kegelbahn Miete" value="${isEdit?escapeHtml(existingTransaction.description):''}"${disabledAttr}>
        <label for="new-tx-date">Datum</label>
        <input type="date" id="new-tx-date" value="${isEdit?existingTransaction.date:todayISO()}"${disabledAttr}>
        <label for="new-tx-income">Einnahme (€)</label>
        <input type="number" id="new-tx-income" min="0" step="0.01" placeholder="0,00" value="${(isEdit && !isExpenseEdit)?Math.abs(existingTransaction.amount).toFixed(2):''}"${disabledAttr}>
        <label for="new-tx-expense">Ausgabe (€)</label>
        <input type="number" id="new-tx-expense" min="0" step="0.01" placeholder="0,00" value="${isExpenseEdit?Math.abs(existingTransaction.amount).toFixed(2):''}"${disabledAttr}>
        ${readOnly ? '' : `<p class="form-error" id="tx-form-error"></p>
        <button type="button" class="btn-primary" id="save-tx-btn" style="width:100%;">${isEdit?'Speichern':'Hinzufügen'}</button>`}
      </div>
    `;
  }
```

Replace it with:

```js
  function viewTransactionDetail(){
    const existingTransaction = state.currentTransactionId ? state.financeTransactions.find(t=>t.id===state.currentTransactionId) : null;
    const isEdit = !!existingTransaction;
    const isLocked = isEdit && !!existingTransaction.fromArrears;
    const isTransfer = isEdit && !!existingTransaction.transferId;
    // Read-Only für Nutzer ohne Finanz-Verwaltungsrechte (siehe canManageFinances()) - enger
    // gefasst als canManageMembers(): hier nur Kassenwart oder Admin, kein Präsident.
    const readOnly = !canManageFinances();
    const disabledAttr = readOnly ? ' disabled' : '';
    if(state.financeAccounts.length===0){
      return `<div class="card"><p class="empty-state">Noch kein Konto/Kasse angelegt. Lege zuerst in den Einstellungen unter „Finanzverwaltung" eines an.</p></div>`;
    }
    if(isLocked){
      return `
        <div class="card">
          ${readOnly ? `<p class="hint" style="margin-top:0;">Nur Kassenwart oder Admin können Umsätze bearbeiten.</p>` : `<p class="hint">Dieser Umsatz stammt aus einer Rückstandszahlung. Betrag, Konto und Datum sind nicht mehr änderbar, die Bezeichnung schon.</p>`}
          <label for="new-tx-description">Bezeichnung</label>
          <input type="text" id="new-tx-description" value="${escapeHtml(existingTransaction.description)}"${disabledAttr}>
          <label>Konto/Kasse</label>
          <input type="text" value="${escapeHtml(financeAccountNameById(existingTransaction.accountId))}" disabled>
          <label>Datum</label>
          <input type="text" value="${formatDateDE(existingTransaction.date)}" disabled>
          <label>${existingTransaction.amount>=0?'Einnahme':'Ausgabe'} (€)</label>
          <input type="text" value="${fmtEuro(Math.abs(existingTransaction.amount))}" disabled>
          ${readOnly ? '' : `<p class="form-error" id="tx-form-error"></p>
          <button type="button" class="btn-primary" id="save-tx-btn" style="width:100%;">Speichern</button>`}
        </div>
      `;
    }
    // Umbuchungen bestehen aus zwei per transferId gekoppelten Transaktionen (Issue #83) - beim
    // Bearbeiten bleiben Von-/Nach-Konto fix (analog zur fromArrears-Sperre oben), nur Betrag,
    // Datum und Bezeichnung sind änderbar. Beide gekoppelten Dokumente werden beim Speichern
    // gemeinsam aktualisiert (siehe attachTransactionDetailListeners()).
    if(isTransfer){
      const pairedTx = state.financeTransactions.find(t=>t.transferId===existingTransaction.transferId && t.id!==existingTransaction.id);
      const fromTx = existingTransaction.amount<0 ? existingTransaction : pairedTx;
      const toTx = existingTransaction.amount<0 ? pairedTx : existingTransaction;
      return `
        <div class="card">
          ${readOnly ? `<p class="hint" style="margin-top:0;">Nur Kassenwart oder Admin können Umsätze bearbeiten.</p>` : `<p class="hint">Diese Umbuchung verschiebt Geld zwischen zwei Konten. Von/Nach sind nach dem Anlegen nicht mehr änderbar.</p>`}
          <label for="new-tx-description">Bezeichnung</label>
          <input type="text" id="new-tx-description" value="${escapeHtml(existingTransaction.description)}"${disabledAttr}>
          <label>Von Konto/Kasse</label>
          <input type="text" value="${escapeHtml(financeAccountNameById(fromTx.accountId))}" disabled>
          <label>Nach Konto/Kasse</label>
          <input type="text" value="${escapeHtml(financeAccountNameById(toTx.accountId))}" disabled>
          <label for="new-tx-date">Datum</label>
          <input type="date" id="new-tx-date" value="${existingTransaction.date}"${disabledAttr}>
          <label for="new-tx-transfer-amount">Betrag (€)</label>
          <input type="number" id="new-tx-transfer-amount" min="0" step="0.01" value="${Math.abs(existingTransaction.amount).toFixed(2)}"${disabledAttr}>
          ${readOnly ? '' : `<p class="form-error" id="tx-form-error"></p>
          <button type="button" class="btn-primary" id="save-tx-btn" style="width:100%;">Speichern</button>`}
        </div>
      `;
    }
    // Einnahme/Ausgabe/Umbuchung als Segmented Control (Issue #83) statt der früheren zwei
    // Zahlenfelder Einnahme/Ausgabe mit "genau eines von beiden"-Validierung. state.newTxSegment
    // wird von goToTransactionDetail() beim Öffnen gesetzt und von den Segment-Buttons in
    // attachTransactionDetailListeners() aktualisiert (jeweils mit anschließendem render(), gleiches
    // Muster wie die bestehenden Finance-Tab-Buttons). "Umbuchung" nur bei einer neuen Transaction
    // und >1 Konto - eine bestehende Einnahme/Ausgabe lässt sich nicht nachträglich in eine
    // Umbuchung umwandeln (siehe Design-Spec).
    const segment = state.newTxSegment || 'income';
    const canTransfer = !isEdit && state.financeAccounts.length>1;
    const segmentedControlHtml = `
      <div class="tab-bar finance-tab-bar tx-type-bar">
        <button type="button" class="tab-btn${segment==='income'?' active':''}" id="tx-type-income-btn"${disabledAttr}>Einnahme</button>
        <button type="button" class="tab-btn${segment==='expense'?' active':''}" id="tx-type-expense-btn"${disabledAttr}>Ausgabe</button>
        ${canTransfer ? `<button type="button" class="tab-btn${segment==='transfer'?' active':''}" id="tx-type-transfer-btn"${disabledAttr}>Umbuchung</button>` : ''}
      </div>
    `;
    if(segment==='transfer'){
      const fromAccountId = state.financeAccounts[0].id;
      const toAccounts = state.financeAccounts.filter(a=>a.id!==fromAccountId);
      const fromOptionsHtml = state.financeAccounts.map(a=>`<option value="${a.id}"${a.id===fromAccountId?' selected':''}>${escapeHtml(a.name)}</option>`).join('');
      const toOptionsHtml = toAccounts.map(a=>`<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
      return `
        <div class="card">
          ${readOnly ? `<p class="hint" style="margin-top:0;">Nur Kassenwart oder Admin können Umsätze bearbeiten.</p>` : ''}
          ${segmentedControlHtml}
          <label for="new-tx-from-account">Von Konto/Kasse</label>
          <select id="new-tx-from-account"${disabledAttr}>${fromOptionsHtml}</select>
          <label for="new-tx-to-account">Nach Konto/Kasse</label>
          <select id="new-tx-to-account"${disabledAttr}>${toOptionsHtml}</select>
          <label for="new-tx-transfer-amount">Betrag (€)</label>
          <input type="number" id="new-tx-transfer-amount" min="0" step="0.01" placeholder="0,00"${disabledAttr}>
          <label for="new-tx-date">Datum</label>
          <input type="date" id="new-tx-date" value="${todayISO()}"${disabledAttr}>
          <label for="new-tx-description">Bezeichnung</label>
          <input type="text" id="new-tx-description" placeholder="z. B. Bargeld einzahlen"${disabledAttr}>
          ${readOnly ? '' : `<p class="form-error" id="tx-form-error"></p>
          <button type="button" class="btn-primary" id="save-tx-btn" style="width:100%;">Hinzufügen</button>`}
        </div>
      `;
    }
    const accountOptionsHtml = state.financeAccounts.map(a=>`<option value="${a.id}"${(isEdit && existingTransaction.accountId===a.id)?' selected':''}>${escapeHtml(a.name)}</option>`).join('');
    return `
      <div class="card">
        ${readOnly ? `<p class="hint" style="margin-top:0;">Nur Kassenwart oder Admin können Umsätze bearbeiten.</p>` : ''}
        ${segmentedControlHtml}
        <label for="new-tx-account">Konto/Kasse</label>
        <select id="new-tx-account"${disabledAttr}>${accountOptionsHtml}</select>
        <label for="new-tx-description">Bezeichnung</label>
        <input type="text" id="new-tx-description" placeholder="z. B. Kegelbahn Miete" value="${isEdit?escapeHtml(existingTransaction.description):''}"${disabledAttr}>
        <label for="new-tx-date">Datum</label>
        <input type="date" id="new-tx-date" value="${isEdit?existingTransaction.date:todayISO()}"${disabledAttr}>
        <label for="new-tx-amount">Betrag (€)</label>
        <input type="number" id="new-tx-amount" min="0" step="0.01" placeholder="0,00" value="${isEdit?Math.abs(existingTransaction.amount).toFixed(2):''}"${disabledAttr}>
        ${readOnly ? '' : `<p class="form-error" id="tx-form-error"></p>
        <button type="button" class="btn-primary" id="save-tx-btn" style="width:100%;">${isEdit?'Speichern':'Hinzufügen'}</button>`}
      </div>
    `;
  }
```

- [ ] **Step 2: Replace `attachTransactionDetailListeners()`**

Find this exact block:

```js
  function attachTransactionDetailListeners(){
    const overflowBtn = document.getElementById('header-tx-overflow-btn');
    const overflowMenu = document.getElementById('header-tx-overflow-menu');
    if(overflowBtn && overflowMenu){
      overflowBtn.addEventListener('click', (e)=>{
        e.stopPropagation();
        overflowMenu.hidden = !overflowMenu.hidden;
      });
    }
    const deleteBtn = document.getElementById('header-delete-tx-btn');
    if(deleteBtn) deleteBtn.addEventListener('click', ()=>{
      if(overflowMenu) overflowMenu.hidden = true;
      const t = state.financeTransactions.find(x=>x.id===state.currentTransactionId);
      if(t) showDeleteTransactionModal(t);
    });
    const saveBtn = document.getElementById('save-tx-btn');
    if(!saveBtn) return;
    saveBtn.addEventListener('click', async ()=>{
      const existingTransaction = state.currentTransactionId ? state.financeTransactions.find(t=>t.id===state.currentTransactionId) : null;
      const isEdit = !!existingTransaction;
      const isLocked = isEdit && !!existingTransaction.fromArrears;
      const errEl = document.getElementById('tx-form-error');

      if(isLocked){
        const description = document.getElementById('new-tx-description').value.trim();
        if(!description){ errEl.textContent='Bitte eine Bezeichnung angeben.'; return; }
        saveBtn.disabled = true; saveBtn.textContent = 'Speichert…';
        const t = state.financeTransactions.find(x=>x.id===existingTransaction.id);
        if(t) t.description = description;
        if(t) await saveTransaction(t);
        history.back();
        return;
      }

      const accountId = document.getElementById('new-tx-account').value;
      const description = document.getElementById('new-tx-description').value.trim();
      const date = document.getElementById('new-tx-date').value;
      const incomeRaw = document.getElementById('new-tx-income').value.replace(',', '.');
      const expenseRaw = document.getElementById('new-tx-expense').value.replace(',', '.');
      const income = incomeRaw==='' ? 0 : parseFloat(incomeRaw);
      const expense = expenseRaw==='' ? 0 : parseFloat(expenseRaw);

      if(!description){ errEl.textContent='Bitte eine Bezeichnung angeben.'; return; }
      if(!date){ errEl.textContent='Bitte ein Datum angeben.'; return; }
      if(isNaN(income) || isNaN(expense) || income<0 || expense<0){ errEl.textContent='Bitte gültige Beträge angeben.'; return; }
      if((income>0) === (expense>0)){ errEl.textContent='Bitte entweder eine Einnahme oder eine Ausgabe angeben (nicht beides oder keins).'; return; }

      const amount = income>0 ? Math.round(income*100)/100 : -Math.round(expense*100)/100;
      saveBtn.disabled = true; saveBtn.textContent = isEdit ? 'Speichert…' : 'Wird hinzugefügt…';

      let savedTx;
      if(isEdit){
        const t = state.financeTransactions.find(x=>x.id===existingTransaction.id);
        if(t){ t.accountId=accountId; t.description=description; t.date=date; t.amount=amount; }
        savedTx = t;
      }else{
        savedTx = {id:uid('tx'), accountId, description, date, amount, createdAt: Date.now()};
        state.financeTransactions.push(savedTx);
      }
      if(savedTx) await saveTransaction(savedTx);
      history.back();
    });
  }
```

Replace it with:

```js
  function attachTransactionDetailListeners(){
    const overflowBtn = document.getElementById('header-tx-overflow-btn');
    const overflowMenu = document.getElementById('header-tx-overflow-menu');
    if(overflowBtn && overflowMenu){
      overflowBtn.addEventListener('click', (e)=>{
        e.stopPropagation();
        overflowMenu.hidden = !overflowMenu.hidden;
      });
    }
    const deleteBtn = document.getElementById('header-delete-tx-btn');
    if(deleteBtn) deleteBtn.addEventListener('click', ()=>{
      if(overflowMenu) overflowMenu.hidden = true;
      const t = state.financeTransactions.find(x=>x.id===state.currentTransactionId);
      if(t) showDeleteTransactionModal(t);
    });

    // Segmented Control Einnahme/Ausgabe/Umbuchung (Issue #83) - Klick setzt state.newTxSegment und
    // rendert die Ansicht neu (gleiches Muster wie die Finance-Tab-Buttons in
    // attachFinanceListeners()). Nur vorhanden, wenn viewTransactionDetail() gerade den
    // Segmented-Control-Zweig zeigt (nicht bei fromArrears- oder Umbuchungs-Bearbeiten).
    const typeIncomeBtn = document.getElementById('tx-type-income-btn');
    if(typeIncomeBtn) typeIncomeBtn.addEventListener('click', ()=>{ state.newTxSegment='income'; render(); });
    const typeExpenseBtn = document.getElementById('tx-type-expense-btn');
    if(typeExpenseBtn) typeExpenseBtn.addEventListener('click', ()=>{ state.newTxSegment='expense'; render(); });
    const typeTransferBtn = document.getElementById('tx-type-transfer-btn');
    if(typeTransferBtn) typeTransferBtn.addEventListener('click', ()=>{ state.newTxSegment='transfer'; render(); });

    // Von-Konto-Auswahl bei der Umbuchung: das gewählte Konto wird direkt aus der Nach-Liste
    // entfernt (Issue #83) statt nur per Validierung abgefangen - gezieltes Options-Rebuild statt
    // render(), damit ein bereits eingegebener Betrag nicht verloren geht. Bei genau 2 Konten
    // bleibt danach automatisch nur ein Nach-Konto übrig.
    const fromAccountSelect = document.getElementById('new-tx-from-account');
    const toAccountSelect = document.getElementById('new-tx-to-account');
    if(fromAccountSelect && toAccountSelect){
      fromAccountSelect.addEventListener('change', ()=>{
        const previousToValue = toAccountSelect.value;
        const options = state.financeAccounts.filter(a=>a.id!==fromAccountSelect.value);
        toAccountSelect.innerHTML = options.map(a=>`<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
        if(options.some(a=>a.id===previousToValue)) toAccountSelect.value = previousToValue;
      });
    }

    const saveBtn = document.getElementById('save-tx-btn');
    if(!saveBtn) return;
    saveBtn.addEventListener('click', async ()=>{
      const existingTransaction = state.currentTransactionId ? state.financeTransactions.find(t=>t.id===state.currentTransactionId) : null;
      const isEdit = !!existingTransaction;
      const isLocked = isEdit && !!existingTransaction.fromArrears;
      const isTransfer = isEdit && !!existingTransaction.transferId;
      const errEl = document.getElementById('tx-form-error');

      if(isLocked){
        const description = document.getElementById('new-tx-description').value.trim();
        if(!description){ errEl.textContent='Bitte eine Bezeichnung angeben.'; return; }
        saveBtn.disabled = true; saveBtn.textContent = 'Speichert…';
        const t = state.financeTransactions.find(x=>x.id===existingTransaction.id);
        if(t) t.description = description;
        if(t) await saveTransaction(t);
        history.back();
        return;
      }

      if(isTransfer){
        const pairedTx = state.financeTransactions.find(t=>t.transferId===existingTransaction.transferId && t.id!==existingTransaction.id);
        const description = document.getElementById('new-tx-description').value.trim();
        const date = document.getElementById('new-tx-date').value;
        const amountRaw = document.getElementById('new-tx-transfer-amount').value.replace(',', '.');
        const amount = amountRaw==='' ? NaN : parseFloat(amountRaw);
        if(!description){ errEl.textContent='Bitte eine Bezeichnung angeben.'; return; }
        if(!date){ errEl.textContent='Bitte ein Datum angeben.'; return; }
        if(isNaN(amount) || amount<=0){ errEl.textContent='Bitte einen gültigen Betrag angeben.'; return; }
        saveBtn.disabled = true; saveBtn.textContent = 'Speichert…';
        const rounded = Math.round(amount*100)/100;
        const outTx = existingTransaction.amount<0 ? existingTransaction : pairedTx;
        const inTx = existingTransaction.amount<0 ? pairedTx : existingTransaction;
        outTx.description = description; outTx.date = date; outTx.amount = -rounded;
        inTx.description = description; inTx.date = date; inTx.amount = rounded;
        await saveTransactions([outTx, inTx]);
        history.back();
        return;
      }

      const segment = state.newTxSegment || 'income';

      if(segment==='transfer'){
        const fromAccountId = document.getElementById('new-tx-from-account').value;
        const toAccountId = document.getElementById('new-tx-to-account').value;
        const amountRaw = document.getElementById('new-tx-transfer-amount').value.replace(',', '.');
        const amount = amountRaw==='' ? NaN : parseFloat(amountRaw);
        const date = document.getElementById('new-tx-date').value;
        let description = document.getElementById('new-tx-description').value.trim();
        if(!date){ errEl.textContent='Bitte ein Datum angeben.'; return; }
        if(isNaN(amount) || amount<=0){ errEl.textContent='Bitte einen gültigen Betrag angeben.'; return; }
        if(fromAccountId===toAccountId){ errEl.textContent='Von und Nach dürfen nicht identisch sein.'; return; }
        if(!description) description = `Umbuchung ${financeAccountNameById(fromAccountId)} → ${financeAccountNameById(toAccountId)}`;
        saveBtn.disabled = true; saveBtn.textContent = 'Wird hinzugefügt…';
        const rounded = Math.round(amount*100)/100;
        const transferId = uid('transfer');
        const createdAt = Date.now();
        const outTx = {id:uid('tx'), accountId:fromAccountId, amount:-rounded, description, date, transferId, transferRole:'out', createdAt};
        const inTx = {id:uid('tx'), accountId:toAccountId, amount:rounded, description, date, transferId, transferRole:'in', createdAt};
        state.financeTransactions.push(outTx, inTx);
        await saveTransactions([outTx, inTx]);
        history.back();
        return;
      }

      const accountId = document.getElementById('new-tx-account').value;
      const description = document.getElementById('new-tx-description').value.trim();
      const date = document.getElementById('new-tx-date').value;
      const amountRaw = document.getElementById('new-tx-amount').value.replace(',', '.');
      const amountAbs = amountRaw==='' ? NaN : parseFloat(amountRaw);

      if(!description){ errEl.textContent='Bitte eine Bezeichnung angeben.'; return; }
      if(!date){ errEl.textContent='Bitte ein Datum angeben.'; return; }
      if(isNaN(amountAbs) || amountAbs<=0){ errEl.textContent='Bitte einen gültigen Betrag angeben.'; return; }

      const amount = segment==='expense' ? -Math.round(amountAbs*100)/100 : Math.round(amountAbs*100)/100;
      saveBtn.disabled = true; saveBtn.textContent = isEdit ? 'Speichert…' : 'Wird hinzugefügt…';

      let savedTx;
      if(isEdit){
        const t = state.financeTransactions.find(x=>x.id===existingTransaction.id);
        if(t){ t.accountId=accountId; t.description=description; t.date=date; t.amount=amount; }
        savedTx = t;
      }else{
        savedTx = {id:uid('tx'), accountId, description, date, amount, createdAt: Date.now()};
        state.financeTransactions.push(savedTx);
      }
      if(savedTx) await saveTransaction(savedTx);
      history.back();
    });
  }
```

- [ ] **Step 3: Syntax-check the module script**

Run:
```bash
node -e "const fs=require('fs');const html=fs.readFileSync('index.html','utf8');const m=html.match(/<script type=\"module\">([\s\S]*?)<\/script>/);fs.writeFileSync('module-check.mjs', m[1]);"
node --check module-check.mjs && rm module-check.mjs
```
Expected: no output, exit code 0.

- [ ] **Step 4: Manual test — Einnahme/Ausgabe still work with the merged amount field**

Serve the app locally and log in as a Kassenwart/Admin test account with at least 1 Konto/Kasse. Open Finanzverwaltung → Umsätze → „+". Confirm:
- Segmented control shows "Einnahme"/"Ausgabe" (and "Umbuchung" only if ≥2 Konten exist).
- Adding an Einnahme (positive) and an Ausgabe (negative) both work with the single Betrag field, save correctly (check the resulting list row sign and `financeAccountBalance()` via the Konten-Aufteilung modal).
- Editing an existing Einnahme/Ausgabe: segmented control reflects the current sign, switching segment flips the sign on save, "Umbuchung" is not offered as an option.
- Leaving Betrag empty or 0 shows "Bitte einen gültigen Betrag angeben." and does not save.

- [ ] **Step 5: Manual test — creating and editing an Umbuchung (only if ≥2 Konten exist)**

With ≥2 Konten/Kassen configured:
- Click "Umbuchung" → Von/Nach/Betrag/Datum/Bezeichnung fields appear in that order.
- Changing "Von" removes that account from the "Nach" dropdown immediately (no page reload). With exactly 2 accounts, "Nach" ends up with exactly one, already-selected option.
- Saving with an empty Bezeichnung stores `Umbuchung {Von} → {Nach}` as the description (verify by opening the saved transaction's detail view or the list row).
- Saving with Betrag ≤ 0 shows the validation error and does not save.
- Open the saved transfer's detail view: Von/Nach are shown disabled with the hint text, only Betrag/Datum/Bezeichnung are editable; changing the Betrag and saving updates both accounts' balances correctly (check via the Konten-Aufteilung modal).

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "Add transfer segmented control, single amount field, and transfer form to transaction detail (Issue #83)"
```

---

### Task 4: Umsätze list — collapse transfer pairs into one row

**Files:**
- Modify: `index.html:3362-3405` (`buildFinanceTransactionsTab()`)

**Interfaces:**
- Consumes: `t.transferId`/`t.transferRole` (Task 3), `ICON_TRANSFER`/`.transaction-amount.transfer` (Task 1), `financeAccountNameById()` (existing).
- Produces: no interface change — `buildFinanceTransactionsTab(): string` keeps its existing signature, only its rendered output changes for transfer rows.

- [ ] **Step 1: Replace `buildFinanceTransactionsTab()`**

Find this exact block:

```js
  function buildFinanceTransactionsTab(){
    const sorted = state.financeTransactions.slice().sort((a,b)=>{
      const dateCompare = b.date.localeCompare(a.date);
      if(dateCompare!==0) return dateCompare;
      const aCreated = a.createdAt || new Date(a.date).getTime();
      const bCreated = b.createdAt || new Date(b.date).getTime();
      return bCreated - aCreated;
    });
    if(sorted.length===0){
      return `<div class="card"><p class="empty-state">Noch keine Umsätze eingetragen. Über das „+" oben hinzufügen.</p></div>`;
    }
    const byYear = {};
    sorted.forEach(t=>{
      const year = t.date.slice(0,4);
      (byYear[year] = byYear[year] || []).push(t);
    });
    const years = Object.keys(byYear).sort((a,b)=> b.localeCompare(a));
    const listHtml = years.map(year=>{
      const expanded = state.financeExpandedYears.has(year);
      const rows = byYear[year].map(t=>{
        const isPositive = t.amount>=0;
        const locked = !!t.fromArrears;
        return `
          <div class="transaction-row" data-id="${t.id}">
            <span class="transaction-info">
              <span class="transaction-description">${escapeHtml(t.description)}${locked?' <span class="fine-type-icon" title="Aus Rückstandszahlung – nur Bezeichnung bearbeitbar" style="display:inline-flex; width:14px; height:14px; vertical-align:middle;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></span>':''}</span>
              <span class="transaction-meta">${formatDateDE(t.date)} · ${financeAccountIconHtmlById(t.accountId)}${escapeHtml(financeAccountNameById(t.accountId))}</span>
            </span>
            <span class="transaction-amount${isPositive?' positive':' negative'}">${isPositive?'+':''}${fmtEuro(t.amount)}</span>
          </div>
        `;
      }).join('');
      return `
        <div class="year-group finance-year-group${expanded?' expanded':''}" data-year="${year}">
          <div class="year-header finance-year-header">
            <span>${year}</span>
            <span class="chevron">▸</span>
          </div>
          <div class="year-evenings">${rows}</div>
        </div>
      `;
    }).join('');
    return `<div class="card"><h2 class="section-title">Umsätze</h2>${listHtml}</div>`;
  }
```

Replace it with:

```js
  function buildFinanceTransactionsTab(){
    // Umbuchungen (Issue #83) bestehen aus zwei gekoppelten Transaktionen (transferRole 'out'/'in')
    // - hier wird nur die 'out'-Seite gerendert, damit pro Umbuchung genau eine Zeile erscheint.
    const sorted = state.financeTransactions
      .filter(t=> !t.transferId || t.transferRole==='out')
      .slice().sort((a,b)=>{
        const dateCompare = b.date.localeCompare(a.date);
        if(dateCompare!==0) return dateCompare;
        const aCreated = a.createdAt || new Date(a.date).getTime();
        const bCreated = b.createdAt || new Date(b.date).getTime();
        return bCreated - aCreated;
      });
    if(sorted.length===0){
      return `<div class="card"><p class="empty-state">Noch keine Umsätze eingetragen. Über das „+" oben hinzufügen.</p></div>`;
    }
    const byYear = {};
    sorted.forEach(t=>{
      const year = t.date.slice(0,4);
      (byYear[year] = byYear[year] || []).push(t);
    });
    const years = Object.keys(byYear).sort((a,b)=> b.localeCompare(a));
    const listHtml = years.map(year=>{
      const expanded = state.financeExpandedYears.has(year);
      const rows = byYear[year].map(t=>{
        const isPositive = t.amount>=0;
        const locked = !!t.fromArrears;
        const isTransfer = !!t.transferId;
        const metaHtml = isTransfer
          ? `${formatDateDE(t.date)} · <span class="finance-account-icon-inline">${ICON_TRANSFER}</span>Von ${escapeHtml(financeAccountNameById(t.accountId))} nach ${escapeHtml(financeAccountNameById(state.financeTransactions.find(p=>p.transferId===t.transferId && p.id!==t.id).accountId))}`
          : `${formatDateDE(t.date)} · ${financeAccountIconHtmlById(t.accountId)}${escapeHtml(financeAccountNameById(t.accountId))}`;
        const amountHtml = isTransfer
          ? `<span class="transaction-amount transfer">${fmtEuro(Math.abs(t.amount))}</span>`
          : `<span class="transaction-amount${isPositive?' positive':' negative'}">${isPositive?'+':''}${fmtEuro(t.amount)}</span>`;
        return `
          <div class="transaction-row" data-id="${t.id}">
            <span class="transaction-info">
              <span class="transaction-description">${escapeHtml(t.description)}${locked?' <span class="fine-type-icon" title="Aus Rückstandszahlung – nur Bezeichnung bearbeitbar" style="display:inline-flex; width:14px; height:14px; vertical-align:middle;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></span>':''}</span>
              <span class="transaction-meta">${metaHtml}</span>
            </span>
            ${amountHtml}
          </div>
        `;
      }).join('');
      return `
        <div class="year-group finance-year-group${expanded?' expanded':''}" data-year="${year}">
          <div class="year-header finance-year-header">
            <span>${year}</span>
            <span class="chevron">▸</span>
          </div>
          <div class="year-evenings">${rows}</div>
        </div>
      `;
    }).join('');
    return `<div class="card"><h2 class="section-title">Umsätze</h2>${listHtml}</div>`;
  }
```

- [ ] **Step 2: Syntax-check the module script**

Run:
```bash
node -e "const fs=require('fs');const html=fs.readFileSync('index.html','utf8');const m=html.match(/<script type=\"module\">([\s\S]*?)<\/script>/);fs.writeFileSync('module-check.mjs', m[1]);"
node --check module-check.mjs && rm module-check.mjs
```
Expected: no output, exit code 0.

- [ ] **Step 3: Manual test — transfer appears as one row**

Using the transfer created in Task 3 Step 5: open Umsätze, confirm the transfer shows exactly one row (not two) with the transfer icon, neutral-colored amount (no `+`/`-`), and meta text "{Datum} · Von {Konto A} nach {Konto B}". Confirm the year grouping and other Einnahme/Ausgabe rows are unaffected. Confirm `viewFinance()`'s "Gesamtbetrag" card is unchanged by the transfer (net zero).

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Collapse transfer pairs into a single Umsätze list row (Issue #83)"
```

---

### Task 5: Delete an Umbuchung — remove both coupled transactions

**Files:**
- Modify: `index.html:8499-8542` (`showDeleteTransactionModal()`)

**Interfaces:**
- Consumes: `deleteTransactions()` (Task 1), `t.transferId` (Task 3).
- Produces: no interface change — `showDeleteTransactionModal(transaction)` keeps its existing signature.

- [ ] **Step 1: Replace `showDeleteTransactionModal()`**

Find this exact block:

```js
  function showDeleteTransactionModal(transaction){
    const isFromArrears = !!transaction.fromArrears;
    const arrearsName = transaction.arrearsName || (transaction.description.includes(' – ') ? transaction.description.split(' – ').pop() : null);
    const arrearsMemberId = transaction.arrearsMemberId || null;
    showModal(`
      <h3>Umsatz löschen</h3>
      <p>„${escapeHtml(transaction.description)}" wirklich löschen?</p>
      ${isFromArrears ? `<p class="hint">Dieser Umsatz stammt aus einer Rückstandszahlung${arrearsName?` von <strong>${escapeHtml(arrearsName)}</strong>`:''}. Beim Löschen wird der Betrag (${fmtEuro(Math.abs(transaction.amount))}) wieder zum offenen Rückstand addiert.</p>` : ''}
      <div class="confirm-row-buttons">
        <button type="button" class="btn-danger" id="confirm-delete-transaction-yes">Ja, löschen</button>
        <button type="button" class="btn-secondary" id="modal-cancel-btn">Abbrechen</button>
      </div>
    `);
    document.getElementById('modal-cancel-btn').addEventListener('click', closeGenericModal);
    document.getElementById('confirm-delete-transaction-yes').addEventListener('click', async ()=>{
      const yesBtn = document.getElementById('confirm-delete-transaction-yes');
      yesBtn.disabled = true; yesBtn.textContent = 'Löscht…';
      state.financeTransactions = state.financeTransactions.filter(t=>t.id!==transaction.id);

      const saves = [deleteTransaction(transaction.id)];
      // arrearsMemberId ist bei allen seit dem ID-Umbau erfassten Zahlungen gesetzt. Für
      // Alttransaktionen (vor der Migration, ohne arrearsMemberId) wird hier einmalig noch per
      // Name auf ein aktuelles Mitglied aufgelöst - reiner Fallback für Bestandsdaten, keine
      // dauerhafte Namensauflösung mehr.
      const resolvedMemberId = arrearsMemberId || (arrearsName ? (state.members.find(m=>displayName(m)===arrearsName)||{}).id : null);
      if(isFromArrears && resolvedMemberId){
        let entry = state.financeArrears.find(a=>a.memberId===resolvedMemberId);
        if(!entry){ entry = {id: resolveArrearsDocId(resolvedMemberId), memberId: resolvedMemberId, name:arrearsName, amount:0, history:[]}; state.financeArrears.push(entry); }
        if(!entry.id) entry.id = resolveArrearsDocId(resolvedMemberId);
        if(!entry.memberId) entry.memberId = resolvedMemberId;
        if(!entry.history) entry.history = [];
        const addBack = Math.abs(transaction.amount);
        entry.amount = Math.round((entry.amount + addBack)*100)/100;
        entry.history.push({
          id: uid('hist'), date: todayISO(), type:'correction', delta: addBack,
          note: `Umsatz „${transaction.description}" gelöscht`, balanceAfter: entry.amount, createdAt: Date.now()
        });
        saves.push(saveArrearsEntry(entry));
      }
      await Promise.all(saves);
      closeGenericModal();
      history.back();
    });
  }
```

Replace it with:

```js
  function showDeleteTransactionModal(transaction){
    const isFromArrears = !!transaction.fromArrears;
    const arrearsName = transaction.arrearsName || (transaction.description.includes(' – ') ? transaction.description.split(' – ').pop() : null);
    const arrearsMemberId = transaction.arrearsMemberId || null;
    // Umbuchungen (Issue #83) bestehen aus zwei per transferId gekoppelten Dokumenten - beide
    // werden beim Löschen gemeinsam über deleteTransactions() entfernt, damit nie nur eine Seite
    // übrig bleibt. Der Bestätigungsdialog bleibt bewusst generisch (siehe Design-Spec).
    const pairedTransferTx = transaction.transferId ? state.financeTransactions.find(t=>t.transferId===transaction.transferId && t.id!==transaction.id) : null;
    showModal(`
      <h3>Umsatz löschen</h3>
      <p>„${escapeHtml(transaction.description)}" wirklich löschen?</p>
      ${isFromArrears ? `<p class="hint">Dieser Umsatz stammt aus einer Rückstandszahlung${arrearsName?` von <strong>${escapeHtml(arrearsName)}</strong>`:''}. Beim Löschen wird der Betrag (${fmtEuro(Math.abs(transaction.amount))}) wieder zum offenen Rückstand addiert.</p>` : ''}
      <div class="confirm-row-buttons">
        <button type="button" class="btn-danger" id="confirm-delete-transaction-yes">Ja, löschen</button>
        <button type="button" class="btn-secondary" id="modal-cancel-btn">Abbrechen</button>
      </div>
    `);
    document.getElementById('modal-cancel-btn').addEventListener('click', closeGenericModal);
    document.getElementById('confirm-delete-transaction-yes').addEventListener('click', async ()=>{
      const yesBtn = document.getElementById('confirm-delete-transaction-yes');
      yesBtn.disabled = true; yesBtn.textContent = 'Löscht…';

      const saves = [];
      if(pairedTransferTx){
        state.financeTransactions = state.financeTransactions.filter(t=>t.id!==transaction.id && t.id!==pairedTransferTx.id);
        saves.push(deleteTransactions([transaction.id, pairedTransferTx.id]));
      }else{
        state.financeTransactions = state.financeTransactions.filter(t=>t.id!==transaction.id);
        saves.push(deleteTransaction(transaction.id));
      }

      // arrearsMemberId ist bei allen seit dem ID-Umbau erfassten Zahlungen gesetzt. Für
      // Alttransaktionen (vor der Migration, ohne arrearsMemberId) wird hier einmalig noch per
      // Name auf ein aktuelles Mitglied aufgelöst - reiner Fallback für Bestandsdaten, keine
      // dauerhafte Namensauflösung mehr.
      const resolvedMemberId = arrearsMemberId || (arrearsName ? (state.members.find(m=>displayName(m)===arrearsName)||{}).id : null);
      if(isFromArrears && resolvedMemberId){
        let entry = state.financeArrears.find(a=>a.memberId===resolvedMemberId);
        if(!entry){ entry = {id: resolveArrearsDocId(resolvedMemberId), memberId: resolvedMemberId, name:arrearsName, amount:0, history:[]}; state.financeArrears.push(entry); }
        if(!entry.id) entry.id = resolveArrearsDocId(resolvedMemberId);
        if(!entry.memberId) entry.memberId = resolvedMemberId;
        if(!entry.history) entry.history = [];
        const addBack = Math.abs(transaction.amount);
        entry.amount = Math.round((entry.amount + addBack)*100)/100;
        entry.history.push({
          id: uid('hist'), date: todayISO(), type:'correction', delta: addBack,
          note: `Umsatz „${transaction.description}" gelöscht`, balanceAfter: entry.amount, createdAt: Date.now()
        });
        saves.push(saveArrearsEntry(entry));
      }
      await Promise.all(saves);
      closeGenericModal();
      history.back();
    });
  }
```

- [ ] **Step 2: Syntax-check the module script**

Run:
```bash
node -e "const fs=require('fs');const html=fs.readFileSync('index.html','utf8');const m=html.match(/<script type=\"module\">([\s\S]*?)<\/script>/);fs.writeFileSync('module-check.mjs', m[1]);"
node --check module-check.mjs && rm module-check.mjs
```
Expected: no output, exit code 0.

- [ ] **Step 3: Manual test — deleting a transfer removes both sides**

Open the transfer created in Task 3 Step 5, delete it via the header overflow menu → „Ja, löschen". Confirm:
- The dialog text stays generic (no transfer-specific wording).
- Both accounts' balances (Konten-Aufteilung modal) return to their pre-transfer values.
- The Umsätze list no longer shows the transfer row (and no orphaned second row).
- Deleting a normal (non-transfer) Einnahme/Ausgabe still works exactly as before, and deleting a `fromArrears` payment still re-adds the amount to the member's Rückstand.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Delete both coupled transactions when an Umbuchung is removed (Issue #83)"
```

---

### Task 6: Full manual verification pass

**Files:** None (no code changes — verification only).

**Interfaces:** None.

- [ ] **Step 1: Run through the design spec's full test plan**

Using a test club with ≥3 Konten/Kassen (to also exercise the "not just 2 accounts" Von/Nach-filtering path) and a Kassenwart/Admin test account, work through every item below (from `docs/superpowers/specs/2026-08-07-umbuchungen-design.md`):

- Exactly 1 Konto: segmented control shows only Einnahme/Ausgabe, "Umbuchung" does not appear.
- ≥2 Konten: "Umbuchung" wählen → Von wählen → bei genau 2 Konten ist Nach automatisch das verbleibende Konto.
- ≥3 Konten: Von wählen → gewähltes Konto verschwindet aus Nach-Liste; Von erneut ändern → Nach-Liste aktualisiert sich, vorherige gültige Nach-Auswahl bleibt erhalten.
- Umbuchung mit leerer Bezeichnung anlegen → Default „Umbuchung {Von} → {Nach}" erscheint in Liste und Detailansicht.
- Nach dem Anlegen: `financeAccountBalance()` beider Konten korrekt, „Gesamtbetrag" in `viewFinance()` unverändert (netto null).
- Umsätze-Liste zeigt die Umbuchung als eine Zeile mit Transfer-Icon und „Von X nach Y", keine zweite Zeile, keine Auswirkung auf andere Zeilen.
- Umbuchung bearbeiten: Von/Nach gesperrt mit Hinweistext, Betrag/Datum/Bezeichnung änderbar, Änderung wirkt auf beide Konten-Salden korrekt.
- Umbuchung löschen: beide gekoppelten Buchungen verschwinden aus Liste und beiden Konto-Salden.
- Bestehende Einnahme/Ausgabe anlegen/bearbeiten funktioniert weiterhin mit dem Ein-Feld-Betrag; Segmented Control Einnahme↔Ausgabe beim Bearbeiten schaltet das Vorzeichen korrekt um.
- Read-Only-Nutzer (kein `canManageFinances()`, z. B. ein Mitglied ohne Kassenwart-Rolle): Formular komplett deaktiviert (inklusive Segmented Control und Von/Nach-Felder), keine interaktiven Elemente durchbrechen die Sperre.
- Browser-Konsole bleibt während des gesamten Durchlaufs frei von Fehlern.

- [ ] **Step 2: Confirm no regressions in adjacent finance features**

Check that `showFinanceBreakdownModal()` (Konten-Aufteilung), the Rückstände tab, and the Spartöpfe tab still render and behave exactly as before this plan (none of them were modified, but they read `state.financeTransactions`/`financeAccountBalance()` which this plan's Task 1 touched indirectly through the storage layer).

- [ ] **Step 3: Report results**

If every check in Step 1 and Step 2 passes, the feature is complete — no further commit needed for this task (verification-only). If any check fails, note which one and return to the relevant task above to fix it before considering the plan done.

---

## Self-Review Notes

- **Spec coverage:** Data model + storage atomicity (Task 1), segmented control replacing the two-field Einnahme/Ausgabe form (Task 3), transfer creation form with live Von/Nach filtering (Task 3), locked transfer-edit branch with hint text (Task 3), list collapsing + icon/meta display (Task 4), coupled delete (Task 5), and the full spec test plan (Task 6) cover every section of `docs/superpowers/specs/2026-08-07-umbuchungen-design.md`. The three "Offene Fragen" from the original issue are all resolved per the approved design: delete dialog stays generic (Task 5), only amount/date/description are editable on an existing transfer (Task 3), and no Firestore Rules change is needed (Task 1's client-side `runTransaction` is the atomicity boundary).
- **Type consistency:** `saveTransactions(txs)`/`deleteTransactions(ids)` (Task 1) are called with the same array-of-transaction-object / array-of-id shapes throughout Task 3 and Task 5. The transaction shape `{id, accountId, amount, description, date, transferId, transferRole, createdAt}` introduced in Task 3 is exactly what Task 4's `buildFinanceTransactionsTab()` and Task 5's `showDeleteTransactionModal()` read (`t.transferId`, `t.transferRole==='out'`/`'in'`). `state.newTxSegment` (Task 2) uses the same three string values (`'income'`/`'expense'`/`'transfer'`) everywhere it's set (Task 2, Task 3's segment buttons) and read (Task 3's `viewTransactionDetail()` and save handler).
- **Placeholder scan:** none found — every step has full, exact code or a fully spelled-out manual-test checklist.
