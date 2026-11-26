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
| `satisfactory`      | `wolveix/satisfactory-server:v1.10.0`         | 8G / 12G        | 7777/tcp+udp, 8888/tcp                | GameDig `satisfactory`    | nein |
| `factorio`          | `factoriotools/factorio:2.1.25`               | 1G / 2G         | 34197/udp                             | nur Container-Status      | nein |
| `enshrouded`        | `mornedhels/enshrouded-server:1.8.1`          | 8G / 16G        | 15637/udp                             | GameDig `enshrouded`      | nein |
| `project-zomboid`   | `danixu86/project-zomboid-dedicated-server:42.20.4-release-2` | 4G / 8G | 16261/udp, 16262/udp        | GameDig `projectzomboid`  | ja   |
| `ark-se`            | `hermsi/ark-server:latest-1795427570`         | 8G / 12G        | 7777–7778/udp, 27015/udp (Query)      | GameDig `ase`             | ja   |
| `rust`              | `pfeiffermax/rust-game-server:build-26921919` | 8G / 12G        | 28015/udp, 28017/udp (Query)          | GameDig `rust`            | nein |
| `v-rising`          | `trueosiris/vrising:2026-04-23-1036`          | 4G / 8G         | 9876–9877/udp                         | GameDig `vrising`         | nein |

Image-Tags sind fest gepinnt (nie `:latest`). Valheim hat keine Versions-Tags, darum der Commit-Tag `sha-…`; ARK nutzt den unveränderlichen Build-Tag `latest-<Zeitstempel>`, Rust den Build-Tag der Spielversion (`build-…`, Facepunch aktualisiert monatlich), V Rising den Datums-Tag.

`arch` in `template.json` nennt die CPU-Architekturen des Images; der Core bietet nur passende Server an. **Nur amd64** (nicht auf Raspberry Pi und Oracle-ARM-VM): Valheim, CS2, Satisfactory, Enshrouded, Project Zomboid, ARK, Rust, V Rising. amd64 + arm64: Minecraft Java/Bedrock, Terraria, Palworld, Factorio. Beim Aktualisieren Tag in `template.json` und `compose.yml` gemeinsam ändern.

## Platzhalter

Der Core ersetzt `${VAR}` durch:

- die Formularfelder aus `template.json` (`fields[].key`), außer Feldern mit `secret: true`,
- Systemwerte: `GAME_NAME`, `PORT_<NAME>` (aus `ports[].name`, großgeschrieben), bei `count > 1` zusätzlich `PORT_<NAME>_END` (= Startport + count − 1, Valheim), `PORT_RCON`, wenn die Vorlage RCON hat, und `TZ` (Zeitzone der Zentrale aus `HZ_TIMEZONE`, z. B. `Europe/Vienna`; jede Vorlage setzt `TZ: ${TZ}`).

Keine Compose-Modifier wie `${A:-b}`.

## Schlafmodus, Mods, RCON-Befehle (M12)

- `wake`: wie der Agent im Schlaf auf den Spielports antwortet (`game.wake.arm`). `minecraft`: Serverliste zeigt „Schläft“, der Login weckt. `minecraft-bedrock`: Ping wird beantwortet, die Verbindungsanfrage weckt. `raw`: das erste TCP-Byte bzw. das erste UDP-Paket, das keine Serverlisten-Abfrage ist (Steam A2S, Satisfactory-Lightweight-Query), weckt. `none`: kein Wecken. Der Agent lauscht nur auf Ports, die die `compose.yml` des Spiels auf allen Schnittstellen veröffentlicht, und leitet nie Daten weiter.
- `mods` (nur Minecraft Java): Feld mit dem Server-Typ (`TYPE`), Werte für Plugins (`PAPER` → `data/plugins`) und Mods (`FABRIC` → `data/mods`) und das Versionsfeld (`VERSION`). Dateien kommen nur von `cdn.modrinth.com` und werden per sha512 geprüft.
- `worldPaths`: Unterordner von `./data`, die Freunde mit dem Recht „Welt herunterladen“ bekommen (`game.export` mit `paths`, nur diese Ordner, Symlinks werden verweigert). Nur gesetzt, wo dort sicher nur Weltdaten liegen (keine Configs mit Passwörtern, keine Logs mit IPs): Minecraft Java/Bedrock, Valheim, Palworld (`SaveGames`), Factorio (`saves`), Project Zomboid (`Saves`), ARK (`SavedArks`). Ohne `worldPaths` gibt es keinen Welt-Download (Terraria: Weltdatei hängt vom Feld `WORLD_NAME` ab; Satisfactory, Enshrouded, V Rising: Pfad nicht sicher; Rust, CS2: kein `./data`).
- `rcon.sayCommand` (`say {msg}`) warnt Spieler vor geplanten Neustarts, `rcon.whitelistAddCommand` (`whitelist add {player}`) trägt bestätigte Whitelist-Anfragen ein. Ohne den Befehl gibt es die Funktion für die Vorlage nicht.
- Factorio erzeugt sein RCON-Passwort selbst (`data/config/rconpw`), darum hat die Vorlage kein RCON. Rust bekommt kein RCON, damit kein Passwort auf der Kommandozeile steht; die Map liegt im Volume `server` (kein Backup, Rust wird monatlich gewiped).

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
