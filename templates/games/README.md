# Gameserver-Vorlagen

Ein Ordner pro Spiel mit:
- `template.json`: Metadaten und Formularfelder (Schema: `template.schema.json`, wird in M6 angelegt)
- `compose.yml`: Docker Compose mit `${VAR}`-Platzhaltern

Systemwerte, die der Core immer setzt: `GAME_NAME`, `PORT_<NAME>` (aus `ports[].name`, großgeschrieben), `PORT_RCON`, `RCON_PASSWORD`.

`minecraft-java` ist das Muster. Die übrigen Vorlagen (SPEC 6.2) entstehen in M6 nach demselben Aufbau. RCON lauscht immer nur auf `127.0.0.1`.
