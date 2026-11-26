# Offene Fragen, To-dos für Alex und Ideen

Diese Datei wird bei jedem Meilenstein aktualisiert. Technische Detailfragen der Agents stehen zusätzlich in `docs/QUESTIONS.md`.

## Was Alex selbst tun muss

Alles hier braucht deine Zugänge oder ist nicht rückgängig zu machen. Bis dahin läuft der Code mit Platzhaltern bzw. Demo-Daten (`HZ_DEMO=1`).

1. **Core auf dem Heimserver starten:** `.env` aus `.env.example` anlegen, `HZ_SECRET_KEY` mit `openssl rand -base64 32` erzeugen und sicher aufheben (ohne ihn sind alle gespeicherten Secrets verloren), dann `docker compose -f deploy/docker-compose.core.yml up -d --build`.
2. **Tailscale serve einrichten:** `tailscale serve --bg --https=443 http://127.0.0.1:8080` auf dem Heimserver, MagicDNS und HTTPS-Zertifikate im Tailscale-Admin aktivieren. `HZ_BASE_URL` auf `https://heimserver.<tailnet>.ts.net` setzen.
3. **Erstes Setup:** Den einmaligen Setup-Link aus `docker compose logs core` öffnen, Konto anlegen, TOTP in der Authenticator-App einrichten, die 10 Wiederherstellungscodes offline sichern.
4. **Push aufs Handy (ab M4):** In `.env` `HZ_VAPID_SUBJECT=mailto:<deine Adresse>` setzen (Apple lehnt Pushes ohne echte Adresse ab). Die VAPID-Schlüssel erzeugt der Core beim ersten Start selbst und speichert sie verschlüsselt; wer sie fest haben will, erzeugt sie mit `pnpm --filter @hz/core vapid` und trägt `HZ_VAPID_PUBLIC`/`HZ_VAPID_PRIVATE` ein. Dann am Handy die Zentrale über `https://…ts.net` öffnen, „Zum Home-Bildschirm“ (iOS braucht die installierte PWA für Push) und unter Einstellungen → Push „Auf diesem Gerät aktivieren“, danach „Testnachricht senden“.
5. **Agent neu ausrollen (ab M3):** Auf Servern, die schon einen Agent haben, `deploy/install-agent.sh` einmal erneut ausführen (neues Image mit `ping`, Schutz-Label `hz.role`).

## Offene Fragen

- **Branch-Namen:** AGENTS.md wünscht pro Meilenstein einen Branch `m<N>-<name>`. Diese Sitzung darf technisch nur auf einen festen Branch pushen. Annahme: Jeder Meilenstein ist trotzdem ein eigener PR mit Titel `M<N>: …`, der Branch wird nach jedem Merge neu von `main` gestartet. Soll ich künftig `m<N>-…`-Branches verwenden?
- **CodeQL / Dependency-Review:** Das Repo ist privat. GitHubs CodeQL-Code-Scanning und die Dependency-Review-Action brauchen dafür „GitHub Code Security“ (kostenpflichtig). Annahme: Stattdessen laufen Semgrep (SAST), Gitleaks (Secrets in der ganzen Git-Historie), Trivy (Abhängigkeiten, Dockerfiles, Image) und `pnpm audit` in `.github/workflows/security.yml`. Wenn du Code Security aktivierst oder das Repo öffentlich machst, ergänze ich CodeQL in 5 Minuten.

- **Server hinzufügen ohne Step-up?** Das Erzeugen eines Enrollment-Tokens (15 Min, einmalig) verlangt derzeit keine erneute TOTP-Eingabe, Widerrufen und Löschen schon. Soll auch das Hinzufügen Step-up brauchen?
- **Agent-Image:** Es gibt noch keine Registry. Annahme: Das Agent-Image wird auf jedem Server lokal gebaut (`deploy/install-agent.sh`). Alternative: GitHub Container Registry (`ghcr.io/puffybooy/homelab-agent`), dann müsste das Repo-Paket für die Server lesbar sein. Soll ich das einrichten?
- **Neu einschreiben unter gleichem Namen:** Ein widerrufener Server muss gelöscht werden, bevor er sich unter demselben Namen neu anmelden kann (dabei geht der Verlauf verloren). Soll ein Re-Enrollment den alten Eintrag samt Verlauf übernehmen?
- **Checks, erste Fehlschläge:** Der erste Fehlschlag zeigt `WARN` ohne Meldung, erst der zweite in Folge ist `CRIT` mit Push. Weiterleitungen (max. 5, nur http/https) werden verfolgt, ein Check kann also keinen 3xx-Code erwarten. Passt das?
- **Ruhezeit:** warn- und info-Pushes in der Ruhezeit (23–7 Uhr) werden verworfen, nicht morgens nachgeliefert (die Meldungen selbst bleiben in der Liste). Lieber morgens gesammelt nachliefern?
- **Level für Updates/Neustart nötig:** derzeit `warn` (wie SPEC 5.1). Mit Push ab M4 wären das gesammelte Pushes alle 30 Min. Lieber `info` (kein Push)?

## Annahmen

- **Trivy-Ausnahme (bis 15.01.2027):** Im Agent-Image steckt das offizielle `docker compose`-Binary mit einer HIGH-Lücke in `golang.org/x/net` (HTML-Parser, CVE-2026-78661). Compose parst kein fremdes HTML, und es gibt noch keine Version mit Fix. Die Ausnahme steht in `apps/agent/.trivyignore` und läuft am 15.01.2027 ab; dann schlägt CI wieder an.

- Sicherheitstests liegen in Dateien mit `security` im Namen und laufen zusätzlich als eigener Job `security tests` in GitHub Actions.

- **Eigene Container geschützt:** Agent und Core tragen das Label `hz.role` (in den Compose-Dateien unter `deploy/`). Der Agent lehnt Stoppen, Neustart und Update dafür ab (auch für den eigenen Container über die Container-ID). Wer den Agent schon vor M3 ohne Label installiert hat, startet ihn einmal neu mit der neuen Compose-Datei (`deploy/install-agent.sh` erneut ausführen). Die Knöpfe sind in der Oberfläche noch sichtbar und liefern dann „nicht erlaubt“; ausblenden kommt später.
- **Kleinigkeiten aus dem M3-Review, später:** Ein neuer Container, der beim Update sofort mit Exit 0 endet, gilt als Erfolg (kein Rollback). Fehler in Docker-Event-Handlern werden still verworfen. Der Log-Demuxer hat keine Obergrenze für die Frame-Größe (Docker ist vertrauenswürdig).

## Zukunftsideen

Sortiert nach Bereich. Nichts davon ist in den Meilensteinen, alles wäre ein eigener kleiner Ausbau.

### Server und Betrieb
- Backups mit restic zwischen den Servern (Heimserver ↔ Oracle), mit Wiederherstellungstest pro Woche und Anzeige „letztes geprüftes Backup vor 3 Tagen“.
- Wake-on-LAN für Rechner im Heimnetz über den Agent am Heimserver.
- Automatische Sicherheitsupdates (unattended-upgrades) pro Server ein-/ausschalten und das Ergebnis anzeigen.
- Geplante Neustarts („Sonntag 04:00, wenn Neustart nötig“).
- SMART-Werte der Festplatten, ZFS/btrfs-Scrub-Status, RAID-Zustand.
- USV-Anbindung (NUT): Akkustand und automatisches Herunterfahren.
- Prognose „Disk voll in 23 Tagen“ aus dem Verlauf.
- Docker-Volumes und ihre Größe pro Container.
- Mehrere Zentralen-Instanzen als Hot-Standby auf Oracle (SQLite-Replikation mit Litestream).

### Container und Deploy
- Watchtower-artige Update-Hinweise: neue Image-Version verfügbar, mit Changelog-Link.
- Preview-Deploys pro Branch unter eigenem Pfad im Tailnet.
- Deploy-Freigabe per Push-Nachricht („Deploy von soundos auf soundos-pi freigeben?“).
- Secrets-Verwaltung für `.env`-Dateien der Apps (verschlüsselt im Core, beim Deploy geschrieben).
- GitHub-App statt Token, damit Rechte feiner sind.
- Release-Notes automatisch aus Commits beim Deploy.

### Gameserver
- Mod-/Plugin-Verwaltung für Paper und Fabric (Modrinth-API).
- Welt-Downloads für Freunde als Link (zeitlich begrenzt).
- Geplante Neustarts und Backups pro Gameserver, Discord-Webhook „Server ist online“.
- Spielerstatistik (Spielzeit pro Freund, Spitzenzeiten).
- Mehr Vorlagen: Satisfactory, Factorio, Enshrouded, Project Zomboid, ARK, Rust, V Rising.
- Auto-Start beim ersten Verbindungsversuch (Proxy, der den Server weckt).
- Whitelist-Anfragen: Freund trägt seinen Namen ein, Alex bestätigt per Push.

### Websites und Meldungen
- ntfy als zweiter Push-Kanal (selbst gehostet), E-Mail als dritter.
- Statusseite nur fürs Tailnet oder öffentlich über das Share-Gateway.
- Check für DNS-Einträge (erwarteter A-Record = Heim-IP), für DDNS-Ausfälle.
- Lighthouse-Werte der eigenen Websites wöchentlich.
- Wartungsfenster: Meldungen für einen Server für 2 h stummschalten.
- Eskalation: crit 15 Min unbestätigt → zweite Push oder Anruf über Home Assistant.

### Wohnung
- Morgen-Briefing auf dem Wandtablet: Wetter Wien und Attersee, Wiener Linien Abfahrten, Termine, Müllabfuhr.
- Stromverbrauch pro Server (Shelly-Steckdosen) und Kosten pro Gameserver im Monat.
- Szenen („Gaming-Abend“: Licht dimmen, Minecraft starten).
- Anwesenheit: Gameserver stoppen, wenn niemand online ist und Alex nicht zu Hause.

### Bedienung
- KI-Befehle in der Befehlspalette („Starte den Minecraft-Server“, „Warum ist oracle-a1 langsam?“).
- Sprachsteuerung über Home Assistant Assist.
- iOS/Android-Widgets über die PWA-Shortcuts.
- Tastatur-Makros und eigene Aktionen in der Palette.
- Dunkles Wandmodus-Layout für den Echo Show.

### Sonstiges
- Roblox-/Evelon-Statistiken.
- SoundOS-Steuerung (FastAPI auf dem Pi): Status, Neustart, Logs.
- Paket-Tracking (Post, DHL) als Kachel.
- Pi-hole/AdGuard-Statistiken.
- Tailscale-Geräteliste mit „zuletzt online“ und Ablauf der Schlüssel.
- Zertifikats- und Domain-Übersicht für alle Domains an einem Ort.
