# Migration: Multi-Club-Vorbereitung + Mitglieder-Blob -> eigene Dokumente

Hintergrund: Bisher lagen alle Mitglieder als ein JSON-Array in einem
gemeinsamen Firestore-Dokument (`kegelbuch/members`). Jede Änderung hat den
kompletten Array zurückgeschrieben - lief die App auf zwei Geräten mit
unterschiedlichem, veraltetem Stand, konnte das versehentlich Änderungen
überschreiben.

Dieses Script macht zwei Dinge in einem Zug:

1. **Multi-Club-Vorbereitung:** Legt `clubs/die-pudolfs` mit den Club-
   Stammdaten an (Name, PayPal-Name für die Bezahl-URL, Gründungsdatum).
   Mitglieder liegen ab jetzt unter `clubs/<clubId>/members/...` statt im
   gemeinsamen `kegelbuch/` - jeder Club bekommt später einen eigenen,
   strukturell getrennten Datenbaum. Andere Bereiche (Kegelabende, Finanzen,
   Kalender) bleiben bewusst vorerst unter `kegelbuch/`, das ist ein
   eigener, späterer Schritt.
2. **Mitglieder-Struktur:** Jedes Mitglied liegt als eigenes Dokument
   (`clubs/<clubId>/members/<id>`), Änderungen laufen über eine Firestore-
   Transaktion statt über kompletten Array-Überschrieb.

## Einmalig einrichten

Voraussetzung: Node.js ist installiert und ihr habt schon mal `firebase login`
ausgeführt (falls ihr schon `firebase deploy` nutzt, ist das längst passiert -
kein zusätzliches Google-Cloud-SDK/`gcloud` nötig).

Kein `npm install` nötig - das Script kommt komplett mit Node-Bordmitteln aus
(kein `firebase-admin` mehr, siehe "Technischer Hintergrund" unten).

## Ausführen

Erst zur Kontrolle ohne Schreibvorgänge (Dry-Run):
```bash
cd scripts
node migrate-members.js
```
Zeigt an, welche Mitglieder gefunden wurden und was passieren würde. Es wird
dabei NICHTS in Firestore verändert.

Wenn die Ausgabe passt, die echte Migration anstoßen:
```bash
node migrate-members.js --apply
```

Das legt an:
- `clubs/die-pudolfs` mit Name "Die Pudolfs", PayPal-Name "diepudolfs",
  Gründungsdatum 30.08.2008
- `clubs/die-pudolfs/members/<id>` für jedes Mitglied
- `clubs/die-pudolfs/members/_index` mit der Liste aller Mitglieder-IDs

## Danach

- Der alte Blob `kegelbuch/members` bleibt unverändert in Firestore liegen
  (als Backup). Der App-Code nutzt ihn ab dem zugehörigen Deploy nicht mehr.
- Vor dem Deploy sicherstellen, dass auch die aktuellen Firestore-Regeln
  (`firestore.rules`) deployed sind (`firebase deploy --only firestore:rules`)
  - sonst blockt Firestore den Zugriff auf den neuen `clubs/`-Pfad.
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

## Migration: Strafen- und Spiele-Katalog

Zweites Script, `migrate-fines-games.js`, verschiebt analog den Strafen-
Katalog (`kegelbuch/fines-catalog`) und den Spiele-Katalog
(`kegelbuch/games-catalog`) zu `clubs/die-pudolfs/data/fines-catalog` bzw.
`clubs/die-pudolfs/data/games-catalog`. Anders als bei den Mitgliedern bleibt
hier jeweils ein einzelnes Blob-Dokument pro Club - beide Listen sind klein
und selten parallel bearbeitet, eine Aufteilung in Einzeldokumente lohnt sich
hier nicht.

```bash
cd scripts
node migrate-fines-games.js            # Dry-Run
node migrate-fines-games.js --apply    # echte Ausführung
```

Auch dieses Script ist idempotent und löscht die alten Dokumente unter
`kegelbuch/` nicht - gleiches Vorgehen wie bei der Mitglieder-Migration
(siehe "Danach" oben): erst `firestore.rules` deployen (bereits erledigt,
wenn ihr die Mitglieder-Migration schon gemacht habt), dann Script laufen
lassen, dann erst den neuen `index.html`-Stand deployen.

## Migration: Kalender (Termine, Rückmeldungen, Serien-Ausnahmen, Feed-Token)

Drittes Script, `migrate-calendar.js`, migriert alles rund um den Kalender:

- `calendar-events`, `calendar-rsvps` und `calendar-occurrence-edits` ->
  wie bei den Mitgliedern eigene Dokumente pro Eintrag
  (`clubs/die-pudolfs/events/<id>`, `.../rsvps/<id>`,
  `.../occurrence-edits/<id>`) + jeweils ein Index-Dokument. Grund: hier
  können mehrere Personen gleichzeitig auf unterschiedlichen Geräten etwas
  ändern - ein Termin wird angelegt während jemand anders zu einem anderen
  Termin zusagt, oder zwei Personen passen gleichzeitig unterschiedliche
  Einzeltermine EINER Serie an. Ein kompletter Array-Überschrieb hätte hier
  das gleiche Last-Write-Wins-Risiko wie ursprünglich bei den Mitgliedern.
- `calendar-feed-token` -> wie bei Strafen/Spielen ein einzelnes
  Blob-Dokument unter `clubs/die-pudolfs/data/`. Ein einzelner Wert, der
  praktisch nie parallel von mehreren Personen geschrieben wird.

```bash
cd scripts
node migrate-calendar.js            # Dry-Run
node migrate-calendar.js --apply    # echte Ausführung
```

Auch dieses Script ist idempotent und löscht die alten Dokumente unter
`kegelbuch/` nicht - gleiches Vorgehen wie bei den vorherigen Migrationen:
Script laufen lassen, Ausgabe kontrollieren, dann erst den neuen
`index.html`-Stand deployen. Ein Firestore-Regeln-Deploy ist hierfür nicht
nötig (die bestehende Regel deckt beliebige Pfadtiefen unter `clubs/`
bereits ab).

## Technischer Hintergrund: warum kein firebase-admin?

Ein erster Versuch, das Firebase-CLI-Zugriffstoken einfach an
`firebase-admin` durchzureichen, scheiterte mit `firestore/invalid-credential`
- das SDK verlangt ein "richtiges" Credential-Objekt (Service-Account-Key oder
über `gcloud` erzeugte Application Default Credentials) und akzeptiert kein
selbstgebautes Token-Objekt. Das Script spricht deshalb direkt die
Firestore-REST-API an (`firestore-rest-client.js`) - die braucht nur einen
normalen `Authorization: Bearer <token>`-Header, genau das, was wir über das
Firebase-CLI-Login ohnehin schon bekommen.

