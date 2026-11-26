# Homelab-Zentrale

Ein privates Kontrollzentrum für alle meine Server, Container, Gameserver, GitHub-Repos, Websites und die Wohnung. Es ist nur über Tailscale erreichbar und nie öffentlich.

> **Status:** Die Meilensteine aus `docs/ROADMAP.md` werden der Reihe nach gebaut. Jeder kann die Zentrale auf eigenen Servern betreiben; GitHub, Home Assistant und Gameserver sind Module zum An- und Ausschalten.

## Installieren

Auf dem Server, der die Zentrale tragen soll (Debian, Ubuntu oder Raspberry Pi OS):

```bash
git clone https://github.com/PuffyBooy/homelab-zentrale.git
cd homelab-zentrale
sudo ./deploy/install.sh
```

Der Assistent installiert bei Bedarf Docker und Tailscale, erzeugt die Konfiguration samt Schlüssel, startet die Zentrale, gibt sie mit `tailscale serve` nur im Tailnet frei und zeigt am Ende den Link für den ersten Login (Passwort + TOTP). Update: `sudo ./deploy/install.sh update`. Alles Weitere in [`docs/INSTALL.md`](docs/INSTALL.md).

## Was sie kann

| Bereich | Kurz |
| --- | --- |
| **Server** | Alle Server in einer Leiste: CPU, RAM, Disk, Temperatur, Netz, Uptime, offene Updates, fehlgeschlagene SSH-Logins |
| **Container** | Docker auf allen Servern: Status, Logs, Start/Stop/Neustart, Image-Update |
| **Gameserver** | In Minuten aus Vorlagen aufsetzen (Minecraft, Valheim, Terraria, CS2 …), Spieler, RAM, TPS, Konsole, Benutzerlinks für Freunde |
| **GitHub** | Repos, CI-Status, „neue Commits nicht live“, Deploy per Knopf, Rollback, Verlauf |
| **Websites** | HTTP/TCP-Checks jede Minute, Antwortzeit, SSL- und Domain-Ablauf |
| **Meldungen** | Alle Probleme als Logzeilen, Push aufs Handy (Web-Push), Wochenbericht |
| **Wohnung** | Home Assistant: Schalter, Klima, Strom, Gegensprechanlage |
| **Konsole** | Web-SSH zu jedem Server, für den es eingeschaltet ist |
| **Wandmodus** | Vollbild-Ansicht fürs Tablet oder Smart Display, nachts gedimmt |

## Aufbau

```
apps/core     Backend (Fastify, SQLite) und liefert die Web-App aus
apps/web      Oberfläche (React, PWA)
apps/agent    Kleiner Dienst auf jedem Server (Docker), meldet sich beim Core
apps/share    Optionales öffentliches Gateway nur für Gameserver-Benutzerlinks
packages/ui   React-Komponenten aus dem Designsystem
packages/shared  Gemeinsame Typen und zod-Schemas
templates/games  Gameserver-Vorlagen (Docker Compose + Metadaten)
design/       Designsystem: Tokens, CSS, Referenzkomponenten, Brand Book
docs/         Spezifikation, Architektur, Sicherheit, Netzwerk, Roadmap
deploy/       Docker-Compose-Dateien und Install-Skripte
```

## Bauen mit Claude Code

Gebaut wird mit **Claude Code** (am besten mit Projects). Start: [`PROMPT.md`](PROMPT.md). Regeln: [`AGENTS.md`](AGENTS.md), Sub-Agents: [`.claude/agents/`](.claude/agents/).

## Designsystem

Live-Ansicht mit allen Komponenten: https://claude.ai/artifact/NxJ5BnwwiSdZfCQUsJsv5w. Eine Kopie liegt in `design/`.
