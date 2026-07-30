# Einrichtung: Strafen-E-Mails über Resend

Diese Cloud Function versendet automatisch eine E-Mail mit den individuellen
Strafen an jedes Mitglied mit gepflegter E-Mail-Adresse, sobald ein
Kegelabend über "Kegelabend abschließen" abgeschlossen wird.

## Einmalige Einrichtung

### 1. Blaze-Tarif aktivieren
Cloud Functions benötigen den kostenpflichtigen Blaze-Tarif (Pay-as-you-go).
In der Firebase Console: **Projekteinstellungen → Nutzung und Abrechnung →
Plan ändern → Blaze**. Bei diesem winzigen Volumen (ein paar Mails pro
Kegelabend) bleibt ihr im kostenlosen Kontingent von Cloud Functions,
ihr müsst aber eine Zahlungsmethode hinterlegen.

### 2. Firebase CLI installieren (falls noch nicht vorhanden)
```bash
npm install -g firebase-tools
firebase login
```

### 3. Resend-API-Key als Secret hinterlegen
Im Projektordner (`kegelapp/`) ausführen:
```bash
firebase functions:secrets:set RESEND_API_KEY
```
Ihr werdet nach dem Wert gefragt - den API-Key aus eurem Resend-Dashboard
(Settings → API Keys) dort einfügen. Der Key landet NICHT im Code oder Git,
sondern verschlüsselt im Google Cloud Secret Manager.

### 4. Absenderadresse festlegen
In `functions/index.js` steht aktuell:
```js
const FROM_ADDRESS = 'Die Pudolfs <onboarding@resend.dev>';
```
Diese Resend-Sandbox-Adresse funktioniert nur eingeschränkt (im Zweifel nur
Zustellung an bei Resend selbst verifizierte Test-Adressen). Für echten
Versand an alle Mitglieder solltet ihr eine eigene Domain in Resend
verifizieren (Resend-Dashboard → Domains → Add Domain, dann die angezeigten
DNS-Einträge bei eurem Domain-Provider setzen) und die Zeile entsprechend
anpassen, z. B.:
```js
const FROM_ADDRESS = 'Die Pudolfs <strafen@eure-domain.de>';
```

### 5. Abhängigkeiten installieren und deployen
```bash
cd functions
npm install
cd ..
firebase deploy --only functions
```

Nach erfolgreichem Deploy läuft alles automatisch: Sobald ein Abend
abgeschlossen wird, feuert die Function und verschickt die E-Mails.

## Testen
1. Legt bei einem Testmitglied eure eigene E-Mail-Adresse ein.
2. Schließt einen Testabend ab, bei dem dieses Mitglied anwesend war.
3. Prüft die Firebase Console unter **Functions → Logs**, ob die Function
   gefeuert hat, und euer Postfach (ggf. Spam-Ordner).

## Wichtig
- Die Function feuert nur beim **Übergang** von offen → abgeschlossen,
  nicht bei jeder Änderung. Erneutes Schließen nach einem Wiederöffnen
  löst also erneut einen Mail-Versand aus.
- Ohne gepflegte E-Mail-Adresse beim Mitglied wird schlicht nichts versendet
  - kein Fehler, keine Aktion nötig.

## Rollen-Rechte (syncMemberRoleClaim)

Seit Version 1.51 gibt es einen Firestore-Trigger `syncMemberRoleClaim`, der
den Custom Claim `role` eines Auth-Accounts synchron zum `role`-Feld im
Mitgliedsdokument hält. Die Firestore Rules nutzen diesen Claim, um
Mitglieder-Schreibzugriff auf Admin, Kassenwart und Präsident zu beschränken.

- **Deploy:** ganz normal über `firebase deploy --only functions` (kein
  separater Schritt nötig, `syncMemberRoleClaim` wird mit ausgerollt).
- **Neue Cloud Run Function → öffentlichen Zugriff freischalten:** wie bei
  `inviteMember`, `unlinkMemberAccount` und `shareGuestBill` muss auch bei
  dieser Function nach dem allerersten Deploy in der Google Cloud Console
  unter Cloud Run manuell "Öffentlichen Zugriff erlauben" gesetzt werden -
  sonst schlägt der Trigger mit einem Berechtigungsfehler fehl. Da es sich
  um einen Firestore-Trigger (kein `onCall`) handelt, betrifft das primär
  die Rechte, mit denen die Function selbst laufen darf (Firestore/Auth
  Admin SDK) - prüft nach dem Deploy einmal die Logs (**Functions → Logs**),
  ob beim Speichern eines Mitglieds ein Eintrag von `syncMemberRoleClaim`
  ohne Fehler erscheint.
- **Firestore Rules:** läuft automatisch über die GitHub Action (Job
  `deploy-firestore-rules` in `.github/workflows/firebase-hosting-deploy.yml`),
  aber NUR wenn sich `firestore.rules` im jeweiligen Push geändert hat. Bei
  einem Push, der die Datei nicht anfasst, wird kein Rules-Deploy ausgelöst -
  bei Bedarf weiterhin manuell möglich: `firebase deploy --only firestore:rules`.
- **Bestehende Mitglieder nachziehen:** `syncMemberRoleClaim` feuert nur bei
  KÜNFTIGEN Schreibvorgängen auf ein Mitgliedsdokument - bestehende Mitglieder
  bekommen den `role`-Claim beim ersten Deploy nicht rückwirkend gesetzt. Nach
  dem ersten Deploy einmalig als Admin jedes bestehende Mitglied mit Account
  öffnen und auf "Speichern" klicken (auch ohne inhaltliche Änderung) - das
  reicht als Schreibvorgang, um den Trigger auszulösen. Betroffene Nutzer
  müssen sich danach einmal neu einloggen, damit ihr Browser den aktuellen
  Claim bekommt (Firebase cached ID-Tokens bis zu 1h).
- Ein bereits eingeloggter Nutzer bemerkt einen Rollenwechsel ggf. erst nach
  bis zu 1 Stunde (Firebase cached ID-Tokens) oder nach erneutem Login/Reload
  mit erzwungenem Token-Refresh - für Rollenwechsel in einem Kegelclub
  unkritisch.

## Kegelabend abschließen/wieder öffnen/löschen als Cloud Function

Seit Version 1.60 laufen diese drei Aktionen serverseitig
(`closeEvening`, `reopenEvening`, `deleteEvening` in `functions/index.js`)
statt direkt aus dem Client heraus. Grund: die Firestore Rules für
`clubs/{clubId}/arrears` und `clubs/{clubId}/transactions` sind auf
Kassenwart/Admin beschränkt (`canManageFinances()`), aber alle drei
Aktionen buchen automatisch Rückstands-Änderungen für JEDEN Nutzer, der
einen Abend abschließt - ohne den Umbau hätte die Rules-Einschränkung
diesen zentralen Ablauf für alle anderen Rollen gebrochen.

- **Deploy:** ganz normal über `firebase deploy --only functions`.
- **Neue Cloud Run Functions → öffentlichen Zugriff freischalten:**
  wie bei den anderen `onCall`-Functions muss auch bei `closeEvening`,
  `reopenEvening` und `deleteEvening` nach dem allerersten Deploy in der
  Google Cloud Console unter Cloud Run manuell "Öffentlichen Zugriff
  erlauben" gesetzt werden.
- **Atomare Schreibvorgänge:** alle drei nutzen einen Firestore
  `WriteBatch` (Hauptdokument, Index, betroffene Rückstands-Einträge in
  einem Rutsch) statt einzelner `Promise.all`-Schreibvorgänge wie zuvor
  im Client - ein Teilfehler kann die Buchung nicht mehr in einem
  inkonsistenten Zwischenzustand hinterlassen.
- **Berechtigung:** nur Kassenwart oder Admin (`requireFinanceRole()`),
  bewusst enger als die übrige Mitglieder-/Clubverwaltung (dort zählt auch
  Präsident) - identisch zu `canManageFinances()` in `firestore.rules` und
  `index.html`.
- **Notizen-Debounce:** der Client wartet vor dem Aufruf von `closeEvening`
  auf `pendingNotesSave` (siehe Notizen-Textarea-Handler in `index.html`,
  800ms Debounce), damit ein gerade getippter Notiz-Text garantiert
  gespeichert ist, bevor serverseitig gerechnet wird. Strafen speichern
  dagegen bereits bei jeder Änderung sofort (kein Debounce), sind also
  unabhängig davon immer aktuell.

