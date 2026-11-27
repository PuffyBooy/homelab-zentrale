# M29: App-Store 2.0 mit Suche (Plan)

Stand: Plan vom 27.11.2026, gebaut wird frühestens ab 29.11.2026 18:00 (Wien), nach M21/M23/M24.
Wunsch des Admins: „Gib mir Apps in den Store, also viel mehr, mit Suchen und so.“

Heute (M21): 11 eingebaute Vorlagen in `templates/apps/`, eigene Vorlagen, strenge Compose-Prüfung (`COMPOSE_FORBIDDEN`), Installation nach `/opt/homelab/apps/<id>/`, Ports standardmäßig nur auf der Tailscale-IP.

## 1. Viel mehr eingebaute Apps (Ziel: rund 80)
Alle als `templates/apps/<id>/` mit gepinnten Image-Versionen, `arch`, RAM-Schätzung, Kategorie, Schlagwörtern, Logo (SVG, lokal im Repo, keine Fremd-URLs), kurzer Beschreibung auf Deutsch und „Erste Schritte“.

| Kategorie | Apps |
|---|---|
| Medien | Jellyfin, Plex, Emby, Navidrome, Audiobookshelf, Kavita, Komga, Immich, PhotoPrism, Tdarr |
| Medien-Automatik | Sonarr, Radarr, Lidarr, Prowlarr, Bazarr, Jellyseerr, qBittorrent, SABnzbd |
| Dateien & Sync | Nextcloud, Seafile, Syncthing, FileBrowser, Paperless-ngx, Stirling-PDF |
| Passwörter & Sicherheit | Vaultwarden, Authelia, 2FAuth, CrowdSec-Dashboard |
| Entwicklung | Forgejo, Gitea, Woodpecker CI, code-server, Docker-Registry, n8n, Node-RED |
| Produktivität | Mealie, Tandoor, Vikunja, Planka, BookStack, Outline, Wiki.js, Joplin-Server, Memos, Linkding, Actual Budget, Firefly III |
| Kommunikation | Matrix Synapse + Element, Mattermost, Rocket.Chat, ntfy, Gotify |
| Netzwerk | AdGuard Home, Pi-hole, Unbound, WireGuard-Easy, Nginx Proxy Manager, Speedtest-Tracker |
| Überwachung | Uptime Kuma, Grafana, Prometheus, Loki, Netdata, Glances, Scrutiny, Dozzle, Beszel |
| Smart Home | Home Assistant, Zigbee2MQTT, Mosquitto, ESPHome, Frigate, Scrypted |
| Lesen & Wissen | FreshRSS, Miniflux, Wallabag, Calibre-Web, Kiwix, SearXNG |
| KI (passt zu M24) | Ollama, Open WebUI, LocalAI, Whisper (ASR) |
| Spiele-Zubehör | BlueMap (Minecraft-Karte), LANCache |

Nicht jede App ist mit der strengen Prüfung möglich (z. B. Frigate braucht Geräte, WireGuard braucht `NET_ADMIN`, Netdata/Glances wollen Host-Zugriff). Solche Apps bekommen eine **ausdrückliche Ausnahme pro Vorlage** (`template.json → exceptions[]`, z. B. `cap_add: NET_ADMIN` oder ein bestimmtes `/dev`-Gerät), die beim Installieren groß angezeigt wird und Step-up verlangt. Docker-Socket und `privileged` bleiben verboten; Apps, die das brauchen (Portainer, Watchtower, Dozzle mit Socket), kommen nicht in den Store, weil die Zentrale das selbst kann (M23).

## 2. Suche und Filter
- Suchfeld oben (auch über die Befehlspalette): Name, Schlagwörter, Beschreibung, deutsch und englisch („passwort“ findet Vaultwarden), tippfehlertolerant, eigene kleine Bewertung ohne neue Abhängigkeit.
- Filter: Kategorie, läuft auf (amd64/arm64 – zeigt nur, was auf den eigenen Servern läuft), RAM-Bedarf, „schon installiert“, „ohne Ausnahmen“, Quelle (eingebaut, Katalog, eigene).
- Sortierung: beliebt (feste Reihenfolge im Repo), neu, Name, RAM.
- App-Seite: Beschreibung, Screenshots (lokal), benötigte Ports und RAM, Ausnahmen, Version, Changelog-Link, „Ähnliche Apps“, „Passt gut zu“ (z. B. Jellyfin + Jellyseerr + Sonarr als **Bundle** mit einem Klick).
- Vorschläge aus M24: „Du hast Nextcloud, aber kein Backup-Ziel“ oder „Immich passt auf den Heimserver (4 GB frei)“.

## 3. Fremde Kataloge importieren (optional, Standard aus)
- Unterstützt: **CasaOS-AppStore** und **Umbrel-Apps** (beide Compose-basiert), Lizenzen werden vor dem Bau geprüft und im Plan festgehalten (`docs/QUESTIONS.md`); nur Kataloge, deren Lizenz das Einlesen erlaubt. LinuxServer.io-Images werden über ihre eigenen Vorlagen-Metadaten angeboten.
- Abruf nur von festen URLs (`raw.githubusercontent.com/<fester Pfad>` bzw. GitHub-Release), auf einen Commit gepinnt, „Katalog aktualisieren“ von Hand oder wöchentlich, mit Vorschau „neu / geändert“.
- Jede importierte App läuft durch **dieselbe Prüfung wie eigene Vorlagen**; was nicht durchgeht, erscheint ausgegraut mit Grund („braucht Docker-Socket“). Images werden beim Import auf Digest gepinnt, Ports auf `${BIND}` umgeschrieben, Host-Pfade auf `./data/` umgelenkt, Umgebungsvariablen mit Passwortmuster werden Parameter mit erzeugtem Wert.
- Importierte Apps tragen die Quelle und Lizenz sichtbar.

## 4. Komfort
- **Aktualisieren** mit Versionsliste und Rollback (Stack-Versionen aus M24).
- **Backup pro App** (Daten-Ordner, Zeitplan, NAS-Ziel aus M13b) und Wiederherstellen.
- **Öffnen** per Link: Tailnet-HTTPS über den Projekt-Proxy aus M28 (`app.<server>.ts.net`-Pfad bzw. Port), da keine eigene Domain genutzt wird.
- **Einrichtung:** erzeugte Admin-Zugänge mit Step-up sichtbar, „Erste Schritte“-Checkliste pro App.

## Arbeitspakete
- **WP Schema** (`packages/shared/src/api/apps.ts`): Kategorien, Schlagwörter, Ausnahmen, Bundles, Katalogquellen, Suchindex-Format.
- **WP Vorlagen ∥** (`templates/apps/`): rund 70 neue Vorlagen in Wellen zu je 10–15, jede mit Test „Compose besteht die Prüfung“ und einem CI-Smoke für 10 ausgewählte Apps (startet, Healthcheck grün, auf amd64 und arm64).
- **WP Core ∥** (`apps/core/src/appstore`): Suchindex beim Start, Katalog-Import mit Umschreiben und Prüfung, Ausnahmen mit Step-up, Bundles, Backup pro App.
- **WP Web ∥** (`apps/web`): Store mit Suche, Filtern, App-Seite, Bundles, Katalog-Einstellungen.

## Abnahme
„passwort“ findet Vaultwarden, „fotos“ findet Immich und PhotoPrism; der arm64-Filter blendet Apps ohne arm64 aus; ein Bundle installiert drei Apps auf einem Sim-Server; ein CasaOS-Katalog-Test-Snapshot wird importiert, eine App mit Docker-Socket ist ausgegraut, eine andere installiert sich mit umgeschriebenen Ports; WireGuard-Easy verlangt Step-up wegen `NET_ADMIN`.
**Sicherheitstests:** importierte Compose ohne Prüfung nie installierbar; Ausnahmen nur aus `template.json` des Repos, nie aus importierten Katalogen; keine Fremd-URLs für Logos/Screenshots im Browser; Katalog-Abruf nur von festen URLs ohne Weiterleitung, Größenlimit; Pfad-Ausbruch und `$`-Werte wie in M21.
