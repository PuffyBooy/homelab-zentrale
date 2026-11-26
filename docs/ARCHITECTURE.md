# Architektur

## Überblick

```
                 Tailnet (WireGuard, nur Geräte des Admins)
 ┌──────────────────────────────────────────────────────────────────┐
 │                                                                  │
 │  Handy/Laptop/Tablet ──HTTPS──▶ tailscale serve ──▶ core :8080   │
 │                                 (heimserver.*.ts.net)  │  (127.0.0.1)
 │                                                        │ WebSocket /agent
 │        ┌──────────────────────┬────────────────────────┤
 │        ▼                      ▼                        ▼
 │   agent@heimserver      agent@oracle-a1          agent@raspi    
 │   (Docker-Socket)       (Docker-Socket)          (Docker-Socket)
 └──────────────────────────────────────────────────────────────────┘
                                │ optional, öffentlich
                                ▼
                      share-gateway @ oracle-a1  ◀── Freunde (Benutzerlinks)
```

- **Core** ist die einzige Stelle mit Zustand (SQLite). Er liefert die Web-App aus, hält die WebSocket-Verbindungen zu Browsern und Agents und führt Checks, Polling und Zeitpläne aus.
- **Agent** ist zustandslos. Er meldet Messwerte, führt erlaubte Aktionen aus und streamt Logs und PTY. Die Verbindung baut er selbst auf und stellt sie mit Backoff wieder her.
- **Share-Gateway** ist optional und öffentlich. Es kennt nur Share-Tokens und leitet erlaubte Aktionen an den Core weiter (eigenes Gateway-Token, eigene enge API).

## Ordner

```
apps/
  core/
    src/
      index.ts            Fastify-Start, Plugins, statische Web-App
      config.ts           Env einlesen und validieren (zod)
      db/                 Drizzle-Schema, Migrationen, Repositories
      auth/               Login, TOTP, Sessions, Geräte-Token (Wand)
      crypto.ts           AES-256-GCM für Secrets
      agents/             Agent-Hub: Verbindungen, Enrollment, RPC
      metrics/            Speicherung und Verdichtung der Messwerte
      servers/            Routen und Statuslogik
      containers/
      games/              Vorlagen laden, Compose rendern, Query/RCON
      share/              Benutzerlinks, API für das Gateway
      github/             Polling-Client, Deploy-Orchestrierung
      checks/             HTTP/TCP/Ping/SSL/RDAP, Scheduler
      alerts/             Regeln, Zustände, Push (web-push), Wochenbericht
      homeassistant/      HA-WebSocket-Client
      terminal/           PTY-Proxy Browser ↔ Agent
      live/               WebSocket zu Browsern (Topics, Diffs)
    test/
  web/
    src/
      main.tsx, routes/, pages/<bereich>/, hooks/, lib/api.ts, lib/live.ts
      sw.ts                Service Worker (Push, Offline-Shell)
  agent/
    src/
      index.ts            Verbindung, Backoff, Heartbeat
      collect/            system.ts (systeminformation), docker.ts (dockerode), security.ts
      actions/            ein Modul pro erlaubter Aktion
      pty.ts              node-pty (nur wenn erlaubt)
    Dockerfile            Multi-Arch (linux/amd64, linux/arm64)
  share/
    src/index.ts          kleine Fastify-App, eigene Mini-UI (dieselben Tokens)
packages/
  shared/src/             zod-Schemas: api/*.ts, agent-protocol.ts, live.ts, types
  ui/src/                 TSX-Komponenten aus design/reference (Props aus index.d.ts)
  ui/styles/              importiert design/tokens.css + design/components.css
templates/games/<id>/     compose.yml + template.json
deploy/
  docker-compose.core.yml
  docker-compose.agent.yml
  install-agent.sh
  tailscale-serve.md
design/                   Designsystem (nicht von Hand ändern, siehe design/README.md)
```

## Datenmodell (SQLite, Drizzle)

| Tabelle | Wichtige Spalten |
| --- | --- |
| `users` | id, username, password_hash (argon2id), totp_secret_enc, totp_last_step (gegen TOTP-Replay), created_at, updated_at |
| `sessions` | id (zufällig, öffentlich), token_hash (SHA-256 des Cookie-Werts), user_id, created_at, expires_at, last_seen, user_agent, step_up_until |
| `recovery_codes` | id, user_id, code_hash (SHA-256), created_at, used_at |
| `device_tokens` | id, kind (`wall`), token_hash, label, created_at, revoked_at |
| `servers` | id, name (unique), location, arch, os, tailscale_ip, public_ip, agent_version, capabilities_json, thresholds_json (nur abweichende Schwellen), allow_terminal, network (`home`/`cloud`/`vps`/`other`, M12), created_at, last_seen |
| `server_state` | server_id, metrics_json (letzte `metrics`), metrics_at, system_json, updates_json, reboot_required, ssh_failed_24h, fail2ban_banned, listening_ports_json, inventory_at (letztes `inventory`) |
| `agent_tokens` | id, server_id, token_hash (SHA-256 von `agent:<token>`), created_at, revoked_at |
| `enroll_tokens` | id, name, location, token_hash (SHA-256 von `enroll:<token>`), created_at, expires_at (15 Min), used_at, server_id |
| `onboarding_codes` | id, name, location, code_hash (HMAC-SHA-256 des Codes, Schlüssel per HKDF aus `HZ_SECRET_KEY`), created_at, expires_at (15 Min), exchanged_at, cancelled_at, enroll_token_id (M11, Server anbinden in einem Schritt) |
| `server_allowed_ports` | server_id, proto, port, note, created_at (Soll-Liste offener Ports, M11) |
| `server_port_audit` | server_id, seeded_at (vorhanden, sobald die Soll-Liste existiert) |
| `metrics_raw` | server_id, ts (Empfangszeit im Core), cpu, ram, swap (Prozent), disk_max, disk_json (`[{mount, pct}]`), temp, net_in, net_out (Byte/s), 48 h |
| `metrics_5m`, `metrics_1h` | server_id, ts (Bucket-Start), cpu, ram, swap, disk_max, temp, net_in, net_out (gemittelt, 1h gewichtet nach samples), samples; 30 Tage bzw. 1 Jahr. Pro Disk wird nur roh gespeichert. |
| `containers` | id, server_id, docker_id (unique je Server), name, image, compose_project, state, health, ports_json, info_json (ganzes `ContainerInfo`, mit `role` aus `hz.role` und `cpuLimit`), last_mem_bytes (zuletzt bekannter Speicher, für die RAM-Reserve), updated_at |
| `game_servers` | id, server_id, template_id, name, settings_json, ports_json, rcon_secret_enc, external_address, auto_stop_minutes, created_at, priority (`wichtig`/`normal`/`niedrig`), allow_stop, allow_stop_with_players, wake_on_connect, sleeping, mods_restart_needed (M12) |
| `container_priorities` | container_id (Core-ID aus Server + Name, übersteht ein Neuerzeugen), server_id, container_name, priority, allow_stop, updated_at. Gameserver-Container nehmen die Priorität des Gameservers. |
| `server_throttle` | server_id, settings_json (`ThrottleSettings`: Automatik, Schwellen, Minuten, `throttleCpus`, `ramReserveMb`), schedules_json (Zeitfenster pro Stufe), updated_at. Fehlt die Zeile: Standardwerte. |
| `container_throttles` | container_id, server_id, container_name, game_id, docker_id (das Limit gehört zu diesem Docker-Container), cpus, original_cpus (wird beim Aufheben wiederhergestellt), by (`auto`/`admin`/`schedule`), reason, since, auto_stopped_at |
| `wichtig_restarts` | id, container_id, server_id, ts, ok (Startversuche gestoppter `wichtig`-Container, 10 Min) |
| `server_storage` | server_id, storage_json (letztes `inventory.storage`: RAID, Volumes, Platten mit SMART), updated_at (M13, Migration 14) |
| `game_backups` | id, game_id, path, size, created_at |
| `server_ingress` | server_id, enabled, public_ip, port_from, port_to, updated_at (Eingang für das Game-Relay, M15, Migration 16) |
| `game_relays` | game_id, ingress_server_id, dns_name, dns_ip (seit M20 ungenutzt: den A-Eintrag führt das Domains-Modul als `dns_records` mit owner `relay`), listen_ports_json (feste Ports am Eingang, bleiben beim Umzug), state, error, updated_at (M15) |
| `game_schedules` | id, game_id, kind (`restart`/`backup`), days_json (ISO-Wochentage), time (HH:MM in `HZ_TIMEZONE`), enabled, last_run_at (M12, Migration 15) |
| `game_notify` | game_id, discord_url_enc (AES-GCM), events_json, last_sent_at, last_error (M12) |
| `game_player_sessions` | id, game_id, player, started_at, ended_at (aus den Status-Abfragen, 90 Tage, M12) |
| `game_player_hours` | game_id, hour (Bucket-Start), samples, players_sum, peak (Ø Spieler pro Stunde, M12) |
| `game_mods` | game_id, kind, file_name, project_id, version_id, title, sha512, installed_at (über die Zentrale installierte Jars, M12) |
| `whitelist_requests` | id, game_id, share_id, person, player, state (`pending`/`approved`/`rejected`), created_at, decided_at (M12) |
| `game_migrations` | id, game_id, game_name, source/target_server_id und _name (ohne Fremdschlüssel), phase, failed_phase, bytes_done, bytes_total, sha256, error, error_text, rollback, ports_json, rcon_port, forwarding_hint (Ports am Ziel), was_running, target_touched (Import angenommen), cleanup_target, restart_source (offene Rückbau-Schritte), started_at, updated_at, finished_at (M11, Migration 13) |
| `share_links` | id, game_id, person, token_hash (SHA-256 von `share:<token>`), pin_hash (argon2id), perms_json, expires_at, revoked_at, last_used_at, pin_failures, locked_until, created_at |
| `share_audit` | id, share_id (ohne Fremdschlüssel, bleibt nach Löschen des Links), game_id, person, action, detail, ts, ip, via (`tailnet`/`gateway`); 90 Tage |
| `github_repos` | id, full_name, default_branch, etag, last_commit_sha, ci_status, updated_at |
| `deploy_targets` | id, repo_id, server_id, path, branch, method, auto_deploy |
| `deploys` | id, target_id, sha, status, log_text, started_at, finished_at, triggered_by |
| `checks` | id, kind, target, from_agent_id, expected_json, interval_s, enabled |
| `check_results` | check_id, ts, ok, code, ms, error (7 Tage Rohdaten, danach Tagesmittel) |
| `cert_status` | check_id, ssl_expires_at, domain_expires_at, checked_at |
| `alerts` | id, key (dedupe, partieller Unique-Index solange nicht `resolved`), level, title, body, server_id, source, state, opened_at, acked_at, resolved_at |
| `push_subscriptions` | id, endpoint, keys_json, label, created_at |
| `settings` | key, value_json, updated_at (HA-URL, HA-Token verschlüsselt, Ruhezeit, GitHub-Token verschlüsselt …) |
| `audit_log` | id, ts, actor (`admin`, `anonymous`, `share:<id>`, `system`), action, target, details_json |
| `schema_migrations` | version, name, applied_at (Migrationen in `apps/core/src/db/migrations.ts`, beim Start angewendet) |

## Agent-Protokoll

Eine WebSocket-Verbindung pro Agent zu `wss://<core>/agent`. Nachrichten sind JSON und werden auf beiden Seiten mit zod geprüft (`packages/shared/src/agent-protocol.ts`).

**Handshake:** Agent → `hello {name, version, arch, os, token}`. Der Core prüft das Token (Hash). Bei einem Enrollment-Token sendet der Core zuerst `enrolled {agentToken}`, und der Agent speichert es im Volume `/data/agent.json`.

Die erste Nachricht muss innerhalb von 10 s ein gültiges `hello` sein. Danach antwortet der Core mit `welcome {serverId, protocol, metricsIntervalS, inventoryIntervalS}` oder `reject {code}` und schließt (Close-Codes `AGENT_CLOSE` in `agent-protocol.ts`: 4000 ersetzt, 4001 abgelehnt, 4002 hello-Timeout, 4003 widerrufen, 1008 zu viele ungültige Nachrichten, 1009 Frame > 1 MiB). Ungültige Nachrichten werden verworfen und gezählt. Eine zweite Verbindung desselben Servers ersetzt die alte.

**Agent → Core**
- `metrics {ts, cpu, ram, swap, disks[], temp, net}` alle 10 s
- `inventory {containers[], updates, rebootRequired, sshFailed24h, fail2banBanned, listeningPorts[], storage?}` alle 60 s und bei Docker-Events sofort. `storage` (M13) nur, wenn der Host Platten oder md-RAID hat: `/proc/mdstat`, Mount-Tabelle von PID 1, `/sys/block`, SMART per `smartctl` nur mit `HZ_AGENT_SMART=1` (siehe `deploy/docker-compose.agent.smart.yml`)
- `event {kind: 'container' | 'oom' | 'game_wake' | 'denied', …}` (`game_wake {gameId, port, protocol}`: ein schlafender Gameserver bekam einen echten Verbindungsversuch, M12; ohne Client-Adresse)
- `rpc.result {id, ok, data | error}`
- `stream.data {streamId, chunk}`, `stream.end {streamId, code}`
- `transfer.begin {streamId, bytes, sha256, chunks}`, `transfer.chunk {streamId, seq, data}`, `transfer.ack {streamId, seq}`, `transfer.end {streamId, chunks, bytes, sha256}` (M11, nur für offene `game.export`/`game.import`-Streams dieser Verbindung, siehe „Umzug von Gameservern“)

**Core → Agent** (`rpc {id, action, params}`). Erlaubte Aktionen (Allowlist, sonst Fehler):

| action | params |
| --- | --- |
| `container.start` / `stop` / `restart` | `{id}` |
| `container.limit` | `{id, cpus}`: nur `docker update --cpus` (0,1–64, höchstens die CPU-Zahl des Hosts; `cpus: null` hebt das Limit auf) → `{cpus}`. Nie für Container mit dem Label `hz.role` (core, agent) und nie für den Agent selbst (`not_allowed`). RAM-Limits werden nie geändert. |
| `container.logs` | `{id, tail, follow}` → Stream |
| `compose.up` / `down` / `pull` | `{dir}` (nur unter `/opt/homelab/`) |
| `compose.write` | `{dir, files: {name: text}}` (nur unter `/opt/homelab/`) |
| `game.rcon` | `{gameDir, command}` |
| `game.backup` | `{gameDir}` → Stream |
| `game.status` | `{gameDir, method, port, gamedigType?, tpsCommand?}` → Spieler, Version, TPS (RCON-Daten liest der Agent aus der `.env` im Ordner) |
| `game.remove` | `{gameDir}` → `compose down` und Ordner löschen (nur unter `/opt/homelab/games/`) |
| `game.export` | `{gameId, maxBytes, paths?}` → Stream: Archiv von `data/` des Spielordners (mit `paths` nur diese Weltordner, für den Welt-Download der Freunde, M12), dann `transfer.begin/chunk/end` (M11) |
| `game.import` | `{gameId, bytes, sha256, chunks}` → Stream: empfängt `transfer.chunk`/`transfer.end`, prüft Größe, sha256 und jeden Archiv-Eintrag, entpackt nach `/opt/homelab/games/<gameId>/data` (M11) |
| `relay.set` | `{routes: [{id, protocol, listenPort, count, target: {host, port}}]}`: ersetzt alle Relay-Routen des Eingangs, Ziele nur im Tailnet, nur mit `HZ_AGENT_ALLOW_RELAY=1` (M15) |
| `game.wake.arm` / `game.wake.disarm` | `{gameId, mode, ports, motd}` / `{gameId}`: Wake-Listener eines gestoppten Gameservers nur auf seinen veröffentlichten Ports (M12, Schlafmodus) |
| `game.mods.list` / `install` / `remove` | `{gameId, kind}` / `+ url, fileName, sha512, sizeBytes` / `+ fileName`: Jars in `data/plugins` bzw. `data/mods`, Download nur von `cdn.modrinth.com` mit sha512 (M12) |
| `game.restore` | `{gameId, fileName}` → Stream: Backup nach `data/` zurückspielen (Spiel gestoppt, jeder Eintrag geprüft, alte Daten bleiben bei Fehler) (M12) |
| `game.backups.purge` | `{gameId, olderThanDays}` → löscht eigene Backup-Archive dieses Gameservers unter `/opt/homelab/backups/<id>/`, die älter sind (für gelöschte Gameserver nach 30 Tagen) |
| `deploy.run` | `{dir, repoUrl, sha, method, keyName?}` → Stream |
| `deploy.key` | `{name}` → `{publicKey}` (ed25519, privater Schlüssel bleibt auf dem Server) |
| `system.cleanupPreview` / `system.cleanup` | `{}` |
| `system.reboot` | `{confirmName}` |
| `check.http` / `check.tcp` / `check.ping` | wie Check-Definition |
| `logs.search` | `{query, caseSensitive, sinceMinutes, containers?, maxMatches}` → Treffer neueste zuerst: reiner Teilstring (nie RegExp), höchstens `LOG_SEARCH_TAIL` Zeilen pro Container, 4 Container gleichzeitig, nach 25 s `truncated` |
| `image.scan` | `{id}` → der Agent ermittelt den Registry-Digest selbst und startet das gepinnte Trivy-Image (`HZ_AGENT_TRIVY_IMAGE`) mit `--image-src remote`, ohne Docker-Socket und Host-Pfade, Cache im Volume `hz-trivy-cache`; lokal gebaute Images → `local_image`; ein Scan gleichzeitig (sonst `busy`) |
| `fail2ban.status` / `fail2ban.unban` | `{}` / `{jail, ip}`: `fail2ban-client status [jail]` bzw. `fail2ban-client set <jail> unbanip <ip>` auf dem Host; der Jail muss in der Jail-Liste stehen |
| `pty.open` / `pty.input` / `pty.resize` / `pty.close` | nur wenn `HZ_AGENT_ALLOW_TERMINAL=1` |
| `task.exec` | `{taskId, command, timeoutSec}` → `{exitCode, timedOut, durationMs, output, truncated}`: eine Zeile `/bin/sh -c` auf dem Host, nur wenn `HZ_AGENT_ALLOW_TASKS=1` (M20), feste Umgebung, Prozessgruppe nach dem Zeitlimit beendet, Befehl nie im Log |
| `speedtest.run` | `{maxSeconds, maxBytes}` → Download, Upload, Ping, Jitter; nur gegen `speed.cloudflare.com` (M20) |
| `cert.write` / `cert.remove` | `{name, fullchainPem, privkeyPem}` / `{name}`: nur `/opt/homelab/certs/<name>/`, Schlüssel 0600, keine Symlinks (M20) |
| `app.remove` | `{appId, deleteData}`: `compose down` in `/opt/homelab/apps/<appId>/`, mit `deleteData` Ordner löschen (M21) |

Pfade werden im Agent normalisiert und müssen mit `/opt/homelab/` beginnen. Kein `exec` beliebiger Strings: Jede Aktion ruft feste Programme mit Argument-Arrays auf (`execFile`, nie `shell: true`).

**Agent-Container:** `docker.sock` gemountet, `/proc` und `/sys` lesend gemountet (`/host/proc`), `/opt/homelab` gemountet, `pid: host` für Temperatur und Prozesse, `network_mode: host`. Für `system.*` läuft ein schmaler Helfer über `nsenter` bzw. dokumentierte Host-Kommandos. Wie genau, entscheidet Meilenstein 2 und dokumentiert es in `deploy/`.

## Server anbinden in einem Schritt (M11)

Vertrag: `packages/shared/src/api/onboarding.ts`, Code: `apps/core/src/servers/onboarding*.ts`, Skript-Vorlage `apps/core/templates/install.sh`.

1. `POST /api/servers/onboarding` (Session + Step-up) legt einen Code an (8 Zeichen aus `ONBOARDING_CODE_ALPHABET`, 15 Min, einmalig, höchstens 10 offene, Name darf nicht belegt oder schon in einem offenen Onboarding sein). Gespeichert wird nur der HMAC. Antwort: Code (einmal sichtbar) und Einzeiler `curl -fsSL <HZ_BASE_URL>/install.sh | sudo sh -s -- <code>`.
2. `GET /install.sh` ist öffentlich im Tailnet (außerhalb von `/api`, kein Session-Check). Das Skript ist für alle Server gleich; eingesetzt wird nur die Adresse aus `HZ_BASE_URL` (nie aus dem `Host`-Header). Ohne https-`HZ_BASE_URL` antwortet es in Produktion 404, sonst (Entwicklung, Tests) mit `http://127.0.0.1:<HZ_PORT>`.
3. Das Skript (POSIX `sh`, `set -eu`) prüft Format des Codes, root, curl, Docker + Compose v2 und Tailscale, bricht ab, wenn schon ein Agent eingerichtet ist, und tauscht dann den Code über `POST /api/onboarding/exchange` (Code über stdin, nicht in `ps`). Antwort `text/plain` mit vier `KEY=value`-Zeilen; jeder Wert wird mit einem festen Muster geprüft (kein `eval`). Es schreibt `/etc/homelab-agent/agent.env` (0600), die Compose-Datei (gleich wie `deploy/docker-compose.agent.yml`, per Test geprüft) und `.env`, holt das Image (`HZ_AGENT_IMAGE` des Core) und startet den Agent. Das Token wird nie ausgegeben.
4. Der Tausch ist ohne Session erreichbar (genau dieser Pfad in `PUBLIC_API_ROUTES`), ohne `Origin`-Header erlaubt (curl), mit fremdem `Origin` 403. Rate-Limit: 5 Versuche pro IP und 15 Min (auch erfolgreiche), 30 Fehlversuche über alle IPs sperren jeden Tausch für 15 Min. Die IP kommt aus `X-Forwarded-For` nur, wenn die Verbindung von Loopback kommt (`tailscale serve`). Jeder falsche, abgelaufene, benutzte oder abgebrochene Code bekommt dieselbe Antwort (400 `invalid_credentials`). Erst beim Tausch entsteht ein Enrollment-Token (`AgentTokens.createEnrollment`, 15 Min).
5. `GET /api/servers/onboarding/:id`: `waiting` → `installing` (getauscht) → `connected` (der Agent hat sich mit dem Token angemeldet, `enroll_tokens.server_id` gesetzt) oder `expired`. `DELETE` bricht ab und macht auch ein schon getauschtes Enrollment-Token ungültig.

Audit: `server.onboarding_created`, `server.onboarding_exchanged`, `server.onboarding_refused`, `server.onboarding_cancelled`, danach wie bisher `server.enrolled`. Code und Token stehen nie im Log oder Audit.

## Port-Abgleich (M11)

Vertrag: `packages/shared/src/api/ports.ts`, Code: `apps/core/src/servers/ports*.ts`. Nach jedem gespeicherten `inventory` (Hook `ServerService.onInventoryStored`) prüft der Core die öffentlichen lauschenden Ports (`isPublicBindAddress`: `0.0.0.0`, `::`, globale Adressen; Loopback, RFC 1918, Tailscale/CGNAT, ULA und Link-Local zählen nicht).

- Gibt es für den Server noch keine Soll-Liste, übernimmt das erste Inventar mit Ports alle öffentlichen Ports, ohne Meldung. Ein Inventar mit leerer Portliste ändert nichts (der Agent konnte sie nicht lesen).
- Danach: jeder öffentliche Port außerhalb der Liste ergibt eine `warn`-Meldung mit Schlüssel `port:<serverId>:<proto>:<port>` (Dedupe über den Meldungsdienst). Ist der Port erlaubt oder weg, wird sie aufgelöst (weg: mit OK-Eintrag; erlaubt: ohne).
- `GET`/`PUT /api/servers/:id/ports/allowed`, `POST /api/servers/:id/ports/allow` (Session, kein Step-up, Audit `ports.update`/`ports.allow`). PUT und POST zählen auch als Anlegen der Liste.

## Umzug von Gameservern (M11)

Vertrag: `packages/shared/src/api/migrate.ts`, Frames in `agent-protocol.ts`. Code: `apps/core/src/games/migrate.ts` (Ablauf), `apps/core/src/games/migrate-routes.ts` (Routen), `apps/core/src/agents/transfer.ts` (Relay), Hooks in `apps/core/src/agents/hub.ts`.

- Routen: `POST /api/games/:id/migrate` (Session + Step-up, Modul games) → 202 `{migrationId}`; `GET /api/games/:id/migration`, `GET /api/games/:id/migration/suggest?targetServerId=`, `POST /api/games/:id/migration/cancel` (nur vor `start`). Ein Umzug pro Gameserver und pro Zielserver gleichzeitig (409 `busy`), Ziel = Quelle 400, Ziel offline 409 `agent_offline`, Ordnername am Ziel belegt oder Ports belegt 409 `conflict`, RAM-Reserve (M10) am Ziel 409 `insufficient_ram`.
- Ablauf: **backup** (RCON-Speichern, dann wird der Gameserver an der Quelle gestoppt, `game.export` startet) → **transfer** (Relay Quelle → Core → Ziel, RAM am Ziel nochmal geprüft, `game.import`) → **restore** (Ziel prüft und entpackt, Core schreibt `compose.yml`/`.env` mit den neuen Ports; das RCON-Passwort bleibt unverändert verschlüsselt) → **start** (RAM-Prüfung, `compose.up`, warten bis `game.status` antwortet; danach zeigt der Datensatz auf das Ziel, gleiche ID, Benutzerlinks gelten weiter) → **stop_old** (Quelle ist schon gestoppt, ihr Ordner bleibt als Rückfall) → **done**. War der Gameserver vorher gestoppt, wird er nach der Startprüfung am Ziel wieder gestoppt.
- Relay: Der Core leitet `transfer.chunk` der Quelle unverändert an den Import-Stream des Ziels weiter und bestätigt der Quelle einen Chunk erst, wenn das Ziel ihn bestätigt hat. Die Quelle darf höchstens `TRANSFER_WINDOW` Chunks über die letzte Bestätigung des Ziels hinaus senden, sonst bricht der Core ab; damit hält der Core nie mehr als das Fenster im Speicher. Jeder Chunk wird geprüft (Reihenfolge, Größe, angekündigte Bytes und `MIGRATION_MAX_BYTES`), sha256 rechnet der Core selbst nach und vergleicht mit `transfer.begin`/`transfer.end`; erst dann geht `transfer.end` mit den eigenen Werten ans Ziel. Kein Frame für `TRANSFER_IDLE_TIMEOUT_MS`: Abbruch. Transfer-Frames für unbekannte Stream-IDs, fremde Verbindungen oder Nicht-Transfer-Streams zählen als ungültig (zu viele schließen die Verbindung mit 1008). Transfer-Frames haben ein eigenes Nachrichtenbudget (`maxTransferMessages`).
- Fehler vor dem erfolgreichen Start am Ziel: Streams werden abgebrochen, die Kopie am Ziel per `game.remove` entfernt (nur wenn `game.import` angenommen wurde, ein fremder Ordner wird nie angefasst), die Quelle wieder gestartet, wenn sie lief. Ist ein Agent offline, bleibt der Schritt offen (`cleanup_target`/`restart_source`) und der Job `games.migrateCleanup` (alle 15 s) holt ihn nach. Ein Neustart des Core markiert laufende Umzüge als `failed` mit `interrupted` und denselben offenen Schritten.
- Fortschritt: Zeilen im Topic `game:<id>`, Busy-Text des Gameservers („Umzug: Übertragung 40 %“), `bytes_done` höchstens einmal pro Sekunde in der DB. Audit: `game.migrate_started`, `game.migrate_done`, `game.migrate_failed`, `game.migrate_refused`, `game.migrate_cancel`.

## Anbindungen (M14)

`apps/core/src/integrations/`: `http.ts` (der einzige ausgehende Client für Anbindungen, Regeln in `SECURITY.md`), `store.ts` (Einstellungen in `settings` unter `integration.<id>.*`, Secret verschlüsselt), `base.ts` (Status, Polling, Meldung nach 5 Min), dazu `proxmox.ts`, `dnsfilter.ts`, `fritzbox.ts` + `digest.ts`, `uptimekuma.ts`. Routen unter `/api/<id>/…`, hinter dem Modul-Gate. `apps/core/src/notify/` hängt sich als `ChannelFanoutSink` hinter den Notifier (gleiche Ruhezeit, Bündel und Morgen-Digest; Kanäle zählen als Pseudo-Geräte `channel:<id>`). `apps/core/src/wol/`: Konfiguration pro Server in `settings`, Senden per `dgram` aus der Zentrale (Host-Netz) oder über die Agent-Aktion `wol.send`. Keine eigene Migration.

## Betriebsmodule: Log-Suche, Schwachstellen-Scan, Fail2ban

Vertrag: `packages/shared/src/api/ops.ts` (Routen) und `packages/shared/src/agent-ops.ts` (Agent-Aktionen). Code: `apps/core/src/ops/` (`setupOps` in `index.ts` legt Dienste, Routen, Job und Modul-Schalter an). Alle Routen: Admin-Session, Modul-Gate.

- `POST /api/logsearch` (Modul logsearch): `logs.search` parallel an alle gewählten verbundenen Server (30 s Timeout), Container-IDs aus dem Inventar des Core nach Namensfilter (keiner passt: `no_containers`, kein RPC). Treffer neueste zuerst (ohne Zeitstempel zuletzt), gekappt auf `maxMatches`. 10 pro Minute und Session (429). Audit `logsearch.query` nur mit `{servers, sinceMinutes, queryLength}`.
- `GET /api/vulnscan`, `PUT /api/vulnscan/settings`, `POST /api/vulnscan/run` (202; 409 `busy` während eines Laufs; 429 bei mehr als einem manuellen Lauf in 10 Min). Job `vulnscan.nightly` (`scheduler.at` + `nextWallClock`, HZ_TIMEZONE) nur bei eingeschaltetem Modul. Pro Server nacheinander `image.scan {id}` (13 Min Timeout) für jeden laufenden Container, Server parallel; gleiche Image-ID wird einmal gescannt. `not_allowed`/offline → `skippedServers`. Ergebnisse in `settings` (`vulnscan.settings`, `vulnscan.results`): neuestes pro Server + Containername, Einträge verschwundener Container und gelöschter Server fallen weg. Meldungen `vulnscan:<serverId>:<container>` (warn); Modul aus erledigt alle.
- `GET /api/fail2ban` (`fail2ban.status` parallel, 15 s, 30 s Cache pro Server), `POST /api/fail2ban/unban` (`fail2ban.unban`, Cache verworfen, Antwort der frische Server-Eintrag, Audit `fail2ban.unban`). Fehlerzuordnung pro Server: `not_allowed` → `unsupported`, offline → `offline`, sonst `failed`.

## Live-Daten zum Browser

`wss://<core>/live`, Session-Cookie nötig. Der Client abonniert Topics (`servers`, `server:<id>`, `containers`, `games`, `checks`, `alerts`, `github`, `ha`). Der Core schickt zuerst einen Snapshot und dann Patches. TanStack Query hält die Daten, `lib/live.ts` schreibt Patches in den Query-Cache.

## Scheduler

Ein Scheduler im Core (kein externes Cron):
- Checks nach Intervall
- GitHub-Polling 60 s
- RDAP täglich 04:00
- Messwert-Verdichtung alle 5 Min bzw. stündlich
- Wochenbericht sonntags 19:00 (Europe/Vienna)
- Auto-Stopp leerer Gameserver jede Minute
- Drossel-Regelwerk (M10) alle 10 s, im Takt der Messwerte (`throttle.tick`): Zeitfenster in `HZ_TIMEZONE`, Drosseln/Stoppen/Aufheben, Neustart gestoppter `wichtig`-Container

## Konfiguration

Alles über Env (`.env.example`), beim Start mit zod geprüft. Fehlt `HZ_SECRET_KEY`, startet der Core nicht.
