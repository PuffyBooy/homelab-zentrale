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
| `HZ_CORE_URL` | `wss://…/agent`. `ws://` nur für Loopback und Tailnet-Adressen (100.64.0.0/10, MagicDNS, `*.ts.net`). |
| `HZ_AGENT_TOKEN` | Enrollment-Token (erster Start) oder Agent-Token. |
| `HZ_AGENT_NAME` | Name des Servers, `a-z0-9-`. Muss bei „Neu starten“ zur Bestätigung eingegeben werden. |
| `HZ_AGENT_ALLOW_TERMINAL` | `1` erlaubt die Web-Konsole (PTY). Standard `0`: alle `pty.*` werden abgelehnt. |
| `HZ_AGENT_DATA` | Datenordner (`/data`). |
| `HZ_AGENT_HOST_EXEC` | `nsenter` (Image-Standard), `direct` (Agent direkt auf dem Host, Entwicklung), `none`. |

### Rechte des Containers

Alles, was nicht gebraucht wird, ist weg (`cap_drop: ALL`, schreibgeschütztes Dateisystem, `no-new-privileges`). Warum der Rest nötig ist, steht als Kommentar in `deploy/docker-compose.agent.yml`. Kurz:

- **Docker-Socket**: Container auflisten, starten, stoppen. Wer den Socket hat, ist faktisch root auf dem Host. Deshalb führt der Agent nur die Aktionen aus der Allowlist aus (`packages/shared/src/agent-protocol.ts`), mit festen Programmen und Argument-Arrays.
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

### Prüfen

```bash
docker logs -f homelab-agent        # JSON-Zeilen, ohne Tokens
pnpm exec tsx test/docker/agent-smoke.ts   # Core + Agent als Container, Enrollment, Offline-Meldung
```
