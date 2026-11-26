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
| `servers` | id, name (unique), location, arch, os, tailscale_ip, public_ip, agent_version, capabilities_json, thresholds_json (nur abweichende Schwellen), allow_terminal, created_at, last_seen |
| `server_state` | server_id, metrics_json (letzte `metrics`), metrics_at, system_json, updates_json, reboot_required, ssh_failed_24h, fail2ban_banned, listening_ports_json, inventory_at (letztes `inventory`) |
| `agent_tokens` | id, server_id, token_hash (SHA-256 von `agent:<token>`), created_at, revoked_at |
| `enroll_tokens` | id, name, location, token_hash (SHA-256 von `enroll:<token>`), created_at, expires_at (15 Min), used_at, server_id |
| `metrics_raw` | server_id, ts (Empfangszeit im Core), cpu, ram, swap (Prozent), disk_max, disk_json (`[{mount, pct}]`), temp, net_in, net_out (Byte/s), 48 h |
| `metrics_5m`, `metrics_1h` | server_id, ts (Bucket-Start), cpu, ram, swap, disk_max, temp, net_in, net_out (gemittelt, 1h gewichtet nach samples), samples; 30 Tage bzw. 1 Jahr. Pro Disk wird nur roh gespeichert. |
| `containers` | id, server_id, docker_id (unique je Server), name, image, compose_project, state, health, ports_json, info_json (ganzes `ContainerInfo`, mit `role` aus `hz.role` und `cpuLimit`), last_mem_bytes (zuletzt bekannter Speicher, für die RAM-Reserve), updated_at |
| `game_servers` | id, server_id, template_id, name, settings_json, ports_json, rcon_secret_enc, external_address, auto_stop_minutes, created_at, priority (`wichtig`/`normal`/`niedrig`), allow_stop, allow_stop_with_players |
| `container_priorities` | container_id (Core-ID aus Server + Name, übersteht ein Neuerzeugen), server_id, container_name, priority, allow_stop, updated_at. Gameserver-Container nehmen die Priorität des Gameservers. |
| `server_throttle` | server_id, settings_json (`ThrottleSettings`: Automatik, Schwellen, Minuten, `throttleCpus`, `ramReserveMb`), schedules_json (Zeitfenster pro Stufe), updated_at. Fehlt die Zeile: Standardwerte. |
| `container_throttles` | container_id, server_id, container_name, game_id, docker_id (das Limit gehört zu diesem Docker-Container), cpus, original_cpus (wird beim Aufheben wiederhergestellt), by (`auto`/`admin`/`schedule`), reason, since, auto_stopped_at |
| `wichtig_restarts` | id, container_id, server_id, ts, ok (Startversuche gestoppter `wichtig`-Container, 10 Min) |
| `game_backups` | id, game_id, path, size, created_at |
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
- `inventory {containers[], updates, rebootRequired, sshFailed24h, fail2banBanned, listeningPorts[]}` alle 60 s und bei Docker-Events sofort
- `event {kind: 'container' | 'oom' | …, data}`
- `rpc.result {id, ok, data | error}`
- `stream.data {streamId, chunk}`, `stream.end {streamId, code}`

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
| `game.backups.purge` | `{gameId, olderThanDays}` → löscht eigene Backup-Archive dieses Gameservers unter `/opt/homelab/backups/<id>/`, die älter sind (für gelöschte Gameserver nach 30 Tagen) |
| `deploy.run` | `{dir, repoUrl, sha, method, keyName?}` → Stream |
| `deploy.key` | `{name}` → `{publicKey}` (ed25519, privater Schlüssel bleibt auf dem Server) |
| `system.cleanupPreview` / `system.cleanup` | `{}` |
| `system.reboot` | `{confirmName}` |
| `check.http` / `check.tcp` / `check.ping` | wie Check-Definition |
| `pty.open` / `pty.input` / `pty.resize` / `pty.close` | nur wenn `HZ_AGENT_ALLOW_TERMINAL=1` |

Pfade werden im Agent normalisiert und müssen mit `/opt/homelab/` beginnen. Kein `exec` beliebiger Strings: Jede Aktion ruft feste Programme mit Argument-Arrays auf (`execFile`, nie `shell: true`).

**Agent-Container:** `docker.sock` gemountet, `/proc` und `/sys` lesend gemountet (`/host/proc`), `/opt/homelab` gemountet, `pid: host` für Temperatur und Prozesse, `network_mode: host`. Für `system.*` läuft ein schmaler Helfer über `nsenter` bzw. dokumentierte Host-Kommandos. Wie genau, entscheidet Meilenstein 2 und dokumentiert es in `deploy/`.

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
