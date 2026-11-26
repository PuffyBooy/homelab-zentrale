# Offene Fragen, To-dos für Alex und Ideen

Diese Datei wird bei jedem Meilenstein aktualisiert. Technische Detailfragen der Agents stehen zusätzlich in `docs/QUESTIONS.md`.

## Was Alex selbst tun muss

Alles hier braucht deine Zugänge oder ist nicht rückgängig zu machen. Bis dahin läuft der Code mit Platzhaltern bzw. Demo-Daten (`HZ_DEMO=1`).

1. **Core auf dem Heimserver starten:** `.env` aus `.env.example` anlegen, `HZ_SECRET_KEY` mit `openssl rand -base64 32` erzeugen und sicher aufheben (ohne ihn sind alle gespeicherten Secrets verloren), dann `docker compose -f deploy/docker-compose.core.yml up -d --build`.
2. **Tailscale serve einrichten:** `tailscale serve --bg --https=443 http://127.0.0.1:8080` auf dem Heimserver, MagicDNS und HTTPS-Zertifikate im Tailscale-Admin aktivieren. `HZ_BASE_URL` auf `https://heimserver.<tailnet>.ts.net` setzen.
3. **Erstes Setup:** Den einmaligen Setup-Link aus `docker compose logs core` öffnen, Konto anlegen, TOTP in der Authenticator-App einrichten, die 10 Wiederherstellungscodes offline sichern.
4. **Push aufs Handy (ab M4):** In `.env` `HZ_VAPID_SUBJECT=mailto:<deine Adresse>` setzen (Apple lehnt Pushes ohne echte Adresse ab). Die VAPID-Schlüssel erzeugt der Core beim ersten Start selbst und speichert sie verschlüsselt; wer sie fest haben will, erzeugt sie mit `pnpm --filter @hz/core vapid` und trägt `HZ_VAPID_PUBLIC`/`HZ_VAPID_PRIVATE` ein. Dann am Handy die Zentrale über `https://…ts.net` öffnen, „Zum Home-Bildschirm“ (iOS braucht die installierte PWA für Push) und unter Einstellungen → Push „Auf diesem Gerät aktivieren“, danach „Testnachricht senden“.
5. **GitHub verbinden (ab M5):** Auf github.com unter Settings → Developer settings → Fine-grained tokens einen Token anlegen: nur die gewünschten Repos, Rechte *Contents: Read*, *Actions: Read*, *Metadata: Read*. In der Zentrale unter Einstellungen → GitHub eintragen (fragt nach dem TOTP-Code). Für private Repos pro Deploy-Ziel „Deploy-Key erzeugen“ und den angezeigten Schlüssel im Repo unter Settings → Deploy keys eintragen (ohne Schreibrecht). Zielordner unter `/opt/homelab/apps/` am besten vom ersten Deploy anlegen lassen; ein von Hand angelegter Ordner muss leer sein (außer `.env`) und root gehören, sonst lehnt git ihn ab. Gelöschte Deploy-Ziele lassen ihren privaten Key auf dem Server unter `/data/deploy-keys/` liegen (bei GitHub den Deploy-Key dann auch entfernen).
6. **Agent neu ausrollen (ab M3, erneut ab M6):** Auf Servern, die schon einen Agent haben, `deploy/install-agent.sh` erneut ausführen (neues Image mit `ping`, Schutz-Label `hz.role`, ab M6 `tar`/`zstd` für Gameserver-Backups). Valheim und CS2 gibt es nur für amd64, also nicht auf dem Raspberry Pi und der Oracle-ARM-VM.
7. **Gameserver für Freunde erreichbar machen (ab M6):** Die Zentrale zeigt pro Gameserver, welche Ports weitergeleitet werden müssen. Das machst du selbst: am Heimserver im Deco-Router (Portweiterleitung auf die feste LAN-IP des Heimservers), bei Oracle in der Security List der VM *und* in iptables auf der VM. Für eine schöne Adresse (z. B. `mc.<deine-domain>`) einen DNS-/DDNS-Eintrag anlegen und im Gameserver unter Einstellungen als externe Adresse eintragen. Die Zentrale selbst bleibt dabei nur über Tailscale erreichbar.
8. **Share-Gateway (optional, ab M7):** Nur wenn Freunde ohne Tailscale Links nutzen sollen. Anleitung in `deploy/README.md` → „Share-Gateway auf oracle-a1“: DDNS-Namen anlegen, in der Oracle Security List und in iptables 80/443 öffnen, Caddy installieren, in der Zentrale unter Einstellungen → Share-Gateway einen Token erzeugen und auf oracle-a1 in `/etc/homelab-share/share.env` eintragen, dann einschalten. Ohne Gateway funktionieren Links nur im Tailnet (sicherer Standard). Die Zentrale selbst bleibt dabei nie öffentlich.
9. **Home Assistant verbinden (ab M8):** In HA unter Profil → Sicherheit einen Long-Lived Access Token anlegen. In der Zentrale unter Einstellungen → Home Assistant die URL (z. B. `http://<heimserver-LAN-IP>:8123`) und den Token eintragen (fragt nach dem TOTP-Code), dann unter „Wohnung: Räume und Geräte“ Räume anlegen und Geräte auswählen. Türöffner (BTicino/Shelly) als Art „Taster“ eintragen. Strompreis €/kWh und die Sensoren für Leistung (W) und Energie (kWh) wählen.
10. **Web-Konsole einschalten (ab M9, nur wo gewünscht):** Die Konsole ist pro Server zweimal aus: Auf dem Server in der Agent-`.env` `HZ_AGENT_ALLOW_TERMINAL=1` setzen und den Agent neu starten (`deploy/install-agent.sh` erneut ausführen, das neue Image enthält die PTY-Bibliothek), dann in der Zentrale unter Einstellungen → Server „Konsole erlaubt“ einschalten. Öffnen fragt nach dem TOTP-Code; jede Sitzung steht im Protokoll (ohne Inhalte). Empfehlung: nur am Heimserver, nicht auf der öffentlichen Oracle-VM.
11. **Wandmodus aufs Tablet (ab M9):** Unter Einstellungen → Wandmodus ein Gerät anlegen (fragt nach dem TOTP-Code), den QR-Code mit dem Tablet scannen und die Seite als Startseite bzw. im Kiosk-Browser festlegen. Das Gerät darf nur den Wandzustand lesen; verliert man das Tablet, das Gerät in den Einstellungen löschen.
12. **Datenbank sichern:** Unter Einstellungen → Export lädt die ganze SQLite-Datenbank herunter (Step-up). Die Secrets darin sind verschlüsselt; ohne `HZ_SECRET_KEY` ist das Backup für Secrets wertlos, also beides getrennt aufbewahren.

**Noch von Hand abzunehmen** (braucht echte Zugänge): Push am Handy (M4); ein echter Deploy eines Test-Repos mit `compose.yml` auf den Heimserver-Agent (M5, automatisiert nur mit Fake-GitHub, Fake-Agent und echtem git gegen ein lokales Repo getestet). Der echte Türöffner (BTicino/Shelly) mit deiner HA (M8, im CI nur mit der HA-Demo getestet). Benutzerlink von außen über das Gateway auf oracle-a1 (M7, im CI nur lokal getestet).

## Offene Fragen

- **Branch-Namen:** AGENTS.md wünscht pro Meilenstein einen Branch `m<N>-<name>`. Diese Sitzung darf technisch nur auf einen festen Branch pushen. Annahme: Jeder Meilenstein ist trotzdem ein eigener PR mit Titel `M<N>: …`, der Branch wird nach jedem Merge neu von `main` gestartet. Soll ich künftig `m<N>-…`-Branches verwenden?
- **CodeQL / Dependency-Review:** Das Repo ist privat. GitHubs CodeQL-Code-Scanning und die Dependency-Review-Action brauchen dafür „GitHub Code Security“ (kostenpflichtig). Annahme: Stattdessen laufen Semgrep (SAST), Gitleaks (Secrets in der ganzen Git-Historie), Trivy (Abhängigkeiten, Dockerfiles, Image) und `pnpm audit` in `.github/workflows/security.yml`. Wenn du Code Security aktivierst oder das Repo öffentlich machst, ergänze ich CodeQL in 5 Minuten.

- **Server hinzufügen ohne Step-up?** Das Erzeugen eines Enrollment-Tokens (15 Min, einmalig) verlangt derzeit keine erneute TOTP-Eingabe, Widerrufen und Löschen schon. Soll auch das Hinzufügen Step-up brauchen?
- **Agent-Image:** Es gibt noch keine Registry. Annahme: Das Agent-Image wird auf jedem Server lokal gebaut (`deploy/install-agent.sh`). Alternative: GitHub Container Registry (`ghcr.io/puffybooy/homelab-agent`), dann müsste das Repo-Paket für die Server lesbar sein. Soll ich das einrichten?
- **Neu einschreiben unter gleichem Namen:** Ein widerrufener Server muss gelöscht werden, bevor er sich unter demselben Namen neu anmelden kann (dabei geht der Verlauf verloren). Soll ein Re-Enrollment den alten Eintrag samt Verlauf übernehmen?
- **Checks, erste Fehlschläge:** Der erste Fehlschlag zeigt `WARN` ohne Meldung, erst der zweite in Folge ist `CRIT` mit Push. Weiterleitungen (max. 5, nur http/https) werden verfolgt, ein Check kann also keinen 3xx-Code erwarten. Passt das?
- **Deploy ohne CI:** Repos ganz ohne GitHub Actions dürfen per Knopf deployt werden (rotes oder laufendes CI nicht). Auto-Deploy nur bei grünem CI. Rollback ignoriert den CI-Status. Passt das?
- **Ruhezeit:** warn- und info-Pushes in der Ruhezeit (23–7 Uhr) werden verworfen, nicht morgens nachgeliefert (die Meldungen selbst bleiben in der Liste). Lieber morgens gesammelt nachliefern?
- **Gameserver-Ports ändern:** Ports sind nach dem Aufsetzen nicht mehr änderbar (sonst stimmt die Portweiterleitung nicht mehr). Reicht das, oder soll Ändern mit Hinweis gehen?
- **Backups beim Löschen:** Vor dem Löschen eines Gameservers wird immer gesichert; die Backup-Dateien bleiben unter `/opt/homelab/backups/` am Server liegen, auch wenn der Eintrag weg ist. Sollen sie nach X Tagen automatisch weg?
- **Step-up für Benutzerlinks?** Links erstellen und widerrufen braucht derzeit keine erneute TOTP-Eingabe (SECURITY.md nennt es nicht); Gateway-Einstellungen und Gateway-Token schon. Soll auch das Erstellen eines Links Step-up brauchen?
- **Neustart-Recht allein:** Ein Link nur mit „Neustart“ darf einen gestoppten Server nicht starten (sonst wäre es heimlich „Starten“). Passt das?
- **Türöffner mit Step-up:** Tür öffnen fragt nach der Bestätigung zusätzlich nach dem TOTP-Code (gilt 15 Min), damit ein gestohlenes Session-Cookie die Haustür nicht öffnen kann. Zu umständlich?
- **Wandgerät-Token wiederverwendbar:** Der Link fürs Tablet gilt, bis das Gerät gelöscht wird (Kiosk-Browser laden oft die Start-URL neu und verlieren Cookies). Sicherer wäre ein Einmal-Token, dann muss das Tablet bei Cookie-Verlust neu gekoppelt werden. Lieber einmalig?
- **Konsole pro Server:** höchstens 2 gleichzeitig, 15 Min ohne Eingabe und 60 Min insgesamt, dann wird getrennt. Passt das?
- **Arm64-Agent mit Konsole:** Die PTY-Bibliothek kommt als fertiges Binary; auf dem Raspberry Pi und der Oracle-ARM-VM ist das in CI gebaut, aber nicht am echten Gerät ausprobiert.
- **Level für Updates/Neustart nötig:** derzeit `warn` (wie SPEC 5.1). Mit Push ab M4 wären das gesammelte Pushes alle 30 Min. Lieber `info` (kein Push)?

## Annahmen

- **Trivy-Ausnahme (bis 15.01.2027):** Im Agent-Image steckt das offizielle `docker compose`-Binary mit einer HIGH-Lücke in `golang.org/x/net` (HTML-Parser, CVE-2026-78661). Compose parst kein fremdes HTML, und es gibt noch keine Version mit Fix. Die Ausnahme steht in `apps/agent/.trivyignore` und läuft am 15.01.2027 ab; dann schlägt CI wieder an.

- Sicherheitstests liegen in Dateien mit `security` im Namen und laufen zusätzlich als eigener Job `security tests` in GitHub Actions.

- **Eigene Container geschützt:** Agent und Core tragen das Label `hz.role` (in den Compose-Dateien unter `deploy/`). Der Agent lehnt Stoppen, Neustart und Update dafür ab (auch für den eigenen Container über die Container-ID). Wer den Agent schon vor M3 ohne Label installiert hat, startet ihn einmal neu mit der neuen Compose-Datei (`deploy/install-agent.sh` erneut ausführen). Die Knöpfe sind in der Oberfläche noch sichtbar und liefern dann „nicht erlaubt“; ausblenden kommt später.
- **Kleinigkeiten aus dem M3-Review, später:** Ein neuer Container, der beim Update sofort mit Exit 0 endet, gilt als Erfolg (kein Rollback). Fehler in Docker-Event-Handlern werden still verworfen. Der Log-Demuxer hat keine Obergrenze für die Frame-Größe (Docker ist vertrauenswürdig).

- **Kleinigkeiten aus dem M9-Review, später:** Eine offene Konsole läuft über die 15 Min Step-up hinaus weiter (bis 15 Min ohne Eingabe bzw. 60 Min gesamt). TOTP neu einrichten beendet die anderen Sessions, erzeugt aber keine neuen Wiederherstellungscodes. Der Wandmodus nutzt eigene Schriftgrößen statt der `wall-*`-Klassen und ein flexibles Raster statt fix 2×2. Die Bundle-Grenze (400 kB gzip, derzeit etwa 160 kB beim Start) wird nicht automatisch im CI geprüft. Für die Repo-Detailseite gibt es keinen Screenshot, weil die Tests keinen GitHub-Token haben.

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
- Feld „Netz: zuhause/Oracle/VPS“ am Server, damit der Hinweis zur Portweiterleitung nicht aus dem Namen geraten wird.
- Gameserver in der Befehlspalette; Ports nachträglich ändern; Wiederherstellen eines Backups per Knopf.
- Docker-Labels im Inventar, damit Gameserver-Container über `homelab.game` statt über Ordner/Name erkannt werden.

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

- Konsole: mehrere Tabs, Datei-Upload per Drag & Drop, gespeicherte Befehle.
- Wandmodus: Kalender, Wetter und Öffi-Abfahrten (Wiener Linien) als Kacheln.
- Export automatisch jede Nacht auf einen zweiten Server (verschlüsselt).

### Sonstiges
- Roblox-/Evelon-Statistiken.
- SoundOS-Steuerung (FastAPI auf dem Pi): Status, Neustart, Logs.
- Paket-Tracking (Post, DHL) als Kachel.
- Pi-hole/AdGuard-Statistiken.
- Tailscale-Geräteliste mit „zuletzt online“ und Ablauf der Schlüssel.
- Zertifikats- und Domain-Übersicht für alle Domains an einem Ort.
