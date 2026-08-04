# Migrationsscripts

## migrate-to-member-ids.js

Einmaliger Umbau von namensbasierter auf memberId-basierte Referenzierung (Rückstände,
Anwesenheitsstatistik, RSVPs, Sitzplan, Termin-Ersteller). Muss **pro Club einmal** laufen,
**nachdem** der Code-Umbau (Branch `feature/member-id-refactor`) live ist, aber **bevor**
alte Clients/Daten sich darauf verlassen, dass `memberId` überall gesetzt ist.

### Voraussetzungen

```bash
cd scripts
npm install
```

Zugangsdaten: entweder `GOOGLE_APPLICATION_CREDENTIALS` auf einen Service-Account-Key setzen,
der Firestore-Zugriff auf das Kegelapp-Projekt hat, oder in einer Umgebung mit Application
Default Credentials ausführen (z.B. `gcloud auth application-default login` lokal).

### Ausführung

Erst **immer zuerst** einen Dry-Run pro Club, um die Log-Ausgabe zu prüfen:

```bash
node migrate-to-member-ids.js <clubId> --dry-run
```

Wenn die Ausgabe plausibel aussieht (Anzahl migrierter/übersprungener Einträge stimmt mit
der Erwartung überein), dann echt ausführen:

```bash
node migrate-to-member-ids.js <clubId>
```

Für mehrere Clubs: das Script einmal pro `clubId` aufrufen (kein Multi-Club-Batch-Modus,
bewusst so gehalten, um zwischen den Clubs jeweils die Ausgabe kontrollieren zu können).

### Was NICHT migriert wird

- Nicht mehr auflösbare Namen (Mitglieder, die zwischenzeitlich gelöscht wurden) - werden
  übersprungen, ohne Log. Ihre alten Sitzplatz-/Rückstands-/Statistik-Einträge bleiben ohne
  `memberId` bestehen und sind danach in memberId-basierten Auswertungen nicht mehr sichtbar -
  das ist dasselbe Verhalten wie vorher (kein passendes Mitglied mehr vorhanden).
- Gäste bekommen bei der Migration eine neue `guest-<uuid>`. Bereits bestehende
  Rückstands-Zusammenführung zwischen mehreren Abenden eines Gastes mit exakt gleichem
  Namen geht dadurch verloren (bewusste Entscheidung, siehe Absprache).
