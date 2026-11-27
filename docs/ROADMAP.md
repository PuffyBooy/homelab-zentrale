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

### M13b: NAS als Backup-Ziel (ohne Agent auf dem NAS)

Für NAS, auf denen kein Agent läuft (z. B. UGREEN DH2300, kein offizielles Docker). Das NAS bleibt unverändert.

- [x] Eine Freigabe des NAS wird auf einem Server unter `/opt/homelab/backup-target` eingebunden (SMB/NFS/USB, Anleitung in `deploy/README.md`).
- [x] Agent-Aktionen `backup.target.status`, `backup.target.sync`, `backup.target.store` (`packages/shared/src/agent-backup-target.ts`). Geschrieben wird nur, wenn der Pfad ein eigener, beschreibbarer Mount ist; sonst Meldung und keine Kopie.
- [x] Jede Nacht (Uhrzeit einstellbar) und per „Jetzt kopieren“: Gameserver-Backups der gewählten Server aufs NAS, verifiziert (sha256 nach dem Zurücklesen), neueste N behalten.
- [x] Datenbank-Schnappschuss (`VACUUM INTO`) von der Zentrale an den Agent gestreamt (Transfer-Protokoll aus M11, Core als Sender), verifiziert, neueste N behalten.
- [x] Meldungen: Freigabe nicht eingebunden / schreibgeschützt, NAS voll, Kopie fehlgeschlagen; OK-Eintrag, wenn es wieder klappt.
- [x] Einstellungen → Backup → „NAS als Backup-Ziel“ (Server, Datenbank-Ziel, Uhrzeit, Anzahl), Änderung nur mit Step-up. Teil des Moduls `storage`.
- [x] Erreichbarkeit des NAS über normale HTTP-/TCP-Checks (Weboberfläche, SMB 445), dokumentiert.
- [x] Sicherheitstests: keine Symlinks auf dem Ziel oder bei den Quellen, nur Namensmuster, kein Schreiben ohne Mount, Step-up, Module aus, Schlüssel nicht in der Kopie.

## M14: Anbindungen (Proxmox, Pi-hole/AdGuard, FRITZ!Box, Uptime Kuma, Wake-on-LAN, Discord/Telegram/ntfy)
Wunsch des Admins vom 26.11.2026. Vier neue Module (alle standardmäßig aus, Einschalten mit Step-up), dazu Wake-on-LAN und weitere Meldungskanäle im Core. Schemas: `packages/shared/src/api/integrations.ts`.
- **WP Schema** (`packages/shared`): Einstellungen, Daten und Aktionen jeder Anbindung, Agent-Aktion `wol.send`, Module `proxmox`, `dnsfilter`, `fritzbox`, `uptimekuma`.
- **WP Core ∥** (`apps/core/src/integrations`, `apps/core/src/notify`, `apps/core/src/wol`): ein gemeinsamer HTTP-Client für Anbindungen (kein Folgen von Weiterleitungen, 8 s, 4 MB, eigene CA statt abgeschalteter Prüfung), Zugangsdaten verschlüsselt, URL-Wechsel verwirft das Token. Proxmox (VMs und LXC über API-Token; Starten, Herunterfahren, Stoppen, Neustart; alles außer Starten mit Step-up), Pi-hole v6 und AdGuard Home (Statistik, Blocken 5/15/30/60 Min pausieren), FRITZ!Box über TR-064 (Internet-Status, Geräte, Neustart mit Step-up), Uptime Kuma (Monitore über `/metrics` mit API-Key lesen, als eigene Checks übernehmen), Wake-on-LAN (MAC pro Server, gesendet von der Zentrale oder einem Agent im selben LAN), Meldungskanäle Discord-Webhook, Telegram-Bot und ntfy mit denselben Regeln wie Push (Ruhezeit, Bündeln) und maskierten Adressen. Meldung, wenn eine Anbindung 5 Min nicht erreichbar ist oder das Internet weg ist.
- **WP Agent ∥** (`apps/agent`): Aktion `wol.send` (nur das Magic Packet an Broadcast:7/9, Rate-Limit).
- **WP Web ∥** (`apps/web`): Seite „VMs“ (Proxmox), Seite „Netzwerk“ (FRITZ!Box und DNS-Filter), Uptime-Kuma-Bereich auf „Websites“, „Aufwecken“ im Server-Detail, Einstellungen „Anbindungen“ und „Meldungskanäle“, Kachel „Heimnetz“ auf der Übersicht.

**Abnahme:** Gegen Test-Server (Proxmox-, Pi-hole-, AdGuard-, FRITZ!Box- und Kuma-Attrappen im Test) erscheinen VMs, Statistik, Geräte und Monitore; eine VM startet, Stoppen verlangt Step-up; Blocken pausiert und läuft danach wieder; ein Kuma-Monitor wird zum Check; ein Magic Packet geht raus; eine Meldung kommt im Discord-, Telegram- und ntfy-Test-Endpunkt an. Sicherheitstests: keine Link-lokalen Ziele, keine Weiterleitung, kein Token nach URL-Wechsel an den neuen Host, keine Secrets in Antworten, Logs und Fehlern, Proxmox-Aktionen nur für bekannte Gäste, Discord nur an discord.com, Telegram nur an api.telegram.org, ausgeschaltetes Modul antwortet 404.

---

## M16: Server im Detail (Überwachung und Verwaltung)
_M14 (Anbindungen) und M15 (Game-Relay) entstehen parallel in eigenen Branches._

**Ziel:** Jeder einzelne Server lässt sich in seiner Detailseite überwachen und verwalten, ohne SSH. Baut auf Serverdetail (M2), Aufräumen/Neustart (M2) und Speicher (M13) auf. Schemas: `packages/shared/src/api/server-admin.ts` und der M16-Block in `agent-protocol.ts`.

- **Verlauf:** Zeitraum 1 h / 24 h / 7 Tage / 30 Tage für CPU, RAM, Netz ein/aus, Temperatur und höchste Disk-Belegung (`diskMax`), aus den vorhandenen Rohdaten und Verdichtungen; Min/Ø/Max je Reihe.
- **Speicher:** Partitionen/Mounts (aus `metrics.disks`) als `UsageBar`, Abschnitt „Speicher“ aus M13 bleibt; **größte Ordner** (`system.du`, nur lesend, `du -x -d1`, höchstens 30 Einträge, zum Hineinklicken, nie unter `/proc`, `/sys`, `/dev`, `/run`); **Docker-Belegung** (`system.dockerDf`: Images, Container, Volumes, Build-Cache, jeweils ungenutzt); **Aufräumen mit Auswahl** (`system.cleanup { items }`: apt-Cache, alte Kernel, Journal, ungenutzte Images, Build-Cache). Container und Volumes werden nie gelöscht (schlafende Gameserver sind gestoppte Container).
- **Dienste:** systemd-Units mit Zustand, fehlgeschlagene zuerst (`system.services`); fehlgeschlagene Units kommen mit dem Inventar (`failedServices`) und ergeben eine `warn`-Meldung und einen Status-Grund. Starten/Stoppen/Neustarten nur für Units in `HZ_AGENT_SERVICES` auf dem Agent und nie für `SERVICE_DENYLIST` (tailscaled, docker, ssh, systemd-* …).
- **Prozesse:** Top 25 nach CPU oder RAM (`system.processes`): PID, Name, Benutzer, CPU, RAM, Container. Nur Prozessnamen, nie Kommandozeilen.
- **Herunterfahren** (`system.shutdown`) neben Neustart: Step-up und Servername eintippen, Hinweis „bleibt aus bis zum Einschalten (oder Wake-on-LAN)“.

**Abnahme:** Im Serverdetail eines Sim-Agents wechselt der Verlauf zwischen 1 h und 30 Tagen, „größte Ordner“ lässt sich bis in einen Unterordner aufklappen, die Docker-Belegung erscheint, Aufräumen mit nur „Build-Cache“ räumt nur den Build-Cache, eine fehlgeschlagene Unit ergibt eine Meldung, ein erlaubter Dienst wird neu gestartet, die Prozessliste sortiert nach RAM, Herunterfahren verlangt Step-up und Namen. Sicherheitstests: Pfadprüfung für `system.du` (auch nach `realpath` im Agent), Units nur mit Allowlist und nie aus der Sperrliste, keine Kommandozeilen in der Prozessliste, Shutdown ohne Step-up oder mit falschem Namen abgelehnt, alle Routen nur mit Admin-Session, Rate-Limit auf `du`.

## M17: Auto-Update
**Ziel:** Die Zentrale und alle Agents halten sich selbst aktuell, optional auch die Betriebssystem-Pakete, in einem Wartungsfenster pro Server, mit Rollback und Meldung. Schemas: `packages/shared/src/api/updates.ts` und der M17-Block in `agent-protocol.ts`.

- **Richtlinie pro Server** (Einstellung, Standard: Agent und Zentrale an, OS-Pakete aus, Neustart aus, täglich 03:00 für 120 Min in `HZ_TIMEZONE`): Agent, Zentrale (nur der Server mit dem `hz.role=core`-Container), OS-Pakete, Neustart bei Bedarf (Einschalten mit Step-up), Wochentage, Start, Dauer.
- **Prüfen:** `update.check` holt den Image-Tag, den der Container schon nutzt (nie ein anderes Image), und vergleicht die Image-ID; Versionen aus den OCI-Labels (`org.opencontainers.image.version`/`revision`). Täglich und per Knopf.
- **Aktualisieren:** `update.apply` antwortet sofort, das Ergebnis kommt als Event `update_result` (auch nach einem Neuverbinden, im Agent gespeichert).
  - Zentrale: Der Agent auf demselben Server zieht das neue Image, ersetzt den Core-Container (gleiche Konfiguration, Volumes bleiben) und wartet bis zu 3 Min auf den Docker-Health-Check des Cores; sonst kommt der alte Container zurück (`rolled_back`).
  - Agent: Ein kurzlebiger Helfer-Container aus dem **alten** Image (Label `hz.role=updater`, nur Docker-Socket und Agent-Datenvolume) ersetzt den Agent und wartet bis zu 3 Min, bis der neue Agent mit dem Core verbunden ist (Health-Check im Agent-Image); sonst Rollback.
  - OS: `system.upgrade` (`apt-get update` + `apt-get -y upgrade`, feste Argumente, keine Entfernungen, Konfigurationsdateien bleiben); danach Neustart im Fenster, wenn eingeschaltet und nötig.
- **Ablauf im Fenster:** ein Server nach dem anderen, pro Server OS → Agent → Zentrale (der Core-Server zuletzt) → Neustart; jeder Schritt höchstens einmal pro Fenster; ohne Ergebnis nach 15 Min `timeout`.
- **Meldungen:** `info` bei Erfolg („Agent auf pi aktualisiert: sha-1a2b3c4 → sha-5d6e7f8“), `warn` bei Rollback und Zeitüberschreitung, `crit` wenn nach einem Fehler nichts mehr läuft. Verlauf der letzten 50 Läufe.
- **Web:** Kachel „Auto-Update“ im Serverdetail (Richtlinie, Versionen, „Jetzt prüfen“, „Jetzt aktualisieren“, letzter Lauf), Abschnitt „Updates“ unter Einstellungen mit allen Servern und dem Verlauf, Live-Topic `updates`.

**Abnahme:** Ein Sim-Agent bekommt ein neueres Agent-Image und läuft danach damit; ein absichtlich kaputtes Image (Health-Check rot) wird zurückgerollt, und es kommt eine `warn`-Meldung; ein Core-Update im Docker-Smoke ersetzt den Core-Container und die Zentrale ist danach wieder erreichbar; außerhalb des Fensters startet kein geplanter Lauf. Sicherheitstests: nur `agent`/`core` als Ziel, nie ein Image aus der Anfrage, Helfer-Container mit minimalen Rechten und geschützt wie Core/Agent, `system.upgrade` mit festen Argumenten, Neustart-Automatik nur mit Step-up, Ergebnis-Events nur für bekannte, laufende Runs, alle Routen nur mit Admin-Session.
## M15: Game-Relay (Eingänge) und feste Adressen
- **Eingang pro Server:** Jeder Server mit öffentlicher IPv4 kann als Eingang markiert werden (Step-up, Portbereich, den man in der Firewall des Anbieters öffnet), auch mehrere. Der Agent dort braucht `HZ_AGENT_ALLOW_RELAY=1`.
- **Relay pro Gameserver:** Ein Gameserver bekommt einen Eingang. Der Agent am Eingang nimmt die Spielports (gleiche Nummern) an und leitet TCP und UDP über Tailscale zum Server, auf dem das Spiel gerade läuft (`relay.set`). Kein Router-Portforwarding zu Hause nötig. Der Schlafmodus funktioniert durch das Relay (das Wecken kommt am Spielserver an).
- **Umzug behält die Adresse:** Zieht ein Gameserver um (M11) oder ändern sich Ports, stellt die Zentrale die Relay-Ziele sofort um. Freunde behalten Adresse und Port.
- **Feste DNS-Namen (optional):** pro Gameserver ein Name; die Zentrale setzt den A-Record auf die IP des Eingangs (seit M20 über das Domains-Modul: Anbieter Cloudflare oder DuckDNS unter Internet → Domains, der Eintrag gehört dem Relay). Wechselt der Eingang, zieht der DNS-Eintrag mit.
- **Web:** Einstellungen → Eingänge (Liste, Portbereich, Firewall-Hinweis), im Gameserver-Detail „Erreichbar über“ mit Eingang, Name, Zustand; Benutzerlinks zeigen die Relay-Adresse.

**Abnahme:** Zwei Sim-Server und ein Sim-Eingang: ein Gameserver ist über den Eingang erreichbar (TCP und UDP, echter Datenfluss im Test), zieht auf den zweiten Server um und ist danach über dieselbe Adresse erreichbar; ein DNS-Name wird bei einem Fake-Anbieter gesetzt und beim Eingangswechsel umgestellt. Sicherheitstests: Relay nur mit `HZ_AGENT_ALLOW_RELAY=1`, Ziele nur im Tailnet, keine Ports unter 1024 oder außerhalb des Bereichs, keine Überschneidungen, Grenzen für Verbindungen und Leerlauf, DNS-Token nie in Antwort oder Log, DNS-Anfragen nur an die festen Anbieter-Hosts, Step-up für Eingänge, Relays und DNS.

## M18: Zusatzmodule Log-Suche, Schwachstellen-Scan, Fail2ban, Discord-Bot, Sprachsteuerung
**Ziel:** Fünf optionale Module (alle Standard aus, unter Einstellungen → Module). Discord-Bot und Sprachsteuerung steuern von außerhalb der Zentrale und brauchen zum Einschalten Step-up. Keine neue Migration (Einstellungen im `settings`-Speicher), damit parallele Meilensteine nicht kollidieren.

- **WP Schema** (`packages/shared`): Agent-Aktionen in `agent-ops.ts` (`logs.search`, `image.scan`, `fail2ban.status`, `fail2ban.unban`), API in `api/ops.ts`, Module in `api/modules.ts`, Share-Protokoll `via: discord`.
- **WP Agent ∥** (`apps/agent`): Log-Suche als reine Textsuche (nie Regex) über `docker logs --since/--tail`; Scan mit dem per Digest gepinnten Trivy-Image als Nachbar-Container mit `--image-src remote` (kein Docker-Socket, read-only, `cap-drop ALL`, Speicher- und PID-Limit), lokal gebaute Images gelten als „nicht prüfbar“; Fail2ban über `fail2ban-client` auf dem Host, Entsperren nur für vorhandene Jails und gültige IPs.
- **WP Core ∥** (`apps/core/src/ops`, `discord`, `voice`): Log-Suche über alle Server (Rate-Limit, Suchtext nie im Log), nächtlicher Scan zur eingestellten Uhrzeit mit `warn`-Meldung pro Container, Fail2ban-Übersicht mit 30 s Cache und Entsperren mit Protokoll. Discord-Bot über das Discord-Gateway (nur ausgehend, kein öffentlicher Endpunkt), Slash-Befehle `/status`, `/start`, `/stop`, `/restart` nur für Freunde, deren Discord-ID der Admin an einen aktiven Benutzerlink gebunden hat, mit genau dessen Rechten und RAM-Reserve. Sprachsteuerung über die bestehende Home-Assistant-Verbindung: ein `input_boolean` pro Gameserver startet/stoppt, ein `input_text` zeigt den Status (für Echo Show und Alexa), Abklingzeit 1 Min.
- **WP Web ∥** (`apps/web`): Seite „Log-Suche“, Seite „Sicherheit“ (Schwachstellen, Fail2ban), Einstellungen „Discord-Bot“ und „Sprachsteuerung“, Schalter unter Module.

**Abnahme:** Eine Suche findet eine Zeile in Containern zweier Sim-Server; ein Scan-Ergebnis mit kritischer Lücke erzeugt eine Meldung, die nach dem Fix verschwindet; eine gesperrte IP wird entsperrt; ein gebundener Freund startet per Slash-Befehl seinen Gameserver, ein fremder nicht; ein HA-Schalter startet den Gameserver und spiegelt den Status zurück. Sicherheitstests: Module aus = 404, keine Route ohne Session, kein Regex aus Nutzereingabe, kein Docker-Socket und kein Host-Pfad für Trivy, Bot-Token nie in Antwort oder Log, Discord nur von der eingestellten Guild, abgelaufene/widerrufene Links wirken nicht, Gateway-URL nur `*.discord.gg`, Sprachsteuerung nur `input_boolean`/`input_text`.

---

## M20: Automatik und Netzwerk (Aufgaben, Selbstheilung, Speedtest, Domains)
**Ziel:** Wiederkehrende Arbeit und kleine Ausfälle erledigt die Zentrale selbst; Internet-Geschwindigkeit, eigene Domains und Zertifikate sind an einem Ort. Vier optionale Module, alle Standard aus (`tasks` und `domains` mit Step-up beim Einschalten). M14 bis M19 gehören parallelen Threads (Anbindungen, Game-Relay, Server-Detail, Auto-Update, Ops-Zusatzmodule).

- **WP Schema** (`packages/shared`): `agent-automation.ts` (Agent-Aktionen `task.exec`, `speedtest.run`, `cert.write`, `cert.remove`, `app.remove`, per `...automationRpcParams` in der Allowlist, Fähigkeit `capabilities.tasks`), `api/tasks.ts`, `api/selfheal.ts`, `api/speedtest.ts`, `api/domains.ts`, Module in `api/modules.ts`, Migration 19.
- **WP Core ∥** (`apps/core/src/tasks|selfheal|speedtest|domains`, verdrahtet über `features.ts`):
  - **Geplante Aufgaben pro Server:** Container neu starten/starten/stoppen, Stack aktualisieren (pull + up), Docker aufräumen, wöchentlich zu Uhrzeiten oder alle N Minuten (ab 5). `Befehl ausführen` nur, wenn der Agent mit `HZ_AGENT_ALLOW_TASKS=1` läuft, Anlegen/Ändern/Starten mit Step-up, Befehl verschlüsselt gespeichert, nie im Log. Letzte 50 Läufe mit Ausgabe, Meldung bei Fehler.
  - **Selbstheilung:** `unhealthy` länger als die Schonfrist, Absturz (wenn gewählt) oder verknüpfter Website-Check DOWN → Neustart. Höchstens 3 Neustarts in 30 Min (einstellbar), dann „aufgegeben“ mit CRIT-Meldung, bis der Container 10 Min gesund ist oder der Admin zurücksetzt. Nie `hz.role`, nie vom Admin oder von M10 gestoppte Container, abgestürzte `wichtig`-Container bleiben bei M10.
  - **Speedtest-Verlauf:** ein gewählter Server misst alle N Stunden gegen `speed.cloudflare.com` (Download, Upload, Ping, Jitter), 90 Tage Verlauf, Schwellen mit Meldung nach 3 langsamen Messungen in Folge.
  - **Domains und Zertifikate:** DNS-Anbieter Cloudflare und DuckDNS (Token verschlüsselt), Einträge A/AAAA/CNAME mit Ziel „öffentliche IP von Server X“ (DynDNS) oder fest, ACME-Zertifikate (Let's Encrypt, DNS-01, auch Wildcards), Verlängerung 30 Tage vorher, Verteilung auf gewählte Server nach `/opt/homelab/certs/<name>/`. Schnittstelle `DomainService.ensureRecord/removeRecord` für das Game-Relay (M15).
- **WP Agent ∥** (`apps/agent`, `deploy/`): `task.exec` (Host-Shell wie die Konsole, ohne TTY, Zeitlimit, Prozessgruppe beenden, Ausgabe gekürzt), `speedtest.run` (nur Cloudflare, Byte- und Zeitgrenzen), `cert.write`/`cert.remove`, `HZ_AGENT_ALLOW_TASKS` im Compose und im Installer (`--tasks`).
- **WP Web ∥** (`apps/web`): Seite „Automatik“ (Aufgaben, Selbstheilung), Seite „Internet“ (Speedtest-Verlauf, Domains, Zertifikate), Schalter unter Einstellungen → Module.

**Abnahme:** Eine Aufgabe startet einen Sim-Container zur eingestellten Minute neu; ein `unhealthy`-Container wird neu gestartet und nach 3 Versuchen aufgegeben (CRIT-Meldung); ein Speedtest landet im Verlauf; ein DuckDNS-Eintrag folgt der öffentlichen IP eines Sim-Servers; ein Zertifikat wird gegen einen ACME-Testserver ausgestellt und auf einen Server verteilt. Sicherheitstests: `task.exec` ohne `HZ_AGENT_ALLOW_TASKS` abgelehnt, Befehl-Aufgaben nur mit Step-up, Befehl in keiner Antwort/Log; keine Selbstheilung an `hz.role`; Speedtest nur gegen Cloudflare; DNS/ACME nur zu erlaubten Hosts ohne Weiterleitungen; Tokens und private Schlüssel in keiner Antwort, keinem Log; fremde DNS-Einträge werden nicht überschrieben.

---

## M21: App-Store und Stack-Vorlagen
**Ziel:** Jellyfin, Nextcloud, Vaultwarden und Co. mit einem Klick auf einem gewählten Server installieren; eigene Docker-Compose-Vorlagen als Basis. Modul `apps`, Standard aus.

- **WP Schema** (`packages/shared/src/api/apps.ts`): Vorlagen-Metadaten (Parameter: Text, Passwort, Port, Zahl, Auswahl, Ja/Nein), Installationen, Vorschau, Regeln `COMPOSE_FORBIDDEN`.
- **WP Vorlagen ∥** (`templates/apps/<id>/template.json + compose.yml`): mindestens Jellyfin, Nextcloud, Vaultwarden, Forgejo, Paperless-ngx, Syncthing, Audiobookshelf, Navidrome, FreshRSS, Uptime Kuma, Mealie; Images auf Versionen gepinnt, Ports immer `${BIND}:…`, Daten unter `./data/`.
- **WP Core ∥** (`apps/core/src/appstore`): Vorlagen laden und prüfen (eingebaut und eigene), Sicherheitsprüfung jeder Compose-Datei (kein privileged, kein Docker-Socket, keine Host-Pfade außerhalb des App-Ordners …), Installation über `compose.write` + `compose.up` nach `/opt/homelab/apps/<appId>/`, Passwörter erzeugt und verschlüsselt, Prüfung Architektur, RAM (M10-Reserve) und freie Ports, Start/Stopp/Neustart/Aktualisieren, Entfernen mit Step-up und Namensbestätigung (`app.remove`).
- **WP Web ∥** (`apps/web`): Seite „Apps“ (Katalog nach Kategorien, Installieren-Dialog mit Server, Bind-Adresse, Parametern und Vorschau, installierte Apps mit Status und „Öffnen“), Editor für eigene Vorlagen.

**Abnahme:** Vaultwarden wird auf einem Sim-Server installiert, läuft, wird aktualisiert und entfernt; eine eigene Vorlage mit `privileged: true` wird abgelehnt; ein belegter Port verhindert die Installation. Sicherheitstests: jede verbotene Compose-Option, Pfad-Ausbruch (`../`, absolute Pfade, Symlinks), Parameterwerte mit `$`/Zeilenumbruch, Passwörter nur mit Step-up lesbar, Entfernen nur mit Step-up, nie Container mit `hz.role`.

---

## M22: Cloud-Server (zuerst Azure)
Wunsch des Admins vom 26.11.2026: Azure-Konto einmal verknüpfen, dann bestellt die Zentrale beim Anlegen eines Gameservers selbst einen passenden Server und zahlt nur, wenn wirklich gespielt wird. Modul `cloud` (Standard aus, Einschalten mit Step-up), generisch über `CLOUD_PROVIDERS`, damit später weitere Anbieter dazukommen. Schemas: `packages/shared/src/api/cloud.ts`.

- **WP Schema** (`packages/shared`): Azure-Zugang (Tenant, App, Secret, Abo, Ressourcengruppe, Region, Tailscale-Auth-Key, Budget), feste Größen-, Disk- und Regionsliste mit Preis-Schätzung, Größen-Empfehlung pro Spiel-RAM, Maschinen mit Zuständen, Bestellung mit bestätigtem Preis und optionalem Gameserver.
- **WP Core ∥** (`apps/core/src/cloud`): Azure-Client nur gegen feste Hosts (Token per Client Credentials, ARM-REST für VNet, NSG, öffentliche IP, NIC, VM; Retail Prices API für echte Preise), cloud-init installiert Docker, Tailscale und den Agent mit Einzeiler-Code (M11), danach wird der Gameserver darauf angelegt und die NSG öffnet genau seine Ports. Schlafmodus: liegen alle Spiele einer Maschine die eingestellte Zeit still, wird die VM deallocated; ein Start eines Spiels (Admin, Benutzerlink, Discord, Sprache) startet zuerst die VM. Laufzeit pro Monat, Kosten-Schätzung, Budget mit Warnung bei 80 % und Sperre automatischer Starts ab 100 %. Löschen mit Step-up und Namensbestätigung räumt alle Azure-Ressourcen der Maschine weg.
- **WP Web ∥** (`apps/web`): Seite „Cloud“ (Zugang, Budget, Maschinen mit Zustand, Kosten, Starten/Schlafen/Löschen), im Gameserver-Formular das Ziel „Neuer Azure-Server“ mit empfohlener Größe, Kosten pro Stunde/Monat und Bestätigung, Schalter unter Module.

**Abnahme:** Gegen eine Azure-Attrappe (Test und e2e) wird eine Maschine mit Minecraft bestellt (empfohlen B2ms, nicht die größte), der simulierte Agent meldet sich, der Gameserver entsteht darauf; nach der Leerlaufzeit wird die VM deallocated, ein Start über den Benutzerlink startet zuerst die VM; das Budget warnt und sperrt automatische Starts; Löschen verlangt Step-up und Namen. Sicherheitstests: Modul aus = 404, nur feste Azure-Hosts (Override nur mit `HZ_DEMO=1` auf 127.0.0.1), keine Pfadteile aus Eingaben ohne Prüfung, Secrets nie in Antwort, Log oder Fehler, Secret verworfen bei Wechsel von Tenant/App/Abo, keine Bestellung ohne passenden bestätigten Preis, NSG nur Spielports (kein SSH, kein RCON), VM ohne Passwort.

---

## M24: KI-Vorschläge, schneller Docker-Wechsel, interaktive Gameserver
Wunsch des Admins vom 27.11.2026. Modul `ai` (Standard aus, Einschalten mit Step-up), anbieterneutral (Anthropic, OpenAI, Ollama im Tailnet). Feste Regeln liefern Vorschläge auch ohne Key, das Sprachmodell sortiert und erklärt nur. Vorschläge sind nie Aktionen: „Anwenden“ ruft nur Aktionen aus `SUGGESTION_ACTIONS` über bestehende Routen mit deren Step-up auf. Dazu Stack-Versionen mit Wechsel und automatischem Rollback, Bauplan-Assistent für neue Server, Gameserver-Einstellungen als Formular mit Live-Änderung per RCON und automatische Vorschläge für RAM, Schlafzeit, Version, Mods und Host (inkl. Azure). Voraussetzung: M23 und M11b gemergt. Arbeitspakete, Abnahme und Sicherheitstests: `docs/M24-KI-PLAN.md`.

---

## M25: GitHub-Ausbau
Wunsch des Admins vom 27.11.2026. Modul `github` bleibt optional. Lesen ist Standard, Schreiben wird pro Repo mit Step-up freigeschaltet, der Client ruft nur Aufrufe aus `GITHUB_CALLS` auf (nie Repos/Secrets/Rechte ändern, Branches nur unter `hz/`). Rechte-Bericht des Tokens, PR-Übersicht mit Mergen, Actions mit Logs/Re-run/Workflow starten, Preview-Deploys pro PR, Releases mit Rollback, Deploy-Status nach GitHub, Update-PRs für Images, Meldung als Issue, Sicherheitsfunde, adaptives Polling statt Webhooks. Arbeitspakete, Token-Empfehlung, Abnahme und Sicherheitstests: `docs/M25-GITHUB-PLAN.md`.

---

## M26: Freunde-Zugang mit einem Klick
Wunsch des Admins vom 27.11.2026. Assistent „Freunde-Zugang einrichten“ richtet das Share-Gateway selbst ein: Weg A (empfohlen) als eigener Tailscale-Knoten mit Funnel nur für das Gateway (keine Ports, keine Domain), Weg B auf einem Server mit öffentlicher IP über den Agent (`share.install`, feste Compose mit Caddy, DNS über M20, Host-Firewall, optional Oracle-Security-List per OCI-Schlüssel). Dazu „Freunde“: ein persönlicher Link pro Freund für mehrere Gameserver, Einladen per Kopieren/QR/Teilen/Discord, Whitelist aus dem Minecraft-Namen. Core und Agent bleiben nie öffentlich. Details: `docs/M26-FREUNDE-ZUGANG-PLAN.md`.

---

## M27: Gameserver Plus
Wunsch des Admins vom 27.11.2026. Forge/NeoForge und Ein-Klick-Profile pro Spiel, Modpacks aus Modrinth (`.mrpack`) und CurseForge (eigener API-Key), mehrere Welten pro Server mit Wechsel und ZIP für Freunde, Live-Konsole für Freunde nur mit Befehls-Allowlist, Auto-Skalierung auf eine größere Azure-VM ohne Spieler online und mit gleicher Relay-Adresse. Details: `docs/M27-M28-PLAN.md`.

---

## M28: Projekte hosten
Wunsch des Admins vom 27.11.2026. Repo-Link einfügen → die Zentrale erkennt Compose, Dockerfile, Node, Python oder statisch, baut auf dem Zielserver und startet; Subdomain mit HTTPS (Standard nur im Tailnet, öffentlich nur mit Step-up), Push to deploy mit Health-Gate und Rollback, Variablen und verschlüsselte Secrets pro Projekt, Logs und Neustart pro Projekt. Details: `docs/M27-M28-PLAN.md`.

---

## M29: App-Store 2.0 mit Suche
Wunsch des Admins vom 27.11.2026. Rund 80 eingebaute Apps in Kategorien, Suche (deutsch/englisch, tippfehlertolerant) und Filter (Architektur, RAM, installiert), Bundles, optionale Ausnahmen pro Vorlage mit Step-up (nie Docker-Socket oder privileged), optionaler Import von CasaOS-/Umbrel-Katalogen durch dieselbe Prüfung, Backup und Rollback pro App. Details: `docs/M29-APPSTORE-PLAN.md`.

---

## M30: 3D-Drucker Bambu Lab
Wunsch des Admins vom 27.11.2026. Modul `printer` (Standard aus): Anbindung im LAN über den Agent (MQTT/FTPS, Zertifikat festgenagelt) oder über Home Assistant, Kachel mit Status, Fortschritt, Restzeit, Temperaturen, AMS und Kamera (auch Wandmodus), Push bei Fertig/Fehler, Pause/Fortsetzen/Licht, Abbrechen und Drucken mit Step-up, Datei-Upload, Verlauf. Details: `docs/M30-BAMBU-PLAN.md`.

---

## M31: Tür und Gegensprechanlage
Wunsch des Admins vom 27.11.2026 (BTicino Classe 100X mit WLAN plus zweite Station ohne WLAN). Modul `door` über Home Assistant (Rückfall: Shelly am Türkontakt): Klingeln als Push mit Bild, Wandkachel und Echo-Ansage, Öffnen nur mit Bestätigung und Step-up, Wandgerät nur mit ausdrücklicher Freigabe, „Tür öffnen?“-Push bei Ankunft (nie automatisch), Verlauf mit Bildern. Details: `docs/M31-TUER-PLAN.md`.

---

## Definition of Done (für jeden PR)
- Code, Tests und Doku sind aktuell (`docs/` mitpflegen, wenn sich etwas ändert)
- Keine `any`, keine auskommentierten Blöcke, keine TODOs ohne Issue
- UI nur aus `packages/ui` plus Tokens; neue Komponenten zuerst als Vorschlag in `docs/QUESTIONS.md`
- Sicherheitsregeln aus `SECURITY.md` eingehalten
