# Gameserver-Vorlagen

Ein Ordner pro Spiel (`<id>` = Ordnername = `id` in `template.json`) mit:

- `template.json`: Metadaten und Formularfelder. Schema: `template.schema.json` (aus `gameTemplateSchema` in `packages/shared/src/api/games.ts` erzeugt, nicht von Hand ändern; der Test `apps/agent/test/templates.test.ts` prüft, dass beide übereinstimmen).
- `compose.yml`: Docker Compose mit `${VAR}`-Platzhaltern.

Eine neue Vorlage ist ein neuer Ordner. `apps/agent/test/templates.test.ts` prüft jede Vorlage automatisch.

## Vorlagen

| Vorlage             | Image (fest)                                  | RAM (min/empf.) | Ports                                 | Spieler/Status            | RCON |
| ------------------- | --------------------------------------------- | --------------- | ------------------------------------- | ------------------------- | ---- |
| `minecraft-java`    | `itzg/minecraft-server:2026.11.1-java25`      | 4G / 6G         | 25565/tcp                             | Server-Liste + TPS (RCON) | ja   |
| `minecraft-bedrock` | `itzg/minecraft-bedrock-server:2026.11.1`     | 1G / 2G         | 19132/udp                             | Bedrock-Status            | nein |
| `valheim`           | `lloesche/valheim-server:sha-0ab6cdcc16dd`    | 3G / 4G         | 2456–2458/udp                         | GameDig `valheim`         | nein |
| `terraria`          | `ryshe/terraria:tshock-1.4.5.8-6.2.1`         | 1G / 2G         | 7777/tcp                              | nur „Port offen“ (TCP)    | nein |
| `cs2`               | `joedwards32/cs2:5.0.1`                       | 4G / 8G         | 27015/udp                             | GameDig `counterstrike2`  | ja   |
| `palworld`          | `thijsvanloef/palworld-server-docker:v2.8.1`  | 8G / 16G        | 8211/udp, REST-API 8212 nur 127.0.0.1 | GameDig `palworld` (REST) | ja   |

Image-Tags sind fest gepinnt (nie `:latest`). Valheim hat keine Versions-Tags, darum der Commit-Tag `sha-…`. **Valheim und CS2 gibt es nur für amd64**, sie laufen also nicht auf dem Raspberry Pi und nicht auf der Oracle-ARM-VM. Die übrigen Images sind amd64 + arm64. Beim Aktualisieren Tag in `template.json` und `compose.yml` gemeinsam ändern.

## Platzhalter

Der Core ersetzt `${VAR}` durch:

- die Formularfelder aus `template.json` (`fields[].key`), außer Feldern mit `secret: true`,
- Systemwerte: `GAME_NAME`, `PORT_<NAME>` (aus `ports[].name`, großgeschrieben), bei `count > 1` zusätzlich `PORT_<NAME>_END` (= Startport + count − 1, Valheim), und `PORT_RCON`, wenn die Vorlage RCON hat.

Keine Compose-Modifier wie `${A:-b}`.

## Geheimnisse

Geheimnisse stehen **nie** in `compose.yml`. Der Core schreibt sie in die `.env` neben `compose.yml` (über `compose.write`, Modus 0600):

```
RCON_PASSWORD=<automatisch erzeugt>
PORT_RCON=<Port auf 127.0.0.1>
<KEY eines secret-Felds>=<Wert>
```

Jede Vorlage hat `env_file: [.env]`, damit kommen die Werte in den Container. Darum heißen Felder mit `secret: true` genau wie die Umgebungsvariable des Images (`SERVER_PASS`, `CS2_PW`, `SRCDS_TOKEN`, `SERVER_PASSWORD`).

Will ein Image das RCON-Passwort unter einem anderen Namen (CS2: `CS2_RCONPW`, Palworld: `ADMIN_PASSWORD`), steht in `compose.yml` genau `KEY: ${RCON_PASSWORD}`. Das ist ein **Laufzeit-Platzhalter**: Der Core ersetzt ihn **nicht**, Docker Compose füllt ihn beim `up` aus der `.env` im Projektordner. In der Datei auf der Platte steht also nie das Passwort.

Der Agent liest `RCON_PASSWORD` und `PORT_RCON` selbst aus der `.env` (für RCON, TPS und die Palworld-REST-API). Das Passwort geht nie über die Leitung zurück.

## Regeln für jede `compose.yml`

- `container_name: game-${GAME_NAME}`, `restart: unless-stopped`
- Labels `homelab.game: ${GAME_NAME}` und `homelab.template: <id>`
- `mem_limit: ${MEMORY}`: Jede Vorlage hat ein Auswahlfeld `MEMORY` (Standard = `ram.recommended`). Minecraft Java nutzt davon 75 % als Java-Heap.
- RCON und interne APIs nur auf `127.0.0.1` veröffentlichen (`'127.0.0.1:${PORT_RCON}:<rcon.port>/tcp'`). Portweiterleitung gibt es nur für die Spielports.
- Weltdaten liegen in `./data` (`dataDir`). `game.backup` sichert genau `<Spielordner>/data` als `tar.zst` nach `/opt/homelab/backups/<name>/<name>-JJJJMMTT-HHMMSS.tar.zst` (UTC) und behält die letzten `keep` Sicherungen. Bei Minecraft Java pausiert der Agent davor das Autosave über RCON (`save-off`, `save-all flush`, danach `save-on`).
- Große Server-Installationen (Valheim, CS2 ~60 GB, Palworld) liegen in einem benannten Volume `server`. Das ist nicht im Backup und wird beim Löschen (`game.remove`: `docker compose down --volumes`) mit entfernt. CS2 hat keine Weltdaten, dort gibt es kein `./data` und darum kein Backup.
- Konsolen ohne RCON (Bedrock, Terraria) laufen mit `stdin_open` + `tty` für `docker attach`.
