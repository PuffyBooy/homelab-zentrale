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

## Benutzerlinks
- Token mit ≥ 128 Bit Zufall, gespeichert nur als Hash.
- Ein Link erlaubt genau einen Gameserver und genau die gesetzten Rechte. Das wird serverseitig bei **jeder** Aktion geprüft.
- Die Share-Seite gibt keine internen Daten preis (keine Tailscale-IPs, keine anderen Server, keine Container-IDs).
- Jede Aktion landet im `share_audit` und im `audit_log`.

## Allgemein
- Jede Eingabe wird mit zod geprüft (Body, Query, Params, WebSocket-Nachrichten, Agent-Nachrichten).
- Sicherheits-Header über `@fastify/helmet` mit strenger CSP (keine Inline-Skripte, `connect-src 'self'`).
- Abhängigkeiten: `pnpm audit` in CI, Renovate oder Dependabot aktivieren.
- Im `audit_log` landet jede verändernde Aktion (wer, was, wann, Ziel).
- Tests pflichtweise für Auth, Step-up, Share-Rechteprüfung, Pfadprüfung im Agent und die Agent-Allowlist.
