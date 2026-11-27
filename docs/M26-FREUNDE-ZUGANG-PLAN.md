# M26: Freunde-Zugang mit einem Klick (Plan)

Stand: Plan vom 27.11.2026, gebaut wird frühestens ab 29.11.2026 18:00 (Wien).
Wunsch des Admins: „Kannst du das automatisch machen, dass ich einfach nur einen Account erstelle oder denen einen Link schicke und sie Zugriff haben?“

Heute (M7, `deploy/README.md` „Share-Gateway“): Benutzerlinks gehen nur im Tailnet. Öffentlich werden sie erst mit dem Share-Gateway auf einem Server mit öffentlicher IP, und das braucht 8 Handgriffe (DDNS, Cloud-Firewall, iptables, Caddy, Token, Env-Datei, Start, Einschalten).

Ziel: Der Admin klickt einmal „Freunde-Zugang einrichten“, danach heißt Freunde einladen nur noch: Freund anlegen, Link schicken. Freunde brauchen kein Tailscale, kein Konto, keine App.

## Was gleich bleibt (Sicherheit)
- Core und Agents bleiben nie öffentlich. Öffentlich ist nur das kleine Gateway (`apps/share`), das ausschließlich `/api/share-gateway/*` des Core erreicht.
- Rechte, Ablauf, PIN, Widerruf, Rate-Limits, RAM-Reserve und `share_audit` wie in M7.
- Einrichten, Abbauen und Gateway-Token erneuern mit Step-up.

## Zwei Wege, der Assistent wählt den passenden

### Weg A (empfohlen): Tailscale Funnel, ohne Ports, ohne Domain, ohne Oracle
Das Gateway läuft als eigener Container mit **eigenem Tailscale-Knoten** (`hz-share`, Tag `tag:homelab-share`) auf einem beliebigen Server, auch zu Hause. Nur dieser Knoten bekommt Funnel; die öffentliche Adresse ist `https://hz-share.<tailnet>.ts.net/s/<token>`. Kein Router, keine Portfreigabe, kein DuckDNS, Zertifikat kommt von Tailscale.
- Die Zentrale erzeugt den Auth-Key über die Tailscale-OAuth-Anbindung aus M11b (einmalig, Tag `tag:homelab-share`, nicht gespeichert).
- Die Tailscale-ACL muss einmal zwei Dinge erlauben: Funnel für `tag:homelab-share` und von `tag:homelab-share` nur Zugriff auf den Core-Knoten Port 443. Hat der OAuth-Client das Recht `policy_file`, trägt die Zentrale das nach Vorschau und Step-up selbst ein; sonst zeigt sie den fertigen ACL-Ausschnitt zum Kopieren.
- Verträgt sich mit `docs/NETWORK.md`/`SECURITY.md`: Funnel bleibt für Core und Agent verboten; der Gateway-Knoten ist ein eigener Knoten mit eigenem Namen, der nichts außer `/api/share-gateway/*` erreicht. Die Doku bekommt dazu einen eigenen Absatz.
- Grenze: Funnel-Bandbreite ist begrenzt; für die kleine Link-Seite reicht das. Spieler-Verkehr läuft nie über das Gateway (dafür Game-Relay M15).

### Weg B: eigener Server mit öffentlicher IP (z. B. Oracle) und eigener Domain
Für alle, die eine eigene Adresse wie `spiel.example.duckdns.org` wollen. Der Assistent macht alles über den vorhandenen Agent:
1. **Server wählen:** nur Server mit öffentlicher IPv4 und Agent (wie Eingänge in M15). Die Zentrale prüft mit dem Port-Abgleich (M11), ob 80/443 frei sind. Belegt (z. B. eigener nginx/prepped): Angebot Port 8443 oder ein fertiger Ausschnitt für den vorhandenen Proxy.
2. **Domain:** über das Domains-Modul (M20, DuckDNS oder Cloudflare, Token dort schon hinterlegt) legt die Zentrale den Eintrag auf die öffentliche IP an. Ohne Domains-Modul: Feld für den Namen und Anleitung.
3. **Installation:** neue Agent-Aktion `share.install` schreibt eine feste, im Agent-Image mitgelieferte Compose-Datei (Gateway + Caddy, gepinnte Images) nach `/opt/homelab/share/` und startet sie. Keine freie Compose-Datei, keine freien Befehle. Gateway-Token und Core-URL setzt die Zentrale selbst (Env-Datei 0600).
4. **Host-Firewall:** Ist auf dem Server iptables mit Oracle-Standardregeln aktiv, setzt der Agent genau die zwei ACCEPT-Regeln für 80/443 (Aktion `share.firewall`, nur mit `HZ_AGENT_ALLOW_SHARE=1`, das der Installer mit `--share` setzt) und speichert sie. Nie andere Ports, nie Regeln löschen außer den eigenen beim Abbau.
5. **Cloud-Firewall:** Oracle-Security-List kann die Zentrale nur mit einem OCI-API-Schlüssel ändern. Optional „Oracle anbinden“ (Tenancy, User, Fingerprint, privater Schlüssel, verschlüsselt, nur `SecurityList` im gewählten Subnetz, nur 80/443). Ohne Schlüssel: Anleitung mit Direktlink in die Konsole. Azure-Server aus M22 erledigt die Zentrale schon heute über die NSG.
6. **Prüfen:** Caddy holt das Zertifikat (beweist, dass 80 von außen offen ist); danach prüft ein Check von einem zweiten Server oder über das Zertifikat, dass `https://<domain>/s/` antwortet. Erst dann wird das Gateway in der Zentrale aktiv.
7. **Abbauen:** ein Knopf entfernt Container, eigene Firewall-Regeln, DNS-Eintrag und widerruft das Gateway-Token.

## Freunde statt einzelner Links
- Neue Einheit **Freund** (Name, optional Discord-ID aus M18): ein persönlicher Link pro Freund, der für mehrere Gameserver gilt, jeweils mit eigenen Rechten (Status, Starten/Stoppen, Welt-Download, Whitelist, Wunschliste aus M24). Das ist das „Konto“: Der Freund speichert sich den Link (PWA „Zum Startbildschirm“), ohne Passwort; optional PIN.
- **Einladen:** „Freund einladen“ zeigt den Link mit Knopf „Kopieren“, QR-Code und Teilen-Menü des Handys (Web Share API → WhatsApp, Signal …); mit Discord-ID optional per Discord-Direktnachricht über den Bot (M18).
- **Whitelist automatisch:** Gibt der Freund beim ersten Öffnen seinen Minecraft-Namen an, landet er nach Freigabe durch den Admin (ein Klick, oder automatisch, wenn eingeschaltet) auf der Whitelist der erlaubten Server.
- **Verwalten:** Liste aller Freunde mit zuletzt aktiv, Rechten, Ablauf; Widerruf wirkt sofort; Link neu erzeugen macht den alten ungültig.
- Bestehende Benutzerlinks bleiben gültig und lassen sich in einen Freund übernehmen. Freunde sind nie Admins und sehen nie Server, IPs oder andere Freunde.

## Arbeitspakete
- **WP Schema** (`packages/shared`): `api/friends.ts`, Gateway-Einrichtung (`api/share-setup.ts`: Weg A/B, Schritte mit Status), Agent-Aktionen `share.install`, `share.remove`, `share.firewall` in eigener Datei, Migration nächste freie Nummer.
- **WP Core ∥** (`apps/core/src/share`, `friends`): Assistent als Zustandsmaschine mit sichtbaren Schritten und Wiederaufnahme nach Fehlern, Tailscale-Auth-Key und ACL (Weg A), DNS über `DomainService`, optional OCI-Client (nur feste Hosts `*.oraclecloud.com`, nur Security-List-Regeln), Freunde mit Mehrfach-Rechten, Einladung, Whitelist-Anfrage.
- **WP Agent ∥** (`apps/agent`, `deploy/`): feste Gateway-Compose für Weg A (mit Tailscale-Sidecar, Funnel nur für diesen Knoten) und Weg B (Caddy), `share.install`/`remove`/`firewall` hinter `HZ_AGENT_ALLOW_SHARE`, Installer `--share`.
- **WP Share-App ∥** (`apps/share`): Link-Seite für mehrere Gameserver pro Freund, Minecraft-Name, PWA-Manifest, QR nur in der Zentrale.
- **WP Web ∥** (`apps/web`): Assistent „Freunde-Zugang einrichten“ (Weg wählen, Fortschritt, Prüfung, Abbauen), Seite „Freunde“, Einladen-Dialog.

## Abnahme
Weg A gegen eine Tailscale-Attrappe: Ein Klick erzeugt Key, ACL-Vorschau, startet den Gateway-Container und schaltet ihn nach erfolgreicher Prüfung aktiv. Weg B gegen Sim-Server + DuckDNS-Attrappe: DNS-Eintrag, `share.install`, Firewall-Regeln, Caddy-Attrappe, aktiv; belegter Port 443 bietet 8443 an; Abbauen entfernt alles. Ein Freund mit Rechten auf zwei Gameservern startet den einen, auf dem dritten bekommt er 403; Widerruf gibt sofort 410.

**Sicherheitstests:** Funnel nie auf dem Core-Knoten (Installer und Assistent prüfen `tailscale funnel status`); Gateway-Knoten erreicht nur Core:443 (ACL-Ausschnitt getestet); `share.install` schreibt nur die mitgelieferte Compose, nur nach `/opt/homelab/share/`; `share.firewall` nur 80/443 bzw. 8443 und nur eigene Regeln entfernen; ohne `HZ_AGENT_ALLOW_SHARE` abgelehnt; OCI-Schlüssel und Gateway-Token nie in Antwort/Log; Freund sieht nie Daten anderer Freunde oder Server; Minecraft-Name nur `[A-Za-z0-9_]{3,16}`; alle Schritte mit Step-up.

## Was der Admin noch selbst tun muss
- **Weg A:** nichts außer der Tailscale-OAuth-Anbindung aus M11b (einmal); falls der OAuth-Client kein ACL-Recht hat, einmal den gezeigten ACL-Ausschnitt in der Tailscale-Konsole einfügen.
- **Weg B:** DuckDNS- oder Cloudflare-Token im Domains-Modul (einmal); entweder OCI-API-Schlüssel eintragen oder einmal 80/443 in der Oracle-Security-List öffnen; Agent auf dem Server mit `--share` (der Assistent zeigt den Befehl).
- Danach: Freund anlegen, Link schicken.
