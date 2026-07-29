# Multi-Club-Migration: abgeschlossen

Die App wurde von einer gemeinsamen Firestore-Collection (`kegelbuch/`)
auf eine Struktur pro Club (`clubs/<clubId>/...`) umgestellt, als
Vorbereitung dafür, künftig mehrere Kegelclubs verwalten zu können. Alle
Daten liegen inzwischen unter `clubs/die-pudolfs/...`. Der alte
`kegelbuch/`-Pfad wird von der App nicht mehr gelesen oder geschrieben und
kann gelöscht werden.

Die Migrations-Skripte, mit denen dieser Umbau durchgeführt wurde, sind
nach erfolgreichem Abschluss aus diesem Ordner entfernt worden (waren
reine Einmal-Werkzeuge, kein Teil der App). Diese Übersicht dient als
Nachschlagewerk, warum die Datenbank so strukturiert ist wie sie ist.

## Datenstruktur

**Club-Stammdaten:** `clubs/<clubId>` (Name, PayPal-Name, Gründungsdatum).

**Einzeldokument pro Eintrag + Index-Dokument** (`clubs/<clubId>/<collection>/<id>`
+ `.../<collection>/_index` mit der Liste aller IDs) - für Daten, bei denen
mehrere Personen gleichzeitig unterschiedliche Einträge ändern können und
ein kompletter Array-Überschrieb ein Last-Write-Wins-Risiko gewesen wäre:

- `members` - Mitglieder
- `events`, `rsvps`, `occurrence-edits` - Kalender (Termine, Rückmeldungen,
  Serien-Ausnahmen)
- `arrears` - Finanz-Rückstände (Dokument-ID ist möglichst die Mitglieds-ID,
  nur für Gäste dient der Name als Fallback mit `guest-`-Präfix)
- `transactions` - Finanz-Buchungen (kollidiert sonst mit der täglichen
  Cloud Function `processRecurringBookings`, die automatisch Buchungen für
  fällige Daueraufträge anlegt)

**Sonderfall Kegelabende:** `clubs/<clubId>/evenings/<id>` als
Hauptdokument (Datum, Sitzordnung, Strafenkatalog-Snapshot, Notizen,
Abschluss-Status) + `clubs/<clubId>/evenings/<id>/seats/<seatId>` als
Unterdokument pro Sitzplatz für die eigentlichen Strafen-Zähler
(`finesBySeat`/`adHocFinesBySeat`) - weil mehrere Personen während eines
Abends gleichzeitig auf unterschiedlichen Geräten Strafen für
unterschiedliche Sitzplätze eintragen.

**Einfacher Blob** (`clubs/<clubId>/data/<key>`) - für kleine, selten
parallel bearbeitete Werte, bei denen sich eine Aufteilung nicht lohnt:

- `fines-catalog`, `games-catalog` - Strafen-/Spiele-Katalog
- `calendar-feed-token` - Token für den iCalendar-Feed
- `evenings-index` - Übersichts-Cache der Kegelabende (Datum, Kennzahlen je
  Abend; nicht zu verwechseln mit den technischen `_index`-Dokumenten der
  Einzeldokument-Collections oben - anderer Zweck, zufällig ähnlicher Name)
- `attendance-stats` - vorab aggregierte Anwesenheits-Statistik
- `finance-accounts`, `finance-recurring`, `finance-savings-pots` - Konten,
  Daueraufträge, Sparziele

## Betroffene Cloud Functions

`functions/index.js` liest/schreibt ausschließlich `clubs/die-pudolfs/...`:

- `sendFineEmailsOnClose` - Trigger-Pfad `clubs/<clubId>/evenings/{docId}`,
  reichert Termine/Abende bei Bedarf mit den Sitzplatz-Unterdokumenten an
  (`enrichEveningWithSeatFines`)
- `shareGuestBill` - durchsucht `clubs/<clubId>/evenings/`
- `processRecurringBookings` - liest `finance-recurring` aus
  `clubs/<clubId>/data/`, schreibt neue Buchungen einzeln unter
  `clubs/<clubId>/transactions/`
- `loadMembers`, `loadClubEntityCollection`, `saveClubEntity` - Helper zum
  Lesen/Schreiben der Einzeldokument-Collections
