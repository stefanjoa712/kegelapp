# Club wechseln Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let members and the admin account who belong to more than one club switch the active club from within a running session (Einstellungen → „Club wechseln") without having to log out and log back in.

**Architecture:** `resolveActiveClub()` becomes the single source of truth for both "which club(s) is this account allowed to see" (cached in a new module variable `AVAILABLE_CLUB_IDS`) and "was a club switch requested" (a one-time `sessionStorage` override consumed via a new `consumeClubSwitchOverride()` helper). A new `switchClub()` function reuses the existing `showClubSelectionScreen()` UI to let the user pick a club, stores the choice in `sessionStorage`, and does a full `location.reload()` — `resolveActiveClub()` then picks up the override on the next boot and skips the prompt. A new item in the existing "Kontenübersicht" settings-menu group (via `settingsMenuItemHtml()`) triggers `switchClub()`, shown only when `AVAILABLE_CLUB_IDS.length > 1`.

**Tech Stack:** Vanilla JS (ES modules, no build step), Firebase Auth, single `index.html` (one `<script type="module">` block, no separate frontend files).

## Global Constraints

- No build step: all changes go directly into `index.html`'s single `<script type="module">` block. Do not introduce new files or frameworks.
- German UI text and German comments (only where the WHY is non-obvious), matching the surrounding code's tone and 2-space indentation.
- No automated test setup exists anywhere in this repo (no root `package.json`, no test runner). Verification is manual: extract the module script and run `node --check` on it for syntax, plus a browser click-through (console free of errors) for behavior.
- Reuse existing patterns exactly: `settingsMenuItemHtml()` for the new menu row, `showClubSelectionScreen()` unchanged for the picker UI, module-level `let`/`const` state declared next to `CURRENT_CLUB_ID`/`CURRENT_CLUB_DATA` for the new `AVAILABLE_CLUB_IDS`.
- Per the approved design (`docs/superpowers/specs/2026-08-07-club-wechseln-design.md`): no "unsaved changes" warning before the reload, no special-case for exactly 2 clubs (always show the full picker), no Cancel option on the picker when triggered from the settings menu (identical behavior to the login-time picker).

---

### Task 1: Module state for the available club list and the switch override

**Files:**
- Modify: `index.html:954-961`

**Interfaces:**
- Produces: module-scope `let AVAILABLE_CLUB_IDS = null;`, `const CLUB_SWITCH_STORAGE_KEY = 'clubSwitchOverrideClubId';`, `function consumeClubSwitchOverride(): string|null` — reads and clears the sessionStorage override, usable by any code later in the same `<script type="module">` block.

- [ ] **Step 1: Add the new module state**

Find this exact block:

```js
  let CURRENT_CLUB_ID = null;
  // Club-Stammdaten (Name, PayPal-Name, ...) des aktuell aktiven Clubs - wird direkt nach dem
  // Setzen von CURRENT_CLUB_ID in bootstrapAuth per getClub() geladen. CLUB_NAME dient als
  // generischer Platzhalter, solange die echten Stammdaten noch nicht geladen sind (Ladebildschirm,
  // Meta-Tags vor dem Login).
  let CURRENT_CLUB_DATA = null;
  const CLUB_NAME_FALLBACK = 'Kegelclub';
  function clubDisplayName(){ return (CURRENT_CLUB_DATA && CURRENT_CLUB_DATA.name) || CLUB_NAME_FALLBACK; }
```

Replace it with:

```js
  let CURRENT_CLUB_ID = null;
  // Club-Stammdaten (Name, PayPal-Name, ...) des aktuell aktiven Clubs - wird direkt nach dem
  // Setzen von CURRENT_CLUB_ID in bootstrapAuth per getClub() geladen. CLUB_NAME dient als
  // generischer Platzhalter, solange die echten Stammdaten noch nicht geladen sind (Ladebildschirm,
  // Meta-Tags vor dem Login).
  let CURRENT_CLUB_DATA = null;
  // Alle Club-IDs, denen der eingeloggte Account zugeordnet ist (bzw. bei ADMIN_EMAIL: alle
  // existierenden Clubs) - wird von resolveActiveClub() gecacht (Issue #88), damit das
  // Einstellungen-Menü weiß, ob ein "Club wechseln"-Menüpunkt nötig ist (>1 Eintrag), ohne bei
  // jedem Menü-Aufbau einen neuen Token-Request auszulösen. null vor dem ersten Login, wird beim
  // Logout in bootstrapAuth() wieder zurückgesetzt.
  let AVAILABLE_CLUB_IDS = null;
  // sessionStorage-Key für den Club-Wechsel innerhalb einer laufenden Session (Issue #88): switchClub()
  // legt hier einmalig die vom Nutzer gewählte Ziel-clubId ab und löst dann location.reload() aus;
  // resolveActiveClub() liest den Wert beim Neustart per consumeClubSwitchOverride() (einmalig,
  // danach gelöscht) und überspringt bei Treffer die erneute Club-Auswahl.
  const CLUB_SWITCH_STORAGE_KEY = 'clubSwitchOverrideClubId';
  function consumeClubSwitchOverride(){
    const value = sessionStorage.getItem(CLUB_SWITCH_STORAGE_KEY);
    if(value) sessionStorage.removeItem(CLUB_SWITCH_STORAGE_KEY);
    return value;
  }
  const CLUB_NAME_FALLBACK = 'Kegelclub';
  function clubDisplayName(){ return (CURRENT_CLUB_DATA && CURRENT_CLUB_DATA.name) || CLUB_NAME_FALLBACK; }
```

- [ ] **Step 2: Syntax-check the module script**

Run:
```bash
node -e "const fs=require('fs');const html=fs.readFileSync('index.html','utf8');const m=html.match(/<script type=\"module\">([\s\S]*?)<\/script>/);fs.writeFileSync('/tmp/kegelapp-module-check.mjs', m[1]);"
node --check /tmp/kegelapp-module-check.mjs
```
Expected: no output from `node --check`, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "Add AVAILABLE_CLUB_IDS and club-switch override state (Issue #88)"
```

---

### Task 2: `resolveActiveClub()` caches the club list and consumes the switch override

**Files:**
- Modify: `index.html:974-1012`

**Interfaces:**
- Consumes: `AVAILABLE_CLUB_IDS` (Task 1), `consumeClubSwitchOverride()` (Task 1), existing `getAllClubIds()`, `renderNoClubAccessScreen()`, `showClubSelectionScreen(clubIds)`.
- Produces: `resolveActiveClub()` keeps its existing signature/return type (`Promise<string|null>`) and existing call site in `bootstrapAuth()` — no caller changes needed. Side effect: sets `AVAILABLE_CLUB_IDS` as a side effect on every call that doesn't recurse for a token refresh.

- [ ] **Step 1: Update `resolveActiveClub()`**

Find this exact block:

```js
  // Liest die Club-Zugehörigkeit (Custom Claim 'clubIds') des gerade eingeloggten Nutzers und
  // setzt CURRENT_CLUB_ID entsprechend:
  // - Admin-Account -> IMMER Auswahl über ALLE existierenden Clubs, unabhängig vom eigenen Claim.
  //   Der Admin ist kein Mitglied eines bestimmten Clubs, sondern verwaltet die App insgesamt -
  //   sein eigener Claim (falls vorhanden) ist für diese Entscheidung irrelevant.
  // - Genau ein Club (Mitglied) -> direkt übernehmen, kein Klick nötig (der heute übliche Fall).
  // - Mehrere Clubs (Mitglied) -> Auswahl-Screen zeigen (Club-Namen aus clubs/<clubId>-Stammdaten
  //   geladen), Nutzer wählt; die Wahl wird NICHT gemerkt, bei jedem Login erneut gefragt.
  // - Kein Club, kein Admin -> Fehlermeldung, kein Zugriff auf die App.
  // 'forceRefresh=true' erzwingt einen neuen ID-Token vom Server (Firebase cached Tokens bis zu
  // einer Stunde) - wichtig direkt nach einer frischen Einladung, wo der Claim serverseitig
  // gerade erst gesetzt wurde und ein gecachtes Token ihn noch nicht enthält.
  async function resolveActiveClub(user, forceRefresh){
    if(user.email===ADMIN_EMAIL){
      let allClubIds = [];
      try{ allClubIds = await getAllClubIds(); }catch(e){ /* fällt unten auf "Kein Zugriff" zurück */ }
      if(allClubIds.length===0){ renderNoClubAccessScreen(); return null; }
      if(allClubIds.length===1) return allClubIds[0];
      return await showClubSelectionScreen(allClubIds);
    }

    const tokenResult = await user.getIdTokenResult(!!forceRefresh);
    let clubIds = (tokenResult.claims && tokenResult.claims.clubIds) || [];
    if(!Array.isArray(clubIds)) clubIds = [];

    if(clubIds.length===0 && !forceRefresh){
      // Möglich, dass der Claim gerade erst gesetzt wurde und das gecachte Token ihn noch nicht
      // kennt - einmal mit erzwungenem Refresh nachschauen, bevor wir aufgeben.
      return resolveActiveClub(user, true);
    }
    if(clubIds.length===0){
      renderNoClubAccessScreen();
      return null;
    }
    if(clubIds.length===1){
      return clubIds[0];
    }
    return await showClubSelectionScreen(clubIds);
  }
```

Replace it with:

```js
  // Liest die Club-Zugehörigkeit (Custom Claim 'clubIds') des gerade eingeloggten Nutzers und
  // setzt CURRENT_CLUB_ID entsprechend:
  // - Admin-Account -> IMMER Auswahl über ALLE existierenden Clubs, unabhängig vom eigenen Claim.
  //   Der Admin ist kein Mitglied eines bestimmten Clubs, sondern verwaltet die App insgesamt -
  //   sein eigener Claim (falls vorhanden) ist für diese Entscheidung irrelevant.
  // - Genau ein Club (Mitglied) -> direkt übernehmen, kein Klick nötig (der heute übliche Fall).
  // - Mehrere Clubs (Mitglied) -> Auswahl-Screen zeigen (Club-Namen aus clubs/<clubId>-Stammdaten
  //   geladen), Nutzer wählt; die Wahl wird NICHT gemerkt, bei jedem Login erneut gefragt.
  // - Kein Club, kein Admin -> Fehlermeldung, kein Zugriff auf die App.
  // 'forceRefresh=true' erzwingt einen neuen ID-Token vom Server (Firebase cached Tokens bis zu
  // einer Stunde) - wichtig direkt nach einer frischen Einladung, wo der Claim serverseitig
  // gerade erst gesetzt wurde und ein gecachtes Token ihn noch nicht enthält.
  // Cacht außerdem die ermittelte Club-Liste in AVAILABLE_CLUB_IDS (Issue #88, für die Sichtbarkeit
  // des "Club wechseln"-Menüpunkts) und konsumiert einen evtl. per switchClub() gesetzten
  // sessionStorage-Override: liegt einer vor UND ist er Teil der gerade ermittelten Club-Liste,
  // wird er direkt übernommen und die Auswahl-Anzeige übersprungen. Die Prüfung gegen die frisch
  // ermittelte Liste schützt davor, dass ein veralteter/manipulierter Override-Wert auf einen Club
  // verweist, auf den der Account inzwischen keinen Zugriff mehr hat.
  async function resolveActiveClub(user, forceRefresh){
    if(user.email===ADMIN_EMAIL){
      let allClubIds = [];
      try{ allClubIds = await getAllClubIds(); }catch(e){ /* fällt unten auf "Kein Zugriff" zurück */ }
      AVAILABLE_CLUB_IDS = allClubIds;
      if(allClubIds.length===0){ renderNoClubAccessScreen(); return null; }
      const override = consumeClubSwitchOverride();
      if(override && allClubIds.includes(override)) return override;
      if(allClubIds.length===1) return allClubIds[0];
      return await showClubSelectionScreen(allClubIds);
    }

    const tokenResult = await user.getIdTokenResult(!!forceRefresh);
    let clubIds = (tokenResult.claims && tokenResult.claims.clubIds) || [];
    if(!Array.isArray(clubIds)) clubIds = [];

    if(clubIds.length===0 && !forceRefresh){
      // Möglich, dass der Claim gerade erst gesetzt wurde und das gecachte Token ihn noch nicht
      // kennt - einmal mit erzwungenem Refresh nachschauen, bevor wir aufgeben.
      return resolveActiveClub(user, true);
    }
    AVAILABLE_CLUB_IDS = clubIds;
    if(clubIds.length===0){
      renderNoClubAccessScreen();
      return null;
    }
    const override = consumeClubSwitchOverride();
    if(override && clubIds.includes(override)) return override;
    if(clubIds.length===1){
      return clubIds[0];
    }
    return await showClubSelectionScreen(clubIds);
  }
```

- [ ] **Step 2: Syntax-check the module script**

Run:
```bash
node -e "const fs=require('fs');const html=fs.readFileSync('index.html','utf8');const m=html.match(/<script type=\"module\">([\s\S]*?)<\/script>/);fs.writeFileSync('/tmp/kegelapp-module-check.mjs', m[1]);"
node --check /tmp/kegelapp-module-check.mjs
```
Expected: no output, exit code 0.

- [ ] **Step 3: Manual smoke test — normal login still works**

Serve the app locally (`firebase emulators:start --only hosting` from the project root) and open it in a browser. Log in with a normal single-club test account and confirm the app boots straight to the main screen exactly as before (no selection screen, no console errors). This confirms the added `AVAILABLE_CLUB_IDS`/override logic didn't change behavior for the common case.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Cache available club IDs and consume switch override in resolveActiveClub (Issue #88)"
```

---

### Task 3: `switchClub()` — trigger the picker and reload with the chosen club

**Files:**
- Modify: `index.html:9782-9788` (insert new function between `showClubSelectionScreen()` and `renderSetPasswordScreen()`)

**Interfaces:**
- Consumes: existing `showClubSelectionScreen(clubIds)` (`index.html:9753`, returns `Promise<string>` resolving to the chosen `clubId`), `AVAILABLE_CLUB_IDS` and `CLUB_SWITCH_STORAGE_KEY` (Task 1).
- Produces: `async function switchClub()` — no return value used by callers (navigates away via `location.reload()`). Called from the settings-menu click handler added in Task 4.

- [ ] **Step 1: Add `switchClub()`**

Find this exact block:

```js
      listEl.querySelectorAll('.club-selection-row').forEach(row=>{
        row.addEventListener('click', ()=> resolve(row.dataset.clubId));
      });
    });
  }

  async function renderSetPasswordScreen(oobCode){
```

Replace it with:

```js
      listEl.querySelectorAll('.club-selection-row').forEach(row=>{
        row.addEventListener('click', ()=> resolve(row.dataset.clubId));
      });
    });
  }

  // Club-Wechsel innerhalb einer laufenden Session (Issue #88): zeigt dieselbe Auswahl wie beim
  // Login, legt die gewählte clubId danach einmalig in sessionStorage ab und erzwingt einen vollen
  // Reload - resolveActiveClub() übernimmt den Override beim Neustart über consumeClubSwitchOverride(),
  // BEVOR die reguläre Auswahl-Logik greift. Ein voller Reload (statt In-App-Umbau) ist bewusst
  // gewählt, damit alle clubspezifischen Firestore-Listener/-Caches sauber neu aufgebaut werden,
  // genau wie bei einem normalen Login-Wechsel.
  async function switchClub(){
    const clubId = await showClubSelectionScreen(AVAILABLE_CLUB_IDS);
    sessionStorage.setItem(CLUB_SWITCH_STORAGE_KEY, clubId);
    location.reload();
  }

  async function renderSetPasswordScreen(oobCode){
```

- [ ] **Step 2: Syntax-check the module script**

Run:
```bash
node -e "const fs=require('fs');const html=fs.readFileSync('index.html','utf8');const m=html.match(/<script type=\"module\">([\s\S]*?)<\/script>/);fs.writeFileSync('/tmp/kegelapp-module-check.mjs', m[1]);"
node --check /tmp/kegelapp-module-check.mjs
```
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "Add switchClub() to trigger club picker + reload (Issue #88)"
```

---

### Task 4: Reset `AVAILABLE_CLUB_IDS` on logout

**Files:**
- Modify: `index.html:10062-10067` (the `else` branch of the `onAuthStateChanged` callback in `bootstrapAuth()`)

**Interfaces:**
- Consumes: `AVAILABLE_CLUB_IDS` (Task 1).
- Produces: no new interface — closes a state-leak gap so a subsequent login by a different account never sees a stale club list.

- [ ] **Step 1: Reset the new state alongside the existing ones**

Find this exact block:

```js
      }else{
        state._lastFetched = {};
        CURRENT_CLUB_ID = null;
        CURRENT_CLUB_DATA = null;
        renderLoginScreen();
      }
```

Replace it with:

```js
      }else{
        state._lastFetched = {};
        CURRENT_CLUB_ID = null;
        CURRENT_CLUB_DATA = null;
        AVAILABLE_CLUB_IDS = null;
        renderLoginScreen();
      }
```

- [ ] **Step 2: Syntax-check the module script**

Run:
```bash
node -e "const fs=require('fs');const html=fs.readFileSync('index.html','utf8');const m=html.match(/<script type=\"module\">([\s\S]*?)<\/script>/);fs.writeFileSync('/tmp/kegelapp-module-check.mjs', m[1]);"
node --check /tmp/kegelapp-module-check.mjs
```
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "Reset AVAILABLE_CLUB_IDS on logout (Issue #88)"
```

---

### Task 5: Settings-menu item "Club wechseln"

**Files:**
- Modify: `index.html:2581-2615` (`viewSettingsMenu()`)
- Modify: `index.html:7007-7008` (`attachSettingsMenuListeners()`)

**Interfaces:**
- Consumes: `AVAILABLE_CLUB_IDS` (Task 1), `clubDisplayName()` (existing, `index.html:961`), `settingsMenuItemHtml()` (existing, `index.html:2501`), `switchClub()` (Task 3).
- Produces: DOM button `#settings-menu-switch-club-btn`, wired to `switchClub()` on click.

- [ ] **Step 1: Add the menu item to `viewSettingsMenu()`**

Find this exact block:

```js
    const accountItem = getCurrentMember() ? settingsMenuItemHtml({
      id:'settings-menu-account-btn', colorClass:'cat-purple', label:'Mein Konto',
      subtitle: settingsMenuAccountSubtitle(),
      iconSvg:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="8" r="4"/>
        <path d="M4 20c0-4 4-6 8-6s8 2 8 6"/>
      </svg>`
    }) : '';
    return `
      <div class="card">
        <h2 class="section-title">Einstellungen</h2>
        <div class="settings-menu-list">
          <div class="group-label">Stammdaten</div>
          ${clubItem}
          ${mitgliederItem}
          <div class="group-label">Spielinhalte</div>
          ${strafenItem}
          ${spieleItem}
          <div class="group-label">Verwaltung</div>
          ${finanzenItem}
          ${termineItem}
          <div class="group-label">Kontenübersicht</div>
          ${accountItem}
          <button type="button" class="profile-item" id="settings-menu-logout-btn">
```

Replace it with:

```js
    const accountItem = getCurrentMember() ? settingsMenuItemHtml({
      id:'settings-menu-account-btn', colorClass:'cat-purple', label:'Mein Konto',
      subtitle: settingsMenuAccountSubtitle(),
      iconSvg:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="8" r="4"/>
        <path d="M4 20c0-4 4-6 8-6s8 2 8 6"/>
      </svg>`
    }) : '';
    // Nur bei Zugehörigkeit zu mehr als einem Club (Issue #88) - AVAILABLE_CLUB_IDS wird von
    // resolveActiveClub() beim Login/Reload gecacht (gleiche Quelle/Logik für Mitglied und Admin),
    // damit hier kein neuer Token-Request nötig ist.
    const switchClubItem = (AVAILABLE_CLUB_IDS && AVAILABLE_CLUB_IDS.length > 1) ? settingsMenuItemHtml({
      id:'settings-menu-switch-club-btn', colorClass:'cat-purple', label:'Club wechseln',
      subtitle: clubDisplayName(),
      iconSvg:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M17 3l4 4-4 4"/>
        <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
        <path d="M7 21l-4-4 4-4"/>
        <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
      </svg>`
    }) : '';
    return `
      <div class="card">
        <h2 class="section-title">Einstellungen</h2>
        <div class="settings-menu-list">
          <div class="group-label">Stammdaten</div>
          ${clubItem}
          ${mitgliederItem}
          <div class="group-label">Spielinhalte</div>
          ${strafenItem}
          ${spieleItem}
          <div class="group-label">Verwaltung</div>
          ${finanzenItem}
          ${termineItem}
          <div class="group-label">Kontenübersicht</div>
          ${accountItem}
          ${switchClubItem}
          <button type="button" class="profile-item" id="settings-menu-logout-btn">
```

- [ ] **Step 2: Wire the click handler in `attachSettingsMenuListeners()`**

Find this exact block:

```js
    const accountBtn = document.getElementById('settings-menu-account-btn');
    if(accountBtn) accountBtn.addEventListener('click', goToAccountSettings);
    const logoutBtn = document.getElementById('settings-menu-logout-btn');
    if(logoutBtn) logoutBtn.addEventListener('click', logout);
```

Replace it with:

```js
    const accountBtn = document.getElementById('settings-menu-account-btn');
    if(accountBtn) accountBtn.addEventListener('click', goToAccountSettings);
    const switchClubBtn = document.getElementById('settings-menu-switch-club-btn');
    if(switchClubBtn) switchClubBtn.addEventListener('click', switchClub);
    const logoutBtn = document.getElementById('settings-menu-logout-btn');
    if(logoutBtn) logoutBtn.addEventListener('click', logout);
```

- [ ] **Step 3: Syntax-check the module script**

Run:
```bash
node -e "const fs=require('fs');const html=fs.readFileSync('index.html','utf8');const m=html.match(/<script type=\"module\">([\s\S]*?)<\/script>/);fs.writeFileSync('/tmp/kegelapp-module-check.mjs', m[1]);"
node --check /tmp/kegelapp-module-check.mjs
```
Expected: no output, exit code 0.

- [ ] **Step 4: Manual test — single-club account sees no new item**

Serve the app locally, log in with a single-club test account, open Einstellungen. Confirm no "Club wechseln" item appears between "Mein Konto" and "Abmelden" (unchanged from before this plan).

- [ ] **Step 5: Manual test — multi-club account can switch**

Log in with a test account that has ≥2 clubs in its `clubIds` claim (or the `ADMIN_EMAIL` account if ≥2 clubs exist in Firestore). Open Einstellungen and confirm:
- "Club wechseln" appears in "Kontenübersicht", between "Mein Konto"/"Abmelden", with the current club's name as subtitle.
- Clicking it shows the club picker (same look as the login-time picker, no Cancel button).
- Picking a different club triggers a reload and lands the app in the newly selected club (correct club name in the header/branding, correct data for that club).
- Opening Einstellungen again in the new club still shows "Club wechseln" with the new club's name as subtitle (confirms `AVAILABLE_CLUB_IDS` is correctly repopulated after the override path).
- Logging out and back in (or a plain reload without using "Club wechseln") prompts the full club selection again, i.e. the choice is not persisted — unchanged existing behavior.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "Add 'Club wechseln' settings-menu item (Issue #88)"
```

---

## Self-Review Notes

- **Spec coverage:** Module-state caching (Task 1), `resolveActiveClub()` override handling (Task 2), `switchClub()` reload flow (Task 3), logout reset (Task 4), and the menu item + visibility/subtitle/wiring (Task 5) cover every section of the design spec. The "no cancel", "no unsaved-warning", "always full picker at 2 clubs" decisions require no extra code — verified no task accidentally reintroduces any of them.
- **Type consistency:** `AVAILABLE_CLUB_IDS` is always an array (`[]` or the claim/`getAllClubIds()` result) everywhere it's set (Task 2) and read (Task 5, Task 3), never `null` at the point `switchClub()`/the menu-item visibility check run (both only reachable post-login, after `resolveActiveClub()` has run). `consumeClubSwitchOverride()` returns `string|null`, used consistently as a truthy check (`if(override && ...)`) in Task 2.
- **Placeholder scan:** none found — every step has full, exact code.
