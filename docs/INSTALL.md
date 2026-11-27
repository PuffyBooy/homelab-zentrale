# Installieren

Ein Skript richtet die ganze Zentrale auf einem frischen Server ein: `deploy/install.sh`. Es fragt nur das Nötigste, merkt sich alles und kann beliebig oft laufen (idempotent).

## Voraussetzungen

- Linux-Server, am einfachsten Debian, Ubuntu oder Raspberry Pi OS (64 Bit). Docker und Tailscale installiert das Skript dort selbst, auf anderen Systemen vorher von Hand.
- Ein Tailscale-Konto. In der [Tailscale-Admin-Konsole unter DNS](https://login.tailscale.com/admin/dns) **MagicDNS** und **HTTPS Certificates** einschalten, sonst gibt es keine `https://<name>.ts.net`-Adresse.
- `git`, um das Repo zu holen (`sudo apt install -y git`).

## In 3 Schritten

```bash
git clone https://github.com/PuffyBooy/homelab-zentrale.git
cd homelab-zentrale
sudo ./deploy/install.sh
```

Der Assistent macht dann:

1. **Docker** prüfen, sonst aus dem offiziellen Repository installieren (mit Compose v2).
2. **Tailscale** prüfen, sonst installieren und anmelden (`tailscale up` zeigt einen Link zum Bestätigen).
3. **Konfiguration** in `/etc/homelab-zentrale/core.env` schreiben (Ordner 0700, Datei 0600, nur root):
   - `HZ_SECRET_KEY`: 32 zufällige Byte, nur beim ersten Mal. Er wird nie überschrieben.
   - `HZ_BASE_URL`: automatisch aus `tailscale status`, z. B. `https://heimserver.<tailnet>.ts.net`.
   - `HZ_TIMEZONE`: Zeitzone des Servers (Standard `Europe/Vienna`).
   - `HZ_INITIAL_MODULES`: welche Module beim ersten Start an sind (GitHub, Home Assistant, Gameserver, NAS und Speicher). Gilt nur bis zum ersten Login, danach entscheidet Einstellungen → Module.
4. **Image** fertig aus der GitHub Container Registry laden oder auf Wunsch lokal aus dem Checkout bauen (`--build-local`, dann braucht die Zentrale GitHub gar nicht).
5. **Starten** mit Docker Compose. Der Core lauscht nur auf `127.0.0.1:8080`.
6. **Health-Check** auf `/api/health`.
7. **Freigabe im Tailnet** mit `tailscale serve --bg --https=443 http://127.0.0.1:8080`. Ist `tailscale funnel` auf Port 443 an, schaltet das Skript es aus. Die Zentrale ist nie öffentlich.
8. **Erster Login**: Das Skript zeigt den Einmal-Link `https://…/setup#token=…`. Dort Passwort setzen, den QR-Code mit einer Authenticator-App scannen (TOTP) und die Wiederherstellungscodes aufheben.

> **HZ_SECRET_KEY sichern.** Damit sind alle gespeicherten Tokens verschlüsselt (GitHub, Home Assistant, Agents, RCON). Ein Backup der Datenbank ist ohne diesen Schlüssel wertlos. Der Assistent bietet an, ihn einmal anzuzeigen; später: `sudo grep ^HZ_SECRET_KEY= /etc/homelab-zentrale/core.env`. In den Passwortmanager damit, nicht ins Repo.

## Danach

| Was | Befehl |
| --- | --- |
| Aktualisieren (neues Image, Neustart, Health-Check) | `sudo ./deploy/install.sh update` |
| Status, Freigabe, Login-Link noch einmal anzeigen | `sudo ./deploy/install.sh status` |
| Neu konfigurieren (z. B. Zeitzone) | `sudo ./deploy/install.sh --timezone Europe/Berlin` |
| Entfernen, Daten und Schlüssel bleiben | `sudo ./deploy/install.sh uninstall` |
| Alles löschen (Datenbank und Schlüssel, endgültig) | `sudo ./deploy/install.sh uninstall --purge` |

Bei lokalem Build vor `update` den Checkout aktualisieren (`git pull`); das Skript baut dann neu. Mit Image aus GHCR reicht `update`.

Agents für weitere Server (und für den Server der Zentrale selbst) kommen über die Zentrale: **Server hinzufügen** zeigt einen Einzeiler mit Einmal-Code.

## Ohne Fragen (Automatisierung)

```bash
sudo ./deploy/install.sh --yes --timezone Europe/Vienna --modules github=0,homeassistant=1,games=1,storage=1
```

`--yes` nimmt überall den Standard und installiert fehlendes Docker/Tailscale. Ist Tailscale noch nicht angemeldet, braucht es ohne Terminal einen Auth-Key in `HZ_TS_AUTHKEY` (geht als 0600-Datei an `tailscale up`, nie als Argument). Weitere Optionen: `sudo ./deploy/install.sh --help`.

## Share-Gateway (optional)

Damit Freunde ohne Tailscale einen Gameserver über einen öffentlichen Namen steuern können, läuft auf einem **anderen, öffentlichen** Server (z. B. einer Cloud-VM) das kleine Share-Gateway. Die Zentrale bleibt dabei im Tailnet.

1. In der Zentrale: Einstellungen → Share-Gateway → **Token erzeugen**.
2. Auf dem öffentlichen Server (mit Tailscale, in einem Checkout dieses Repos):

   ```bash
   sudo ./deploy/install.sh share --core-url https://heimserver.<tailnet>.ts.net --domain spiel.example.duckdns.org
   ```

   Das Token wird verdeckt abgefragt (oder über `HZ_SHARE_GATEWAY_TOKEN` bzw. `--token-stdin`), nie als Argument. Es landet in `/etc/homelab-share/share.env` (0600). Ist Caddy installiert, schreibt das Skript das Caddyfile für den Namen (das alte wird gesichert).
3. **Ports öffnet das Skript nicht.** TCP 80 und 443 in der Cloud-Firewall und in iptables freigeben, nichts sonst (Schritte in `deploy/README.md`).
4. In der Zentrale das Share-Gateway auf „Aktiv“ stellen und die öffentliche Adresse eintragen.

`share update`, `share status` und `share uninstall` gibt es auch.

## Wenn der Core nicht startet

**`exec /usr/local/bin/docker-entrypoint.sh: operation not permitted` in Schleife:** Docker läuft hier selbst eingesperrt unter AppArmor, meistens weil der Ubuntu-Server-Installer Docker als **Snap** mitinstalliert hat (oder der Server ist ein LXC-Container, z. B. auf Proxmox). Dann startet kein Container mit `no-new-privileges`. Das Skript prüft das vor dem Start („Härtung prüfen“) und erklärt die Ursache. Beheben:

```bash
snap list docker                       # zeigt es "docker", ist es der Snap
sudo snap remove --purge docker        # löscht alles, was im Snap-Docker liegt
sudo systemctl restart docker.socket docker
sudo ./deploy/install.sh               # Schlüssel und Einstellungen bleiben
```

Den Snap entfernt das Skript nur nach ausdrücklichem „j“, nie mit `--yes`. `--purge` löscht dabei alles im Snap-Docker, auch Volumes anderer Container (z. B. eines Agents). Lässt sich die Ursache nicht beheben (LXC), startet das Skript ohne `no-new-privileges`, aber nur nach ausdrücklichem „j“ oder mit `--allow-no-nnp` (`--yes` allein bricht ab); Benutzer `node`, keine Capabilities, schreibgeschütztes Dateisystem und `127.0.0.1` bleiben. Jedes `update` prüft erneut und schaltet die Option wieder ein, sobald der Host es erlaubt. Der Agent (`install-agent.sh`) prüft das noch nicht; auf so einem Host den Snap entfernen.

**`curl: (60) SSL: no alternative certificate subject name matches …ts.net` beim Einzeiler eines Agents:** Auf dem Server der Zentrale hört ein anderer Dienst auf `0.0.0.0:443` (z. B. nginx). Dann bekommt `tailscale serve` nur IPv6, und andere Server landen bei diesem Dienst und seinem Zertifikat. Das Skript prüft nach `tailscale serve` das Zertifikat und nennt den Dienst. Beheben: `sudo ss -ltnp | grep ':443 '`, den Dienst nur an die LAN-IP binden (nginx: `listen 192.168.1.10:443 ssl;`) oder abschalten (`sudo systemctl disable --now nginx`), dann `sudo systemctl restart tailscaled`. `sudo ./deploy/install.sh status` prüft erneut.

## Was das Skript nie tut

- `tailscale funnel` einschalten, eine Portweiterleitung anlegen oder den Core auf etwas anderes als `127.0.0.1` binden.
- Einen vorhandenen `HZ_SECRET_KEY` ersetzen. Findet es Daten (Volume `homelab-zentrale_hz-data`), aber keinen Schlüssel, bricht es ab, statt einen neuen zu erzeugen. Ein `HZ_SECRET_KEY` aus einer `.env` im Checkout (frühere Installation von Hand) wird übernommen.
- Secrets ausgeben, als Argument an andere Programme geben oder mitloggen. Auch `bash -x` wird abgeschaltet.
- Ports in Firewalls öffnen.
