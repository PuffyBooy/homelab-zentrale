# Discord-Bot und Sprachsteuerung (Echo Show / Alexa)

Zwei optionale Module unter Einstellungen → Module. Beide sind standardmäßig aus, zum Einschalten braucht es Step-up. Die Zentrale bleibt dabei privat: Es gibt keinen öffentlichen Endpunkt, beide Module bauen nur ausgehende Verbindungen auf.

## Discord-Bot (Modul `discordbot`)

### Was er kann

Freunde steuern im eigenen Discord-Server die Gameserver, für die sie einen Benutzerlink haben:

- `/status`: ihre Spiele mit Status („Läuft“, „Gestoppt“ …), Spielerzahl und Adresse
- `/start spiel:<name>`, `/stop spiel:<name>`, `/restart spiel:<name>`

Der Bot handelt immer mit den Rechten des Links: `/start` und `/stop` brauchen „Start/Stopp“, `/restart` braucht „Neustart“. Die RAM-Reserve gilt wie bei jedem Start über einen Link. Jede Aktion steht im Protokoll des Links (Weg „discord“) und im Audit-Log. Abgelaufene oder widerrufene Links funktionieren nicht mehr. Bei einem Link mit PIN fragt der Bot nicht nach der PIN, denn die Verknüpfung mit dem Discord-Konto legt der Admin selbst fest.

Alle Antworten sind nur für den Fragenden sichtbar, erwähnen niemanden und zeigen keine internen Daten (keine Tailscale-Adressen, keine Servernamen). Grenzen: 5 Befehle pro Minute und Person, 30 Sekunden Pause pro Spiel nach einer Aktion.

### Einrichten

1. Im [Discord Developer Portal](https://discord.com/developers/applications) eine neue Anwendung anlegen. Die **Application ID** steht unter „General Information“.
2. Unter „Bot“ ein Token erzeugen („Reset Token“) und kopieren. Privileged Gateway Intents bleiben alle aus, der Bot braucht keine.
3. Den Bot in den eigenen Server einladen, mit den Scopes `bot` und `applications.commands` und ohne weitere Berechtigungen:

   ```
   https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot+applications.commands&permissions=0
   ```

4. In Discord unter Einstellungen → Erweitert den Entwicklermodus einschalten. Dann Rechtsklick auf den Server → „Server-ID kopieren“ (Guild ID) und Rechtsklick auf einen Freund → „Benutzer-ID kopieren“.
5. In der Zentrale unter Discord-Bot Token, Application ID und Server-ID eintragen (Step-up). Der Status wechselt auf „Verbunden als …“, die Befehle sind im Server sofort da.
6. In der Liste der Links (alle mit „Start/Stopp“ oder „Neustart“) bei jedem Freund seine Discord-Benutzer-ID eintragen.

Das Token wird verschlüsselt gespeichert und nie wieder angezeigt. Zum Wechseln einfach ein neues eintragen; Application ID oder Server-ID ändern behält das Token.

## Sprachsteuerung über Home Assistant (Modul `voice`)

### Was sie kann

Die Zentrale beobachtet über ihre bestehende Verbindung zu Home Assistant zwei Helfer pro Spiel:

- einen **Schalter** (`input_boolean`): ein → Spiel starten, aus → Spiel stoppen (nur wenn „Stoppen erlauben“ an ist)
- optional einen **Statustext** (`input_text`): die Zentrale schreibt z. B. „Läuft, 3 Spieler“ hinein

Die Zentrale stellt den Schalter immer auf den echten Zustand des Spiels zurück, so zeigt Alexa nie etwas Falsches. Nach einem Schaltvorgang wartet sie 60 Sekunden, bevor dasselbe Spiel wieder geschaltet werden kann. Starts beachten die RAM-Reserve. Jeder Schaltvorgang steht im Audit-Log (Akteur `voice:ha`). Voraussetzung ist das Modul Home Assistant mit aktiver Verbindung.

### Einrichten

1. In Home Assistant unter Einstellungen → Geräte & Dienste → Helfer anlegen:
   - „Schalter“ (input_boolean), z. B. `input_boolean.minecraft`
   - optional „Text“ (input_text), z. B. `input_text.minecraft_status`, maximale Länge 100
2. In der Zentrale unter Sprachsteuerung beim Spiel den Schalter und den Statustext eintragen (Step-up bei neuem Schalter, neuem Statustext und beim Erlauben von Stoppen).
3. Den Schalter für Alexa freigeben, eine der beiden Varianten:
   - **Nabu Casa** (Home Assistant Cloud): Einstellungen → Sprachassistenten → Alexa → Entität freigeben. Danach in der Alexa-App „Geräte suchen“.
   - **emulated_hue** (lokal, ohne Cloud): in der `configuration.yaml` `emulated_hue:` mit dem Helfer unter `entities` eintragen. Alexa findet den Schalter als Lampe.
4. Sprechen: „Alexa, schalte Minecraft ein.“
5. **Echo Show:** Im Silk-Browser des Echo Show das Home-Assistant-Dashboard öffnen. Am besten ein eigenes Dashboard mit einer Kachel für den Schalter und einer für den Statustext anlegen.

Modul aus oder Home Assistant nicht verbunden: Die Zentrale tut nichts und ändert auch nichts an den Helfern.

**Wichtig:** Wer den Schalter in Home Assistant umlegen kann, startet das Spiel, ohne Benutzerlink: jeder HA-Benutzer, jede Automation und mit Alexa jeder, der mit der Echo spricht. Mit „Stoppen erlauben“ gilt das auch fürs Stoppen. Nur Spiele zuordnen, bei denen das in Ordnung ist.
