# Spezifikation: Homelab-Zentrale

## 1. Ziel und Nutzer

Ein Admin will alle eigenen Server, Container, Gameserver, Repos, Websites und die Wohnung auf **einer** Oberfläche sehen und steuern, am Desktop, am Handy (PWA) und auf einem Tablet an der Wand.

**Grundsatz:** Wenn alles läuft, ist der Bildschirm still. Probleme stehen immer oben, und ein Blick muss reichen.

Außer dem Admin gibt es nur eine Art von Nutzer: **Freunde mit einem Benutzerlink** für einen einzelnen Gameserver (Abschnitt 6.4). Sie sehen nichts anderes.

## 1a. Für jeden deploybar, Module

Die Zentrale ist nicht an eine bestimmte Person, Stadt oder ein bestimmtes Netz gebunden. Alles Persönliche steht in der Konfiguration (`.env`, Einstellungen), nicht im Code: Basis-URL, Zeitzone (`HZ_TIMEZONE`, Standard `Europe/Vienna`), Server-Namen, Domains.

Optionale Teile sind **Module**, die der Admin unter Einstellungen → Module an- und ausschaltet:

| Modul | Standard bei Neuinstallation | Aus heißt |
| --- | --- | --- |
| GitHub | aus | keine GitHub-Seite, kein Polling, keine Deploys; die Zentrale braucht GitHub nicht |
| Home Assistant | aus | keine Seite „Wohnung“, keine Verbindung zu HA |
| Gameserver | an | keine Gameserver-Seite, keine Benutzerlinks |
| Proxmox | aus | keine Seite „VMs“, keine Verbindung zu Proxmox |
| DNS-Filter (Pi-hole/AdGuard) | aus | kein DNS-Bereich auf „Netzwerk“ |
| FRITZ!Box | aus | kein Router-Bereich auf „Netzwerk“ |
| Uptime Kuma | aus | kein Kuma-Bereich auf „Websites“ |

Ein ausgeschaltetes Modul verschwindet aus Navigation, Übersicht und Befehlspalette, seine API antwortet `404 module_disabled`, und es läuft nichts im Hintergrund. Container-Images gibt es fertig in der GitHub Container Registry; wer GitHub nicht nutzen will, baut sie lokal (`HZ_BUILD_LOCAL=1`).

## 2. Ausgangslage (Beispiel-Setup)

| Server | Ort | Rolle | Erreichbarkeit |
| --- | --- | --- | --- |
| `heimserver` | zu Hause, Ubuntu Server 24.04, Docker | Core, Home Assistant, eigene Web-Apps, kleinere Gameserver | Tailscale; zu Hause hinter dem Router, öffentliche IPv4 mit DDNS |
| `oracle-a1` | Oracle Cloud, VM.Standard.A1.Flex (ARM), Ubuntu | Gameserver (Minecraft Paper), öffentliche Dienste | Tailscale; reservierte öffentliche IP |
| `pi` | Raspberry Pi 5 | kleine Dienste | Tailscale |
| weitere | beliebig | | Tailscale |

Alle Server laufen auf Linux mit Docker. ARM (Oracle, Pi) und x86 müssen beide unterstützt werden: Multi-Arch-Images für den Agent.

## 3. Navigation und Seiten

Linke Navigation (`NavRail`). Die Tastenkürzel `1`–`9` gehen nach Position der sichtbaren Punkte (ausgeschaltete Module fehlen), die Konsole hat immer `` ` ``:

1. Übersicht
2. Server
3. Container
4. VMs (Modul Proxmox)
5. Gameserver
6. GitHub
7. Websites
8. Netzwerk (Module FRITZ!Box und DNS-Filter)
9. Wohnung
10. Meldungen
11. Konsole (`` ` ``)

Dazu kommen die Einstellungen (Zahnrad unten in der Navigation) und eine **Befehlspalette** (`Strg/⌘+K`): Suche über Server, Container, Repos, Gameserver und Aktionen wie „minecraft neu starten“ oder „my-app deployen“.

Am Handy wird die Navigation zur unteren Leiste mit Übersicht, Server, Gameserver und Meldungen sowie „Mehr“ für den Rest.

Oben auf jeder Seite steht ein **Statussatz**, der zuerst die Probleme nennt („2 Probleme · 3 von 4 Servern laufen“), und rechts der **ServerSwitch**, der die Seite auf einen Server filtert.

## 4. Übersicht

Die Vorlage ist `design/reference/previews/Dashboard.html`:

1. Statussatz und ServerSwitch
2. Offene `crit`-Meldungen als `Alert` (höchstens 3, dann „+N weitere“)
3. `ServerList` über die volle Breite
4. Gameserver (laufende) und Websites als Paar
5. GitHub (Repos mit neuen Commits zuerst) und Container (Probleme zuerst) als Paar
6. Wohnung (Klima, Strom, wichtigste Schalter), wenn Home Assistant verbunden ist

Alles aktualisiert sich live über WebSocket. Es gibt kein Neuladen.

## 5. Server

### 5.1 Liste
`ServerList`: Status, Name, Ort, Tailscale-IP, CPU, RAM, Disk, Uptime. Sortierung: `crit` → `warn` → Name.

**Status-Regeln** (Schwellen pro Server einstellbar):
- `crit`: Agent seit über 90 s nicht gemeldet, Disk ≥ 95 %, RAM ≥ 95 % für 5 Min
- `warn`: CPU ≥ 85 % für 10 Min, RAM ≥ 90 %, Disk ≥ 85 %, Temperatur ≥ 75 °C, Sicherheitsupdates offen, Neustart nötig (`/var/run/reboot-required`)
- `ok`: sonst

### 5.2 Detail
- `UsageBar` für CPU, RAM, Swap, jede Disk, Temperatur; `Sparkline` für die letzten 24 h (CPU, RAM, Netz ein/aus)
- System: OS, Kernel, Architektur, Uptime, Tailscale-IP, öffentliche IP (falls vorhanden)
- Updates: Anzahl offener Pakete, davon Sicherheitsupdates, „Neustart nötig“
- Sicherheit: fehlgeschlagene SSH-Logins (24 h), von fail2ban gesperrte IPs (falls installiert), offene Ports (`ss -tlnp`)
- Container dieses Servers (Abschnitt 6)
- Aktionen: „Aufräumen“ (zeigt vorher die frei werdenden GB: apt-Cache, alte Kernel, Journal > 200 MB, ungenutzte Docker-Images) und „Neustart“ (Danger, mit Bestätigung durch Eintippen des Servernamens)

### 5.3 Server hinzufügen (Enrollment)
1. In der Zentrale: „Server hinzufügen“ → Name eingeben → einmaliges Token (15 Min gültig)
2. Die Zentrale zeigt einen Einzeiler zum Kopieren: `docker run …` bzw. ein Compose-Snippet mit `HZ_CORE_URL` und Token
3. Der Agent meldet sich, tauscht das Einmal-Token gegen ein dauerhaftes Agent-Token und erscheint in der Liste

### 5.4 Speicher und NAS (M13)
Für Server mit Festplatten, vor allem ein NAS wie das UGREEN NASync (UGOS Pro ist ein Debian mit md-RAID, LVM und btrfs/ext4 unter `/volume1`; eine offene Schnittstelle bietet UGOS nicht, deshalb liest der Agent den Host selbst):
- **Anbinden:** Wie jeder Server: in UGOS SSH einschalten (Systemsteuerung → Terminal), Docker ist dabei. Dann den Einzeiler aus „Server hinzufügen“ per SSH als root ausführen. Auf einem UGREEN-NAS schaltet der Einzeiler SMART selbst ein; sonst `--smart` anhängen.
- **Anzeige** im Serverdetail, Abschnitt „Speicher“: RAID-Arrays (Level, Platten x/y, Zustand, Fortschritt bei Neuaufbau oder Prüfung), Volumes (belegt/gesamt), Platten (Modell, Größe, HDD/SSD/NVMe, SMART-Zustand, defekte Sektoren, Betriebsstunden, Abnutzung, Temperatur, „schläft“). Übersicht: Kachel „Speicher“ mit allen Servern, die RAID haben oder ein NAS sind, Probleme zuerst.
- **Meldungen:** RAID beschädigt/inaktiv und SMART-Ausfall `crit`; defekte Sektoren, Medienfehler, SSD-Abnutzung ab 90 % `warn`; Temperatur je nach Plattenart (HDD warn 50 °C / crit 60 °C, SATA-SSD 60/70, NVMe 70/80). Erholt sich etwas, kommt eine OK-Meldung.
- **Schlafende Platten** werden nie geweckt: SMART wird mit `--nocheck=standby` gelesen und höchstens alle 10 Min; während die Platte schläft, bleiben die letzten Werte stehen, die Temperatur zeigt „schläft“.
- Nur lesend: Die Zentrale ändert nichts am RAID und an den Platten.
- Modul „NAS und Speicher“ (Standard an), unter Einstellungen → Module abschaltbar.
- **NAS als Backup-Ziel (M13b), auch ohne Agent auf dem NAS** (z. B. UGREEN DH2300 ohne Docker): Ein Server bindet eine Freigabe des NAS unter `/opt/homelab/backup-target` ein. Jede Nacht zur eingestellten Uhrzeit (Standard 05:00) und per „Jetzt kopieren“ kopiert der Agent dort die Gameserver-Backups seiner Spiele hin, und die Zentrale schickt einen Schnappschuss ihrer Datenbank (Secrets bleiben verschlüsselt). Jede Kopie wird zurückgelesen und per SHA-256 geprüft, die neuesten N (Standard 14) bleiben. Ist die Freigabe nicht eingebunden oder schreibgeschützt, wird nichts geschrieben und es kommt eine `warn`-Meldung; ebenso bei vollem NAS oder abgebrochener Kopie, mit OK-Meldung danach. Einstellungen → Backup → „NAS als Backup-Ziel“, Änderung mit Step-up. Die Erreichbarkeit des NAS prüfen normale Checks (Weboberfläche per HTTP, SMB per TCP 445).

## 6. Container und Gameserver

### 6.1 Container
`ServiceRow` pro Container, gruppiert nach Server: Status (running/exited/restarting/unhealthy), Name, Image, Ports, Uptime oder Exit-Code, CPU/RAM.
Aktionen: Logs (live, `Terminal`, die letzten 500 Zeilen plus Folgen), Start, Stop, Neustart, „Image aktualisieren“ (pull + recreate, für Compose-Projekte über `docker compose pull && up -d`).
Compose-Projekte werden als Gruppe erkannt (Label `com.docker.compose.project`).

### 6.2 Gameserver anlegen
„Neuer Gameserver“ öffnet `GameTemplates`:

| Vorlage | Image | RAM | Port |
| --- | --- | --- | --- |
| Minecraft Java (Paper/Vanilla/Fabric) | `itzg/minecraft-server` | 4–8 GB | 25565/tcp |
| Minecraft Bedrock | `itzg/minecraft-bedrock-server` | 2 GB | 19132/udp |
| Valheim | `lloesche/valheim-server` | 4 GB | 2456-2458/udp |
| Terraria / tModLoader | `ryshe/terraria` | 2 GB | 7777/tcp |
| Counter-Strike 2 | `joedwards32/cs2` | 8 GB | 27015/tcp+udp |
| Palworld | `thijsvanloef/palworld-server-docker` | 16 GB | 8211/udp |
| Satisfactory (M12, nur amd64) | `wolveix/satisfactory-server` | 12 GB | 7777/tcp+udp, 8888/tcp |
| Factorio (M12) | `factoriotools/factorio` | 2 GB | 34197/udp |
| Enshrouded (M12, nur amd64) | `mornedhels/enshrouded-server` | 16 GB | 15637/udp |
| Project Zomboid (M12, nur amd64) | `danixu86/project-zomboid-dedicated-server` | 8 GB | 16261-16262/udp |
| ARK: Survival Evolved (M12, nur amd64) | `hermsi/ark-server` | 12 GB | 7777-7778/udp, 27015/udp |
| Rust (M12, nur amd64) | `pfeiffermax/rust-game-server` | 12 GB | 28015/udp, 28017/udp |
| V Rising (M12, nur amd64) | `trueosiris/vrising` | 8 GB | 9876-9877/udp |

Vorlagen liegen als Dateien in `templates/games/<id>/`: `compose.yml` mit `${VAR}`-Platzhaltern und `template.json` (Name, Image, Ports, RAM, Felder für das Formular, Query-Methode, RCON-Unterstützung). Neue Vorlagen sind einfach ein neuer Ordner. Seit M12 sagt `template.json` auch, auf welchen CPU-Architekturen das Image läuft (`arch`); nur passende Server sind wählbar.

**Ablauf:**
1. Vorlage wählen
2. Formular: Name, Zielserver (mit freiem RAM, „zu wenig RAM frei“ als Warnung), Version, max. Spieler, Port (Vorschlag: der nächste freie), vorlagenspezifische Felder (z. B. Minecraft: Typ, Seed, Whitelist an/aus, Online-Mode)
3. „Aufsetzen“: Der Core rendert die Compose-Datei, der Agent legt sie unter `/opt/homelab/games/<name>/` ab und startet sie. Der Fortschritt erscheint live (Image ziehen, Welt erzeugen, „bereit“).
4. Danach erscheint die `GameServer`-Kachel. Der Hinweis zur Portweiterleitung (Router bzw. Oracle Security List) wird mit den genauen Ports angezeigt, wenn der Server von außen erreichbar sein soll.

RCON-Passwörter werden automatisch erzeugt und verschlüsselt gespeichert.

### 6.3 Gameserver betreiben
`GameServer`-Kachel: Spiel, Version, Adresse (Klick kopiert sie; extern: DDNS-Name oder öffentliche IP mit Port), Spieler x/y mit Namen, RAM, TPS (Minecraft), Status.
Aktionen: Start/Stop, Neustart, Konsole (RCON, sonst `docker attach`), Teilen (Benutzerlink), Backup jetzt (Welt-Ordner als tar.zst nach `/opt/homelab/backups/`, die letzten 7 behalten), Einstellungen (Formular von oben, mit Neustart), Löschen (Danger, Name eintippen; die Welt wird vorher gesichert).
Spielerdaten kommen über RCON/Query (`minecraft-server-util`) bzw. GameDig (`gamedig`).
Optional: automatisch stoppen nach N Minuten ohne Spieler.

### 6.4 Benutzerlinks (Share)
Freunde bekommen pro Gameserver einen Link, mit dem sie **nur diesen Server** steuern.
- Erstellen: Name der Person, Rechte (Starten/Stoppen, Neustart, Konsole lesen, Konsole schreiben, Whitelist bearbeiten), Ablauf (1 Tag / 7 Tage / 14 Tage / 30 Tage / nie)
- Link: zufälliges Token (≥ 128 Bit, URL-safe). Gespeichert wird nur der Hash. Optional zusätzlich eine 4-stellige PIN.
- Die Seite hinter dem Link zeigt: Name des Servers, Status, Adresse zum Kopieren, Spieler online und die erlaubten Knöpfe. Sonst nichts: keine Server-Liste, keine IPs, keine Navigation.
- Jede Aktion wird mit Person und Zeit protokolliert und ist in der Gameserver-Detailseite sichtbar.
- Widerrufen jederzeit. Abgelaufene Links zeigen „Link abgelaufen“.
- **Erreichbarkeit:** Über das optionale Share-Gateway (`apps/share`, siehe `docs/NETWORK.md`). Solange das Gateway aus ist, funktionieren Links nur im Tailnet. Das ist der Standard.

### 6.5 Gameserver: Schlafmodus, Zeitpläne, Mods (M12)
- **Schlafmodus:** Nach X Min ohne Spieler (Standard 15 bei neuen Servern) stoppt die Zentrale den Server sauber und lässt den Agent auf seinen Ports lauschen. Der erste echte Verbindungsversuch weckt ihn (Minecraft: Login; Bedrock: Verbindungsanfrage; andere: erstes Spielpaket, keine Steam-Serverlisten-Abfragen). Im Schlaf zeigt die Minecraft-Serverliste „Schläft – zum Aufwecken verbinden“. Der Agent leitet nie Daten weiter. Aufwecken prüft die RAM-Reserve (6a); passt es nicht, bleibt der Server aus und es gibt eine Meldung.
- **Zeitpläne:** Neustart oder Backup an gewählten Wochentagen um HH:MM. Vor einem Neustart warnt RCON die Spieler 5 und 1 Min vorher. Schlafende Server werden für Neustarts nicht geweckt.
- **Discord:** pro Gameserver ein Webhook (nur `discord.com`/`discordapp.com`), Ereignisse online, offline, schläft, aufgeweckt. Die Nachricht enthält nur Name, Spiel, die eingetragene externe Adresse und die Spielerzahl.
- **Statistik:** Spielzeit pro Spieler, Sitzungen, Ø Spieler pro Stunde, Höchststand (7 oder 30 Tage).
- **Mods/Plugins:** Für Minecraft Java mit Paper (Plugins) oder Fabric (Mods) Suche in Modrinth, Installieren der neuesten passenden Version, Entfernen. Dateien kommen nur von `cdn.modrinth.com` und werden per sha512 geprüft.
- **Backup wiederherstellen:** Knopf am Backup, mit Step-up und Namensbestätigung; vorher entsteht ein frisches Backup.
- **Benutzerlinks:** zusätzliche Rechte „Welt herunterladen“ und „Whitelist-Anfrage“ (Admin bestätigt per Push-Hinweis und Knopf im Detail).
- **Netz am Server:** zuhause / Cloud / VPS / anderes. Danach richtet sich der Hinweis zur Portweiterleitung (Router bzw. Firewall des Anbieters).

### 6.6 Game-Relay und feste Adressen (M15)
Jeder Server mit öffentlicher IPv4 kann **Eingang** sein. Ein Gameserver kann über einen Eingang laufen: Der Agent am Eingang nimmt die Spielports an und leitet sie über Tailscale zu dem Server, auf dem das Spiel gerade läuft. Zu Hause muss dann nichts im Router freigegeben werden. Zieht der Gameserver um, ändert sich nur das Ziel; Adresse und Port für Freunde bleiben gleich. Optional bekommt jeder Gameserver einen festen DNS-Namen, den die Zentrale über das Domains-Modul (Abschnitt 18, Cloudflare oder DuckDNS) auf den Eingang zeigen lässt. Hinweis: Das Spiel sieht als Absender die Tailscale-Adresse des Eingangs, IP-Sperren im Spiel wirken deshalb nicht pro Spieler.

## 6a. Prioritäten und automatisches Drosseln

Jeder Container und jeder Gameserver hat eine **Priorität**:

| Priorität | Bedeutung |
| --- | --- |
| `wichtig` | Muss immer laufen (z. B. die eigene Web-App). Wird nie gedrosselt oder gestoppt. Fällt er aus, startet die Zentrale ihn neu (höchstens 3 Versuche in 10 Min, dann CRIT-Meldung). |
| `normal` | Standard. Wird nicht automatisch angefasst. |
| `niedrig` | Darf gedrosselt werden, wenn ein Server knapp wird (typisch: Gameserver). Optional „darf gestoppt werden“. |

Regel pro Server (Schwellen in den Server-Einstellungen, Standard: CPU über 90 % oder RAM über 90 % für 2 Min):

1. **Drosseln:** Die Zentrale begrenzt die CPU der `niedrig`-Container (zuerst den mit der höchsten CPU) auf einen Anteil (Standard 1 Kern) mit `docker update --cpus`. RAM-Limits werden nie automatisch gesenkt (das würde den Prozess abschießen).
2. **Stoppen:** Bleibt der Server weitere 5 Min über der Schwelle und ist der Container als „darf gestoppt werden“ markiert, stoppt die Zentrale ihn (Gameserver sauber über `compose down` wie beim Stopp von Hand, vorher Speichern per RCON, wenn vorhanden). Gameserver mit Spielern online werden nur gestoppt, wenn das ausdrücklich erlaubt ist.
3. **Aufheben:** Ist der Server 10 Min unter der Schwelle minus 10 Prozentpunkte, hebt die Zentrale die Drosselung wieder auf. Automatisch gestoppte Container startet sie nicht von selbst neu (Meldung mit Knopf „Wieder starten“).

Jeder Eingriff ist eine `warn`-Meldung mit Grund („minecraft gedrosselt: heimserver CPU 96 % seit 2 Min“) und steht im Protokoll. Die Zentrale und der Agent (`hz.role`) sind immer `wichtig` und nie Ziel. Ein Schalter pro Server schaltet die Automatik ganz ab.

## 7. GitHub

- **Anbindung:** Ein Fine-grained Personal Access Token (Contents read, Actions read, Metadata read; für Deploy nur read nötig). Es wird verschlüsselt gespeichert. Später ist eine GitHub-App möglich.
- **Abgleich:** Polling alle 60 s mit ETags (spart Rate-Limit), da der Core nicht öffentlich erreichbar ist und deshalb keine Webhooks bekommt.
- **Repos:** `RepoRow` pro Repo: letzter Commit, Branch, CI-Status (letzter Workflow-Run), wohin deployt, „N neu“, wenn GitHub weiter ist als der Server.
- **Deploy-Ziele** pro Repo (in den Repo-Einstellungen der Zentrale): Server, Pfad (`/opt/homelab/apps/<repo>`), Branch, Methode (`compose`: `git fetch && git checkout <sha> && docker compose up -d --build`; `script`: eine Datei `deploy.sh` im Repo), optional „automatisch deployen, wenn CI grün“.
- **Deploy:** Knopf in `RepoRow`, Live-Log im `Terminal`, Ergebnis als `Alert`. Ist CI rot, wird nicht angeboten zu deployen. Sperre: pro Ziel höchstens ein Deploy gleichzeitig.
- **Verlauf:** `CommitRow`-Liste (die letzten 30 Commits) mit LIVE-Markierung. Ein Commit, der früher deployt war, bekommt den Knopf „Rollback“.
- Klonen privater Repos auf dem Zielserver: Ein Deploy-Key pro Repo (die Zentrale erzeugt ihn und zeigt an, wo er bei GitHub einzutragen ist) oder das Token per HTTPS. Der Key liegt nur auf dem Zielserver.

## 8. Websites und Checks

`WebCheckRow` pro Check. Arten:
- **HTTP(S):** URL, erwarteter Status (Standard 200–399), optional ein Text, der vorkommen muss, Timeout 10 s
- **TCP:** Host:Port (z. B. Gameserver-Port)
- **Ping (ICMP)** über den Agent

Ein Check läuft von einem wählbaren Ort aus: dem Core oder einem bestimmten Agent. So lässt sich „von außen“ prüfen, z. B. von Oracle aus auf die Heim-IP.
Intervall 60 s, Status `crit` erst nach 2 Fehlschlägen hintereinander (gegen Fehlalarme).
Zusätzlich: SSL-Ablauf (Warnung < 14 Tage, crit < 5 Tage) und Domain-Ablauf über RDAP (täglich, Warnung < 30 Tage).
Verlauf: Uptime in % für 24 h / 7 d / 30 d, Antwortzeit als `Sparkline`.

## 9. Meldungen und Push

- Jedes Ereignis wird zur Meldung (`Alert`-Logzeile): Zeit, Level (OK/INFO/WARN/CRIT), Titel (Was + Wo), Details (seit wann + was hilft), Server, Quelle.
- Meldungen haben einen Zustand: offen → bestätigt → erledigt (automatisch erledigt, wenn sich der Zustand erholt; dann kommt eine OK-Meldung).
- **Push:** Web-Push (VAPID) an die installierte PWA. Regeln: `crit` sofort; `warn` gesammelt, höchstens eine Push alle 30 Min; „Ruhezeit“ 23–7 Uhr nur `crit`.
- Weitere Kanäle (Abschnitt 16): Discord-Webhook, Telegram-Bot, ntfy. Gleiche Regeln wie Push, pro Kanal ein Mindest-Level.
- **Wochenbericht** sonntags 19:00: Uptime pro Server/Website, Ausfälle, Deploys, Backups, Speicherverbrauch.
- Texte nach den Regeln in `design/README.md` → „Stimme und Text“.

## 9a. Betrieb: Log-Suche, Schwachstellen-Scan, Fail2ban

Drei optionale Module (Einstellungen → Module, ab Werk aus). Ein ausgeschaltetes Modul antwortet mit 404 `module_disabled`.

- **Log-Suche:** Ein Suchfeld durchsucht die Container-Logs aller verbundenen Server (oder einer Auswahl) gleichzeitig. Reiner Text (nie RegExp), Zeitraum 5 Min bis 7 Tage, optional Containername als Filter, höchstens 500 Treffer, neueste zuerst. Pro Server sieht man, ob er durchsucht wurde (offline, Agent zu alt, kein passender Container). Höchstens 10 Suchen pro Minute; der Suchtext landet nie im Log, im Audit nur seine Länge.
- **Schwachstellen-Scan:** Jede Nacht (Uhrzeit einstellbar, Standard 03:30) scannt Trivy auf dem Agent die Images aller laufenden Container. Die Zentrale nennt nur den Container, nie ein Image. Ergebnis pro Container: Anzahl kritischer und hoher Lücken mit CVE und behobener Version. Ab der eingestellten Schwelle (nur kritische oder auch hohe) gibt es eine WARN-Meldung („2 kritische Lücken in nginx“), die sich von selbst erledigt, wenn die Lücken weg sind oder der Container verschwindet. Manuell höchstens ein Lauf alle 10 Min.
- **Fail2ban:** Jails und gesperrte IPs jedes Servers (live vom Agent, 30 s zwischengespeichert). Eine einzelne IP lässt sich in einem Jail entsperren; das landet im Audit-Log.

## 10. Wohnung (Home Assistant)

- Verbindung über URL und Long-Lived Access Token (verschlüsselt gespeichert), WebSocket-API für Live-Zustände.
- In den Einstellungen wählt man, welche Entitäten erscheinen und in welchem Raum.
- Darstellung: `Toggle` für Schalter und Lichter, `Metric` für Sensoren (Temperatur, Luftfeuchte, CO₂, Strom in W, Energie in kWh pro Monat mit €-Schätzung).
- Türöffner und Gegensprechanlage (BTicino Classe 100X bzw. Shelly): **Button mit Bestätigung**, nie Toggle.
- Fällt HA aus, erscheint eine Meldung, und der Bereich zeigt „Home Assistant nicht erreichbar“.

## 11. Konsole

- Web-Terminal (xterm.js) zu einem Server über den Agent (PTY).
- Nur für Server mit `HZ_AGENT_ALLOW_TERMINAL=1` und nur nach erneuter TOTP-Eingabe (gilt 15 Min).
- Jede Sitzung wird protokolliert (wer, wann, Dauer; keine Tastenanschläge).

## 12. Wandmodus

- Route `/wall`, `data-theme="wall"`, nur Lesen, keine Navigation, Vollbild.
- Ein Raster aus großen Kacheln (`Metric size="wall"`): Server-Status, Spieler online, Temperatur innen, Strom aktuell, offene Probleme.
- Ein Problem färbt die ganze Kachel rot. Nachts (22–7 Uhr) wird auf 40 % gedimmt, nur `crit` bleibt hell.
- Zugang über ein eigenes, nur lesendes Geräte-Token (QR-Code in den Einstellungen), damit das Tablet kein Admin-Login braucht.

## 13. Einstellungen

Konto (Passwort, TOTP, aktive Sessions), Server (Schwellen, Konsole erlaubt, entfernen), Agents (Tokens widerrufen), GitHub (Token, Repos, Deploy-Ziele), Checks, Push (Geräte, Ruhezeit, Testnachricht), Home Assistant, Wandmodus-Token, Share-Gateway (an/aus, öffentliche URL), Backup der Zentrale selbst (SQLite-Export).

## 14. Nicht-Ziele

- Keine Mehrbenutzerverwaltung (außer Benutzerlinks)
- Kein Kubernetes
- Kein eigenes Monitoring-Backend wie Prometheus. Die Zentrale speichert Messwerte selbst (Rohdaten 48 h, 5-Min-Mittel 30 Tage, Stundenmittel 1 Jahr).
- Keine öffentliche Erreichbarkeit der Zentrale, auch nicht „nur kurz“

## 15. Ideen für später (nicht in den Meilensteinen)

Backups mit restic zwischen den Servern, Spiel-Statistiken, Steuerung eigener Apps, Morgen-Briefing (Wetter, Öffi-Abfahrten, Termine), Paket-Tracking, KI-Befehle („Starte den Minecraft-Server“).

## 16. Anbindungen (M14)

Jede Anbindung hat in den Einstellungen → Anbindungen URL, Zugangsdaten, optional ein CA-Zertifikat (für selbst signierte Zertifikate wie bei Proxmox) und „Verbindung testen“. Zugangsdaten werden verschlüsselt gespeichert und nie wieder angezeigt („gesetzt“). Ändern verlangt Step-up. Wechselt die Adresse, ist das alte Token weg und muss neu eingetragen werden. Ist eine Anbindung 5 Min nicht erreichbar, kommt eine `warn`-Meldung.

- **Proxmox** (Seite „VMs“): alle VMs und LXC-Container aller Knoten mit Status, CPU, RAM, Laufzeit. Starten sofort; Herunterfahren, Stoppen und Neustart mit Bestätigung und Step-up. Zugang über ein API-Token (`benutzer@realm!name` + Secret), am besten mit der Rolle `PVEVMUser` statt root.
- **DNS-Filter** (Seite „Netzwerk“): Pi-hole ab v6 oder AdGuard Home. Anfragen und Blockierte heute, Anteil, Einträge auf den Listen. Blocken für 5, 15, 30 oder 60 Min pausieren, danach blockt der Filter von selbst wieder. Kein Pausieren ohne Ende.
- **FRITZ!Box** (Seite „Netzwerk“): über TR-064 Internet-Status (verbunden, Leitung, Laufzeit, externe IP) und Geräte im Netz (Name, IP, LAN/WLAN, aktiv). Neustart der Box mit Bestätigung und Step-up. Internet weg: `crit`-Meldung.
- **Uptime Kuma** (Bereich auf „Websites“): liest die Monitore über `/metrics` mit einem API-Key und zeigt ihren Status. „Übernehmen“ legt daraus eigene Checks an (HTTP, Port, Ping), damit Kuma später abgeschaltet werden kann.
- **Wake-on-LAN** (Server-Detail): MAC-Adresse pro Server, Broadcast-Adresse und Sender (die Zentrale oder ein Agent im selben Netz). Ein ausgeschalteter Server zeigt „Aufwecken“.
- **Meldungskanäle** (Einstellungen → Meldungskanäle): Discord-Webhook, Telegram-Bot (Token + Chat-ID) und ntfy (Server, Thema, optional Token). An/aus, Mindest-Level, Testnachricht. IP-Adressen werden in den Texten maskiert, weil die Nachrichten das Tailnet verlassen.

## 17. Cloud-Server (M22)
Optionales Modul `cloud` (Standard aus). Der Admin verknüpft einmal ein Azure-Konto (App-Registrierung mit Rolle auf einer eigenen Ressourcengruppe) und einen Tailscale-Auth-Key. Beim Anlegen eines Gameservers gibt es das Ziel „Neuer Azure-Server“: Die Zentrale schlägt die kleinste passende Größe vor (Spiel-RAM plus 1 GB für das System, B-Serie zuerst; Minecraft Java bekommt B2ms), zeigt die Kosten pro Stunde, im Schlaf pro Monat und im Dauerbetrieb (echte Azure-Preise, sonst Schätzung) und bestellt erst nach einem Häkchen. Die VM (Ubuntu 24.04, Standard-SSD, Region wählbar, Standard Deutschland West-Mitte) richtet sich per cloud-init selbst ein (Docker, Tailscale, Agent über den Einzeiler-Code), danach legt die Zentrale den Gameserver darauf an und öffnet genau dessen Ports. Liegen alle Spiele der Maschine die Leerlaufzeit (Standard 15 Min) still, wird die VM deallocated (nur Disk und IP kosten weiter). Ein Start des Spiels über Zentrale, Benutzerlink, Discord oder Sprache startet zuerst die VM. Seite „Cloud“: Zugang, Budget (Monat bisher, Hochrechnung, Warnung ab 80 %, ab 100 % keine automatischen Starts), Maschinen mit Zustand, Laufzeit und Kosten im Monat, Starten, Schlafen legen, Löschen (Step-up und Name). Weitere Anbieter kommen über `CLOUD_PROVIDERS` dazu.
## 18. Automatik, Netzwerk und Apps (M20, M21)

Alle Teile sind optionale Module (Einstellungen → Module), Standard aus. Die Zentrale bleibt nur über Tailscale erreichbar; Domains und Zertifikate sind für die öffentlichen Dinge des Admins (Game-Relay, Apps auf einem VPS, Heimserver mit wechselnder IP).

### 18.1 Geplante Aufgaben (`tasks`)
Pro Server wiederkehrende Aktionen: Container neu starten, starten oder stoppen, Stack aktualisieren (pull + up), Docker aufräumen, wöchentlich an Tagen zu Uhrzeiten oder alle N Minuten (ab 5 Min). „Befehl ausführen“ (eine Zeile Shell auf dem Host) gibt es nur, wenn der Agent mit `HZ_AGENT_ALLOW_TASKS=1` läuft (`install-agent.sh --tasks`); Anlegen, Ändern und Starten verlangen Step-up, der Befehl wird verschlüsselt gespeichert und erscheint in keinem Log und keiner Meldung. Die letzten 50 Läufe bleiben mit Ausgabe sichtbar; ein fehlgeschlagener Lauf meldet sich (warn). Verpasste Läufe werden nicht nachgeholt, ein noch laufender Lauf wird nicht doppelt gestartet.

### 18.2 Selbstheilung (`selfheal`)
Hängende Container werden neu gestartet: Docker-Status `unhealthy` länger als die Schonfrist (Standard 2 Min), auf Wunsch auch ein Absturz, oder ein verknüpfter Website-Check ist DOWN. Schutz gegen Schleifen: höchstens 3 Neustarts in 30 Min und 2 Min Abstand (einstellbar); danach „aufgegeben“ mit CRIT-Meldung, bis der Container 10 Min gesund läuft oder der Admin zurücksetzt. Nie an der Zentrale oder dem Agent (`hz.role`), nie an Containern, die der Admin oder M10 gestoppt hat; abgestürzte `wichtig`-Container startet weiter M10.

### 18.3 Speedtest-Verlauf (`speedtest`)
Ein gewählter Server misst alle 1–24 Stunden Download, Upload, Ping und Jitter gegen `speed.cloudflare.com` (nur dieser Host). Datenmenge pro Messung einstellbar (Standard bis 100 MB je Richtung). Verlauf 7/30/90 Tage; mit Schwellen meldet sich „Internet langsam“ nach 3 langsamen Messungen in Folge.

### 18.4 Domains und Zertifikate (`domains`)
DNS-Anbieter Cloudflare (API-Token mit Zone:DNS:Edit) und DuckDNS. Einträge A/AAAA/CNAME mit Ziel „öffentliche IP von Server X“ (DynDNS, Abgleich jede Minute) oder einem festen Wert; die Zentrale ändert nur Einträge, die sie selbst angelegt hat. Zertifikate über ACME (Let's Encrypt, Staging zum Testen) mit DNS-01, auch Wildcards, Verlängerung 30 Tage vor Ablauf, Verteilung nach `/opt/homelab/certs/<name>/` auf gewählte Server. Das Game-Relay legt seine stabilen Namen über dieselbe Schnittstelle an (nur lesbar in der Oberfläche).

### 18.5 App-Store und Stack-Vorlagen (`apps`)
Katalog mit eingebauten Vorlagen (`templates/apps/`: Jellyfin, Nextcloud, Vaultwarden, Forgejo, Paperless-ngx, Syncthing, Audiobookshelf, Navidrome, FreshRSS, Uptime Kuma, Mealie) und eigenen Docker-Compose-Vorlagen mit Parametern. Installation mit einem Klick nach `/opt/homelab/apps/<name>/` auf einem gewählten Server, Ports standardmäßig nur auf der Tailscale-IP des Servers. Jede Vorlage geht durch eine Sicherheitsprüfung (kein `privileged`, kein Docker-Socket, keine Host-Pfade außerhalb des App-Ordners, kein Host-Netz …). Passwörter erzeugt die Zentrale und zeigt sie nur mit Step-up. Start, Stopp, Aktualisieren, Entfernen (Step-up, Name bestätigen, Daten optional löschen).
