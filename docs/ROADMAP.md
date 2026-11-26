# Roadmap

Arbeite die Meilensteine **in dieser Reihenfolge** ab. Jeder Meilenstein bekommt einen Branch `m<N>-<name>` und endet mit einem PR auf `main`. Fertig ist er erst, wenn
- alle Abnahmekriterien erfüllt sind,
- `pnpm check` grün ist (lint, typecheck, test),
- der Playwright-Smoke-Test des Meilensteins grün ist,
- `docs/CHANGELOG.md` einen Eintrag hat.

**Sub-Agents:** Innerhalb eines Meilensteins sind die Arbeitspakete (WP) mit **∥** parallel möglich. Jedes WP hat einen Besitzer-Ordner. Nur der Besitzer ändert Dateien darin. `packages/shared` gehört immer dem WP „Schema“, das zuerst fertig sein muss. Danach dürfen andere WPs dort nur nach Absprache ergänzen.

---

## M0: Fundament
**Ziel:** Ein lauffähiges, leeres Monorepo mit Werkzeugen und CI.

- pnpm-Workspaces: `apps/{core,web,agent,share}`, `packages/{shared,ui}`
- TypeScript strict, ESLint (flat config), Prettier, Vitest, Playwright
- Skripte: `dev`, `check`, `build`, `e2e` (siehe `AGENTS.md`)
- GitHub Actions: `check` + `build` bei jedem Push/PR, `pnpm audit --prod`
- `apps/core`: Fastify mit `/api/health`, Config-Validierung (zod) aus `.env`
- `apps/web`: Vite + React, lädt `design/tokens.css` und `design/components.css`, zeigt eine leere Seite mit `NavRail`
- `deploy/docker-compose.core.yml`: ein Image (Core liefert die Web-App aus), Volume für `data/`

**Abnahme:** `pnpm install && pnpm check && pnpm build` laufen sauber; `docker compose -f deploy/docker-compose.core.yml up` startet, und `/api/health` antwortet `{ok:true}`.

## M1: Designsystem, Shell, Login
- **WP Schema** (`packages/shared`): API-Schemas für Auth und Session.
- **WP UI ∥** (`packages/ui`): Alle Komponenten aus `design/reference/bundle.js` nach TSX portieren, mit den Props aus `design/reference/index.d.ts` und denselben `hz-`-Klassen. Dazu eine Storybook-freie Galerie unter `/dev/ui` (nur im Dev-Modus), die alle Previews aus `design/reference/previews` mit denselben Daten nachbaut. Visueller Vergleich: Playwright-Screenshot jeder Galerie-Karte in allen 3 Themes.
- **WP Auth ∥** (`apps/core/src/auth`, `apps/web/src/pages/login`): Setup-Assistent, Login, TOTP-Einrichtung mit QR, Wiederherstellungscodes, Sessions, Step-up, Rate-Limit, `audit_log`.
- **WP Shell** (`apps/web/src/routes`, Layout): NavRail mit Tastenkürzeln, untere Leiste am Handy, Statussatz-Bereich, ServerSwitch-Platzhalter, Befehlspalette (`Strg/⌘+K`, vorerst nur Navigation), Theme-Umschalter (dark/light, folgt System), PWA-Manifest und Icons aus `design/assets/`.

**Abnahme:** Erstes Setup → Login mit TOTP → leere Übersicht mit Navigation. Ohne Session gibt es auf jede `/api/*`-Route 401. Die UI-Galerie stimmt sichtbar mit den Previews überein. Tests für Login, falsches TOTP, Rate-Limit, Step-up.

## M2: Agent und Server
- **WP Schema:** `agent-protocol.ts` vollständig (alle Nachrichten aus `ARCHITECTURE.md`, auch die späteren, damit spätere Meilensteine nicht am Protokoll rütteln müssen).
- **WP Agent ∥** (`apps/agent`): Verbindung mit Backoff, `hello`/Enrollment, `metrics` (systeminformation), `inventory` (Updates via `apt list --upgradable` auf dem Host, reboot-required, SSH-Fehlversuche aus `journalctl`/auth.log, fail2ban falls vorhanden, Ports), Multi-Arch-Dockerfile, `deploy/docker-compose.agent.yml`, `deploy/install-agent.sh`.
- **WP Core-Agents ∥** (`apps/core/src/agents`, `metrics`, `servers`): Agent-Hub, Enrollment-Tokens, Speicherung und Verdichtung der Messwerte, Statusregeln (SPEC 5.1), Live-Topic `servers`.
- **WP Web-Server ∥** (`apps/web/src/pages/servers`, Übersicht-Abschnitt): `ServerList`, Serverdetail (UsageBars, Sparklines, System, Updates, Sicherheit), „Server hinzufügen“-Dialog mit Einzeiler, Aufräumen mit Vorschau, Neustart mit Bestätigung.

**Abnahme:** Zwei Agents (einer lokal per Docker, einer simuliert im Test) erscheinen live. Wird ein Agent gestoppt, steht der Server nach ≤ 90 s auf DOWN, und es gibt eine Meldung. Ein ARM64-Image wird in CI gebaut. Tests für Allowlist und Pfadprüfung.

## M3: Container
- Agent: Docker-Inventar plus Docker-Events, `container.*`, `compose.*`, Log-Streams
- Core/Web: Container-Seite gruppiert nach Server und Compose-Projekt, `ServiceRow`, Logs im `Terminal` (Folgen, Pause, Suche), Start/Stop/Neustart, „Image aktualisieren“
- Übersicht: Container-Kachel (Probleme zuerst)

**Abnahme:** Ein Container wird gestoppt → er steht live auf OFF/DOWN und erzeugt eine Meldung. Logs streamen. Nach einem Image-Update läuft der Container mit dem neuen Image.

## M4: Checks und Meldungen
- **WP Checks ∥** (`checks/`): HTTP, TCP, Ping über den Agent, SSL-Ablauf, RDAP, „ausführen von“ (Core oder Agent), 2-Fehlschläge-Regel, Verlauf.
- **WP Alerts ∥** (`alerts/`, `pages/alerts`): Meldungsmodell (offen/bestätigt/erledigt, Dedupe-Key), Seite „Meldungen“ mit Filtern, Web-Push (VAPID, Abo-Verwaltung, Testnachricht), Ruhezeit, warn-Bündelung, Wochenbericht.
- Web: Seite „Websites“ mit `WebCheckRow`, Check anlegen/bearbeiten.

**Abnahme:** Ein Check auf eine nicht erreichbare URL erzeugt nach 2 Intervallen eine CRIT-Meldung und eine Push-Nachricht am Handy (PWA über `tailscale serve`). Erholt sich der Check, kommt eine OK-Meldung, und die alte wird erledigt.

## M5: GitHub und Deploy
- Token-Einstellung, Polling mit ETag, Repos, CI-Status, Commits
- Deploy-Ziele, Deploy-Key-Erzeugung mit Anleitung, `deploy.run` im Agent (compose/script), Live-Log, Sperre pro Ziel, Rollback, Auto-Deploy bei grünem CI
- Seite „GitHub“ mit `RepoRow` und `CommitRow`-Verlauf, Kachel in der Übersicht

**Abnahme:** Ein Test-Repo mit `compose.yml` wird per Knopf auf den lokalen Agent deployt. Ein neuer Commit erscheint innerhalb von 60 s als „1 neu“. Ein Rollback stellt den vorherigen Commit wieder her. Bei rotem CI gibt es keinen Deploy-Knopf.

## M6: Gameserver
- **WP Vorlagen ∥** (`templates/games`): Die 6 Vorlagen aus SPEC 6.2 mit `compose.yml` + `template.json` und ein JSON-Schema für `template.json`.
- **WP Core-Games ∥** (`games/`): Vorlagen laden, Formular-Schema aus `template.json`, Compose rendern, Port-Vorschlag, RAM-Prüfung, Status/Spieler (minecraft-server-util, gamedig), RCON, Backups, Auto-Stopp.
- **WP Web-Games ∥** (`pages/games`): `GameTemplates`, Formular, Fortschritt beim Aufsetzen, `GameServer`-Kacheln, Detail mit Konsole, Backups, Einstellungen, Löschen, Hinweis zur Portweiterleitung.

**Abnahme:** Ein Minecraft-Paper-Server wird aus der Oberfläche auf dem lokalen Agent aufgesetzt, ist erreichbar, zeigt Spieler und TPS, die RCON-Konsole funktioniert, und ein Backup wird erstellt.

## M7: Benutzerlinks und Share-Gateway
- Share-Links (SPEC 6.4): erstellen, Rechte, Ablauf, PIN, widerrufen, Audit
- Share-Seite `/s/<token>` im Core (nur im Tailnet)
- `apps/share`: optionales öffentliches Gateway mit eigener Mini-UI (gleiche Tokens/CSS), enge Gateway-API im Core, Rate-Limits, Deploy-Anleitung mit Caddy für `oracle-a1`

**Abnahme:** Ein Link mit dem Recht „Starten/Stoppen“ kann den Server starten, aber keine Konsole öffnen (serverseitig geprüft, Test). Ein widerrufener Link gibt sofort 410. Das Gateway gibt keine internen Daten preis (Test auf die Antwortfelder).

## M8: Wohnung (Home Assistant)
- HA-Verbindung (WebSocket), Auswahl der Entitäten und Räume, `Toggle`/`Metric`, Türöffner als Button mit Bestätigung, Stromkosten-Schätzung (€/kWh einstellbar)
- Übersicht-Kachel „Wohnung“

**Abnahme:** Mit einer HA-Testinstanz (Docker, Demo-Integration) schalten Lichter live hin und her, und Sensoren aktualisieren sich.

## M9: Konsole, Wandmodus, Feinschliff
- Web-Konsole (xterm.js ↔ Agent-PTY) mit Step-up und Protokoll
- Wandmodus `/wall` mit Geräte-Token, Dimmen nachts
- Befehlspalette mit Aktionen
- Einstellungen vollständig (SPEC 13), Export der SQLite-Datenbank
- Leistung: Übersicht lädt < 1 s im Tailnet, Bundle < 400 kB gzip
- Barrierefreiheit: Tastatur überall, Fokusring, axe-Check in Playwright ohne ernste Fehler

**Abnahme:** Alle Smoke-Tests grün; ein Durchgang durch jede Seite in allen 3 Themes per Screenshot in `docs/screenshots/`.

---

## M10: Prioritäten und automatisches Drosseln
- Priorität pro Container/Gameserver (`wichtig`, `normal`, `niedrig`, „darf gestoppt werden“), Einstellungen pro Server (Schwellen, Automatik an/aus)
- Agent-Aktion `container.limit` (nur `docker update --cpus`, nie für `hz.role`-Container)
- Core-Regelwerk: drosseln, stoppen, aufheben, `wichtig` neu starten, Meldungen und Protokoll
- **Zeitpläne pro Stufe:** z. B. „niedrig“ Mo–Fr 18–23 Uhr ohne Drosselung bzw. mit höherem CPU-Anteil (Zeitzone `HZ_TIMEZONE`)
- **RAM-Reserve für „wichtig“:** pro Server wird RAM für die wichtigen Container freigehalten; ein Gameserver startet (von Hand, per Link oder automatisch) nur, wenn sein RAM-Limit in den freien RAM minus Reserve passt, sonst „Zu wenig RAM, X GB frei“
- **Kachel „Wer frisst gerade?“:** Top 3 Container nach CPU und RAM über alle Server, mit Drosseln/Stoppen (Stoppen fragt nach)
- Web: Priorität im Container- und Gameserver-Detail, Hinweis „gedrosselt“ in der Liste, Einstellungen

**Abnahme:** Ein simulierter Server über der Schwelle drosselt den `niedrig`-Container, nach weiteren 5 Min wird er gestoppt (wenn erlaubt), ein gestoppter `wichtig`-Container läuft binnen 1 Min wieder; im Zeitfenster wird nicht gedrosselt; ein Gameserver ohne Platz startet nicht. Sicherheitstests: kein Eingriff an Core/Agent, keine Aktion ohne Admin, Grenzen für `--cpus`, Benutzerlinks können die RAM-Reserve nicht umgehen.

---

## M11: Server anbinden, Lastverschiebung, Port-Abgleich
- **Server anbinden in einem Schritt:** „Server hinzufügen“ zeigt einen Code (8 Zeichen, 15 Min, einmalig) und einen Einzeiler `curl -fsSL https://<zentrale>/install.sh | sudo sh -s -- <code>`. Das Skript (vom Core ausgeliefert, nur im Tailnet erreichbar) prüft Docker und Tailscale, holt das Agent-Image (GHCR oder eigene Registry aus `HZ_AGENT_IMAGE`) und startet den Agent; die Seite zeigt live „verbunden“. Code-Tausch mit Rate-Limit, Code nie im Log.
- **Lastverschiebung:** Gameserver per Knopf auf einen anderen Server umziehen: Backup → Übertragung über die Zentrale (gestreamt, Größenlimit, Prüfsumme) → Restore → Start am Ziel → alter gestoppt; Ports am Ziel neu vorgeschlagen, Hinweis zur Portweiterleitung. Bricht etwas ab, bleibt der alte Server unverändert.
- **Port-Abgleich:** pro Server eine Soll-Liste offener Ports (aus dem ersten Inventar übernehmen, von Hand pflegbar); ein neuer lauschender Port auf `0.0.0.0`/öffentlich ergibt eine `warn`-Meldung „Neuer offener Port 8081 (nginx)“ mit „Erlauben“.

**Abnahme:** Ein neuer Sim-Agent kommt nur mit Code und Einzeiler online; ein Gameserver zieht zwischen zwei Sim-Servern um und läuft danach am Ziel; ein neuer Port meldet sich. Sicherheitstests: Code nur einmal, abgelaufen, Brute-Force-Grenze, `install.sh` enthält kein Secret, Umzug nur mit Step-up, kein Pfad außerhalb der Spielordner.

## M12: Gameserver komplett
- **Schlafmodus:** Neue Gameserver schlafen nach 15 Min ohne Spieler (einstellbar, 0 = nie). Solange sie schlafen, lauscht der Agent auf ihren Ports (`game.wake.arm`): Minecraft zeigt in der Serverliste „Schläft“, der erste Login (bzw. bei anderen Spielen das erste Spielpaket) weckt den Server; der Spieler bekommt „Server startet, bitte in 1 Minute neu verbinden“. Aufwecken beachtet die RAM-Reserve (M10). Status „Schläft“ in Kachel, Detail und Benutzerlink.
- **Zeitpläne pro Gameserver:** Neustart und Backup an Wochentagen zu einer Uhrzeit (`HZ_TIMEZONE`), Neustart mit Warnung an die Spieler 5 und 1 Min vorher (RCON `say`); schlafende Server werden nicht geweckt.
- **Discord-Webhook:** „Server ist online“, offline, schläft, aufgeweckt; URL verschlüsselt, nur Discord-Hosts, nur Name, Spiel, externe Adresse und Spielerzahl.
- **Spielerstatistik:** Spielzeit pro Spieler, Sitzungen, Spitzenzeiten (Ø Spieler pro Stunde), Höchststand; 7 oder 30 Tage, Daten 90 Tage.
- **Mods und Plugins (Modrinth):** Für Paper (Plugins) und Fabric (Mods) suchen, installieren (nur `cdn.modrinth.com`, sha512 geprüft), entfernen; Hinweis „Neustart nötig“.
- **Benutzerlinks:** neue Rechte „Welt herunterladen“ (tar.zst, 1×/Stunde, so lange der Link gilt) und „Whitelist-Anfrage“ (Freund trägt Namen ein, Admin bestätigt nach Push).
- **Backup wiederherstellen per Knopf** (Step-up, Name bestätigen, vorher frisches Backup).
- **7 neue Vorlagen:** Satisfactory, Factorio, Enshrouded, Project Zomboid, ARK: Survival Evolved, Rust, V Rising (mit Architektur-Angabe, nur passende Server wählbar).
- **Netz am Server** (zuhause/Cloud/VPS) für den richtigen Hinweis zur Portweiterleitung; Gameserver-Container werden über das Label `homelab.game` erkannt.

**Abnahme:** Ein Minecraft-Server schläft nach der eingestellten Zeit ohne Spieler ein, ein Login-Versuch weckt ihn, danach läuft er; die Serverliste zeigt im Schlaf „Schläft“. Ein Zeitplan-Backup läuft zur eingestellten Minute. Ein Plugin wird aus Modrinth installiert und wieder entfernt. Ein Freund lädt über den Link die Welt herunter und stellt eine Whitelist-Anfrage, die der Admin bestätigt. Ein Backup wird wiederhergestellt. Sicherheitstests: Wake-Listener nur auf Ports des eigenen Spiels, keine Weiterleitung von Daten, Größen- und Verbindungsgrenzen, kein Wecken über Serverlisten-Pings; Mod-URLs nur von Modrinth mit Hash; Discord-URL nicht im Log und in keiner Antwort; Welt-Download nur mit Recht und Limit; Restore nur mit Step-up und ohne Pfade außerhalb des Spielordners.

---

## M13: NAS und Speicher
**Ziel:** Ein NAS (zuerst UGREEN NASync mit UGOS Pro, aber generisch für jeden Linux-Server mit md-RAID) hängt wie jeder andere Server an der Zentrale und zeigt seinen Speicher-Zustand.

- **WP Schema** (`packages/shared`): optionales Feld `inventory.storage` (Plattform, RAID-Arrays, Volumes, Platten mit SMART), API `GET /api/storage`, `GET /api/storage/:id`, Regeln für Meldungen (`storageProblems`), Modul `storage` (Standard an).
- **WP Agent ∥** (`apps/agent`, `deploy/`): Sammler `collect/storage.ts`: md-RAID aus `/proc/mdstat`, Volumes aus der Mount-Tabelle des Hosts mit Geräte-Kette (dm → md → Platte), Platten aus `/sys/block`, NVMe-Temperatur aus hwmon. SMART nur mit `HZ_AGENT_SMART=1` über `smartctl` aus dem Image, mit `--nocheck=standby` (weckt keine schlafende Platte), höchstens alle 10 Min pro Platte. Override `deploy/docker-compose.agent.smart.yml` (nur Lesezugriff auf die Platten, `CAP_SYS_RAWIO`). `install-agent.sh --smart` und der Einzeiler (`… -- <code> --smart`) schalten es ein, auf einem UGREEN-NAS automatisch.
- **WP Core ∥** (`apps/core/src/storage`): letzter Stand pro Server (Tabelle `server_storage`, Migration 14), Meldungen: RAID beschädigt oder inaktiv (crit), SMART meldet Ausfall (crit), defekte Sektoren, Medienfehler, SSD abgenutzt (warn), Plattentemperatur (HDD 50/60 °C, SATA-SSD 60/70 °C, NVMe 70/80 °C); erledigt sich mit OK-Meldung. Modul aus: keine Routen, keine Meldungen.
- **WP Web ∥** (`apps/web/src/pages/storage`): Abschnitt „Speicher“ im Serverdetail (RAID mit Rebuild-Fortschritt, Volumes als UsageBar, Platten mit Zustand, Temperatur, Betriebsstunden, „schläft“), Kachel „Speicher“ in der Übersicht, Schalter unter Einstellungen → Module.

**Abnahme:** Ein simuliertes UGREEN-NAS zeigt RAID, Volumes und Platten. Fällt eine Platte aus dem RAID, gibt es eine CRIT-Meldung, nach dem Neuaufbau eine OK-Meldung. Sicherheitstests: `smartctl` nur mit festen, lesenden Argumenten und gültigen Plattennamen, kein Wecken schlafender Platten, strenges Schema mit Obergrenzen, Routen nur mit Admin-Session und nur lesend, Override gibt nur Lesezugriff auf Blockgeräte.

**Später (M13b):** Das NAS als Backup-Ziel für Gameserver-Backups (Kopie über die Zentrale wie beim Umzug), sobald M12 (Gameserver komplett) gemergt ist.

---

## Definition of Done (für jeden PR)
- Code, Tests und Doku sind aktuell (`docs/` mitpflegen, wenn sich etwas ändert)
- Keine `any`, keine auskommentierten Blöcke, keine TODOs ohne Issue
- UI nur aus `packages/ui` plus Tokens; neue Komponenten zuerst als Vorschlag in `docs/QUESTIONS.md`
- Sicherheitsregeln aus `SECURITY.md` eingehalten
