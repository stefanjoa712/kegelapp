# Design: Menüpunkt „Club wechseln" — Issue #88

## Kontext

Ein Auth-Account kann laut Custom Claim `clubIds` mehreren Clubs zugeordnet
sein. `resolveActiveClub()` (`index.html:986-1012`) wird aktuell
ausschließlich beim Login aufgerufen (`onAuthStateChanged`,
`index.html:10036ff`) und setzt `CURRENT_CLUB_ID` einmalig für die gesamte
Session:

- Bei genau einem zugeordneten Club wird dieser automatisch übernommen.
- Bei mehreren Clubs zeigt `showClubSelectionScreen(clubIds)`
  (`index.html:9753ff`) eine Auswahl — deren Wahl wird bewusst nicht
  gemerkt, bei jedem Login erneut gefragt.
- Der Admin-Account (`ADMIN_EMAIL`) bekommt unabhängig vom eigenen Claim
  immer eine Auswahl über alle existierenden Clubs (`getAllClubIds()`,
  `index.html:1811ff`).

Es gibt aktuell keine Möglichkeit, den aktiven Club innerhalb einer
laufenden Session zu wechseln — dafür ist zwingend Abmelden + erneutes
Anmelden nötig.

Betroffene bestehende Bausteine:
- `resolveActiveClub()` (`index.html:986-1012`)
- `showClubSelectionScreen()` (`index.html:9753ff`)
- `bootstrapAuth()` (`index.html:10028ff`)
- `viewSettingsMenu()` / `settingsMenuItemHtml()` (`index.html:2501-2615`)
- `attachSettingsMenuListeners()` (`index.html:6994-7011`)

## Entschiedene Eckpunkte

- **Ablauf:** Auswahl-Screen erscheint sofort beim Klick auf „Club
  wechseln" (In-App, kein Reload). Erst nach der Auswahl wird die
  gewählte `clubId` in `sessionStorage` abgelegt und `location.reload()`
  ausgelöst — nur ein sichtbarer Ladezyklus nach der Auswahl, kein
  zusätzlicher Boot-Screen davor.
- **Bei genau 2 Clubs:** Kein Sonderfall — immer die volle Auswahl zeigen,
  auch bei nur 2 Einträgen.
- **Abbrechen-Option:** Keine. Die Auswahl beim Wechseln verhält sich
  identisch zum Login-Fall (`showClubSelectionScreen()` bleibt
  unverändert wiederverwendbar).
- **Unsaved-Warnung vor Reload:** Keine. Analog zum bestehenden
  Update-Reload (`index.html:9852`), bewusst nicht abgefangen.
- **Persistenz:** Die Club-Wahl wird weiterhin nicht dauerhaft gemerkt —
  nach regulärem Logout/Login oder einem einfachen Reload (ohne Klick auf
  „Club wechseln") wird bei >1 Club wie bisher jedes Mal neu gefragt.
  Keine Verhaltensänderung gegenüber heute.

## Technisches Design

### Zwischenspeicherung der verfügbaren Club-IDs

`resolveActiveClub()` ist bereits die einzige Stelle, die die
Club-Zugehörigkeit ermittelt (Admin: `getAllClubIds()`, Mitglied: Claim
`clubIds`). Sie cacht das Ergebnis zusätzlich in einer neuen
Modul-Variable `AVAILABLE_CLUB_IDS` (analog zu `CURRENT_CLUB_ID`), bevor
sie ggf. `showClubSelectionScreen()` aufruft oder den einzigen Eintrag
direkt zurückgibt. Damit steht die Information dem Einstellungen-Menü zur
Verfügung, ohne bei jedem Menü-Aufbau einen neuen Token-Request
auszulösen — dieselbe Quelle/Logik wie in `resolveActiveClub()`, sowohl
für normale Mitglieder als auch für den Admin-Sonderfall.

`AVAILABLE_CLUB_IDS` wird beim Logout (im `else`-Zweig von
`onAuthStateChanged` in `bootstrapAuth()`) wieder auf `null` gesetzt,
analog zu `CURRENT_CLUB_ID`/`CURRENT_CLUB_DATA`.

### Override-Mechanismus für den Wechsel

Neue Konstante `CLUB_SWITCH_STORAGE_KEY` und Hilfsfunktion
`consumeClubSwitchOverride()`, die den Wert einmalig aus `sessionStorage`
liest und den Eintrag danach entfernt (Single-Use).

`resolveActiveClub()` wird so erweitert, dass sie — nachdem sie die
verfügbare Club-Liste ermittelt und in `AVAILABLE_CLUB_IDS` gecacht hat —
einen vorhandenen Override konsumiert und, falls die enthaltene `clubId`
Teil der gerade ermittelten `AVAILABLE_CLUB_IDS`-Liste ist, diese direkt
zurückgibt statt `showClubSelectionScreen()` aufzurufen. Die Validierung
gegen die frisch ermittelte Liste schützt davor, dass ein veralteter oder
manipulierter `sessionStorage`-Wert auf einen Club verweist, auf den der
Account inzwischen keinen Zugriff mehr hat — in diesem Fall fällt die
Funktion auf den normalen Auswahl-Pfad zurück.

Dieser Weg ersetzt die im Issue skizzierte Variante, den Override separat
in `bootstrapAuth()` zu prüfen: Die Logik bleibt vollständig in
`resolveActiveClub()` gebündelt, die einzige Stelle, die ohnehin schon
zwischen Admin-/Mitglieder-Fall unterscheidet.

### Neue Funktion `switchClub()`

```
async function switchClub(){
  const clubId = await showClubSelectionScreen(AVAILABLE_CLUB_IDS);
  sessionStorage.setItem(CLUB_SWITCH_STORAGE_KEY, clubId);
  location.reload();
}
```

Wählt der Nutzer zufällig wieder den bereits aktiven Club, läuft der
Reload trotzdem durch (kein Sonderfall) — funktional korrekt, nur ein
unnötiger zusätzlicher Ladevorgang.

### Einstellungen-Menü

Neuer Menüpunkt „Club wechseln" in `viewSettingsMenu()`
(`index.html:2517ff`), Gruppe „Kontenübersicht", zwischen „Mein Konto"
und „Abmelden":

- Sichtbar nur wenn `AVAILABLE_CLUB_IDS && AVAILABLE_CLUB_IDS.length > 1`.
- Aufbau über `settingsMenuItemHtml()` wie die übrigen Einträge,
  `colorClass: 'cat-purple'` (passend zur Gruppe, wie „Mein Konto").
- Subtitle: Name des aktuell aktiven Clubs (`clubDisplayName()`).
- Icon: Wechsel-/Tausch-Symbol (zwei gegenläufige Pfeile), im Stroke-Stil
  der übrigen Icons.

`attachSettingsMenuListeners()` (`index.html:6994ff`) verdrahtet den
Klick auf `switchClub()`.

## Testplan (manuell, da kein automatisierter Test-Setup im Projekt)

- Mitglied mit genau 1 Club: Menüpunkt „Club wechseln" erscheint nicht.
- Mitglied mit 2 Clubs: Menüpunkt erscheint, Subtitle zeigt aktuellen
  Club, Klick zeigt Auswahl mit beiden Clubs, Auswahl löst Reload aus und
  landet im gewählten Club (Daten, Rolle, Branding korrekt für den neuen
  Club).
- Admin-Account mit >1 existierendem Club: Menüpunkt erscheint ebenfalls,
  Auswahl zeigt alle Clubs.
- Admin-Account mit genau 1 existierendem Club: Menüpunkt erscheint
  nicht.
- Nach einem Wechsel: erneuter Login/Logout fragt wie bisher jedes Mal
  neu (keine dauerhafte Persistenz der Wahl).
- Nach einem Wechsel: „Club wechseln" ist im neuen Club weiterhin
  sichtbar/funktionsfähig (prüft, dass `AVAILABLE_CLUB_IDS` nach dem
  Override-Pfad korrekt neu gesetzt wird).
