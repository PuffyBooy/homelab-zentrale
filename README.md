# Homelab-Zentrale

Ein privates Kontrollzentrum für alle meine Server, Container, Gameserver, GitHub-Repos, Websites und die Wohnung. Es ist nur über Tailscale erreichbar und nie öffentlich.

> **Status:** Spezifikation und Designsystem sind fertig, der Code wird nach `docs/ROADMAP.md` gebaut.

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
| **Wandmodus** | Vollbild-Ansicht fürs Tablet/Echo Show, nachts gedimmt |

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

## Für Coding-Agents

Start: [`AGENTS.md`](AGENTS.md). Der Startprompt steht in [`PROMPT.md`](PROMPT.md).

## Designsystem

Live-Ansicht mit allen Komponenten: https://claude.ai/artifact/NxJ5BnwwiSdZfCQUsJsv5w. Eine Kopie liegt in `design/`.
