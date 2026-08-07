# Design: Profil-Verwaltung (Self-Service) — Issue #60

## Kontext

Aktuell können nur Admins/Kassenwart/Präsident Mitgliedskonten verwalten
(`unlinkMemberAccount`, `requireManageMembersRole`). Eingeloggte Mitglieder
haben keine Möglichkeit, selbst ihr Passwort zu ändern, ihre E-Mail-Adresse
zu aktualisieren oder ihren Konto-Zugang zu einem Verein zu trennen.

Betroffene bestehende Bausteine:
- `functions/index.js:1390-1421` — `updateOwnLastLogin` (Vorbild für neue
  Self-Service-Functions: nur `requireCallerBelongsToClub`, kein Rollen-Check)
- `functions/index.js:1301-1325` — `removeMemberClubAuthAccess(email, clubId)`
  (bestehender Helper, wird wiederverwendet)
- `functions/index.js:1800-1817` — `unlinkMemberAccount` (Admin-Pendant)
- `index.html:2497-2584` — `viewSettingsMenu()` (Einstellungen-Hauptmenü)
- `index.html:4122-4133` — `getCurrentMember()` (Auth-User ↔ Firestore-Member
  per E-Mail-Match)
- Datenmodell: Mitglieder liegen pro Club unter `clubs/{clubId}/members/{id}`,
  keine `authUid`-Referenz — Verknüpfung ausschließlich über E-Mail-Match und
  Custom Claims `clubIds`/`roles`.

## Entschiedene Eckpunkte

- **Passwort ändern:** Reset-E-Mail-Flow (`sendPasswordResetEmail`), nutzt
  den bereits vorhandenen `renderSetPasswordScreen()`-Landingpage-Flow. Kein
  In-App-Formular mit alt/neu-Passwort.
- **E-Mail ändern:** Neue E-Mail wird nach Bestätigung automatisch in **allen**
  Club-Mitgliedschaften des Nutzers synchronisiert (nicht nur im aktuell
  aktiven Club), damit E-Mail-Match-Logik (`getCurrentMember`,
  `updateOwnLastLogin`, Rollen-Sync) in jedem Verein weiter funktioniert.
- **Konto-Verknüpfung aufheben:** Trennt nur den **aktuell aktiven Verein**
  (`CURRENT_CLUB_ID`). Bestehende Mitgliedschaften in anderen Vereinen bleiben
  unberührt. Ist der Nutzer nur in einem Verein, verschwindet der komplette
  Auth-Account automatisch (bestehende Logik in `removeMemberClubAuthAccess`).
- **Admin-Sonderfall:** Der `ADMIN_EMAIL`-Login hat kein Member-Dokument und
  bekommt die Seite "Mein Konto" nicht angezeigt (nur "Abmelden" bleibt).

## UI/UX-Design

### Einstellungen-Menü

Neuer Menüpunkt **"Mein Konto"** in der bestehenden Gruppe "Profil"
(`index.html:2571-2580`), oberhalb des `.profile-divider` / "Abmelden"-Buttons.
Vollwertiges `settings-menu-item` im Stil der übrigen Menüpunkte
(Icon-Badge `cat-blue`, Label, Untertitel = hinterlegte E-Mail-Adresse,
Chevron) — gebaut über `settingsMenuItemHtml()` (`index.html:2481-2496`),
verdrahtet in `attachSettingsMenuListeners()`.

Begründung: "Mein Konto" bündelt drei Aktionen und verdient einen eigenen
Bereich, anders als der reine Aktions-Link "Abmelden".

### Detailseite "Mein Konto"

Neue View, analog zu `viewClubManagement()` etc.:

- Info-Karte oben: Name + aktuelle E-Mail-Adresse (aus `getCurrentMember()`).
- Abschnitt **"Sicherheit"**:
  - "Passwort zurücksetzen" → Bestätigungsdialog → Erfolgsmeldung im Modal.
  - "E-Mail-Adresse ändern" → Formular-Modal.
- Abschnitt **"Gefahrenzone"** (visuell abgesetzt, wine-farben):
  - "Konto-Verknüpfung aufheben" → Warndialog, Danger-Button.

Die Gruppierung mit "Gefahrenzone" schafft bewusste Distanz zur
destruktiven Aktion (Vorbild: `showDeleteMemberModal`).

### Modal: Passwort zurücksetzen

Text: "Wir senden einen Link an **{email}**, mit dem du ein neues Passwort
festlegen kannst." Buttons: Abbrechen / "Link senden". Nach Erfolg: grüne
Erfolgsmeldung im selben Modal, kein Seitenwechsel.

### Modal: E-Mail-Adresse ändern

Ein Formular in einem Schritt: Feld "Neue E-Mail-Adresse" + Feld "Aktuelles
Passwort" (Reauth wird immer direkt mitabgefragt, um eine zweite
Fehlerrunde bei `auth/requires-recent-login` zu vermeiden). Hinweistext:
"Nach dem Speichern erhältst du einen Bestätigungslink an die neue Adresse —
erst danach wird sie aktiv." Buttons: Abbrechen / "Bestätigungslink senden".

### Modal: Konto-Verknüpfung aufheben

Warnbox (wine-farben): "Dein Login-Zugang zu **{Vereinsname}** wird entfernt.
Deine Daten (Historie, Strafen, Beiträge) bleiben erhalten. Ein
Vorstandsmitglied kann dich jederzeit erneut einladen." Zusatzhinweis, falls
`clubIds` nach der Aktion leer wäre: kompletter Login-Zugang wird gelöscht,
automatischer Logout. Buttons: Abbrechen / "Verknüpfung aufheben"
(`.btn-danger`-Stil wie `showUnlinkAccountModal`).

## Backend-Design

Neue Cloud Functions in `functions/index.js`, alle `onCall`, geprüft nur mit
`requireCallerBelongsToClub` (kein `requireManageMembersRole` wie bei den
Admin-Pendants):

### `syncOwnEmailAcrossClubs`

Aufgerufen, nachdem der Nutzer die neue E-Mail über den von Firebase
versendeten Bestätigungslink (`verifyBeforeUpdateEmail`) verifiziert hat und
`auth.currentUser.email` bereits die neue Adresse zeigt (erkannt beim
nächsten `onAuthStateChanged`/App-Start, ähnlich `bootstrapAuth()`).

**Wie die alte Adresse bekannt bleibt:** Der Member-Datensatz enthält keine
`authUid`-Referenz, daher kann die Function das Member-Dokument nach der
E-Mail-Änderung nicht mehr über `auth.currentUser.email` finden (die zeigt ja
bereits auf die neue Adresse). Das Frontend merkt sich deshalb die alte
Adresse selbst: unmittelbar bevor `verifyBeforeUpdateEmail()` aufgerufen
wird, schreibt es `{oldEmail, newEmail}` in `sessionStorage`
(`pendingEmailChange`). Beim nächsten App-Start prüft `bootstrapAuth()`, ob
dieser Eintrag existiert und `auth.currentUser.email === newEmail` bereits
zutrifft — dann wird `syncOwnEmailAcrossClubs({oldEmail, newEmail})` genau
einmal aufgerufen und der `sessionStorage`-Eintrag danach gelöscht.

- Function-Parameter: `{ oldEmail, newEmail }` (String, jeweils
  clientseitig übergeben — die Function verifiziert selbst nicht erneut, ob
  `newEmail` wirklich zu `request.auth.token.email` passt, tut dies aber
  vorab per Vergleich mit `request.auth.token.email`, um Missbrauch
  auszuschließen: schlägt fehl, wenn `newEmail` nicht der aktuellen
  Token-E-Mail entspricht).
- Liest `request.auth.token.clubIds` (Custom Claim).
- Für jeden Club darin: sucht das Member-Dokument, dessen `email`-Feld
  (case-insensitive) `oldEmail` entspricht, und aktualisiert es per
  Admin-SDK auf `newEmail` (`db.collection(...).set(...)`, gleiches Muster
  wie `updateOwnLastLogin`, da Firestore Rules (`firestore.rules:86-90`)
  normalen Mitgliedern das direkte Schreiben auf `members/{id}` verbieten).
- Idempotent: Clubs, in denen kein Member-Doc mit `oldEmail` gefunden wird
  (z.B. weil bereits synchronisiert), werden übersprungen statt einen Fehler
  zu werfen.

Der eigentliche `verifyBeforeUpdateEmail()`-Aufruf (inkl. vorherigem
`reauthenticateWithCredential`) passiert **client-seitig** im Frontend, nicht
in einer Cloud Function — Firebase Auth verlangt diesen Aufruf ohnehin vom
eingeloggten Client.

### `unlinkOwnAccount`

- Prüft nur `requireCallerBelongsToClub`.
- Ermittelt `callerEmail` aus `request.auth.token.email`.
- Ruft den bestehenden Helper `removeMemberClubAuthAccess(callerEmail,
  CURRENT_CLUB_ID)` unverändert auf.
- Kein neuer Code für die Löschlogik selbst nötig — nur eine neue, schwächer
  berechtigte Einstiegs-Function.

Passwort-Reset benötigt **keine** neue Cloud Function (reiner Client-Aufruf
`sendPasswordResetEmail(auth, email)`).

## Frontend-Datenfluss

- Neuer Eintrag in `VIEWS`-Registry (`index.html:3714ff`):
  `accountSettings: { body: viewAccountSettings, title: 'Mein Konto', attach:
  attachAccountSettingsListeners }`.
- Navigation: `goToAccountSettings()` (Pattern wie `goToClubManagement()`,
  `index.html:2207`).
- Datenquelle: `getCurrentMember()` (`index.html:4122-4133`) für Name/E-Mail;
  wenn `null` (Admin-Login), wird der Menüpunkt "Mein Konto" gar nicht erst
  gerendert.
- Neue Modal-Funktionen nach bestehendem Muster (`showModal`,
  `showModalLoadingOverlay`/`hideModalLoadingOverlay`, `.form-error`):
  - `showPasswordResetModal()`
  - `showChangeEmailModal()`
  - `showUnlinkOwnAccountModal()`
- Firebase-Auth-Imports in `index.html:898-902` müssen ergänzt werden um:
  `sendPasswordResetEmail`, `reauthenticateWithCredential`,
  `EmailAuthProvider`, `verifyBeforeUpdateEmail`.
- Nach erfolgreichem `unlinkOwnAccount`: `signOut(auth)` im Frontend, danach
  Redirect zum Login-Screen (bestehender Logout-Pfad wiederverwendet).

## Fehlerbehandlung

| Fall | Verhalten |
|---|---|
| `auth/wrong-password` bei Reauth (E-Mail-Änderung) | Inline-Fehler am Passwort-Feld ("Passwort ist falsch"), Formular bleibt offen |
| `auth/requires-recent-login` trotz Reauth | Inline-Fehler mit Hinweis, erneut zu versuchen |
| `auth/email-already-in-use` | Inline-Fehler am E-Mail-Feld |
| Netzwerk-/Function-Fehler bei `unlinkOwnAccount` | Fehlermeldung im Modal, Button wieder aktiv, **kein** Logout |
| `sendPasswordResetEmail` schlägt fehl | Fehlermeldung im Modal, Button wieder aktiv |

## Testing-Ansatz

Kein automatisiertes Test-Setup im Repo vorhanden. Verifikation manuell über
die Browser-Preview:
1. Passwort-Reset-Mail an echten Test-User, Landingpage-Flow
   (`renderSetPasswordScreen`) prüfen.
2. E-Mail-Änderung mit zwei Test-Adressen, Sync über mehrere Test-Vereine
   prüfen (Login danach in beiden Vereinen weiterhin möglich).
3. Konto-Verknüpfung aufheben mit einem Wegwerf-Testmitglied — einmal mit
   nur einer Vereinsmitgliedschaft (kompletter Account weg), einmal mit
   zwei Mitgliedschaften (nur ein Verein getrennt).

## Nicht im Scope

- Kein In-App-Passwortformular (alt/neu-Passwort) — bewusst zugunsten des
  Reset-E-Mail-Flows verworfen.
- Keine Auswahl einzelner Vereine bei "Konto-Verknüpfung aufheben" — nur der
  aktuell aktive Verein wird getrennt.
- Keine neue Cloud Function für Passwort-Änderung.
