# App-Vorlagen (M21)

Ein Ordner pro App (`<id>` = Ordnername = `id` in `template.json`) mit:

- `template.json`: Metadaten und Parameter nach `appTemplateMetaSchema` (`packages/shared/src/api/apps.ts`).
- `compose.yml`: Docker Compose mit `${KEY}`-Platzhaltern. Der Core schreibt die Werte in `.env` (Modus 0600) neben die `compose.yml` in `/opt/homelab/apps/<appId>/`; Compose setzt sie beim Start ein.

Der Core liefert die Vorlagen im Image unter `/app/templates/apps` aus (`HZ_APP_TEMPLATES_DIR`). Eine neue Vorlage ist ein neuer Ordner; `apps/agent/test/app-templates.test.ts` prüft jede automatisch.

## Regeln

- Images auf eine konkrete Version gepinnt, nie `:latest`. Die Version der Haupt-App steht auch in `version`.
- Jeder Port als `'${BIND}:${<PORT_PARAM>}:<Containerport>'`; `BIND` setzt der Core (Tailnet-IP, `127.0.0.1` oder `0.0.0.0`). Höchstens ein Port mit `web: true` (Link „Öffnen“).
- Daten nur als Bind-Mount `./data/<ordner>:<pfad>`, keine benannten Volumes, keine Pfade außerhalb des App-Ordners.
- Verboten (prüft auch der Core, `COMPOSE_FORBIDDEN`): `privileged`, `cap_add`, `devices`, Host-Netz/-PID/-IPC, `security_opt`, `build`, Docker-Socket, `container_name` außer `${APP_ID}…`, das Label `hz.role`, mehr als 10 Dienste.
- `restart: unless-stopped` bei jedem Dienst.
- Werte nur über `${KEY}`, ohne Compose-Standardwerte (`${A:-b}`). Reserviert und vom Core gesetzt: `APP_ID`, `APP_DIR`, `BIND`, `TZ`, `PUID`, `PGID` (1000).
- Passwörter und Schlüssel als Parameter `password` mit `generate: true`. Kein Dienst bekommt die ganze `.env` (`env_file`), nur die Werte, die er braucht.
- Beschreibungen und Hinweise auf Deutsch, kurz.

## Vorlagen

| Vorlage          | Images                                                          | RAM min | Ports (Standard)       |
| ---------------- | --------------------------------------------------------------- | ------- | ---------------------- |
| `jellyfin`       | `jellyfin/jellyfin:10.11.11`                                    | 1024 MB | 8096                   |
| `nextcloud`      | `nextcloud:35.0.3-apache`, `mariadb:11.8.9`, `redis:7.4.12-alpine` | 1536 MB | 8180                |
| `vaultwarden`    | `vaultwarden/server:1.37.5`                                     | 128 MB  | 8222 (braucht HTTPS)   |
| `forgejo`        | `codeberg.org/forgejo/forgejo:15.0.7` (LTS)                     | 256 MB  | 3000, SSH 2222         |
| `paperless-ngx`  | `ghcr.io/paperless-ngx/paperless-ngx:3.5.1`, `postgres:17.12-alpine`, `redis:7.4.12-alpine` | 2048 MB | 8010 |
| `syncthing`      | `syncthing/syncthing:2.1.7`                                     | 128 MB  | 8384, Sync 22000/tcp   |
| `audiobookshelf` | `ghcr.io/advplyr/audiobookshelf:2.38.0`                         | 256 MB  | 13378                  |
| `navidrome`      | `deluan/navidrome:0.64.2`                                       | 128 MB  | 4533                   |
| `freshrss`       | `freshrss/freshrss:1.31.0`                                      | 128 MB  | 8280                   |
| `uptime-kuma`    | `louislam/uptime-kuma:2.5.12`                                   | 256 MB  | 3001                   |
| `mealie`         | `ghcr.io/mealie-recipes/mealie:v3.31.0`                         | 512 MB  | 9925                   |

Alle Images gibt es für amd64 und arm64. Beim Aktualisieren den Tag in `compose.yml` und `version` in `template.json` gemeinsam ändern. Große Sprünge (Nextcloud-Hauptversionen, PostgreSQL-Hauptversionen) nie überspringen: Nextcloud nur eine Hauptversion pro Update, PostgreSQL braucht eine Datenmigration.
