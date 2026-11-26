# Homelab-Zentrale

Die Homelab-Zentrale ist ein privates Kontrollzentrum für einen Admin. Auf einer Oberfläche sieht und steuert man alle Server (Heimserver, Cloud-VM, Raspberry Pi, weitere VPS), Docker-Container, Gameserver mit Benutzerlinks für Freunde, das GitHub-Konto mit Deploys, alle Websites und die Wohnung. Das Designsystem folgt der Idee einer **Kommandozentrale**: dunkel, ruhig und präzise. Bernstein leuchtet nur dort, wo etwas zu tun ist.

**Grundsatz: Wenn alles läuft, ist der Bildschirm still.** Farbe ist ein Signal und keine Deko. Ein Blick muss reichen, um zu wissen, ob es irgendwo ein Problem gibt.

## Stimme und Text

Die Oberfläche spricht wie ein guter Techniker am Funk: kurz, sachlich, mit echten Zahlen. Sie duzt.

- **Status zuerst, dann Details.** „example.at ist offline“ und nicht „Es gibt ein Problem mit einer Website“.
- **Echte Werte statt Adjektive.** „RAM 92 %“ statt „RAM fast voll“. „vor 4 Min“ statt „kürzlich“.
- **Zahlen im österreichischen Format.** Komma als Dezimaltrennzeichen, ein Leerzeichen vor der Einheit: `7,8 GB`, `38 W`, `21,4 °C`. Uhrzeiten im 24-h-Format: `23:04`.
- **Technische Namen bleiben technisch.** Container, Hosts und Repos stehen in Kleinschreibung und so, wie sie im System heißen: `homeassistant`, `oracle-a1`, `my-app`.
- **Buttons:** Verb im Infinitiv, ohne Ausrufezeichen: „Starten“, „Neu deployen“, „Backup jetzt“.
- **Meldungen:** Titel = Was + Wo, Text = Seit wann + was hilft. „Speicher auf heimserver bei 81 %. Aufräumen gibt ca. 40 GB frei.“
- **Nie:** Emojis, „Ups!“, Marketing-Sprache oder Ausrufezeichen bei Fehlern.

## Farbe

Es gibt drei Themes, die dieselben Token-Namen teilen:

| Theme | Wofür | Grund |
| --- | --- | --- |
| **Dunkel** (Standard) | Desktop, Handy, abends | Kontrollraum-Gefühl, Zahlen leuchten |
| **Hell** | Tagsüber, draußen am Handy | Warmes Papierweiß statt grellem Weiß |
| **Wandmodus** | Altes Tablet oder Smart Display an der Wand | Echtes Schwarz (OLED, nachts kaum Licht), etwas kräftigere Statusfarben |

**Flächen** stufen sich in vier Ebenen ab: `bg-000` (Seite) → `bg-100` (Kachel) → `bg-200` (Hover, Eingabe) → `bg-300` (gedrückt, Schienen). Getrennt wird über `line`-Haarlinien, nie über Schatten.

**Text** hat drei Stufen: `ink` für Inhalt und Zahlen, `ink-muted` für Einheiten und Hosts, `ink-faint` für Labels und Zeitstempel. Alle drei erreichen in jedem Theme mindestens 4.5:1 auf `bg-100` und `bg-200`.

**Bernstein (`accent`)** ist die einzige Markenfarbe. Er wird verwendet für
- den Primary-Button (eine Hauptaktion pro Ansicht),
- den aktiven Navigationspunkt (`accent-soft`-Fläche mit `accent-ink`-Text),
- den Tastaturfokus (`focus-ring`),
- Git-Hashes und das Bernstein-Quadrat im Zeichen.

Text auf Bernstein ist immer `on-accent` (fast schwarz). Als Textfarbe auf Flächen nimmst du `accent-ink`, weil `accent` im hellen Theme zu wenig Kontrast hat.

**Status** hat vier Farben, und jede trägt eine eigene Form mit, damit es auch ohne Farbsehen funktioniert:

| Status | Token | Form | Bedeutung |
| --- | --- | --- | --- |
| Läuft | `ok` | ● Kreis · `UP` | Alles in Ordnung |
| Warnung | `warn` | ◆ Raute · `WARN` | Bald ein Problem: Last, Speicher, Update offen |
| Ausgefallen | `crit` | ■ Quadrat, pulsiert · `DOWN` | Jetzt kaputt, bitte handeln |
| Gestoppt | `off` | ○ Ring · `OFF` | Absichtlich aus |
| Info / Startet | `info`, `busy` | ● Kreis · `INFO`/`BOOT` | Deploy läuft, neuer Commit |

Neben dem Punkt steht ein kurzes Tag in Mono (UP, WARN, DOWN …), wie in einer Terminal-Ausgabe. Die deutsche Langform steht im Tooltip und wird vorgelesen.

`warn` teilt sich bewusst den Bernstein-Ton mit `accent`: Bernstein heißt immer „hier schauen“. Weil die Form unterschiedlich ist (Raute statt Button oder Fläche), verwechselt man die beiden nicht. Zu jeder Statusfarbe gibt es eine `-soft`-Fläche für Badges und Meldungen.

**Konsole:** `terminal-bg` und `terminal-ink` bleiben in allen Themes dunkel.

## Typografie

Es gibt zwei Familien, beide von Google Fonts:

- **Space Grotesk** (`--font-sans`) für Oberfläche, Titel und Text. Sie ist technisch, aber freundlich, und ihre eckigen Details passen zur Kommandozentrale.
- **JetBrains Mono** (`--font-mono`) für alles, was gemessen wird: Zahlen, Labels, Hashes, IPs, Logs. Sie hat immer `tabular-nums`, damit Zahlen beim Aktualisieren nicht springen.

| Stil | Größe | Wofür |
| --- | --- | --- |
| `display` | 32/38 · 600 | Statussatz oben („2 Probleme · 3 von 4 Servern laufen“) |
| `title` | 14/20 · 600 | Kachel- und Abschnittstitel |
| `body` / `body-strong` | 13/20 · 400/600 | Text, Dienstnamen |
| `small` | 12/16 | Zeitstempel, Hilfe |
| `label` | 11/16 Mono · Versalien · +8 % | Beschriftung über Zahlen, immer `ink-faint` |
| `metric-xl` | 28/32 Mono | Hauptzahl einer Kachel |
| `metric` | 16/20 Mono | Werte in Listen |
| `code` | 12/20 Mono | Konsole, Logs |
| `wall-metric` / `wall-label` | 96 / 20 Mono | Wandmodus |

## Raster und Form

- **4-px-Raster.** Abstände kommen aus `space-1` (4) bis `space-7` (48). Innenabstand einer Kachel ist `space-4`, der Abstand im Kachelraster ebenfalls `space-4`, der Seitenrand am Desktop `space-6`.
- **Kachelraster:** 4 Spalten ab 1200 px, 2 Spalten ab 700 px, sonst 1. Kacheln spannen 1–4 Spalten.
- **Radien bleiben klein:** `radius-sm` (2) für Badges und Balken, `radius-md` (4) für Buttons und Zeilen, `radius-lg` (6) für Kacheln. Das System ist präzise, nicht weich. `radius-full` nur für Statuspunkte.
- **Terminal-Details:** Auslastung als segmentierte Zellenbalken wie in htop, Status-Tags in Versalien, Meldungen als Logzeilen (`23:02 CRIT …`), Schalter als AN/AUS-Segment, Tastenkürzel in der Navigation.
- **Schatten** gibt es nur für schwebende Ebenen (`raise`: Toasts, Menüs, Dialoge). Kacheln liegen flach.
- **Bewegung:** Nur Pulsieren bei `crit` und `busy`, der Cursor in der Konsole und kurze Übergänge (120–300 ms). Bei `prefers-reduced-motion` ist alles statisch.

## Komponenten

Alle Komponenten liegen in `components/bundle.js` als `window.HZ` und brauchen React 18. Die Styles stehen in `components/bundle.css` (Klassen mit Präfix `hz-`), die Typen in `components/index.d.ts`.

| Gruppe | Komponenten |
| --- | --- |
| Grundlagen | `Icon` |
| Aktionen | `Button` |
| Status | `StatusDot`, `Badge` |
| Layout | `Tile`, `NavRail`, `ServerSwitch` |
| Server | `ServerList` |
| Daten | `Metric`, `UsageBar` (mit `BlockBar`), `Sparkline`, `Terminal` |
| Listen | `ServiceRow`, `WebCheckRow` |
| Git | `RepoRow`, `CommitRow` |
| Gameserver | `GameServer`, `GameTemplates`, `ShareLink` |
| Smart Home | `Toggle` |
| Rückmeldung | `Alert` |

Die Karte **Dashboard** zeigt die fertige Übersichtsseite, zusammengesetzt aus diesen Teilen. Sie ist die Vorlage für die Startseite.

### So ist eine Seite aufgebaut

1. Links `NavRail`, am Handy eine untere Leiste mit Übersicht, Server, Git und Meldungen.
2. Oben `display`-Titel mit einem Statussatz („Alles läuft.“ oder „1 Problem auf oracle-a1.“) und rechts `ServerSwitch`.
3. Darunter das Kachelraster. **Probleme stehen zuerst:** Kacheln mit `crit` rutschen nach oben links.
4. Meldungen erscheinen als `Alert` mit `floating` unten rechts und gleichzeitig als Push am Handy, mit demselben Text.

### Bereiche und ihre Bausteine

- **Übersicht:** Statussatz, offene `crit`-Alerts, `ServerList` über die volle Breite, darunter Gameserver, Websites, GitHub und Container als Paare.
- **Server:** `ServerList` als Leiste mit allen Servern. Ein Klick öffnet die Detailansicht mit `UsageBar` (CPU, RAM, Disk, Temperatur, Netz), `Sparkline`-Verläufen, laufenden Containern und Web-SSH (`Terminal`). Jeder Server meldet sich über einen kleinen Agent, verbunden über Tailscale.
- **Container:** `ServiceRow` pro Container mit Ghost-Buttons (Logs, Neustart, Update), gruppiert nach Server.
- **Gameserver:** `GameServer`-Kacheln für alles, was läuft. „Neuer Server“ öffnet `GameTemplates` (Minecraft Java/Bedrock, Valheim, Terraria, CS2, Palworld …). Danach Name, Server, Version, Spielerzahl, und die Zentrale startet den Docker-Container. „Teilen“ erzeugt einen `ShareLink`.
- **Benutzerlinks:** Freunde bekommen einen eigenen Link pro Gameserver. Er zeigt nur diesen einen Server und nur die freigegebenen Aktionen (Start/Stopp, Neustart, Konsole, Whitelist, Dateien). Er läuft ab, ist widerrufbar und protokolliert, wer was getan hat.
- **GitHub:** Das Konto ist über die GitHub-App bzw. den Token angebunden. `RepoRow` pro Repo zeigt CI-Status, wohin es deployt ist und ob neue Commits warten, mit „Deploy“ per Knopf. Darunter steht der Verlauf als `CommitRow`, inklusive Rollback.
- **Websites:** `WebCheckRow` pro URL und Port: HTTP-Code, Antwortzeit, SSL-Ablauf, Domain-Ablauf. Geprüft wird jede Minute.
- **Wohnung:** `Toggle` für Geräte, `Metric` für Klima, Strom und CO₂.
- **Meldungen:** Alle `Alert`-Logzeilen chronologisch und filterbar nach Level und Server. Die gleichen Texte gehen als Push ans Handy.
- **Konsole:** `Terminal` im Vollbild mit Server-Auswahl.

## Wandmodus

Der Wandmodus ist eine eigene Ansicht und nicht nur ein Theme: `data-theme="wall"`, nur Lesen, keine Navigation, große Kacheln (2×2) mit `Metric size="wall"`. Eine Zahl pro Kachel, aus 3 m lesbar. Probleme erscheinen als ganze rote Kachel. Nachts (22–7 Uhr) dimmt die Ansicht auf 40 %, nur `crit` bleibt hell.

## Iconografie

Es gibt 25 Linien-Icons (`Icon`, sowie als SVG unter `assets/Icons`) auf einem 24er-Raster mit 1,75 Strich. Ein Icon begleitet immer ein Wort und ersetzt es nie. Die Ausnahme sind Ghost-Buttons in Zeilen, und die haben `aria-label`. Icons bleiben `ink-faint` oder `ink-muted`. Statusfarben bekommen sie nur in `Alert`.

Das Zeichen (`assets/Logos`) ist ein Rahmen mit Bernstein-Quadrat unten rechts. Ein ausgearbeitetes Logo gibt es noch nicht. Daneben steht der Name in Space Grotesk 600.

## Zugänglichkeit

- Text erreicht mindestens 4.5:1 in allen drei Themes. Rahmen von Bedienelementen (`line-strong`) und der Fokusring erreichen mindestens 3:1.
- Status wird immer über Form und Text vermittelt, nie über Farbe allein.
- Jedes Bedienelement hat einen sichtbaren `focus-ring`.
- Touch-Ziele am Handy sind mindestens 36 px hoch (`Button md`).

## Nicht tun

- Keine Verläufe, kein Glas-Effekt, keine Neon-Glows, kein Blau-Lila.
- Keine farbigen Kacheln für normale Zustände. Grün ist der Statuspunkt und nicht die ganze Kachel.
- Kein Bernstein als Deko. Wenn alles Bernstein ist, ist nichts mehr wichtig.
- Keine Emoji-Icons und keine Diagramme mit Achsen in Kacheln. Details gehören in die Detailansicht.


## Dateien in diesem Ordner

| Datei | Inhalt |
| --- | --- |
| `tokens.json` | Alle Tokens (Quelle). Farben in 3 Themes, Typografie, Abstände, Radien, Schatten |
| `tokens.css` | Aus `tokens.json` erzeugt: CSS-Variablen pro Theme (`:root`/`[data-theme=…]`) und eine Klasse pro Schriftstil |
| `components.css` | Styles aller Komponenten (`hz-`-Klassen). Inklusive Google-Fonts-Import (Space Grotesk, JetBrains Mono) |
| `reference/bundle.js` | Referenzimplementierung aller Komponenten (React 18, ohne JSX) als `window.HZ` |
| `reference/index.d.ts` | Props jeder Komponente. Diese Props gelten auch für die TSX-Version in `packages/ui` |
| `reference/components/*.md` | Richtlinien pro Komponente |
| `reference/previews/*.html` | Beispiele pro Komponente mit echten Daten, direkt im Browser zu öffnen. `Dashboard.html` ist die Vorlage für die Startseite |
| `assets/` | Zeichen (Logo) und Icons als SVG |

**Ändern:** Tokens nur in `tokens.json` ändern und `tokens.css` neu erzeugen. Größere Änderungen am Design zuerst im Live-Designsystem (https://claude.ai/artifact/NxJ5BnwwiSdZfCQUsJsv5w) machen und dann hierher übernehmen.

**Schriften:** Für die PWA (offline) Space Grotesk und JetBrains Mono als woff2 selbst hosten (`apps/web/public/fonts`), statt sie von Google Fonts zu laden. Beide stehen unter der OFL-Lizenz.
