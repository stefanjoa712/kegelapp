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
