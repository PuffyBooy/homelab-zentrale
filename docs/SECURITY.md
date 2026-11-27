# Sicherheit

Die Zentrale hat Root-ähnliche Macht über alle Server. Diese Regeln sind **nicht verhandelbar**. Ein Meilenstein ist nicht fertig, wenn eine davon verletzt ist.

## Erreichbarkeit
- Der Core bindet nur an `127.0.0.1`. Zugriff nur über `tailscale serve` (siehe `NETWORK.md`).
- Kein `tailscale funnel`, keine Portweiterleitung, kein Cloudflare-Tunnel für Core oder Agent.

## Login
- Ein Admin-Konto, angelegt beim ersten Start über einen Setup-Assistenten. Den Setup-Link gibt es nur einmal, er steht im Log des Core-Containers.
- Passwort mit argon2id gehasht (mindestens 12 Zeichen), dazu **TOTP Pflicht**, mit Wiederherstellungscodes (10 Stück, gehasht).
- Session-Cookie: `httpOnly`, `Secure`, `SameSite=Strict`, 30 Tage gleitend, in der DB widerrufbar.
- **Step-up:** Für die Konsole, Server-Neustart und -Herunterfahren, Löschen eines Gameservers und das Ändern von Tokens muss TOTP erneut eingegeben werden. Das gilt dann 15 Min.
- Rate-Limit beim Login: 5 Versuche pro 15 Min pro IP, danach wachsende Wartezeit.
- CSRF: `SameSite=Strict` plus `Origin`-Prüfung bei allen Anfragen, die etwas ändern.

## Secrets
- Gespeichert mit AES-256-GCM (`crypto.ts`), Schlüssel aus `HZ_SECRET_KEY`, pro Wert ein eigener zufälliger Nonce.
- Tokens, die nur verglichen werden (Agent, Share, Gerät, Enrollment), werden gehasht gespeichert (SHA-256 reicht, da zufällig mit ≥ 128 Bit), nicht verschlüsselt.
- Secrets tauchen nie in Logs, API-Antworten, Fehlermeldungen oder im Frontend auf. Die API liefert nur „gesetzt / nicht gesetzt“.

## Agent
- Nur Aktionen aus der Allowlist (`ARCHITECTURE.md`). Alles andere wird abgelehnt und protokolliert.
- Programme werden mit `execFile` und Argument-Arrays aufgerufen, nie mit `shell: true` oder String-Verkettung.
- Dateipfade werden normalisiert und müssen unter `/opt/homelab/` liegen (Schutz gegen `..` und Symlinks: `realpath` prüfen).
- PTY nur bei `HZ_AGENT_ALLOW_TERMINAL=1` **und** einer Step-up-Session im Core.
- Geplante Shell-Befehle (`task.exec`, M20) nur bei `HZ_AGENT_ALLOW_TASKS=1` am Agent; Anlegen, Ändern, manuelles Starten und Anzeigen des Befehls brauchen Step-up. Der Befehl liegt verschlüsselt in der DB und erscheint in keinem Log, keiner Meldung und keiner Antwort ohne Step-up. Das ist Root auf dem Host: wie die Konsole nur dort einschalten, wo es gebraucht wird.
- App-Store (M21): Compose-Dateien laufen durch eine Allowlist-Prüfung (kein privileged, keine Capabilities, keine Geräte, kein Host-Netz/-PID, kein Docker-Socket, Bind-Mounts nur unter `./data/` des App-Ordners); Ports lauschen standardmäßig nur auf der Tailscale-IP.
- Das Agent-Token ist pro Server eindeutig und widerrufbar. Bei Widerruf trennt der Core die Verbindung sofort.
- Einrichtungscode-Tausch (Onboarding): 5 Versuche pro 15 Min pro IP, dazu eine globale Grenze von 30 Fehlversuchen pro 15 Min. Ist sie erreicht, lehnt der Core 15 Min lang jeden Tausch ab, auch mit gültigem Code. Ein Gerät im Tailnet kann das Onboarding damit absichtlich 15 Min blockieren; das nehmen wir bewusst in Kauf (ein Admin, eigenes Tailnet, die Zentrale ist nie öffentlich), weil es Raten über viele IPs hinweg verhindert.

## Gameserver (M12)
- Wake-Listener nur auf Host-Ports, die die `compose.yml` des Spiels veröffentlicht, nie Weiterleitung, Grenzen für Frames (1 KiB), Bytes, Zeit (5 s) und Verbindungen (16); Serverlisten-Pings wecken nicht.
- Mods/Plugins nur von `cdn.modrinth.com` mit sha512 aus der Modrinth-API, feste Größe, O_EXCL, keine Symlinks.
- Discord-Webhook-URL verschlüsselt, nur `discord.com`/`discordapp.com`, nie in Antwort, Log oder Fehlermeldung, Step-up beim Setzen; Nachrichten ohne Tailnet-Adressen, ohne Erwähnungen.
- Welt-Download für Freunde nur mit Recht `world_download`, nur die Weltordner aus `worldPaths` der Vorlage (nie Konfigurationen mit Passwörtern oder Logs), 1 pro Link und Stunde.
- Backup wiederherstellen nur mit Step-up und Namensbestätigung; jeder Archiv-Eintrag wird geprüft.

## Serververwaltung und Auto-Update (M16, M17)
- `system.du` misst nur Größen, mit festen Argumenten (`du -x -a -B1 -d1 -- <pfad>`); der Pfad wird im Schema und nach `realpath` im Agent geprüft, nie unter `/proc`, `/sys`, `/dev`, `/run`. Höchstens eine Anfrage pro 5 s und Server.
- Dienste starten/stoppen nur für Units in `HZ_AGENT_SERVICES` auf dem Server und nie für `SERVICE_DENYLIST` (tailscaled, docker, containerd, ssh/sshd, dbus, systemd-*, Netzwerk, getty). Jede Aktion steht im `audit_log`.
- Die Prozessliste enthält nur Prozessnamen, nie Kommandozeilen oder Umgebungsvariablen.
- Herunterfahren und Neustart: Step-up und eingetippter Servername, im Core und im Agent geprüft.
- Updates ersetzen nur die Container mit `hz.role=core` bzw. den Agent selbst, und nur mit dem Image-Tag, den der Container schon nutzt. Kein Image, kein Tag und keine Registry kommt aus einer Anfrage.
- Der Helfer-Container für das Agent-Update läuft aus dem alten, bekannten Image, mit `hz.role=updater` (wie Core/Agent nie aus der UI steuerbar), ohne Netz, mit `cap_drop: ALL`, `no-new-privileges`, schreibgeschütztem Dateisystem, nur Docker-Socket und Agent-Datenvolume, und entfernt sich selbst.
- `system.upgrade` ruft nur `apt-get update` und `apt-get -y upgrade` mit festen Argumenten auf (kein `dist-upgrade`, keine Entfernungen).
- Ergebnis-Events (`update_result`) zählen nur für einen bekannten, laufenden Lauf desselben Servers und Ziels.
- Neustart-Automatik nach Updates einschalten braucht Step-up.
## Game-Relay (M15)
- Relay nur mit `HZ_AGENT_ALLOW_RELAY=1` am Eingang und Step-up für Eingänge und Relays. DNS-Namen setzt das Relay seit M20 über das Domains-Modul (Anbieter und Token dort, Step-up beim Einschalten); Relay-Einträge kann man in den Domains nicht bearbeiten oder löschen.
- Ziele nur Tailscale-Adressen, Ports ab 1024 im Bereich des Eingangs, keine Überschneidungen; Grenzen für Verbindungen/Sessions (256 je Route) und Leerlauf (TCP 10 Min, UDP 2 Min). Keine Inhalte und keine Client-IPs im Log.
- DNS-Token (Cloudflare/DuckDNS) verschlüsselt, nie in Antwort, Log, Audit oder Fehlertext; Anfragen nur an `api.cloudflare.com` bzw. `www.duckdns.org`, ohne Redirects.
- Das Spiel sieht als Absender den Eingang; IP-Sperren im Spiel greifen nicht pro Spieler.

## Benutzerlinks
- Token mit ≥ 128 Bit Zufall, gespeichert nur als Hash.
- Ein Link erlaubt genau einen Gameserver und genau die gesetzten Rechte. Das wird serverseitig bei **jeder** Aktion geprüft.
- Die Share-Seite gibt keine internen Daten preis (keine Tailscale-IPs, keine anderen Server, keine Container-IDs).
- Jede Aktion landet im `share_audit` und im `audit_log`.

## Anbindungen und Meldungskanäle (M14)
- Ausgehende Anfragen an Proxmox, Pi-hole/AdGuard, FRITZ!Box und Uptime Kuma laufen nur über `apps/core/src/integrations/http.ts`: http/https, keine Zugangsdaten, Query oder Anker in der URL, nie link-lokal (169.254.0.0/16, fe80::/10, auch IPv4-mapped), geprüft bei der Eingabe, vor jeder Anfrage und nach der DNS-Auflösung (verbunden wird nur mit der geprüften Adresse). Weiterleitungen werden nie gefolgt. 8 s Zeitlimit, 4 MB Obergrenze. Selbst signierte Zertifikate nur mit eingefügter CA, die Prüfung wird nie abgeschaltet.
- Zugangsdaten sind verschlüsselt (AAD pro Anbindung bzw. Kanal-Feld). Ändern von URL, Benutzer, Secret oder CA verlangt Step-up. Wird die URL zum ersten Mal gesetzt oder ändert sich ihr Origin, muss das Secret in derselben Anfrage kommen, sonst wird das gespeicherte verworfen.
- Step-up und Bestätigung für Proxmox Herunterfahren/Stoppen/Neustart und den FRITZ!Box-Neustart. Proxmox-Aktionen nur für Gäste aus der letzten Abfrage. DNS-Blocken nur befristet pausierbar.
- Antworten fremder Systeme werden begrenzt und ohne DTD/Entities geparst; Fehlertexte sind feste Strings, nie der fremde Inhalt.
- Meldungskanäle: Discord nur an die offiziellen Discord-Webhook-Adressen, Telegram nur an `api.telegram.org`, ntfy nach denselben URL-Regeln. Adressen in den Texten werden maskiert, weil die Nachrichten das Tailnet verlassen; keine Erwähnungen (Discord) und kein Markup (Telegram).
- Wake-on-LAN sendet nur das Magic Packet an 255.255.255.255 oder eine private IPv4-Adresse, Port 7 oder 9, höchstens 6 pro Minute (Core pro Server und Agent gesamt).

## Zusatzmodule (M18)
- **Log-Suche:** Der Suchtext ist reiner Text (nie ein regulärer Ausdruck, kein ReDoS), wird nie geloggt (im Protokoll nur die Länge) und ist auf 10 Suchen pro Minute und Session begrenzt.
- **Schwachstellen-Scan:** Trivy läuft nur als per Digest gepinntes Image (`HZ_AGENT_TRIVY_IMAGE` ohne Digest wird ignoriert), mit `--image-src remote`, ohne Docker-Socket und ohne Host-Pfad (nur das Volume `hz-trivy-cache`), read-only, `cap-drop ALL`, `no-new-privileges`, Speicher-, CPU- und PID-Limit. Die Zentrale nennt nie ein Image, nur einen Container; das Image samt Digest bestimmt der Agent.
- **Fail2ban:** Entsperren nur für einen Jail, den `fail2ban-client status` kennt, und genau eine gültige IPv4/IPv6-Adresse, als Argument-Array ohne Shell; jede Entsperrung steht im `audit_log`.
- **Discord-Bot:** Bot-Token AES-256-GCM verschlüsselt, nur schreibbar, nie in Antwort, Log oder Fehlermeldung, nur an `https://discord.com/api/v10` gesendet; Gateway nur `wss://*.discord.gg` ohne Zugangsdaten oder Port. Kein öffentlicher Endpunkt (keine Interactions-URL). Befehle nur aus der eingestellten Guild, nur von Discord-Usern, die der Admin mit Step-up an einen aktiven Benutzerlink gebunden hat; Rechte, Ablauf, Widerruf, RAM-Reserve und `share_audit` (`via: discord`) wie beim Link. Die Bindung ersetzt den PIN des Links. Antworten nur für den Fragenden sichtbar, ohne Erwähnungen, Rate-Limit pro User und Abklingzeit pro Spiel.
- **Sprachsteuerung:** Wer in Home Assistant den zugeordneten `input_boolean` schalten kann (HA-Benutzer, Automationen, Alexa und damit jeder, der mit der Echo spricht), kann das Spiel starten und mit „Stoppen erlauben“ auch stoppen, ohne Benutzerlink. Deshalb: Step-up für einen neuen Schalter, einen neuen Statustext und für „Stoppen erlauben“; nur Domänen `input_boolean`/`input_text`; Abklingzeit 60 s; RAM-Reserve gilt (unbekannter RAM = kein Start); jeder Auslöser im `audit_log` (`voice:ha`).

## Cloud-Server (M22)
- Azure-Zugang (Client-Secret der App-Registrierung) und Tailscale-Auth-Key AES-256-GCM verschlüsselt (AAD pro Feld), nur schreibbar, nie in Antwort, Log oder Fehlermeldung. Ändern verlangt Step-up; wechseln Tenant, App oder Abo ohne neues Secret, wird das gespeicherte verworfen.
- Die App-Registrierung hat nur die Rolle *Contributor* auf einer eigenen Ressourcengruppe, nicht auf dem Abo.
- Anfragen nur an `login.microsoftonline.com`, `management.azure.com` und `prices.azure.com`, ohne Weiterleitungen, mit Zeitlimit und Größengrenze. Jeder Pfadteil kommt aus einer geprüften Liste oder einem Schema. Andere Hosts nur mit `HZ_DEMO=1` und nur `http://127.0.0.1:<port>` (Tests).
- Nichts wird ohne Bestätigung des geschätzten Preises bestellt; Budget-Warnung ab 80 %, ab 100 % keine automatischen Starts mehr. Löschen nur mit Step-up und Namensbestätigung.
- Die VM bekommt kein Passwort und einen SSH-Schlüssel, dessen privater Teil sofort verworfen wird. Die Netzwerk-Sicherheitsgruppe lässt nur die öffentlichen Spielports der Gameserver darauf herein (kein SSH, kein RCON); Verwaltung nur über Tailscale. cloud-init enthält nur geprüfte, gequotete Werte. Der Auth-Key liegt nur kurz in einer 0600-Datei auf tmpfs; nach `tailscale up` (und auch bei einem Fehler) löscht das Skript sie samt den Kopien der Benutzerdaten (`/var/lib/cloud/instance/user-data.txt*`, `cloud-config.txt`, `/var/lib/waagent/ovf-env.xml`, `CustomData`). Übrig bleibt nur cloud-inits `obj.pkl` (nur root lesbar, nötig für Neustarts) und die customData im VM-Modell bei Azure (nicht abrufbar). Deshalb einen eigenen, getaggten Key nur für Cloud-Server nutzen, mit Ablauf.
- Laufende VMs werden nie vergessen: Abrechnung zählt, solange Azure die VM als eingeschaltet meldet (auch bei Fehlern), ein fehlgeschlagenes Deallocate wird wiederholt, eine VM ohne Agent wird nach 8 Min schlafen gelegt, das Modul lässt sich erst ausschalten, wenn alle Cloud-Server schlafen, und ein Cloud-Server lässt sich nur über die Cloud-Seite löschen. Statusänderungen sind Compare-and-set, ein bestätigtes Löschen oder Schlafenlegen wird nie überschrieben.

## Allgemein
- Jede Eingabe wird mit zod geprüft (Body, Query, Params, WebSocket-Nachrichten, Agent-Nachrichten).
- Sicherheits-Header über `@fastify/helmet` mit strenger CSP (keine Inline-Skripte, `connect-src 'self'`).
- Abhängigkeiten: `pnpm audit` in CI, Renovate oder Dependabot aktivieren.
- Im `audit_log` landet jede verändernde Aktion (wer, was, wann, Ziel).
- Tests pflichtweise für Auth, Step-up, Share-Rechteprüfung, Pfadprüfung im Agent und die Agent-Allowlist.
