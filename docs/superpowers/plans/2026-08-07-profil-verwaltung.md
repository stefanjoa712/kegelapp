# Profil-Verwaltung (Self-Service) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give logged-in members a self-service "Mein Konto" page in Einstellungen to reset their password, change their email (synced across all their club memberships), and unlink their own account from the current club — without needing an admin.

**Architecture:** Two new Cloud Functions in `functions/index.js` (`unlinkOwnAccount`, `syncOwnEmailAcrossClubs`), both gated only by `requireCallerBelongsToClub`/token identity (no admin role check), following the existing `updateOwnLastLogin` pattern. A new `accountSettings` view in `index.html` reachable from the existing "Profil" group in the Einstellungen menu, with three modals built on the app's existing `showModal()`/`showModalLoadingOverlay()` infrastructure. Password change goes through Firebase's `sendPasswordResetEmail()` (no new backend code); email change goes through client-side `reauthenticateWithCredential()` + `verifyBeforeUpdateEmail()`, with a `localStorage`-backed pending-change marker that triggers the cross-club Firestore sync on the next app start once the user has clicked the verification link.

**Tech Stack:** Vanilla JS (ES modules, no build step), Firebase Auth/Firestore/Cloud Functions v2 (`onCall`), single `index.html` + `functions/index.js`.

## Global Constraints

- No build step: all frontend changes go directly into `index.html`'s single `<script type="module">` block; all backend changes go directly into `functions/index.js`. Do not introduce new files or frameworks.
- German UI text and German comments (only where the WHY is non-obvious), matching the surrounding code's tone and 2-space indentation.
- No automated test setup exists anywhere in this repo (no root `package.json`, no test runner). Verification is manual: `node --check functions/index.js` for backend syntax, and browser click-through (console free of errors) for frontend behavior.
- New `onCall` Cloud Functions require manually enabling "Allow unauthenticated invocations" in the Google Cloud Console → Cloud Run **after the first deploy** — same requirement as every existing `onCall` function (see `functions/DEPLOY.md`).
- `firestore.rules:86-90` forbids normal members from writing to `clubs/{clubId}/members/{memberId}` directly (only Kassenwart/Präsident/Admin may). Any write to a member's own record by a normal member MUST go through a Cloud Function using the Admin SDK — never `saveMember()` from the client.
- Reuse existing patterns exactly: `showModal()`/`showModalLoadingOverlay()`/`closeGenericModal()` for all new dialogs, `settingsMenuItemHtml()` for menu rows, the `VIEWS` registry + paired `goToX()` function for navigation, `httpsCallable(functions, 'name')` for calling Cloud Functions.

---

### Task 1: Firebase Auth imports for password reset and email change

**Files:**
- Modify: `index.html:898-902`

**Interfaces:**
- Produces: module-scope bindings `sendPasswordResetEmail`, `EmailAuthProvider`, `reauthenticateWithCredential`, `verifyBeforeUpdateEmail`, usable by any code later in the same `<script type="module">` block.

- [ ] **Step 1: Add the four new imports**

Find this block:

```js
  import {
    getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
    setPersistence, browserLocalPersistence, browserSessionPersistence,
    verifyPasswordResetCode, confirmPasswordReset
  } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
```

Replace it with:

```js
  import {
    getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
    setPersistence, browserLocalPersistence, browserSessionPersistence,
    verifyPasswordResetCode, confirmPasswordReset, sendPasswordResetEmail,
    EmailAuthProvider, reauthenticateWithCredential, verifyBeforeUpdateEmail
  } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
```

- [ ] **Step 2: Verify the app still loads without console errors**

Serve the app locally (`firebase emulators:start --only hosting` from the project root, or open `index.html` through any static file server — it cannot be opened via `file://` because of the ES module imports) and open it in a browser. Log in with a test account and confirm the app boots to the main screen with no red errors in the browser console (an import of a non-existent export would throw a `SyntaxError` at module-load time and the whole app would show a blank white screen instead of the login/main screen).

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "Add Firebase Auth imports for self-service password/email change"
```

---

### Task 2: Backend — `unlinkOwnAccount` Cloud Function

**Files:**
- Modify: `functions/index.js:1817` (insert new function directly after `unlinkMemberAccount`, before the `-------- Rollen-Rechte` comment)

**Interfaces:**
- Consumes: existing `removeMemberClubAuthAccess(email, clubId)` (`functions/index.js:1301`), existing `loadMembers(clubId)` (`functions/index.js:448`), existing `requireCallerBelongsToClub(request, clubId)` (`functions/index.js:914`).
- Produces: `exports.unlinkOwnAccount` — callable as `httpsCallable(functions, 'unlinkOwnAccount')({ clubId })`. Resolves `{ success: true }` on success; throws `HttpsError` with codes `invalid-argument`, `unauthenticated`, `permission-denied` (from `requireCallerBelongsToClub`), or `failed-precondition`.

- [ ] **Step 1: Insert the new function**

Find this exact block (end of `unlinkMemberAccount`):

```js
  requireManageMembersRole(request, clubId);
  await requireClubAccessNotBlocked(clubId);

  await removeMemberClubAuthAccess(email, clubId);

  return { success: true };
});

// -------- Rollen-Rechte: Custom Claim 'roles' synchron zum Mitgliedsdokument halten --------
```

Replace it with:

```js
  requireManageMembersRole(request, clubId);
  await requireClubAccessNotBlocked(clubId);

  await removeMemberClubAuthAccess(email, clubId);

  return { success: true };
});

// Self-Service-Pendant zu unlinkMemberAccount (Issue #60): trennt NUR den Zugang des Aufrufers
// selbst zu GENAU DEM Club, den er übergibt - keine Rollen-Prüfung wie requireManageMembersRole,
// nur requireCallerBelongsToClub (Vorbild: updateOwnLastLogin). Setzt zusätzlich hasAccount/
// lastLogin am eigenen Mitgliedsdokument zurück (per Admin-SDK, da firestore.rules normalen
// Mitgliedern das direkte Schreiben auf members/{id} verbietet) - identisch zum Verhalten, das
// das Admin-Pendant über showUnlinkAccountModal()/saveMember() im Client erreicht.
exports.unlinkOwnAccount = onCall({}, async (request) => {
  const { clubId } = request.data || {};
  if (!clubId || typeof clubId !== 'string') {
    throw new HttpsError('invalid-argument', 'Club-ID fehlt.');
  }
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Bitte zuerst anmelden.');
  }
  requireCallerBelongsToClub(request, clubId);
  const callerEmail = request.auth.token.email;
  if (!callerEmail) {
    throw new HttpsError('failed-precondition', 'Keine E-Mail-Adresse am Account hinterlegt.');
  }

  await removeMemberClubAuthAccess(callerEmail, clubId);

  const members = await loadMembers(clubId);
  const member = members && members.find(m => (m.email || '').toLowerCase() === callerEmail.toLowerCase());
  if (member) {
    member.hasAccount = false;
    member.lastLogin = null;
    await db.collection('clubs').doc(clubId).collection('members').doc(member.id)
      .set({ value: JSON.stringify(member) });
  }

  return { success: true };
});

// -------- Rollen-Rechte: Custom Claim 'roles' synchron zum Mitgliedsdokument halten --------
```

- [ ] **Step 2: Syntax-check the file**

Run: `node --check functions/index.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add functions/index.js
git commit -m "Add unlinkOwnAccount Cloud Function for self-service account unlinking"
```

---

### Task 3: Backend — `syncOwnEmailAcrossClubs` Cloud Function

**Files:**
- Modify: `functions/index.js:1421` (insert new function directly after `updateOwnLastLogin`, before the `-------- Die eigentliche Cloud Function --------` comment)

**Interfaces:**
- Consumes: existing `loadMembers(clubId)` (`functions/index.js:448`).
- Produces: `exports.syncOwnEmailAcrossClubs` — callable as `httpsCallable(functions, 'syncOwnEmailAcrossClubs')({ oldEmail })`. Resolves `{ success: true, updatedClubs: number }`. The new email is **not** taken from client input — it is read from `request.auth.token.email` (the already-verified new address on the caller's ID token), so a caller cannot use this function to overwrite a member document with an arbitrary email.

- [ ] **Step 1: Insert the new function**

Find this exact block (end of `updateOwnLastLogin`):

```js
  member.lastLogin = new Date().toISOString();
  member.hasAccount = true;
  await db.collection('clubs').doc(clubId).collection('members').doc(member.id)
    .set({ value: JSON.stringify(member) });

  return { success: true };
});

// -------- Die eigentliche Cloud Function --------
```

Replace it with:

```js
  member.lastLogin = new Date().toISOString();
  member.hasAccount = true;
  await db.collection('clubs').doc(clubId).collection('members').doc(member.id)
    .set({ value: JSON.stringify(member) });

  return { success: true };
});

// Synchronisiert eine per Self-Service geänderte E-Mail-Adresse (Issue #60) in JEDEM
// Mitgliedsdokument aller Clubs, denen der Aufrufer laut Custom Claim 'clubIds' angehört. Nötig,
// weil Member-Dokumente keine authUid-Referenz haben, sondern per E-Mail-Match gefunden werden
// (siehe getCurrentMember() im Client, updateOwnLastLogin oben) - bleibt die E-Mail in einem
// zweiten Club auf dem alten Stand stehen, bricht dort der Match. Der Client ruft diese Function
// erst auf, NACHDEM der Nutzer den von verifyBeforeUpdateEmail() verschickten Bestätigungslink
// angeklickt hat (auth.currentUser.email zeigt dann bereits auf die neue Adresse) - die neue
// Adresse wird deshalb bewusst NICHT vom Client übernommen, sondern aus request.auth.token.email
// gelesen, damit ein Aufrufer damit nicht ein fremdes Mitgliedsdokument auf eine beliebige E-Mail
// umbiegen kann. 'oldEmail' muss der Client mitgeben, da sie nach der Änderung nirgends mehr im
// Auth-Token steht.
exports.syncOwnEmailAcrossClubs = onCall({}, async (request) => {
  const { oldEmail } = request.data || {};
  if (!oldEmail || typeof oldEmail !== 'string') {
    throw new HttpsError('invalid-argument', 'Alte E-Mail-Adresse fehlt.');
  }
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Bitte zuerst anmelden.');
  }
  const newEmail = (request.auth.token.email || '').toLowerCase();
  if (!newEmail) {
    throw new HttpsError('failed-precondition', 'Keine E-Mail-Adresse am Account hinterlegt.');
  }
  const oldEmailLower = oldEmail.toLowerCase();
  const clubIds = Array.isArray(request.auth.token.clubIds) ? request.auth.token.clubIds : [];

  let updatedClubs = 0;
  for (const clubId of clubIds) {
    const members = await loadMembers(clubId);
    if (!members) continue;
    const member = members.find(m => (m.email || '').toLowerCase() === oldEmailLower);
    if (!member) continue;
    member.email = newEmail;
    await db.collection('clubs').doc(clubId).collection('members').doc(member.id)
      .set({ value: JSON.stringify(member) });
    updatedClubs++;
  }

  return { success: true, updatedClubs };
});

// -------- Die eigentliche Cloud Function --------
```

- [ ] **Step 2: Syntax-check the file**

Run: `node --check functions/index.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add functions/index.js
git commit -m "Add syncOwnEmailAcrossClubs Cloud Function for cross-club email sync"
```

---

### Task 4: Frontend — "Mein Konto" menu item and page scaffold

**Files:**
- Modify: `index.html:2481-2584` (add subtitle helper, extend `viewSettingsMenu()`)
- Modify: `index.html:2203-2206` (add `goToAccountSettings()` next to `goToSettingsMenu()`)
- Modify: `index.html:2429-2440` (extend `goBackFromHeaderInner()`)
- Modify: `index.html:3714-3716` (register `accountSettings` in `VIEWS`)
- Modify: `index.html:6904-6919` (extend `attachSettingsMenuListeners()`)
- Modify: `index.html:313-337` (CSS: add `.cat-wine` icon color, account info card styles)

**Interfaces:**
- Consumes: `getCurrentMember()` (`index.html:4122`), `displayName()` (`index.html:4452`), `settingsMenuItemHtml()` (`index.html:2481`), `escapeHtml()` (`index.html:2057`), `clubDisplayName()` (`index.html:952`).
- Produces: `goToAccountSettings()`, `viewAccountSettings()`, `attachAccountSettingsListeners()` — the last one is initially empty; Tasks 5–7 each add one line to it. Button ids produced for later tasks to wire up: `account-reset-password-btn`, `account-change-email-btn`, `account-unlink-btn`.

- [ ] **Step 1: Add the subtitle helper**

Find (`index.html`, right before `settingsMenuItemHtml`):

```js
  function settingsMenuItemHtml(opts){
```

Replace with:

```js
  // Untertitel für das "Mein Konto"-Item: die eigene hinterlegte E-Mail-Adresse, aus dem bereits
  // geladenen state.members (kein extra Firestore-Request, gleiches Prinzip wie die übrigen
  // settingsMenu*Subtitle()-Funktionen).
  function settingsMenuAccountSubtitle(){
    const member = getCurrentMember();
    return member ? (member.email || '') : '';
  }
  function settingsMenuItemHtml(opts){
```

- [ ] **Step 2: Add the "Mein Konto" item to the menu**

Find (`index.html`, inside `viewSettingsMenu()`):

```js
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
          <div class="group-label">Profil</div>
          <div class="profile-divider"></div>
```

Replace with:

```js
    // Nur anzeigen, wenn der eingeloggte Auth-User einem Mitgliedsdokument in diesem Club
    // zugeordnet werden kann - beim Admin-Sonderaccount (kein Mitgliedsdokument) liefert
    // getCurrentMember() null, siehe dort.
    const accountItem = getCurrentMember() ? settingsMenuItemHtml({
      id:'settings-menu-account-btn', colorClass:'cat-blue', label:'Mein Konto',
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
          <div class="group-label">Profil</div>
          ${accountItem}
          <div class="profile-divider"></div>
```

- [ ] **Step 3: Add `goToAccountSettings()`**

Find:

```js
  function goToSettingsMenu(){
    state.view = 'settingsMenu';
    render();
  }
```

Replace with:

```js
  function goToSettingsMenu(){
    state.view = 'settingsMenu';
    render();
  }
  function goToAccountSettings(){
    state.view = 'accountSettings';
    render();
  }
```

- [ ] **Step 4: Add `viewAccountSettings()`**

Find (right after `viewSettingsMenu()`'s closing, before `function fmtEuro(n){`):

```js
  function fmtEuro(n){
```

Replace with:

```js
  function viewAccountSettings(){
    const member = getCurrentMember();
    const email = member ? (member.email || '') : '';
    const name = member ? displayName(member) : '';
    const resetPasswordItem = settingsMenuItemHtml({
      id:'account-reset-password-btn', colorClass:'cat-blue', label:'Passwort zurücksetzen',
      subtitle:'Link per E-Mail erhalten',
      iconSvg:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="5" y="11" width="14" height="9" rx="2"/>
        <path d="M8 11V8a4 4 0 0 1 8 0v3"/>
      </svg>`
    });
    const changeEmailItem = settingsMenuItemHtml({
      id:'account-change-email-btn', colorClass:'cat-blue', label:'E-Mail-Adresse ändern',
      subtitle: email,
      iconSvg:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="5" width="18" height="14" rx="2"/>
        <path d="M3 7l9 6 9-6"/>
      </svg>`
    });
    const unlinkItem = settingsMenuItemHtml({
      id:'account-unlink-btn', colorClass:'cat-wine', label:'Konto-Verknüpfung aufheben',
      subtitle: clubDisplayName(),
      iconSvg:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 9v4"/>
        <path d="M12 17h.01"/>
        <path d="M10.3 3.9L2.5 17a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>
      </svg>`
    });
    return `
      <div class="card">
        <h2 class="section-title">Mein Konto</h2>
        <div class="account-info-card">
          <div class="account-info-name">${escapeHtml(name)}</div>
          <div class="account-info-email">${escapeHtml(email)}</div>
        </div>
        <div class="settings-menu-list">
          <div class="group-label">Sicherheit</div>
          ${resetPasswordItem}
          ${changeEmailItem}
          <div class="group-label">Gefahrenzone</div>
          ${unlinkItem}
        </div>
      </div>
    `;
  }

  function fmtEuro(n){
```

- [ ] **Step 5: Add `attachAccountSettingsListeners()` (empty scaffold)**

Find:

```js
  function attachSettingsMenuListeners(){
```

Replace with:

```js
  // Wird pro Feature in Task 5-7 um je einen Button-Listener ergänzt (Passwort zurücksetzen,
  // E-Mail ändern, Konto-Verknüpfung aufheben).
  function attachAccountSettingsListeners(){
  }

  function attachSettingsMenuListeners(){
```

- [ ] **Step 6: Wire the new menu item's click handler**

Find:

```js
    const termineBtn = document.getElementById('settings-menu-termine-btn');
    if(termineBtn) termineBtn.addEventListener('click', goToEventManagement);
    const logoutBtn = document.getElementById('settings-menu-logout-btn');
```

Replace with:

```js
    const termineBtn = document.getElementById('settings-menu-termine-btn');
    if(termineBtn) termineBtn.addEventListener('click', goToEventManagement);
    const accountBtn = document.getElementById('settings-menu-account-btn');
    if(accountBtn) accountBtn.addEventListener('click', goToAccountSettings);
    const logoutBtn = document.getElementById('settings-menu-logout-btn');
```

- [ ] **Step 7: Register the view in the `VIEWS` registry**

Find:

```js
    settingsMenu: { body: viewSettingsMenu, title: 'Einstellungen', attach: attachSettingsMenuListeners },
```

Replace with:

```js
    settingsMenu: { body: viewSettingsMenu, title: 'Einstellungen', attach: attachSettingsMenuListeners },
    accountSettings: { body: viewAccountSettings, title: 'Mein Konto', attach: attachAccountSettingsListeners },
```

- [ ] **Step 8: Make the header back button return to the settings menu**

Find:

```js
    if(state.view==='settings' || state.view==='clubManagement' || state.view==='finesManagement' || state.view==='gamesManagement' || state.view==='financeManagement' || state.view==='eventManagement') goToSettingsMenu();
```

Replace with:

```js
    if(state.view==='settings' || state.view==='clubManagement' || state.view==='finesManagement' || state.view==='gamesManagement' || state.view==='financeManagement' || state.view==='eventManagement' || state.view==='accountSettings') goToSettingsMenu();
```

- [ ] **Step 9: Add CSS for the wine icon badge and the account info card**

Find:

```css
  .settings-menu-item-icon.cat-blue{background:#3A6EA5;}
```

Replace with:

```css
  .settings-menu-item-icon.cat-blue{background:#3A6EA5;}
  .settings-menu-item-icon.cat-wine{background:var(--wine);}
```

Find:

```css
  .profile-item-icon{width:19px; height:19px; flex-shrink:0; color:var(--wine);}
```

Replace with:

```css
  .profile-item-icon{width:19px; height:19px; flex-shrink:0; color:var(--wine);}
  .account-info-card{
    background:var(--bg); border:1px solid var(--line); border-radius:10px;
    padding:12px 14px; margin-bottom:16px;
  }
  .account-info-name{font-family:var(--font-display); font-weight:700; font-size:15px;}
  .account-info-email{font-family:var(--font-body); font-size:13px; color:var(--muted); margin-top:2px;}
  .form-success{color:#2F7A5E; font-size:13px; margin:6px 0;}
```

(`.form-success` is added here already — it's needed by Tasks 5 and 7's success states, and this is the natural place next to `.form-error` in the same feature's CSS additions.)

- [ ] **Step 10: Manually verify the scaffold**

Serve the app, log in as a normal (non-admin) test member, open Einstellungen. Confirm:
- A "Mein Konto" row appears under "Profil", above "Abmelden", showing your test member's email as its subtitle.
- Tapping it opens a page titled "Mein Konto" showing your name and email in an info box, then "Sicherheit" (Passwort zurücksetzen, E-Mail-Adresse ändern) and "Gefahrenzone" (Konto-Verknüpfung aufheben, wine-colored icon).
- Tapping the buttons currently does nothing (not wired yet) — confirm no JavaScript error appears in the console when clicking them (an error there would mean a stray listener reference).
- The header back arrow returns to Einstellungen, not the main screen.
- Log in as the fixed `ADMIN_EMAIL` account and confirm "Mein Konto" does **not** appear (no member document exists for the admin).

- [ ] **Step 11: Commit**

```bash
git add index.html
git commit -m "Add Mein Konto menu item and account settings page scaffold"
```

---

### Task 5: Frontend — "Passwort zurücksetzen" modal

**Files:**
- Modify: `index.html` (add `showPasswordResetModal()` near the other modal functions, e.g. right after `showInviteMemberModal()`)
- Modify: `index.html` (`attachAccountSettingsListeners()` from Task 4)

**Interfaces:**
- Consumes: `showModal()`, `closeGenericModal()`, `getCurrentMember()`, `escapeHtml()`, `sendPasswordResetEmail` (Task 1).
- Produces: `showPasswordResetModal()`.

- [ ] **Step 1: Insert the new function after `showInviteMemberModal()`**

Find this exact block (the end of `showInviteMemberModal()` and the start of `showDeleteFineModal()`):

```js
      }catch(e){
        hideModalLoadingOverlay();
        btn.disabled = false; btn.textContent = 'Einladung senden';
        if(errEl) errEl.textContent = 'Einladung konnte nicht gesendet werden. Bitte später erneut versuchen.';
      }
    });
  }

  function showDeleteFineModal(fine){
```

Replace it with:

```js
      }catch(e){
        hideModalLoadingOverlay();
        btn.disabled = false; btn.textContent = 'Einladung senden';
        if(errEl) errEl.textContent = 'Einladung konnte nicht gesendet werden. Bitte später erneut versuchen.';
      }
    });
  }

  function showPasswordResetModal(){
    const member = getCurrentMember();
    const email = member ? member.email : '';
    showModal(`
      <h3>Passwort zurücksetzen</h3>
      <p>Wir senden einen Link an <strong>${escapeHtml(email)}</strong>, mit dem du ein neues Passwort festlegen kannst.</p>
      <p class="form-error" id="password-reset-error"></p>
      <div class="confirm-row-buttons" id="password-reset-actions">
        <button type="button" class="btn-secondary" id="modal-cancel-btn">Abbrechen</button>
        <button type="button" class="btn-primary" id="confirm-password-reset-btn">Link senden</button>
      </div>
    `);
    document.getElementById('modal-cancel-btn').addEventListener('click', closeGenericModal);
    document.getElementById('confirm-password-reset-btn').addEventListener('click', async ()=>{
      const btn = document.getElementById('confirm-password-reset-btn');
      const errEl = document.getElementById('password-reset-error');
      btn.disabled = true; btn.textContent = 'Wird gesendet…';
      try{
        await sendPasswordResetEmail(auth, email);
        document.getElementById('password-reset-actions').outerHTML = `<p class="form-success">E-Mail wurde gesendet. Prüfe dein Postfach.</p>`;
      }catch(e){
        btn.disabled = false; btn.textContent = 'Link senden';
        errEl.textContent = 'Konnte nicht gesendet werden. Bitte später erneut versuchen.';
      }
    });
  }

  function showDeleteFineModal(fine){
```

- [ ] **Step 2: Wire the button in `attachAccountSettingsListeners()`**

Find (added in Task 4):

```js
  function attachAccountSettingsListeners(){
  }
```

Replace with:

```js
  function attachAccountSettingsListeners(){
    const resetPwBtn = document.getElementById('account-reset-password-btn');
    if(resetPwBtn) resetPwBtn.addEventListener('click', showPasswordResetModal);
  }
```

- [ ] **Step 3: Manually verify**

On a test member whose email you control, open Mein Konto → "Passwort zurücksetzen" → "Link senden". Confirm: the button shows "Wird gesendet…" then the row is replaced by a green "E-Mail wurde gesendet…" message, and a real password-reset email arrives at that inbox. Click the link in the email and confirm it lands on this app's existing `renderSetPasswordScreen()` (`?mode=resetPassword&oobCode=...`) and lets you set a new password.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Add password reset modal to Mein Konto"
```

---

### Task 6: Frontend — "Konto-Verknüpfung aufheben" modal

**Files:**
- Modify: `index.html` (add `showUnlinkOwnAccountModal()` near `showPasswordResetModal()` from Task 5)
- Modify: `index.html` (`attachAccountSettingsListeners()`)

**Interfaces:**
- Consumes: `showModal()`, `showModalLoadingOverlay()`, `hideModalLoadingOverlay()`, `closeGenericModal()`, `clubDisplayName()`, `escapeHtml()`, `httpsCallable`, `functions`, `CURRENT_CLUB_ID`, `logout()` (`index.html:9620`).
- Produces: `showUnlinkOwnAccountModal()`, calls the `unlinkOwnAccount` Cloud Function from Task 2.

- [ ] **Step 1: Add the function**

Find this exact block (the end of `showPasswordResetModal()` from Task 5, followed by `showDeleteFineModal()`):

```js
        errEl.textContent = 'Konnte nicht gesendet werden. Bitte später erneut versuchen.';
      }
    });
  }

  function showDeleteFineModal(fine){
```

Replace it with:

```js
        errEl.textContent = 'Konnte nicht gesendet werden. Bitte später erneut versuchen.';
      }
    });
  }

  function showUnlinkOwnAccountModal(){
    const clubName = escapeHtml(clubDisplayName());
    showModal(`
      <h3>Konto-Verknüpfung aufheben</h3>
      <p>Dein Login-Zugang zu <strong>${clubName}</strong> wird entfernt. Deine Daten (Historie, Strafen, Beiträge) bleiben erhalten. Ein Vorstandsmitglied kann dich jederzeit erneut einladen.</p>
      <p>Bist du in keinem weiteren Verein mit diesem Konto angemeldet, wird dein Login komplett gelöscht und du wirst automatisch abgemeldet.</p>
      <p class="form-error" id="unlink-own-account-error"></p>
      <div class="confirm-row-buttons">
        <button type="button" class="btn-secondary" id="modal-cancel-btn">Abbrechen</button>
        <button type="button" class="btn-danger" id="confirm-unlink-own-yes">Verknüpfung aufheben</button>
      </div>
    `);
    document.getElementById('modal-cancel-btn').addEventListener('click', closeGenericModal);
    document.getElementById('confirm-unlink-own-yes').addEventListener('click', async ()=>{
      const btn = document.getElementById('confirm-unlink-own-yes');
      const errEl = document.getElementById('unlink-own-account-error');
      btn.disabled = true; btn.textContent = 'Wird entfernt…';
      showModalLoadingOverlay('Verknüpfung wird aufgehoben…');
      try{
        const unlinkFn = httpsCallable(functions, 'unlinkOwnAccount');
        await unlinkFn({ clubId: CURRENT_CLUB_ID });
        closeGenericModal();
        await logout();
      }catch(e){
        hideModalLoadingOverlay();
        btn.disabled = false; btn.textContent = 'Verknüpfung aufheben';
        errEl.textContent = 'Konnte nicht entfernt werden. Bitte später erneut versuchen.';
      }
    });
  }

  function showDeleteFineModal(fine){
```

- [ ] **Step 2: Wire the button**

Find (from Task 5):

```js
  function attachAccountSettingsListeners(){
    const resetPwBtn = document.getElementById('account-reset-password-btn');
    if(resetPwBtn) resetPwBtn.addEventListener('click', showPasswordResetModal);
  }
```

Replace with:

```js
  function attachAccountSettingsListeners(){
    const resetPwBtn = document.getElementById('account-reset-password-btn');
    if(resetPwBtn) resetPwBtn.addEventListener('click', showPasswordResetModal);
    const unlinkBtn = document.getElementById('account-unlink-btn');
    if(unlinkBtn) unlinkBtn.addEventListener('click', showUnlinkOwnAccountModal);
  }
```

- [ ] **Step 3: Deploy the backend function before testing this end-to-end**

```bash
cd functions
npm install
cd ..
firebase deploy --only functions:unlinkOwnAccount
```

The first time this function deploys, go to Google Cloud Console → Cloud Run → find the `unlinkownaccount` service → **Allow unauthenticated invocations** (same one-time step as every other `onCall` function in this project, see `functions/DEPLOY.md`).

- [ ] **Step 4: Manually verify — two scenarios**

Using disposable test members (never a real member's data):

1. **Single-club member:** create a test member in one club, invite them (`showInviteMemberModal`), log in as them, go to Mein Konto → "Konto-Verknüpfung aufheben" → confirm. Expect: the modal closes, the app signs out and shows the login screen. Confirm in Firebase Console → Authentication that the test user's account no longer exists.
2. **Multi-club member:** if you have (or can set up) a test account belonging to two clubs, unlink from one club only and confirm: you're signed out (current behavior is always a full sign-out, even for a partial unlink — matches the spec's "Nicht im Scope" decision), but logging back in still grants access to the *other* club, and in Firebase Console → Authentication the user still exists with `clubIds` containing only the remaining club.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Add unlink-own-account modal to Mein Konto"
```

---

### Task 7: Frontend — "E-Mail-Adresse ändern" modal and cross-club sync

**Files:**
- Modify: `index.html` (add `showChangeEmailModal()` near `showUnlinkOwnAccountModal()` from Task 6)
- Modify: `index.html` (add `checkPendingEmailChange()` near `updateOwnLastLogin()`, `index.html:9726-9734`)
- Modify: `index.html:9686` (call `checkPendingEmailChange()` from `init()`)
- Modify: `index.html` (`attachAccountSettingsListeners()`)

**Interfaces:**
- Consumes: `EmailAuthProvider`, `reauthenticateWithCredential`, `verifyBeforeUpdateEmail` (Task 1), `httpsCallable`, `functions`, `getCurrentMember()`, `invalidate()` (`index.html:1402`), `state.members`.
- Produces: `showChangeEmailModal()`, `checkPendingEmailChange()`, calls the `syncOwnEmailAcrossClubs` Cloud Function from Task 3. Writes/reads `localStorage['pendingEmailChange']` as `{ oldEmail: string, newEmail: string }`.

- [ ] **Step 1: Add `showChangeEmailModal()`**

Find this exact block (the end of `showUnlinkOwnAccountModal()` from Task 6, followed by `showDeleteFineModal()`):

```js
        errEl.textContent = 'Konnte nicht entfernt werden. Bitte später erneut versuchen.';
      }
    });
  }

  function showDeleteFineModal(fine){
```

Replace it with:

```js
        errEl.textContent = 'Konnte nicht entfernt werden. Bitte später erneut versuchen.';
      }
    });
  }

  function showChangeEmailModal(){
    const member = getCurrentMember();
    const currentEmail = member ? member.email : '';
    showModal(`
      <h3>E-Mail-Adresse ändern</h3>
      <p>Aus Sicherheitsgründen benötigen wir dein aktuelles Passwort. Nach dem Speichern erhältst du einen Bestätigungslink an die neue Adresse - erst danach wird sie aktiv.</p>
      <label for="change-email-new">Neue E-Mail-Adresse</label>
      <input type="email" id="change-email-new" placeholder="neue@email.de" autocomplete="email">
      <label for="change-email-password">Aktuelles Passwort</label>
      <input type="password" id="change-email-password" placeholder="••••••••" autocomplete="current-password">
      <p class="form-error" id="change-email-error"></p>
      <div class="confirm-row-buttons" id="change-email-actions">
        <button type="button" class="btn-secondary" id="modal-cancel-btn">Abbrechen</button>
        <button type="button" class="btn-primary" id="confirm-change-email-btn">Bestätigungslink senden</button>
      </div>
    `);
    document.getElementById('modal-cancel-btn').addEventListener('click', closeGenericModal);
    document.getElementById('confirm-change-email-btn').addEventListener('click', async ()=>{
      const newEmail = document.getElementById('change-email-new').value.trim();
      const password = document.getElementById('change-email-password').value;
      const errEl = document.getElementById('change-email-error');
      errEl.textContent = '';
      if(!newEmail || !newEmail.includes('@')){ errEl.textContent = 'Bitte eine gültige E-Mail-Adresse eingeben.'; return; }
      if(!password){ errEl.textContent = 'Bitte dein aktuelles Passwort eingeben.'; return; }
      const btn = document.getElementById('confirm-change-email-btn');
      btn.disabled = true; btn.textContent = 'Wird gesendet…';
      showModalLoadingOverlay('Bestätigungslink wird gesendet…');
      try{
        const user = auth.currentUser;
        const credential = EmailAuthProvider.credential(currentEmail, password);
        await reauthenticateWithCredential(user, credential);
        await verifyBeforeUpdateEmail(user, newEmail);
        localStorage.setItem('pendingEmailChange', JSON.stringify({ oldEmail: currentEmail, newEmail }));
        hideModalLoadingOverlay();
        document.getElementById('change-email-actions').outerHTML = `<p class="form-success">Bestätigungslink wurde an ${escapeHtml(newEmail)} gesendet. Prüfe dein Postfach.</p>`;
      }catch(e){
        hideModalLoadingOverlay();
        btn.disabled = false; btn.textContent = 'Bestätigungslink senden';
        if(e.code==='auth/wrong-password' || e.code==='auth/invalid-credential'){
          errEl.textContent = 'Passwort ist falsch.';
        }else if(e.code==='auth/email-already-in-use'){
          errEl.textContent = 'Diese E-Mail-Adresse wird bereits verwendet.';
        }else if(e.code==='auth/requires-recent-login'){
          errEl.textContent = 'Bitte melde dich erneut an und versuche es noch einmal.';
        }else{
          errEl.textContent = 'Konnte nicht gesendet werden. Bitte später erneut versuchen.';
        }
      }
    });
  }

  function showDeleteFineModal(fine){
```

(`showDeleteFineModal` itself is untouched — this block only confirms the insertion point. Do not duplicate it.)

- [ ] **Step 2: Add `checkPendingEmailChange()`**

Find:

```js
  async function updateOwnLastLogin(){
    try{
      const user = auth.currentUser;
      if(!user || user.email===ADMIN_EMAIL || !CURRENT_CLUB_ID) return;
      const updateOwnLastLoginFn = httpsCallable(functions, 'updateOwnLastLogin');
      await updateOwnLastLoginFn({ clubId: CURRENT_CLUB_ID });
      invalidate('members');
    }catch(e){ /* nicht kritisch, einfach ignorieren */ }
  }
```

Replace with:

```js
  async function updateOwnLastLogin(){
    try{
      const user = auth.currentUser;
      if(!user || user.email===ADMIN_EMAIL || !CURRENT_CLUB_ID) return;
      const updateOwnLastLoginFn = httpsCallable(functions, 'updateOwnLastLogin');
      await updateOwnLastLoginFn({ clubId: CURRENT_CLUB_ID });
      invalidate('members');
    }catch(e){ /* nicht kritisch, einfach ignorieren */ }
  }

  // Prüft bei jedem App-Start, ob eine per showChangeEmailModal() angestoßene E-Mail-Änderung
  // (Issue #60) inzwischen bestätigt wurde. verifyBeforeUpdateEmail() ändert auth.currentUser.email
  // erst NACH Klick auf den von Firebase verschickten Bestätigungslink - der Link wird typischerweise
  // in einer separaten Mail-App geöffnet, daher steht der Eintrag in localStorage (nicht
  // sessionStorage) und übersteht einen App-Neustart. user.reload() holt den aktuellen Stand vom
  // Server; stimmt die E-Mail noch nicht mit der erwarteten neuen überein, wurde der Link noch
  // nicht angeklickt - der Eintrag bleibt dann einfach stehen und wird beim nächsten Start erneut
  // geprüft.
  async function checkPendingEmailChange(){
    const raw = localStorage.getItem('pendingEmailChange');
    if(!raw) return;
    let pending;
    try{ pending = JSON.parse(raw); }catch(e){ localStorage.removeItem('pendingEmailChange'); return; }
    if(!pending || !pending.oldEmail || !pending.newEmail) { localStorage.removeItem('pendingEmailChange'); return; }
    const user = auth.currentUser;
    if(!user) return;
    try{ await user.reload(); }catch(e){ return; }
    if((auth.currentUser.email||'').toLowerCase() !== pending.newEmail.toLowerCase()) return;
    try{
      const syncFn = httpsCallable(functions, 'syncOwnEmailAcrossClubs');
      await syncFn({ oldEmail: pending.oldEmail });
      const m = state.members.find(x=> (x.email||'').toLowerCase()===pending.oldEmail.toLowerCase());
      if(m) m.email = pending.newEmail;
      invalidate('members');
    }catch(e){ return; }
    localStorage.removeItem('pendingEmailChange');
  }
```

- [ ] **Step 3: Call it from `init()`**

Find:

```js
      setTimeout(checkForUpdate, 2000);
      updateOwnLastLogin();
```

Replace with:

```js
      setTimeout(checkForUpdate, 2000);
      updateOwnLastLogin();
      checkPendingEmailChange();
```

- [ ] **Step 4: Wire the button**

Find (from Task 6):

```js
  function attachAccountSettingsListeners(){
    const resetPwBtn = document.getElementById('account-reset-password-btn');
    if(resetPwBtn) resetPwBtn.addEventListener('click', showPasswordResetModal);
    const unlinkBtn = document.getElementById('account-unlink-btn');
    if(unlinkBtn) unlinkBtn.addEventListener('click', showUnlinkOwnAccountModal);
  }
```

Replace with:

```js
  function attachAccountSettingsListeners(){
    const resetPwBtn = document.getElementById('account-reset-password-btn');
    if(resetPwBtn) resetPwBtn.addEventListener('click', showPasswordResetModal);
    const changeEmailBtn = document.getElementById('account-change-email-btn');
    if(changeEmailBtn) changeEmailBtn.addEventListener('click', showChangeEmailModal);
    const unlinkBtn = document.getElementById('account-unlink-btn');
    if(unlinkBtn) unlinkBtn.addEventListener('click', showUnlinkOwnAccountModal);
  }
```

- [ ] **Step 5: Deploy the backend function**

```bash
firebase deploy --only functions:syncOwnEmailAcrossClubs
```

First deploy: repeat the Cloud Run "Allow unauthenticated invocations" step from Task 6 for the `syncownemailacrossclubs` service.

- [ ] **Step 6: Manually verify — single club**

Using a disposable test member with an inbox you control: Mein Konto → "E-Mail-Adresse ändern" → enter a second test address you also control + your current password → "Bestätigungslink senden". Confirm the success message appears. Open the confirmation email and click the link (this hits Firebase's own hosted confirmation page). Back in the app, reload/restart — confirm `checkPendingEmailChange()` runs (add a temporary `console.log` if needed to observe it, then remove it), and that the member's email shown in Mitgliederverwaltung (as Kassenwart/Präsident) has changed to the new address. Confirm you can now log in with the new address (and that the old one no longer works).

- [ ] **Step 7: Manually verify — multi-club sync**

With a test account belonging to two clubs, repeat the email change. After clicking the confirmation link and restarting the app, verify the member document's email was updated in **both** clubs (check Mitgliederverwaltung in each), not just the currently active one.

- [ ] **Step 8: Verify error handling**

Retry "E-Mail-Adresse ändern" with a deliberately wrong password — confirm the inline error "Passwort ist falsch." appears and the form stays open (no crash, no accidental sign-out).

- [ ] **Step 9: Commit**

```bash
git add index.html
git commit -m "Add change-email modal with cross-club sync to Mein Konto"
```

---

### Task 8: Final end-to-end pass and cleanup

**Files:** none (verification only, plus removing any temporary debug logging left over from Task 7).

- [ ] **Step 1: Remove any temporary `console.log` calls** added during Task 7's manual verification, if any were left in.

- [ ] **Step 2: Full click-through as a normal member**

Fresh test member, fresh login. Walk the entire "Mein Konto" surface top to bottom: menu item shows correct email subtitle → page shows correct name/email → password reset sends and completes → email change completes and syncs → (as the *last* action, since it ends the session) unlink completes and signs out cleanly. Confirm the browser console shows no errors at any point in this walk.

- [ ] **Step 3: Confirm no regressions in existing account-related admin flows**

As Kassenwart/Präsident, open Mitgliederverwaltung and confirm the existing admin-side "Verknüpfung aufheben" (`showUnlinkAccountModal`) and "Einladen" (`showInviteMemberModal`) flows for *other* members still work unchanged — this plan didn't touch those functions, but verify no accidental collision (e.g. duplicate button ids) was introduced.

- [ ] **Step 4: Deploy everything together for a final confirmation**

```bash
firebase deploy --only functions,hosting
```

- [ ] **Step 5: Final commit (only if Step 1 changed anything)**

```bash
git add index.html
git commit -m "Remove temporary debug logging from email-change verification"
```
