# Netzwerk

## Grundregel

**Die Zentrale ist nie öffentlich erreichbar.** Core und Agents sprechen nur über Tailscale miteinander, und der Browser erreicht die Zentrale nur über Tailscale. Es braucht keine gekaufte Domain.

## Gegebenheiten

- Zu Hause: ein Router mit eigener öffentlicher **IPv4** und **DDNS-Name** (Beispiel-Setup)
- Oracle Cloud: reservierte öffentliche IP
- Alle Server sind im selben Tailnet

## Zugriff auf die Zentrale

1. Der Core lauscht auf `127.0.0.1:8080` (`HZ_HOST=127.0.0.1`).
2. Auf dem Heimserver gibt `tailscale serve --bg --https=443 http://127.0.0.1:8080` den Core als `https://heimserver.<tailnet>.ts.net` im Tailnet frei, mit gültigem HTTPS-Zertifikat von Tailscale. Das braucht die PWA für Web-Push und den Service Worker.
3. MagicDNS ist im Tailnet aktiv, dadurch heißen alle Server einfach `heimserver`, `oracle-a1`, `pi`. Eigene DNS-Einträge im Router sind nicht nötig.
4. **Nicht** `tailscale funnel` für den Core verwenden.

## Agents

- Der Agent verbindet sich ausgehend zu `wss://heimserver.<tailnet>.ts.net/agent`.
- Auf keinem Server wird ein Port für den Agent geöffnet.
- **Ausnahme Schlafmodus (M12):** Solange ein Gameserver schläft, lauscht der Agent auf genau den Spielports dieses Gameservers (die ohnehin für Freunde weitergeleitet sind), damit der erste Verbindungsversuch ihn weckt. Er antwortet nur mit „Schläft“ bzw. „Server startet“, leitet nie Daten weiter, begrenzt Größe, Zeit und Verbindungen und schließt die Ports, bevor das Spiel startet. Kein anderer Port, nie die Agent-Verbindung selbst. Wer das nicht will, schaltet „Beim Verbinden aufwecken“ aus.

## Router-Einstellungen

- **Adressreservierung** (DHCP-Reservierung im Router) für den Heimserver und jedes Gerät mit festen Diensten.
- **Portweiterleitung** nur für Gameserver, die zu Hause laufen und von außen erreichbar sein sollen. Die Zentrale zeigt beim Anlegen genau an, welche Ports (TCP/UDP) nötig sind.
- **DDNS** wird nur für Gameserver-Adressen zu Hause verwendet (`<ddns-name>:25565`).

## Gameserver von außen

| Wo läuft der Gameserver? | Adresse für Freunde | Nötig |
| --- | --- | --- |
| `oracle-a1` (empfohlen) | öffentliche Oracle-IP oder DDNS/DuckDNS-Name, Port | Ingress-Regel in der Oracle Security List und Firewall auf der VM (`iptables`/`ufw`) |
| `heimserver` | DDNS-Name zu Hause, Port | Portweiterleitung im Router |

Die Zentrale speichert pro Gameserver die `external_address` und zeigt sie zum Kopieren an.

## Share-Gateway (optional, Standard: aus)

Benutzerlinks funktionieren standardmäßig nur im Tailnet. Sollen Freunde ohne Tailscale einen Gameserver steuern:

- `apps/share` läuft auf `oracle-a1` als eigener Container hinter Caddy (automatisches HTTPS) unter einem kostenlosen DDNS-Namen.
- Das Gateway spricht über Tailscale mit dem Core, und zwar nur mit `/api/share-gateway/*`, authentifiziert mit `HZ_SHARE_GATEWAY_TOKEN`.
- Der Core akzeptiert auf dieser API nur: Share-Token prüfen, Status eines Gameservers lesen und die erlaubten Aktionen dieses Tokens ausführen.
- Rate-Limit am Gateway: 10 Anfragen pro Minute pro IP, 5 falsche PINs sperren den Link für 15 Min.

## Checks von außen

Damit „Website erreichbar“ auch wirklich von außen geprüft wird, kann ein Check auf `oracle-a1` ausgeführt werden (`from_agent_id`). So erkennt man z. B., ob die Heim-IP oder eine Portweiterleitung ausgefallen ist.

## Ausgehende Verbindungen der Zusatzmodule (M18)

- **Discord-Bot:** Core → `https://discord.com/api/v10` (REST) und `wss://gateway.discord.gg` (Gateway), nur ausgehend. Es gibt keinen öffentlichen Endpunkt für Discord.
- **Schwachstellen-Scan:** Der Trivy-Container auf jedem Server lädt sein Image (Docker Hub), die Schwachstellen-Datenbank (`ghcr.io`/`mirror.gcr.io`) und die Image-Metadaten aus der jeweiligen Registry. Kein Port wird geöffnet.
- **Sprachsteuerung:** nutzt nur die bestehende Verbindung Core → Home Assistant. Alexa spricht mit Home Assistant (Nabu Casa oder `emulated_hue` im LAN), nie mit der Zentrale.
