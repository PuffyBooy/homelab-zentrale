# Deploy

## Core (Heimserver)

Ein Image: Der Core liefert die gebaute Web-App mit aus.

```bash
cp .env.example .env            # HZ_SECRET_KEY setzen: openssl rand -base64 32
docker compose -f deploy/docker-compose.core.yml up -d --build
curl http://127.0.0.1:8080/api/health   # {"ok":true}
```

- Der Core-Container nutzt das Host-Netz (`network_mode: host`) und lauscht nur auf `127.0.0.1:8080`. `tailscale serve` erreicht ihn über Loopback, dadurch stimmen auch die Client-IPs (X-Forwarded-For) fürs Login-Rate-Limit.
- Die SQLite-Daten liegen im Volume `hz-data` (im Container `/data`).
- Der Container läuft als Benutzer `node`, mit schreibgeschütztem Dateisystem, ohne Capabilities und mit `no-new-privileges`.

## Freigabe im Tailnet

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8080
```

Danach ist die Zentrale unter `https://heimserver.<tailnet>.ts.net` erreichbar. Nie `tailscale funnel` und nie eine Portweiterleitung für den Core (siehe `docs/NETWORK.md`).

## Agent (jeder Server)

Der Agent läuft als Container auf jedem Server und baut die Verbindung **selbst** zum Core auf (`wss://heimserver.<tailnet>.ts.net/agent`, über Tailscale). Er öffnet keinen Port.

### Installation

1. In der Zentrale „Server hinzufügen“: Name eingeben, das Einmal-Token (15 Min gültig) kopieren.
2. Auf dem Server, in einem Checkout dieses Repos:

```bash
sudo HZ_AGENT_TOKEN=<token> ./deploy/install-agent.sh \
  --url wss://heimserver.<tailnet>.ts.net/agent --name oracle-a1
# optional: --image <registry/agent:tag> statt lokal zu bauen, --allow-terminal für die Web-Konsole
```

Das Skript prüft Docker und Compose v2, legt `/opt/homelab` an, schreibt `/etc/homelab-agent/agent.env` (0600, enthält das Token) und startet `deploy/docker-compose.agent.yml` als `/etc/homelab-agent/docker-compose.yml`. Das Token wird nie als Argument angenommen (Shell-History, `ps`), sondern über `HZ_AGENT_TOKEN`, `--token-stdin` oder eine Eingabeaufforderung.

Beim ersten Verbinden tauscht der Agent das Einmal-Token gegen ein dauerhaftes Agent-Token und speichert es atomar in `/data/agent.json` (Volume `agent-data`, Modus 0600). Wird es in der Zentrale widerrufen, wartet der Agent 10 Min zwischen Versuchen. Mit einem neuen Enrollment-Token in `agent.env` (Skript erneut ausführen) meldet er sich neu an.

| Variable | Bedeutung |
| --- | --- |
| `HZ_CORE_URL` | `wss://…/agent`. `ws://` nur für Loopback (`127.0.0.0/8`, `::1`, `localhost`), Tailscale-IPs (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`), `*.ts.net` und **Hostnamen ohne Punkt** (MagicDNS-Kurznamen, z. B. `ws://heimserver/agent`). Jeder andere Hostname mit Punkt braucht `wss://`. Weil Kurznamen als MagicDNS gelten, darf die DNS-Suchdomain des Servers sie nicht auf Geräte außerhalb des Tailnets auflösen; im Zweifel `wss://heimserver.<tailnet>.ts.net/agent` verwenden. |
| `HZ_AGENT_TOKEN` | Enrollment-Token (erster Start) oder Agent-Token. |
| `HZ_AGENT_NAME` | Name des Servers, `a-z0-9-`. Muss bei „Neu starten“ zur Bestätigung eingegeben werden. |
| `HZ_AGENT_ALLOW_TERMINAL` | `1` erlaubt die Web-Konsole (PTY). Standard `0`: alle `pty.*` werden abgelehnt. |
| `HZ_AGENT_DATA` | Datenordner (`/data`). |
| `HZ_AGENT_HOST_EXEC` | `nsenter` (Image-Standard), `direct` (Agent direkt auf dem Host, Entwicklung), `none`. |

### Rechte des Containers

Alles, was nicht gebraucht wird, ist weg (`cap_drop: ALL`, schreibgeschütztes Dateisystem, `no-new-privileges`). Warum der Rest nötig ist, steht als Kommentar in `deploy/docker-compose.agent.yml`. Kurz:

- **Docker-Socket**: Container auflisten, starten, stoppen, Logs, Events, Image-Update und `docker compose`. Wer den Socket hat, ist faktisch root auf dem Host. Deshalb führt der Agent nur die Aktionen aus der Allowlist aus (`packages/shared/src/agent-protocol.ts`), mit festen Programmen und Argument-Arrays.
- **`pid: host`, `network_mode: host`, `/proc` und `/sys` lesend**: Messwerte, Ports und Netz des Hosts statt des Containers.
- **`user: 0:0` mit `SYS_ADMIN`, `SYS_PTRACE`, `SYS_CHROOT`** und `apparmor=unconfined`: `nsenter` in die Namespaces von Host-PID 1 und Lesen von `/host/proc/1/root`. Das Image selbst läuft standardmäßig als `node`; dann gibt es nur Messwerte.
- **`DAC_READ_SEARCH`**: `/var/log/auth.log` gehört `syslog:adm`.
- **`DAC_OVERRIDE`, `CHOWN`, `FOWNER`, `FSETID`, `SETUID`, `SETGID`**: `apt-get`/`dpkg` beim Aufräumen.
- **`NET_RAW`**: `check.ping`.
- **`/opt/homelab`** unter demselben Pfad: der einzige Ordner, in den Aktionen schreiben dürfen. Jeder Pfad wird mit `realpath` geprüft (Schutz gegen `..` und Symlinks).

### Wie der Agent den Host liest

| Wert | Quelle im Container |
| --- | --- |
| CPU, RAM, Swap, Uptime | `systeminformation` über `/proc/stat`, `/proc/meminfo`, `/proc/uptime`. Diese Dateien sind in Docker nicht namespaced, zeigen also den Host. |
| Temperatur | `systeminformation` über `/sys` (Host-sysfs), sonst `/sys/class/thermal/thermal_zone*/temp`. In VMs (Oracle) oft nicht vorhanden, dann `null`. |
| Disks | Mount-Tabelle von Host-PID 1 (`/host/proc/1/mounts`), `statfs` über `/host/proc/1/root/<mount>`. Ohne `SYS_PTRACE`/AppArmor-Freigabe nur die Mounts des Containers (ungenau). tmpfs, overlay, squashfs, Loop-Devices fallen weg. |
| Netz | `/host/proc/1/net/dev`, nur physische Interfaces (ohne lo, veth, docker, Bridges, tailscale). |
| Betriebssystem | `/etc/os-release` des Hosts über `/host/proc/1/root`. |
| Updates | `nsenter -t 1 … apt list --upgradable` auf dem Host. Sicherheitsupdates: Zeilen mit `-security`. Kein apt: `null`. Die Paketlisten aktualisiert der Host selbst (z. B. `unattended-upgrades`/`apt-daily.timer`), der Agent ruft kein `apt update` auf. |
| Neustart nötig | `/run/reboot-required` über `/host/proc/1/root`. |
| SSH-Fehlversuche 24 h | `nsenter … journalctl _COMM=sshd _COMM=sshd-session --since -24h -o json`, gezählt pro sshd-Prozess; sonst `/var/log/auth.log`. |
| fail2ban | `nsenter … fail2ban-client status` und pro Jail. Nicht installiert: `null`. |
| Ports | `ss -H -l -n -t -u -p` im Container (Host-Netz, mit `pid: host` auch Prozessnamen); sonst `/proc/net/{tcp,udp}{,6}` ohne Prozessnamen. |
| Container | Docker-API über den Socket. |

Jeder Teil schlägt weich fehl: Was nicht lesbar ist, kommt als `null` (bzw. leer) und lässt den Agent nicht abstürzen.

### Host-Kommandos über nsenter

Programme, die auf dem Host laufen müssen, startet der Agent mit

```
nsenter --target 1 --mount --uts --ipc --net --pid --cgroup -- <programm> <argumente…>
```

Damit laufen die Binaries und Dateien des Hosts, nicht die des Images. Erlaubt sind nur diese Programme (Allowlist in `apps/agent/src/exec.ts`), immer mit `execFile`, Argument-Array, Timeout und minimaler Umgebung (das Agent-Token wird nie an Kindprozesse vererbt):

| Aktion | Host-Kommando |
| --- | --- |
| Inventar | `apt list --upgradable`, `journalctl …`, `fail2ban-client status [jail]` |
| `system.cleanupPreview` | `apt-get -s -q autoremove --purge` (nur Simulation, für alte Kernel), `journalctl --disk-usage`; Größen von `/var/cache/apt`, `/lib/modules/<ver>`, `/boot/*-<ver>` werden direkt gelesen; Docker-Images und Build-Cache über die Docker-API |
| `system.cleanup` | `apt-get clean`, `apt-get -y -q purge -- <alte Kernel-Pakete>` (nie der laufende Kernel, die Liste berechnet der Agent selbst), `journalctl --vacuum-size=200M`, Docker: ungenutzte Images und Build-Cache löschen |
| `system.reboot` | `systemctl reboot`, 2 s nach der Antwort, nur wenn `confirmName` gleich `HZ_AGENT_NAME` ist |

### Container (M3)

Alles über die Docker-API am Socket, außer `compose.*`, das die Docker-CLI im Image ausführt.

| Teil | Wie |
| --- | --- |
| Inventar | `listContainers` bei jedem Inventar (60 s und nach Docker-Events). `inspect` (Startzeit, Neustarts, Exit-Code, Health) nur für neue oder geänderte Container: Cache, den Docker-Events leeren, spätestens nach 10 Min neu. Compose-Gruppe aus den Labels `com.docker.compose.project`, `…service`, `…project.working_dir` (→ `composeDir`). |
| CPU/RAM | One-Shot-Stats (`one-shot=true`, kein 2-s-Warten) höchstens alle ~60 s, 4 parallel, nur laufende Container. CPU % ist der Anteil am ganzen Host zwischen zwei Messungen (0–100, vergleichbar mit der Server-CPU; `docker stats` zeigt pro Kern). RAM wie `docker stats`: Nutzung minus `inactive_file`. Das erste Inventar hat noch keine CPU. |
| Docker-Events | `GET /events` (nur `type=container`), Reconnect mit Backoff. `start`, `stop`, `die` (mit Exit-Code), `restart`, `health_status`, `oom` gehen sofort als `event` an den Core; jede Änderung (auch `create`, `destroy`, `kill`, `pause`, `rename`) löst ein neues `inventory` aus, entprellt (1 s nach dem letzten Event, spätestens nach 5 s). `exec_*` (Healthchecks) wird ignoriert. Nach einem Reconnect kommt ein frisches Inventar. |
| `container.logs` | Stream (`stream.data`/`stream.end`, Stream-ID = RPC-ID). Zuerst kommt das `rpc.result`, dann die Daten. Docker-Multiplex (8-Byte-Header) wird in `stdout`/`stderr` getrennt, TTY-Container liefern rohe Bytes (`stdout`). UTF-8 wird über Frame-Grenzen korrekt dekodiert. Jeder Chunk besteht aus ganzen Zeilen (`zeile\n…`), höchstens 64 KiB (`MAX_CHUNK_CHARS`), Zeilen über 16 KiB werden geteilt, gebündelt für 50 ms. Bei `stream.cancel` oder Verbindungsverlust wird der Docker-Stream geschlossen. Ist der WebSocket-Puffer über 4 MiB, pausiert der Agent den Docker-Stream. Höchstens 16 Streams gleichzeitig. |
| `container.update` | Nur Container **ohne** Compose-Label (sonst `invalid_params`: „compose.pull + compose.up“) und nur mit Image-Tag (nicht mit nackter Image-ID). Ablauf: `inspect` → `pull` (schlägt der Pull fehl, z. B. bei einem nur lokalen Tag, wird ein neueres lokales Image mit diesem Tag verwendet) → alten Container in `<name>-hz-old-<zeit>` umbenennen → neuen mit gleichem Namen und gleicher Konfiguration anlegen (HostConfig, Env, Labels, Ports, Netzwerke mit Aliasen; Werte, die nur aus dem alten Image kamen, werden weggelassen, damit die Vorgaben des neuen Images gelten; anonyme Volumes werden übernommen) → weitere Netzwerke verbinden → alten stoppen → neuen starten → nach 3 s prüfen, dass er läuft → alten entfernen (Volumes bleiben). Schlägt ein Schritt nach dem Umbenennen fehl, wird zurückgerollt: neuer Container weg, alter bekommt seinen Namen zurück und startet wieder. Solange das Update läuft, ist der alte Container im Inventar und in den Events ausgeblendet. Eine Aktion pro Container gleichzeitig (`busy`). |
| `compose.pull` / `up` / `down` | `DOCKER_HOST=unix://<socket> docker compose --ansi never --project-directory <dir> -f <datei> pull --quiet` bzw. `up -d --remove-orphans` bzw. `down --remove-orphans` (Volumes bleiben). `<dir>` ist mit `realpath` geprüft und liegt unter `/opt/homelab/`; die Compose-Datei (`compose.yml`, `compose.yaml`, `docker-compose.yml`, `docker-compose.yaml`) wird ebenfalls mit `realpath` geprüft und muss eine normale Datei unter `/opt/homelab/` sein (ein Symlink nach draußen wird abgelehnt). Kindprozesse bekommen nur `PATH`, `LANG`, `LC_ALL`, `DEBIAN_FRONTEND`, `DOCKER_HOST` und `DOCKER_CONFIG=/tmp/.docker`. Zeitlimits: pull 15 Min, up 10 Min, down 5 Min. Eine Compose-Aktion pro Ordner gleichzeitig. |
| `compose.write` | Dateinamen nach `fileNameSchema` (kein `/`, kein `..`, keine Punktdateien, max. 100 Zeichen, 1–20 Dateien, je max. 256 KiB). Der Ordner wird angelegt (0750) und danach noch einmal mit `realpath` geprüft. Jede Datei wird atomar geschrieben: exklusive Temp-Datei im selben Ordner (`O_EXCL`, folgt keinem Symlink), `fsync`, `rename`. Ein vorhandener Symlink am Ziel wird ersetzt, nicht beschrieben. Modus 0640. |

**Docker-CLI im Image:** `docker` und das Compose-Plugin kommen als statische Binaries aus dem offiziellen Multi-Arch-Image `docker:29-cli` (per Digest gepinnt, `linux/amd64` und `linux/arm64`), ohne apt-Repository. `docker` steht in der Programm-Allowlist (`apps/agent/src/exec.ts`) und wird nur von `actions/compose.ts` mit festen Argumenten aufgerufen.

### Prüfen

```bash
docker logs -f homelab-agent        # JSON-Zeilen, ohne Tokens
pnpm exec tsx test/docker/agent-smoke.ts   # Core + Agent als Container, Enrollment, Container, Offline-Meldung
```

## Share-Gateway auf oracle-a1

Optional und standardmäßig aus. Ohne Gateway funktionieren Benutzerlinks nur im Tailnet (`https://heimserver.<tailnet>.ts.net/s/<token>`). Mit Gateway können Freunde ohne Tailscale einen einzelnen Gameserver über einen öffentlichen DDNS-Namen steuern. **Der Core bleibt dabei nicht öffentlich**: Öffentlich ist nur `oracle-a1` mit Caddy und dem kleinen Gateway (`apps/share`), das über Tailscale ausschließlich mit `/api/share-gateway/*` des Core spricht.

```
Freund ── HTTPS ──▶ Caddy (oracle-a1, :443) ──▶ Gateway 127.0.0.1:8090 ── Tailscale ──▶ Core /api/share-gateway/*
```

### Schritte

1. **DDNS-Name**: kostenlos z. B. bei DuckDNS einen Namen anlegen (`spiel.example.duckdns.org`) und auf die öffentliche IPv4 von `oracle-a1` zeigen lassen.
2. **Oracle Security List**: in der Oracle-Cloud-Konsole (VCN → Subnetz → Security List) eingehend TCP **80** und **443** von `0.0.0.0/0` erlauben. Port 80 braucht Caddy nur für das Let's-Encrypt-Zertifikat und die Weiterleitung auf HTTPS. Sonst nichts öffnen, vor allem nicht 8090.
3. **iptables auf der VM** (Oracle-Ubuntu-Images blocken alles außer 22):
   ```bash
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   ```
4. **Caddy installieren** (offizielles Paket, Debian/Ubuntu):
   ```bash
   sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
   sudo apt update && sudo apt install -y caddy
   ```
   Dann `deploy/Caddyfile.share` nach `/etc/caddy/Caddyfile` kopieren, `spiel.example.duckdns.org` durch den eigenen Namen ersetzen und `sudo systemctl reload caddy`. Caddy leitet nur `/s/*` weiter, alles andere ist 404. Das Zugriffslog enthält keine URIs (dort stünde das Token).
5. **Gateway-Token**: in der Zentrale unter Einstellungen → Share-Gateway „Token erzeugen“ (mit Step-up). Das Token wird nur einmal angezeigt; ein neues macht das alte sofort ungültig.
6. **Umgebung** auf `oracle-a1` anlegen (nie ins Repo):
   ```bash
   sudo install -d -m 0700 /etc/homelab-share
   sudo install -m 0600 /dev/null /etc/homelab-share/share.env
   sudoedit /etc/homelab-share/share.env
   ```
   ```
   HZ_SHARE_CORE_URL=https://heimserver.<tailnet>.ts.net
   HZ_SHARE_GATEWAY_TOKEN=<Token aus Schritt 5>
   ```
   `HZ_SHARE_CORE_URL` ist die `ts.net`-Adresse des Core (dieselbe wie im Browser). Tailscale läuft auf `oracle-a1` bereits (für den Agent), dadurch ist der Core von dort erreichbar. Erlaubt sind nur `https://<name>.ts.net` und für Tests `http://127.0.0.1`.
7. **Starten**, in einem Checkout dieses Repos auf `oracle-a1`:
   ```bash
   docker compose -f deploy/docker-compose.share.yml up -d --build
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8090/s/$(printf 'a%.0s' $(seq 43))   # 200
   ```
8. **In der Zentrale einschalten**: Einstellungen → Share-Gateway, „Aktiv“ und die öffentliche Adresse `https://spiel.example.duckdns.org` eintragen. Erst dann nimmt der Core Anfragen des Gateways an, und neue Benutzerlinks bekommen zusätzlich den öffentlichen Link. Ausschalten sperrt das Gateway sofort.

### Was das Gateway tut

| Teil | Verhalten |
| --- | --- |
| Routen | `GET /s/<token>` (Seite, für jedes gültig geformte Token gleich), `GET /s/assets/<datei>` (nur Dateien aus dem UI-Build, beim Start in den Speicher geladen, feste MIME-Liste), `GET /s/api/status`, `POST /s/api/action`, `GET /s/api/console?after=`, `POST /s/api/console`, `POST /s/api/whitelist`. Alles andere ist 404, auch `/`, `/api` und `/admin`. |
| Weiterleitung | An `<HZ_SHARE_CORE_URL>/api/share-gateway/<gleicher Name>` mit `Authorization: Bearer <Gateway-Token>`, dem Freundes-Token als `X-Share-Token`, der PIN als `X-Share-Pin` (genau 4 Ziffern) und der Client-IP als `X-Share-Client-Ip`. Andere Header (Cookies, Origin …) gehen nicht weiter. Bodys höchstens 4 KB, nur JSON, mit den Schemas aus `packages/shared` geprüft und neu serialisiert. Zeitlimit 10 s, keine Redirects. |
| Antworten | Nur was den strikten Schemas entspricht (`packages/shared/src/api/share.ts`); zusätzliche Felder, unbekannte Statuscodes oder eine Tailscale-Adresse (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`, `*.ts.net`) im Status ergeben 502 `{"ok":false,"error":"unavailable"}`. In Konsolen- und Befehlsausgaben (freier Spieltext) werden solche Adressen durch `[intern]` ersetzt. Header des Core werden nie weitergegeben. |
| Rate-Limits | Pro IP (IPv6 pro /64) und Minute: **10** API-Anfragen (`/s/api/*`, auch unbekannte Pfade), **30** Konsolen-Abfragen (`GET /s/api/console`, die Seite fragt alle 3 s nach, das wären 20/min und würde die 10 sofort aufbrauchen), **120** Seiten- und Asset-Abrufe; insgesamt höchstens 600 API-Anfragen pro Minute. Danach 429 mit `Retry-After`. Die Tabellen sind auf 10 000 Einträge begrenzt. Die PIN-Sperre (5 Fehlversuche → 15 Min) macht der Core. |
| Client-IP | Nur wenn die Verbindung von Loopback kommt (Caddy), gilt der **letzte** Eintrag von `X-Forwarded-For`; sonst die Socket-Adresse. |
| Header | Strenge CSP (`default-src 'self'`, kein Inline-Script, `frame-ancestors 'none'`), HSTS, `nosniff`, `no-referrer`, `X-Robots-Tag: noindex`; HTML und API mit `no-store`. |
| Logs | JSON-Zeilen auf stderr, nur Methode, Routenname (`/s/:token`), Status, Dauer, IP. Nie Tokens, PINs, Header oder die rohe URL. |

Der Container läuft als `node`, mit schreibgeschütztem Dateisystem, `cap_drop: ALL`, `no-new-privileges`, im Host-Netz nur auf `127.0.0.1:8090`. Das Image (`deploy/Dockerfile.share`) gibt es für `linux/amd64` und `linux/arm64` (Oracle A1 ist ARM).
