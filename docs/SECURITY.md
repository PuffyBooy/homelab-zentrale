# Sicherheit

Die Zentrale hat Root-ähnliche Macht über alle Server. Diese Regeln sind **nicht verhandelbar**. Ein Meilenstein ist nicht fertig, wenn eine davon verletzt ist.

## Erreichbarkeit
- Der Core bindet nur an `127.0.0.1`. Zugriff nur über `tailscale serve` (siehe `NETWORK.md`).
- Kein `tailscale funnel`, keine Portweiterleitung, kein Cloudflare-Tunnel für Core oder Agent.

## Login
- Ein Admin-Konto, angelegt beim ersten Start über einen Setup-Assistenten. Den Setup-Link gibt es nur einmal, er steht im Log des Core-Containers.
- Passwort mit argon2id gehasht (mindestens 12 Zeichen), dazu **TOTP Pflicht**, mit Wiederherstellungscodes (10 Stück, gehasht).
- Session-Cookie: `httpOnly`, `Secure`, `SameSite=Strict`, 30 Tage gleitend, in der DB widerrufbar.
- **Step-up:** Für die Konsole, Server-Neustart, Löschen eines Gameservers und das Ändern von Tokens muss TOTP erneut eingegeben werden. Das gilt dann 15 Min.
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
- Das Agent-Token ist pro Server eindeutig und widerrufbar. Bei Widerruf trennt der Core die Verbindung sofort.
- Einrichtungscode-Tausch (Onboarding): 5 Versuche pro 15 Min pro IP, dazu eine globale Grenze von 30 Fehlversuchen pro 15 Min. Ist sie erreicht, lehnt der Core 15 Min lang jeden Tausch ab, auch mit gültigem Code. Ein Gerät im Tailnet kann das Onboarding damit absichtlich 15 Min blockieren; das nehmen wir bewusst in Kauf (ein Admin, eigenes Tailnet, die Zentrale ist nie öffentlich), weil es Raten über viele IPs hinweg verhindert.

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

## Allgemein
- Jede Eingabe wird mit zod geprüft (Body, Query, Params, WebSocket-Nachrichten, Agent-Nachrichten).
- Sicherheits-Header über `@fastify/helmet` mit strenger CSP (keine Inline-Skripte, `connect-src 'self'`).
- Abhängigkeiten: `pnpm audit` in CI, Renovate oder Dependabot aktivieren.
- Im `audit_log` landet jede verändernde Aktion (wer, was, wann, Ziel).
- Tests pflichtweise für Auth, Step-up, Share-Rechteprüfung, Pfadprüfung im Agent und die Agent-Allowlist.
