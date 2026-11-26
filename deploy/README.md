# Deploy

## Images (GHCR)

Die Images baut `.github/workflows/images.yml` nach jedem grünen CI-Lauf auf `main` und bei jedem Tag `v*`, für `linux/amd64` und `linux/arm64` (viele Cloud-VMs und der Raspberry Pi sind ARM), und legt sie in der GitHub Container Registry ab:

| Image | Dockerfile |
| --- | --- |
| `ghcr.io/puffybooy/homelab-agent` | `apps/agent/Dockerfile` |
| `ghcr.io/puffybooy/homelab-core` | `deploy/Dockerfile.core` |
| `ghcr.io/puffybooy/homelab-share` | `deploy/Dockerfile.share` |

Tags: `latest` und `sha-<kurz>` (Push auf `main`), `v<version>` und `sha-<kurz>` (Git-Tag). Jedes Image trägt OCI-Labels (`org.opencontainers.image.source` zeigt auf das Repo, dazu `revision`, `version`, `created`). Die Compose-Dateien verwenden standardmäßig `:latest`; für einen festen Stand die Variable setzen, z. B. `HZ_CORE_IMAGE=ghcr.io/puffybooy/homelab-core:sha-1a2b3c4` (Agent: `HZ_AGENT_IMAGE`, Share: `HZ_SHARE_IMAGE`). Solange das Repo bzw. die Packages privat sind, braucht `docker pull` vorher `docker login ghcr.io` mit einem Token mit `read:packages`.

**Lokal bauen statt laden:** Zu jeder Compose-Datei gibt es eine Override-Datei `docker-compose.<dienst>.build.yml`, die das Image aus dem Checkout baut (`homelab-zentrale/<dienst>:local`, `pull_policy: build`). Der Agent-Installer baut mit `--build-local` oder `HZ_BUILD_LOCAL=1`.

## Core (Heimserver)

Ein Image: Der Core liefert die gebaute Web-App mit aus.

**Am einfachsten mit dem Installer:** `sudo ./deploy/install.sh` richtet alles ein (Docker, Tailscale, `/etc/homelab-zentrale/core.env` mit 0600, Image, Compose, `tailscale serve`, Health-Check, erster Login). Update, Status und Entfernen über dieselbe Datei, das Share-Gateway mit `sudo ./deploy/install.sh share`. Siehe [`docs/INSTALL.md`](../docs/INSTALL.md). Von Hand geht es so:

```bash
cp .env.example .env            # HZ_SECRET_KEY setzen: openssl rand -base64 32
docker compose -f deploy/docker-compose.core.yml up -d     # Image aus GHCR
# oder lokal bauen:
docker compose -f deploy/docker-compose.core.yml -f deploy/docker-compose.core.build.yml up -d --build
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
# optional: --allow-terminal für die Web-Konsole
#           --image ghcr.io/puffybooy/homelab-agent:sha-<kurz>   fester Stand statt :latest
#           --build-local (oder HZ_BUILD_LOCAL=1)                 Image aus dem Checkout bauen
#           --smart       SMART-Werte der Platten lesen (NAS, auf UGREEN automatisch)
```

Standardmäßig lädt das Skript `ghcr.io/puffybooy/homelab-agent:latest` (passend zur Architektur des Servers) und startet es. `--image` und `--build-local` schließen sich aus. Ein erneuter Aufruf ohne `--image` setzt das Image wieder auf `:latest` und zieht es neu (Update).

Das Skript prüft Docker und Compose v2, legt `/opt/homelab` an, schreibt `/etc/homelab-agent/agent.env` (0600, enthält das Token) und startet `deploy/docker-compose.agent.yml` als `/etc/homelab-agent/docker-compose.yml`. Das Token wird nie als Argument angenommen (Shell-History, `ps`), sondern über `HZ_AGENT_TOKEN`, `--token-stdin` oder eine Eingabeaufforderung.

Beim ersten Verbinden tauscht der Agent das Einmal-Token gegen ein dauerhaftes Agent-Token und speichert es atomar in `/data/agent.json` (Volume `agent-data`, Modus 0600). Wird es in der Zentrale widerrufen, wartet der Agent 10 Min zwischen Versuchen. Mit einem neuen Enrollment-Token in `agent.env` (Skript erneut ausführen) meldet er sich neu an.

| Variable | Bedeutung |
| --- | --- |
| `HZ_CORE_URL` | `wss://…/agent`. `ws://` nur für Loopback (`127.0.0.0/8`, `::1`, `localhost`), Tailscale-IPs (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`), `*.ts.net` und **Hostnamen ohne Punkt** (MagicDNS-Kurznamen, z. B. `ws://heimserver/agent`). Jeder andere Hostname mit Punkt braucht `wss://`. Weil Kurznamen als MagicDNS gelten, darf die DNS-Suchdomain des Servers sie nicht auf Geräte außerhalb des Tailnets auflösen; im Zweifel `wss://heimserver.<tailnet>.ts.net/agent` verwenden. |
| `HZ_AGENT_TOKEN` | Enrollment-Token (erster Start) oder Agent-Token. |
| `HZ_AGENT_NAME` | Name des Servers, `a-z0-9-`. Muss bei „Neu starten“ zur Bestätigung eingegeben werden. |
| `HZ_AGENT_ALLOW_TERMINAL` | `1` erlaubt die Web-Konsole (PTY). Standard `0`: alle `pty.*` werden abgelehnt. |
| `HZ_AGENT_ALLOW_RELAY` | `1` macht den Server zum Game-Eingang (M15, `install-agent.sh --allow-relay`, aus mit `--no-relay`): der Agent nimmt die Spielports (ab 1024) an und leitet TCP/UDP über Tailscale zum Server des Spiels. **Nur am Eingang** setzen (öffentliche IPv4, Portbereich in der Anbieter-Firewall offen), nie am Heimserver. Standard `0`: `relay.set` wird abgelehnt. |
| `HZ_AGENT_SMART` | `1` liest SMART der Platten (M13). Setzt das Override `docker-compose.agent.smart.yml`, nicht von Hand: es bringt auch die nötigen Rechte. |
| `HZ_AGENT_DATA` | Datenordner (`/data`). |
| `HZ_AGENT_TRIVY_IMAGE` | Scanner für `image.scan` (Schwachstellen-Scan). Nur mit Digest (`repo[:tag]@sha256:…`), sonst nimmt der Agent den eingebauten Standard (`TRIVY_IMAGE_DEFAULT`) und schreibt eine Warnung ins Log. Der Scanner läuft als eigener Container ohne Docker-Socket und ohne Host-Pfade (read-only, `--cap-drop ALL`, 1 GB RAM, 256 PIDs), holt das Image selbst aus der Registry und legt seine Datenbank im Docker-Volume `hz-trivy-cache` ab (wird beim ersten Scan angelegt, löschen mit `docker volume rm hz-trivy-cache`). |
| `HZ_AGENT_HOST_EXEC` | `nsenter` (Image-Standard), `direct` (Agent direkt auf dem Host, Entwicklung), `none`. |
| `HZ_AGENT_SERVICES` | M16: systemd-Dienste, die die Zentrale starten, stoppen und neu starten darf, durch Komma getrennt, z. B. `nginx.service,smbd`. Ohne Endung wird `.service` ergänzt. Leer (Standard): nur Anzeige. Ungültige Namen und Dienste der festen Sperrliste (`tailscaled`, `docker`, `containerd`, `ssh`/`sshd`, `dbus`, `systemd-*`, `networking`, `NetworkManager`, `getty` …) ignoriert der Agent mit einer Warnung im Log, egal was hier steht. |

### NAS und SMART (M13)

Ein NAS bindest du wie jeden Server an. Für ein **UGREEN NASync** (UGOS Pro):

1. UGOS: Systemsteuerung → Terminal → SSH einschalten; Docker aus dem App Center; Tailscale aufs NAS (App Center oder Container mit `network_mode: host`).
2. Zentrale: „Server hinzufügen“, den Einzeiler per SSH als root am NAS ausführen. Auf UGREEN-Hardware (DMI-Hersteller `UGREEN`) schaltet er SMART selbst ein, sonst `--smart` anhängen: `curl -fsSL https://<zentrale>/install.sh | sudo sh -s -- <code> --smart`.

Mit SMART startet zusätzlich `docker-compose.agent.smart.yml` (in `/etc/homelab-agent/` als `docker-compose.smart.yml`, eingetragen über `COMPOSE_FILE` in `.env`). Es gibt dem Agent **nur Lesezugriff** auf die Blockgeräte der Platten (`device_cgroup_rules` mit `r`, Major 8, 65–71, 128–135, 259) und `CAP_SYS_RAWIO` für ATA-Pass-through. Der Agent ruft `smartctl --json --info --health --attributes --nocheck=standby,0` auf, höchstens alle 10 Min pro Platte; schlafende Platten bleiben schlafen. Ohne Override zeigt die Zentrale RAID, Volumes und Platten, aber keine SMART-Werte.

RAID kommt aus `/proc/mdstat`, Volumes aus der Mount-Tabelle des Hosts, Platten aus `/sys/block` (USB-Sticks und andere Wechselmedien nicht). Die Zentrale ändert nichts an RAID oder Platten.

Gameserver auf dem NAS: `/opt/homelab` liegt bei UGOS auf dem kleinen Systemvolume. Wer Spiele dort laufen lassen will, legt `/volume1/homelab` an und mountet es per Bind-Mount auf `/opt/homelab`, bevor der Agent startet.

### Rechte des Containers

Alles, was nicht gebraucht wird, ist weg (`cap_drop: ALL`, schreibgeschütztes Dateisystem, `no-new-privileges`). Warum der Rest nötig ist, steht als Kommentar in `deploy/docker-compose.agent.yml`. Kurz:

- **Docker-Socket**: Container auflisten, starten, stoppen, Logs, Events, Image-Update und `docker compose`. Wer den Socket hat, ist faktisch root auf dem Host. Deshalb führt der Agent nur die Aktionen aus der Allowlist aus (`packages/shared/src/agent-protocol.ts`), mit festen Programmen und Argument-Arrays.
- **`pid: host`, `network_mode: host`, `/proc` und `/sys` lesend**: Messwerte, Ports und Netz des Hosts statt des Containers.
  Wake-on-LAN (`wol.send`) braucht das Host-Netz: Das Magic Packet geht als UDP-Broadcast (Port 7 oder 9) ins lokale Netz des Servers, höchstens 6 pro Minute. Ohne `network_mode: host` landet es nur im Docker-Bridge-Netz.
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
| `system.shutdown` (M16) | `systemctl poweroff`, sonst wie `system.reboot`. Der Server bleibt aus, bis ihn jemand einschaltet (oder Wake-on-LAN). |
| `system.cleanup { items }` (M16) | wie oben, aber nur die gewählten Arten (`apt-cache`, `old-kernels`, `journal`, `docker-images`, `docker-build-cache`); ohne `items` alles. Container und Volumes löscht der Agent nie. |
| `system.du` (M16) | `du -x -a -B1 -d1 -0 -- <ordner>`, nur lesend, 60 s Zeitlimit, 8 MiB Ausgabe. Der Pfad wird im Agent **innerhalb des Host-Dateisystems** aufgelöst (jeder Symlink einzeln mit `lstat`/`readlink` unter `/host/proc/1/root`, absolute Ziele beginnen wieder beim Host-`/`) und danach noch einmal gegen `/proc`, `/sys`, `/dev`, `/run` und Pseudo-Dateisysteme (proc, sysfs, cgroup, debugfs …) geprüft. Höchstens 30 Einträge, größte zuerst. |
| `system.services` / `system.service` (M16) | `systemctl list-units --type=service --all --no-legend --plain --no-pager`; `systemctl <start\|stop\|restart> --no-ask-password -- <unit>` (60 s) nur für Units aus `HZ_AGENT_SERVICES`, nie aus der Sperrliste. Vorher löst der Agent den echten Namen mit `systemctl show -p Id --value -- <unit>` auf und prüft auch ihn gegen die Sperrliste (ein Alias wie `dbus-org.freedesktop.network1.service` → `systemd-networkd.service` wird abgelehnt). Eine Ablehnung geht als `denied` an den Core. Das Inventar enthält `failedServices` aus `systemctl list-units --type=service --state=failed …`. |
| `system.processes` (M16) | kein Programm: `/proc/<pid>/stat`, `status`, `cgroup` direkt (mit `pid: host` die des Hosts), zwei Messungen im Abstand von 0,5 s. Nur der Prozessname (`comm`), **nie** `/proc/<pid>/cmdline` oder die Umgebung. Benutzername aus der `/etc/passwd` des Hosts, Container aus der cgroup. |
| `system.upgrade` (M17) | `apt-get update -q`, dann `apt-get -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade` mit `DEBIAN_FRONTEND=noninteractive`. Feste Argumente, kein `dist-upgrade`, keine Entfernungen, geänderte Konfigurationsdateien bleiben. Bis zu 40 Min. Nur auf apt-Hosts; nie gleichzeitig mit `system.cleanup`. Mit systemd läuft apt in einer eigenen, kurzlebigen Unit (`systemd-run --unit=hz-upgrade-<zufall> --collect --wait --quiet --service-type=exec --property=StandardOutput=file:/run/hz-upgrade-<zufall>.log … -- /usr/bin/apt-get …`), also außerhalb der cgroup des Agents: Startet das Upgrade Docker, containerd oder tailscaled neu (und damit den Agent), läuft dpkg trotzdem zu Ende. Nach 40 Min hört der Agent auf zu warten, beendet die Unit aber nicht. Ohne systemd oder `systemd-run` wie bisher direkt. |

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

### Web-Konsole einschalten

Die Web-Konsole ist pro Server **aus**. Sie braucht zwei Schalter, die beide an sein müssen:

1. **Auf dem Server:** In `/etc/homelab-agent/agent.env` `HZ_AGENT_ALLOW_TERMINAL=1` setzen (oder `install-agent.sh` mit `--allow-terminal` erneut ausführen) und den Agent neu starten:

   ```bash
   sudo sed -i 's/^HZ_AGENT_ALLOW_TERMINAL=.*/HZ_AGENT_ALLOW_TERMINAL=1/' /etc/homelab-agent/agent.env
   cd /etc/homelab-agent && sudo docker compose up -d --no-build --force-recreate agent
   ```

   Der Agent liest den Wert nur beim Start und meldet ihn im `hello` als Fähigkeit `terminal`. Ohne den Schalter lehnt er jedes `pty.*` mit `terminal_disabled` ab (und meldet die Ablehnung als `denied`), egal was der Core schickt. node-pty wird erst beim ersten Öffnen geladen.
2. **In der Zentrale:** Server → Einstellungen → „Konsole erlaubt“ einschalten. Das verlangt eine Step-up-Bestätigung (Passwort + TOTP); jedes Öffnen der Konsole ebenfalls.

Zum Ausschalten `HZ_AGENT_ALLOW_TERMINAL=0` setzen und den Agent neu starten, oder den Schalter in der Zentrale ausschalten.

**Was die Konsole ist:** eine Login-Shell **auf dem Host**, nicht im Agent-Container:

```
nsenter --target 1 --mount --uts --ipc --net --pid --cgroup --wd=/host/proc/1/root/root -- /bin/bash -l
```

(`/bin/sh -l`, wenn es kein `bash` gibt; ohne `/root` startet sie in `/`). Festes Argument-Array, kein `sh -c`. Umgebung nur `TERM=xterm-256color`, `COLORTERM`, `LANG=C.UTF-8`, `HOME=/root`, `USER`/`LOGNAME=root`, `PATH`; das Agent-Token erreicht die Shell nie. Sie braucht keine Rechte über die vorhandenen hinaus (`pid: host`, `SYS_ADMIN`/`SYS_PTRACE`/`SYS_CHROOT`, `apparmor=unconfined` für nsenter).

| Grenze | Wert |
| --- | --- |
| Gleichzeitige Konsolen pro Server | 3 (sonst `busy`) |
| Ohne Eingabe | 15 Min, dann wird die Sitzung beendet (`stream.end` mit `error: "idle_timeout"`) |
| Insgesamt | 60 Min (`error: "max_duration"`) |
| Eingabe pro Nachricht | 16 KiB |
| Ausgabe | UTF-8-Text als `stream.data`, 16 ms gebündelt, höchstens 64 KiB pro Chunk; ist der WebSocket-Puffer über 4 MiB, pausiert der Agent das PTY |

Der Core setzt dieselben Zeitgrenzen; die des Agents sind die zweite Sicherung. Bei „Schließen“, Zeitablauf, `stream.cancel` und Verbindungsabbruch zum Core bekommt jeder Prozess der Sitzung (auch Hintergrundjobs) `SIGHUP`, nach 2 s `SIGKILL`. Nur Prozesse, die sich mit `setsid`/`nohup … &` und `disown` bewusst abgelöst haben, laufen weiter. Im Log stehen Öffnen und Schließen mit Stream-ID, Grund, Dauer und Byte-Zahlen, **nie Eingaben oder Ausgaben**.

**Risiken:**

- Wer die Konsole öffnen kann, ist root auf dem Host. Der Schutz ist die Admin-Session mit Step-up im Core plus der Schalter auf dem Server. Nur auf Servern einschalten, auf denen sie gebraucht wird, und danach wieder aus.
- Die Shell erbt die Capability-Grenze und `no-new-privileges` des Containers: kein `CAP_KILL` (Prozesse anderer Benutzer beenden), kein `NET_ADMIN`, `SYS_MODULE`, `SYS_BOOT`, `SYS_TIME`; setuid-Programme (`sudo`, `su` zu anderen Benutzern) bekommen keine zusätzlichen Rechte. `apt`, `systemctl`, `journalctl`, Dateien bearbeiten funktionieren. Für alles andere SSH über Tailscale. Die Rechte des Agents werden für die Konsole nicht erweitert.
- Das PTY gehört zum Container (`/dev/pts` des Containers). Programme, die ihr Terminal über den Pfad neu öffnen (selten), finden es auf dem Host nicht; `/dev/tty` funktioniert.
- Alles, was in der Konsole getippt wird, geht als Text über den Agent-WebSocket (Tailscale verschlüsselt ihn). Passwörter tippen ist möglich, aber in der Zentrale gibt es keinen Mitschnitt.

### Prüfen

### Auto-Update (M17)

Die Zentrale stößt Updates an (Wartungsfenster pro Server). Der Agent zieht dabei **immer nur den Tag, den der Container schon nutzt** (`Config.Image`, z. B. `ghcr.io/puffybooy/homelab-agent:latest`), nie ein Image aus der Anfrage. Läuft ein Container mit nackter Image-ID oder schlägt der Pull fehl (privates Registry ohne Login, nur lokaler Tag aus `--build-local`), meldet `update.check` `pulled: false` und `update.apply` `failed`.

| Ziel | Ablauf |
| --- | --- |
| `core` | Nur auf dem Server, auf dem ein Container mit Label `hz.role=core` läuft. Der Agent dieses Servers zieht das Image, benennt den Core-Container um, legt einen neuen mit gleicher Konfiguration an (Volumes, Labels inklusive Compose-Labels, Netz), stoppt den alten, startet den neuen und wartet bis zu 3 Min auf den Docker-Health-Check (`/api/health`). Erst dann wird der alte entfernt; sonst kommt der alte zurück (`rolled_back`). |
| `agent` | Der Agent kann sich nicht selbst ersetzen. Er startet einen kurzlebigen **Helfer-Container** aus seinem **aktuellen** Image (Label `hz.role=updater`, Befehl `node dist/updater.js`), der den Agent-Container genauso tauscht und bis zu 3 Min wartet, bis der neue Agent „healthy“ ist. Healthy heißt: mit dem Core verbunden (der Agent legt `/tmp/hz-connected` beim `welcome` an und löscht sie beim Trennen; der `HEALTHCHECK` im Image prüft nur diese Datei). Sonst Rollback auf den alten Container. |

**Warum der Helfer den Docker-Socket braucht:** Er muss den Agent-Container umbenennen, neu anlegen, stoppen, starten und entfernen; das geht nur über die Docker-API. Der Socket ist wie beim Agent selbst gleichbedeutend mit root auf dem Host. Darüber hinaus bekommt der Helfer nichts: nur zwei Mounts (Docker-Socket und das Datenvolume `agent-data` für die Ergebnisdatei), kein Netz (`network_mode: none`, der Socket ist ein Unix-Socket), schreibgeschütztes Dateisystem, `cap_drop: ALL`, `no-new-privileges`, nicht privilegiert, 256 MB RAM, 64 Prozesse. Er läuft als Besitzer von `/data` mit der Gruppe des Sockets (keine Capability nötig). Wie Core und Agent ist er geschützt: `container.*` lehnt `hz.role=updater` ab.

**Absturzsicher:** Vor jedem Schritt (umbenennen, anlegen, stoppen, starten) schreibt der Helfer ein kleines Journal nach `/data/update-journal-<runId>.json`. Stirbt er mittendrin, startet Docker ihn neu (`restart: on-failure`, höchstens 3-mal, statt `AutoRemove`). Er behält dann den neuen Agent, wenn der healthy wird, sonst bekommt der alte seinen Namen zurück und startet wieder. Ist der Helfer endgültig weg, erledigt das der Agent, der danach läuft, nach seinem `welcome` (der neue entfernt den alten Container, der alte den neuen). Ein Core-Update journalisiert der Agent genauso und räumt es beim nächsten Start auf, bevor er sich verbindet (der Core ist dann vielleicht gerade aus). Beendete Helfer-Container und erledigte Journale entfernt der Agent nach dem Senden des Ergebnisses. Umbenannte `<name>-hz-old-*`-Container werden nur nach einem erfolgreichen Update gelöscht.

Das Ergebnis (`update_result`) schreibt der Agent bzw. der Helfer zuerst atomar nach `/data/update-result-<runId>.json` und sendet es dann; die Datei wird erst nach dem Senden gelöscht. So kommt es auch an, wenn der Core gerade neu startet oder der Agent ausgetauscht wurde (der neue bzw. wiederhergestellte Agent schickt es nach seinem `welcome`, verbunden prüft er alle 15 s).

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
7. **Starten**, in einem Checkout dieses Repos auf `oracle-a1` (Image aus GHCR; lokal bauen mit zusätzlich `-f deploy/docker-compose.share.build.yml … --build`):
   ```bash
   docker compose -f deploy/docker-compose.share.yml up -d
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

### Grenzen

- Das Gateway lässt insgesamt höchstens 600 API-Anfragen pro Minute durch (über alle IPs). Wer viele IPv6-Netze hat, kann diese Grenze ausschöpfen; dann sind die Links für alle Freunde kurz gesperrt (nur Ausfall, kein Zugriff). Abhilfe bei Bedarf: Gateway ausschalten oder in Caddy zusätzliche Limits setzen.
- Im Tailnet zählt der Core das IP-Limit nach der Adresse, die `tailscale serve` meldet. Zusätzlich gilt immer das Limit pro Link (20 Anfragen pro Minute, Konsole 60).
