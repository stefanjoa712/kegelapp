# Migration: Mitglieder-Blob -> eigene Dokumente

Hintergrund: Bisher lagen alle Mitglieder als ein JSON-Array in einem
gemeinsamen Firestore-Dokument (`kegelbuch/members`). Jede Änderung hat den
kompletten Array zurückgeschrieben - lief die App auf zwei Geräten mit
unterschiedlichem, veraltetem Stand, konnte das versehentlich Änderungen
überschreiben. Ab Version mit dieser Migration liegt jedes Mitglied als
eigenes Dokument (`kegelbuch/member-<id>`), Änderungen laufen über eine
Firestore-Transaktion.

## Einmalig einrichten

Voraussetzung: Node.js ist installiert.

```bash
gcloud auth application-default login
```
(Google Cloud CLI, falls noch nicht vorhanden: https://cloud.google.com/sdk/docs/install)
Meldet dich mit deinem Google-Account an, der Zugriff auf das Firebase-Projekt
`die-pudolfs` hat.

```bash
cd scripts
npm install
```

## Ausführen

Erst zur Kontrolle ohne Schreibvorgänge (Dry-Run):
```bash
node migrate-members.js
```
Zeigt an, welche Mitglieder gefunden wurden und was passieren würde. Es wird
dabei NICHTS in Firestore verändert.

Wenn die Ausgabe passt, die echte Migration anstoßen:
```bash
node migrate-members.js --apply
```

## Danach

- Der alte Blob `kegelbuch/members` bleibt unverändert in Firestore liegen
  (als Backup). Der App-Code nutzt ihn ab dem zugehörigen Deploy nicht mehr.
- Erst den neuen `index.html`-Stand deployen, NACHDEM die Migration
  erfolgreich durchgelaufen ist - sonst versucht die App, Mitglieder-
  Dokumente zu lesen, die noch nicht existieren (Mitgliederliste wäre leer).
- Nach ein paar Tagen stabilem Betrieb kannst du `kegelbuch/members` manuell
  in der Firebase Console löschen (Firestore -> Sammlung `kegelbuch` ->
  Dokument `members` -> löschen). Eilt nicht, ist nur Aufräumen.

## Falls etwas schiefgeht

Das Script ist idempotent - einfach erneut mit `--apply` ausführen, das
richtet keinen Schaden an. Der alte Blob wird nie gelöscht, ihr könnt also
jederzeit zur alten `index.html`-Version zurück-deployen, falls nötig.
