# Offene Fragen, To-dos für den Admin und Ideen

Diese Datei wird bei jedem Meilenstein aktualisiert. Technische Detailfragen der Agents stehen zusätzlich in `docs/QUESTIONS.md`.

## Was der Admin selbst tun muss

Alles hier braucht deine Zugänge oder ist nicht rückgängig zu machen. Bis dahin läuft der Code mit Platzhaltern bzw. Demo-Daten (`HZ_DEMO=1`).

1. **Core auf dem Heimserver starten:** `.env` aus `.env.example` anlegen, `HZ_SECRET_KEY` mit `openssl rand -base64 32` erzeugen und sicher aufheben (ohne ihn sind alle gespeicherten Secrets verloren), dann `docker compose -f deploy/docker-compose.core.yml up -d --build`.
2. **Tailscale serve einrichten:** `tailscale serve --bg --https=443 http://127.0.0.1:8080` auf dem Heimserver, MagicDNS und HTTPS-Zertifikate im Tailscale-Admin aktivieren. `HZ_BASE_URL` auf `https://heimserver.<tailnet>.ts.net` setzen.
3. **Erstes Setup:** Den einmaligen Setup-Link aus `docker compose logs core` öffnen, Konto anlegen, TOTP in der Authenticator-App einrichten, die 10 Wiederherstellungscodes offline sichern.
4. **Push aufs Handy (ab M4):** In `.env` `HZ_VAPID_SUBJECT=mailto:<deine Adresse>` setzen (Apple lehnt Pushes ohne echte Adresse ab). Die VAPID-Schlüssel erzeugt der Core beim ersten Start selbst und speichert sie verschlüsselt; wer sie fest haben will, erzeugt sie mit `pnpm --filter @hz/core vapid` und trägt `HZ_VAPID_PUBLIC`/`HZ_VAPID_PRIVATE` ein. Dann am Handy die Zentrale über `https://…ts.net` öffnen, „Zum Home-Bildschirm“ (iOS braucht die installierte PWA für Push) und unter Einstellungen → Push „Auf diesem Gerät aktivieren“, danach „Testnachricht senden“.
5. **GitHub verbinden (ab M5):** Auf github.com unter Settings → Developer settings → Fine-grained tokens einen Token anlegen: nur die gewünschten Repos, Rechte *Contents: Read*, *Actions: Read*, *Metadata: Read*. In der Zentrale unter Einstellungen → GitHub eintragen (fragt nach dem TOTP-Code). Für private Repos pro Deploy-Ziel „Deploy-Key erzeugen“ und den angezeigten Schlüssel im Repo unter Settings → Deploy keys eintragen (ohne Schreibrecht). Zielordner unter `/opt/homelab/apps/` am besten vom ersten Deploy anlegen lassen; ein von Hand angelegter Ordner muss leer sein (außer `.env`) und root gehören, sonst lehnt git ihn ab. Gelöschte Deploy-Ziele lassen ihren privaten Key auf dem Server unter `/data/deploy-keys/` liegen (bei GitHub den Deploy-Key dann auch entfernen).
6. **Agent neu ausrollen (ab M3, erneut ab M6):** Auf Servern, die schon einen Agent haben, `deploy/install-agent.sh` erneut ausführen (neues Image mit `ping`, Schutz-Label `hz.role`, ab M6 `tar`/`zstd` für Gameserver-Backups). Valheim und CS2 gibt es nur für amd64, also nicht auf dem Raspberry Pi und der Oracle-ARM-VM.
7. **Gameserver für Freunde erreichbar machen (ab M6):** Die Zentrale zeigt pro Gameserver, welche Ports weitergeleitet werden müssen. Das machst du selbst: am Heimserver im Router (Portweiterleitung auf die feste LAN-IP des Heimservers), bei Oracle in der Security List der VM *und* in iptables auf der VM. Für eine schöne Adresse (z. B. `mc.<deine-domain>`) einen DNS-/DDNS-Eintrag anlegen und im Gameserver unter Einstellungen als externe Adresse eintragen. Die Zentrale selbst bleibt dabei nur über Tailscale erreichbar.
8. **Share-Gateway (optional, ab M7):** Nur wenn Freunde ohne Tailscale Links nutzen sollen. Anleitung in `deploy/README.md` → „Share-Gateway auf oracle-a1“: DDNS-Namen anlegen, in der Oracle Security List und in iptables 80/443 öffnen, Caddy installieren, in der Zentrale unter Einstellungen → Share-Gateway einen Token erzeugen und auf oracle-a1 in `/etc/homelab-share/share.env` eintragen, dann einschalten. Ohne Gateway funktionieren Links nur im Tailnet (sicherer Standard). Die Zentrale selbst bleibt dabei nie öffentlich.
9. **Home Assistant verbinden (ab M8):** In HA unter Profil → Sicherheit einen Long-Lived Access Token anlegen. In der Zentrale unter Einstellungen → Home Assistant die URL (z. B. `http://<heimserver-LAN-IP>:8123`) und den Token eintragen (fragt nach dem TOTP-Code), dann unter „Wohnung: Räume und Geräte“ Räume anlegen und Geräte auswählen. Türöffner (BTicino/Shelly) als Art „Taster“ eintragen. Strompreis €/kWh und die Sensoren für Leistung (W) und Energie (kWh) wählen.
10. **Web-Konsole einschalten (ab M9, nur wo gewünscht):** Die Konsole ist pro Server zweimal aus: Auf dem Server in der Agent-`.env` `HZ_AGENT_ALLOW_TERMINAL=1` setzen und den Agent neu starten (`deploy/install-agent.sh` erneut ausführen, das neue Image enthält die PTY-Bibliothek), dann in der Zentrale unter Einstellungen → Server „Konsole erlaubt“ einschalten. Öffnen fragt nach dem TOTP-Code; jede Sitzung steht im Protokoll (ohne Inhalte). Empfehlung: nur am Heimserver, nicht auf der öffentlichen Oracle-VM.
11. **Wandmodus aufs Tablet (ab M9):** Unter Einstellungen → Wandmodus ein Gerät anlegen (fragt nach dem TOTP-Code), den QR-Code mit dem Tablet scannen und die Seite als Startseite bzw. im Kiosk-Browser festlegen. Das Gerät darf nur den Wandzustand lesen; verliert man das Tablet, das Gerät in den Einstellungen löschen.
12. **Datenbank sichern:** Unter Einstellungen → Export lädt die ganze SQLite-Datenbank herunter (Step-up). Die Secrets darin sind verschlüsselt; ohne `HZ_SECRET_KEY` ist das Backup für Secrets wertlos, also beides getrennt aufbewahren.
13. **Images öffentlich lesbar machen (einmalig):** Nach dem ersten Lauf von `images.yml` auf `main` unter github.com → dein Profil → Packages bei `homelab-agent`, `homelab-core` und `homelab-share` die Sichtbarkeit auf „Public“ stellen (sonst brauchen die Server ein `docker login ghcr.io`).
14. **Prioritäten setzen (ab M10):** Im Container-Detail deine wichtigen Apps (z. B. prepped) auf `wichtig` stellen, Gameserver auf `niedrig` und bei Bedarf „darf gestoppt werden“. Schwellen, Zeitpläne und RAM-Reserve stehen im Serverdetail unter „Automatik“ (Standard: CPU oder RAM über 90 % für 2 Min).
15. **Neue Server anbinden (ab M11):** Unter Server → „Server hinzufügen“ Name eingeben, TOTP bestätigen, den angezeigten Einzeiler am neuen Server als root ausführen (braucht Docker und Tailscale). Dafür muss `HZ_BASE_URL` auf deine `https://…ts.net`-Adresse gesetzt sein, sonst gibt es keinen Einzeiler.
16. **UGREEN-NAS anbinden (ab M13):** In UGOS Pro unter Systemsteuerung → Terminal SSH einschalten, Docker aus dem App Center installieren und Tailscale aufs NAS bringen (Tailscale-App aus dem App Center bzw. als Docker-Container mit `network_mode: host`; der Einzeiler prüft `tailscale status`). Dann in der Zentrale „Server hinzufügen“ und den Einzeiler per SSH als root (`sudo -i`) am NAS ausführen. SMART schaltet sich auf UGREEN-Hardware selbst ein. Danach SSH in UGOS wieder ausschalten, wenn du es nicht brauchst.
17. **Anbindungen einschalten (ab M14):** Unter Einstellungen → Module das jeweilige Modul einschalten (fragt nach dem TOTP-Code), dann unter Einstellungen → Anbindungen URL und Zugangsdaten eintragen und „Verbindung testen“. Wechselt später die Adresse, musst du das Token neu eintragen.
18. **Proxmox (ab M14):** In Proxmox unter Datacenter → Permissions → API Tokens einen Token anlegen, am besten für einen eigenen Benutzer (z. B. `hz@pve`) mit der Rolle `PVEVMUser` auf `/vms` und `PVEAuditor` auf `/` (sehen, starten, stoppen, aber nichts löschen). „Privilege Separation“ an lassen und die Rechte dem Token geben. In der Zentrale Token-ID (`hz@pve!zentrale`) und Secret eintragen, URL `https://<proxmox-LAN-IP>:8006`. Proxmox hat ein selbst signiertes Zertifikat: den Inhalt von `/etc/pve/pve-root-ca.pem` (vom Proxmox-Host) als CA-Zertifikat einfügen.
19. **Pi-hole oder AdGuard Home (ab M14):** Pi-hole ab v6: unter Settings → Web interface / API ein **App-Passwort** erzeugen und in der Zentrale als Passwort eintragen, URL `http://<pihole-IP>`. AdGuard Home: Benutzer und Passwort des Web-Logins, URL `http://<adguard-IP>:3000` (bzw. der Port deiner Oberfläche). Pi-hole v5 wird nicht unterstützt.
20. **FRITZ!Box (ab M14):** In der FRITZ!Box unter Heimnetz → Netzwerk → Netzwerkeinstellungen „Zugriff für Anwendungen zulassen“ (TR-064) einschalten. Unter System → FRITZ!Box-Benutzer einen eigenen Benutzer (z. B. `zentrale`) mit dem Recht „FRITZ!Box Einstellungen“ anlegen. In der Zentrale URL `http://<fritzbox-IP>:49000`, Benutzer und Passwort eintragen. Neustart der Box aus der Zentrale fragt nach dem TOTP-Code.
21. **Uptime Kuma (ab M14):** In Kuma unter Settings → API Keys einen Schlüssel anlegen. In der Zentrale URL `http://<kuma-IP>:3001` und den Schlüssel eintragen. Unter Websites → Uptime Kuma die Monitore auswählen und „Übernehmen“; für Ping-Monitore einen Agent wählen. Danach kannst du Kuma abschalten, wenn du willst.
22. **Wake-on-LAN (ab M14):** Im BIOS/UEFI des Servers Wake-on-LAN einschalten und unter Linux mit `ethtool -s <nic> wol g` dauerhaft aktivieren (z. B. per systemd-Unit oder Netplan `wakeonlan: true`). In der Zentrale im Server-Detail die MAC-Adresse eintragen. Sender ist die Zentrale (wenn sie im selben LAN läuft) oder ein Agent im selben Netz; Magic Packets gehen nicht über Tailscale und nicht über das Internet.
23. **Meldungen auf Discord, Telegram oder ntfy (ab M14):** Discord: Servereinstellungen → Integrationen → Webhooks → „Neuer Webhook“, URL kopieren. Telegram: bei @BotFather einen Bot anlegen (Token), dem Bot eine Nachricht schreiben und die Chat-ID z. B. über @userinfobot holen. ntfy: Server (Standard `https://ntfy.sh`, besser selbst gehostet) und ein schwer zu ratendes Thema wählen, bei eigenem Server optional ein Zugriffstoken (`tk_…`). Alles unter Einstellungen → Meldungskanäle eintragen (fragt nach dem TOTP-Code) und „Testnachricht“ drücken. IP-Adressen werden in diesen Nachrichten maskiert.

24. **Game-Relay einrichten (ab M15):** Auf dem Server mit öffentlicher IP (z. B. der Oracle-VM) den Agent neu ausrollen mit `deploy/install-agent.sh --allow-relay` (oder `HZ_AGENT_ALLOW_RELAY=1` in der Agent-`.env`). In der Zentrale unter Einstellungen → Eingänge den Server als Eingang einschalten und einen Portbereich wählen, genau diesen Bereich (TCP und UDP) in der Firewall des Anbieters öffnen (bei Oracle: Security List und iptables). Dann im Gameserver unter „Erreichbar über“ den Eingang wählen. Für einen festen Namen wie `mc.<deine-domain>` das Modul „Domains“ einschalten und unter Internet → Domains einen Cloudflare- oder DuckDNS-Anbieter anlegen, dessen Zone den Namen enthält (siehe unten). Die Zentrale legt den A-Record dann selbst an; er steht dort als „Game-Relay“ in der Liste.

### Automatik, Domains und Apps (ab M20/M21)

- **Module einschalten:** Einstellungen → Module: „Geplante Aufgaben“ und „Domains“ fragen nach dem TOTP-Code, „Selbstheilung“, „Speedtest“ und „Apps“ nicht. Alle sind anfangs aus.
- **Befehl-Aufgaben (nur wo gewünscht):** Freie Shell-Befehle als geplante Aufgabe laufen nur auf Servern, deren Agent mit `--tasks` installiert ist (Einzeiler `… -- <code> --tasks` oder `deploy/install-agent.sh --tasks`, setzt `HZ_AGENT_ALLOW_TASKS=1`). Empfehlung wie bei der Konsole: nicht auf öffentlichen VPS.
- **Speedtest:** Unter Internet → Speedtest den Server wählen, der misst (am besten der Heimserver). Eine Messung braucht bis zu 2 × die eingestellte Datenmenge (Standard 2 × 100 MB, alle 6 Stunden ≈ 24 GB im Monat); bei Volumentarif Datenmenge oder Intervall senken.
- **Cloudflare:** Unter dash.cloudflare.com → Profil → API-Tokens einen Token mit *Zone → DNS → Bearbeiten* nur für deine Zone anlegen und unter Internet → Domains eintragen.
- **DuckDNS:** Auf duckdns.org anmelden, Subdomain anlegen, Token kopieren und unter Internet → Domains eintragen.
- **Zertifikate:** Zuerst mit „Let's Encrypt Staging“ testen, dann auf Produktion umstellen (Let's Encrypt begrenzt fehlgeschlagene Versuche pro Stunde). Die Dateien landen auf den gewählten Servern unter `/opt/homelab/certs/<name>/fullchain.pem` und `privkey.pem`; Dienste müssen sie selbst einbinden und nach einer Verlängerung neu laden.
- **Apps:** Apps lauschen standardmäßig nur auf der Tailscale-IP des Servers. Vaultwarden braucht HTTPS (z. B. `tailscale serve` auf dem Server). Mealie-Standardlogin sofort ändern. Paperless-ngx, Forgejo und Mealie bitte einmal echt testen (Versionen konnte ich nicht in allen Quellen prüfen).

**Noch von Hand abzunehmen** (braucht echte Zugänge): Push am Handy (M4); ein echter Deploy eines Test-Repos mit `compose.yml` auf den Heimserver-Agent (M5, automatisiert nur mit Fake-GitHub, Fake-Agent und echtem git gegen ein lokales Repo getestet). Der echte Türöffner (BTicino/Shelly) mit deiner HA (M8, im CI nur mit der HA-Demo getestet). Benutzerlink von außen über das Gateway auf oracle-a1 (M7, im CI nur lokal getestet). SMART auf dem echten UGREEN-NAS (M13, im CI nur mit simuliertem `smartctl` und einem nachgebauten `/sys` getestet).

24. **Log-Suche, Schwachstellen-Scan, Fail2ban (ab M18):** Unter Einstellungen → Module einschalten. Danach auf jedem Server den Agent neu ausrollen (`deploy/install-agent.sh` erneut ausführen), ältere Agents melden „Agent zu alt“. Der Scan lädt beim ersten Lauf das Trivy-Image und dessen Datenbank (rund 1 GB im Volume `hz-trivy-cache` pro Server); Uhrzeit unter Sicherheit → Schwachstellen. Fail2ban muss auf dem Host installiert sein.
25. **Discord-Bot (ab M18):** Im Discord Developer Portal eine Application anlegen, unter „Bot“ den Token kopieren, Application-ID und die ID deines Discord-Servers (Entwicklermodus → Rechtsklick auf den Server → „Server-ID kopieren“) in der Zentrale unter Einstellungen → Discord-Bot eintragen (fragt nach dem TOTP-Code), dann den angezeigten Einladungslink öffnen. Pro Freund im Benutzerlink-Abschnitt die Discord-User-ID eintragen; nur diese Freunde dürfen Befehle nutzen.
26. **Echo Show und Alexa (ab M18, Sprachsteuerung):** In Home Assistant pro Gameserver zwei Helfer anlegen: Schalter (`input_boolean.minecraft`) und optional Text (`input_text.minecraft_status`). Den Schalter an Alexa freigeben: mit Nabu Casa (Home Assistant Cloud) oder kostenlos mit `emulated_hue` im LAN. Dann in der Zentrale unter Einstellungen → Sprachsteuerung zuordnen. Auf der Echo Show das HA-Dashboard im Silk-Browser öffnen („Alexa, öffne Silk“) und die Helfer als Karten anzeigen. Die Zentrale selbst bleibt nur über Tailscale erreichbar.

27. **Cloud-Server bei Azure (ab M22):** Einmalig im Azure-Portal (portal.azure.com) oben die Cloud Shell (Bash) öffnen und eingeben:
    - `az group create -n homelab-zentrale -l germanywestcentral` (eigene Ressourcengruppe, nur darin darf die Zentrale etwas tun)
    - `az ad sp create-for-rbac --name homelab-zentrale --role Contributor --scopes $(az group show -n homelab-zentrale --query id -o tsv)` gibt `appId` (App-ID), `password` (Client-Secret) und `tenant` (Tenant-ID) aus. Das Secret nur einmal sichtbar, gleich in die Zentrale übernehmen.
    - `az account show --query id -o tsv` ist die Abo-ID.
    - Als zweite Bremse unter Kostenverwaltung → Budgets ein Budget für die Ressourcengruppe mit E-Mail-Warnung anlegen (z. B. 20 €).

    Tailscale: im Admin unter Access controls `"tagOwners": {"tag:homelab-cloud": ["autogroup:admin"]}` ergänzen, dann unter Settings → Keys einen Auth-Key erzeugen: *Reusable*, *Pre-approved*, Tag `tag:homelab-cloud`, Ablauf höchstens 90 Tage (danach einen neuen eintragen; laufende Cloud-Server bleiben verbunden). Wenn du ACLs nutzt: `tag:homelab-cloud` muss die Zentrale auf Port 443 erreichen.

    In der Zentrale unter Einstellungen → Module „Cloud-Server“ einschalten (TOTP), dann auf der Seite „Cloud“ Tenant-ID, App-ID, Secret, Abo-ID, Ressourcengruppe `homelab-zentrale`, Region und Tailscale-Key eintragen und „Verbindung testen“. Danach beim Anlegen eines Gameservers als Ziel „Neuer Azure-Server“ wählen. Hinweis: Das Startguthaben eines Azure-Free-Kontos gilt 30 Tage; danach muss das Konto auf „Pay-As-You-Go“ umgestellt werden, sonst schaltet Azure die VMs ab. Die Free-Tier-Größe `B2ats_v2` (1 GB RAM, 750 h/Monat für 12 Monate) reicht nur für sehr kleine Spiele.

28. **Server mit einem Befehl anbinden, ohne Login-Klick (ab M11b):** Einmalig in der Tailscale-Konsole (login.tailscale.com/admin):
    - Access controls: in `tagOwners` den Eintrag `"tag:homelab-server": ["autogroup:admin"]` ergänzen und speichern (die Zentrale zeigt das Snippet unter Einstellungen → Tailscale). Wenn du eigene ACLs hast: `tag:homelab-server` muss die Zentrale auf Port 443 erreichen.
    - Settings → OAuth clients (neuere Konsole: Trust credentials) → „Generate OAuth client“: Scope **Auth Keys** mit **Write**, Tag `tag:homelab-server` auswählen, erzeugen. Client-ID und Secret (`tskey-client-…`, nur einmal sichtbar) kopieren.
    - In der Zentrale unter Einstellungen → Tailscale Client-ID und Secret eintragen, Speichern (fragt nach dem TOTP-Code). Status muss „bereit“ zeigen.

    Danach unter Server → „Server hinzufügen“ den angezeigten Befehl auf dem neuen Server einfügen. Er installiert Tailscale und Docker, meldet den Server mit einem Einweg-Schlüssel an (gilt 15 Min) und startet den Agent. Ohne diesen Schritt geht es auch: dann zeigt der Befehl einen Login-Link, den du einmal öffnest.

## Entschieden (26.11.2026)

- Ein PR pro Meilenstein auf dem festen Arbeitsbranch bleibt so.
- Repo ist öffentlich; CodeQL und Dependency-Review laufen jetzt (`.github/workflows/codeql.yml`).
- „Server hinzufügen“ braucht Step-up.
- Images kommen aus der GitHub Container Registry (`ghcr.io/puffybooy/homelab-{agent,core,share}`), lokaler Bau bleibt möglich (`HZ_BUILD_LOCAL=1`, `docker-compose.*.build.yml`).
- Ein widerrufener Server kann sich unter demselben Namen neu anmelden und behält seinen Verlauf.
- Checks (2 Fehlschläge), Deploy ohne CI, Neustart-Recht allein, Konsolen-Grenzen: bleiben wie gebaut.
- Pushes in der Ruhezeit kommen morgens gesammelt („Über Nacht: N Meldungen“).
- Gameserver-Ports lassen sich ändern, mit Hinweis zur Portweiterleitung.
- Backups gelöschter Gameserver werden nach 30 Tagen gelöscht.
- Benutzerlinks erstellen und widerrufen braucht Step-up.
- Türöffner behält Bestätigung plus Step-up.
- Wandgerät-Link gilt nur einmal; „Neuen Link“ koppelt ein Tablet neu.
- „Updates verfügbar“ und „Neustart nötig“ sind `info` (kein Push).
- Die App ist für jeden deploybar: nichts Persönliches im Code, Zeitzone über `HZ_TIMEZONE`, GitHub, Home Assistant und Gameserver sind Module zum An- und Ausschalten.

## Offene Fragen

- **Prioritäten (M10):** „prepped“ kommt im Repo nicht vor; Annahme: eine eigene App, die als Container läuft. Du markierst sie selbst als `wichtig`, Gameserver als `niedrig`. Standard-Schwelle CPU oder RAM über 90 % für 2 Min, Drosseln auf 1 Kern, Stoppen erst nach weiteren 5 Min und nur mit „darf gestoppt werden“, nie mit Spielern online (außer ausdrücklich erlaubt). Passt das?
- **Schlafmodus (M12):** Neue Gameserver schlafen standardmäßig nach 15 Min ohne Spieler und wachen beim Verbinden auf. Bestehende Server bleiben, wie sie sind (Aufwecken aus), bis du es in den Einstellungen einschaltest. Passt das?
- **Wandmodus-Zeitzone:** Die Wandseite zeigt die Zeit in der Zone des Tablets (sie hat keine Admin-Session). Soll der Core die Zeitzone mitschicken?

- **NAS (M13):** Hast du ein UGREEN NASync (welches Modell, wie viele Platten, welches RAID)? Davon hängt ab, ob die Erkennung „UGREEN-NAS“ greift (DMI-Hersteller `UGREEN`). Soll das NAS auch Gameserver-Backups bekommen (M13b, nach dem Gameserver-Meilenstein)? Und sollen Gameserver selbst auf dem NAS laufen dürfen? Dann sollte `/opt/homelab` auf dem Datenvolume liegen (das Systemvolume von UGOS ist klein), z. B. per Bind-Mount von `/volume1/homelab`.

- **Medienordner für Apps (M21):** Jellyfin, Navidrome und Audiobookshelf sehen aus Sicherheitsgründen nur ihren eigenen Ordner `/opt/homelab/apps/<name>/data/`. Sollen sie zusätzlich einen Medienordner (z. B. vom NAS) nur lesend einbinden dürfen? Vorschlag: pro App freigegebene Ordner mit Step-up, nur lesend.
- **IPv6 für DynDNS (M20):** Der Agent meldet nur eine öffentliche IP. AAAA-Einträge funktionieren erst, wenn er auch die IPv6 meldet. Brauchst du IPv6-Einträge?
- **NAS als Backup-Ziel (M13b):** Für dein DH2300 habe ich die Variante ohne Agent gebaut. Du musst am NAS nur eine Freigabe und einen Benutzer anlegen und sie am Heimserver einbinden (Schritte in `deploy/README.md`, Abschnitt „NAS ohne Agent als Backup-Ziel“). Danach unter Einstellungen → Backup die Kopien einschalten. Bewahre `HZ_SECRET_KEY` getrennt vom NAS auf (z. B. im Passwort-Manager), sonst ist die Datenbank-Kopie nach einem Totalausfall wertlos.

## Annahmen

- **Echo Show ohne Wandmodus der Zentrale:** Eine Echo Show kann nicht ins Tailnet, also kann sie die Zentrale (nur `*.ts.net`) nicht öffnen. Statt sie öffentlich zu machen, läuft die Echo-Show-Anzeige über das Home-Assistant-Dashboard im Silk-Browser, das die Zentrale über die HA-Helfer mit Status versorgt. Ein eigener Alexa-Skill bräuchte einen öffentlichen HTTPS-Endpunkt oder eine AWS-Lambda im Tailnet; das ist bewusst nicht gebaut (siehe Zukunftsideen).
- **Discord-Bot ohne PIN:** Ein Benutzerlink mit PIN wirkt im Bot ohne PIN, weil du die Discord-ID selbst bindest. Wer das nicht will, bindet keine Discord-ID an diesen Link.
- **Schwachstellen-Scan nur für Registry-Images:** Trivy prüft das Image direkt in der Registry (per Digest), damit der Scanner keinen Docker-Socket braucht. Selbst gebaute Images ohne Registry-Digest stehen als „nicht prüfbar“ da. Gemeldet wird ab „kritisch“ (einstellbar auf „hoch“).
- **NAS als Backup-Ziel (M13b):** Jeder Server kopiert nur die Backups der Spiele, die auf ihm laufen, auf seine eigene eingebundene Freigabe. Laufen Spiele auf einem Cloud-Server, braucht der die Freigabe selbst (über Tailscale) oder sie werden nicht aufs NAS kopiert. Standard: 05:00 Uhr, 14 Kopien. Die Freigabe wird nicht automatisch eingebunden (keine Zugangsdaten in der Zentrale); fällt sie weg, meldet die Zentrale das, statt auf die lokale Platte zu schreiben.
- **NAS ohne UGOS-Schnittstelle (M13):** UGOS Pro hat keine dokumentierte API. Der Agent liest deshalb den Linux-Unterbau selbst (`/proc/mdstat`, `/sys`, `smartctl`). Speicherpools mit SHR-ähnlichen Mischformen erscheinen als mehrere md-Arrays. Ein UGOS-Update kann Pfade ändern; dann fehlen Teile der Anzeige, nichts geht kaputt.
- **SMART-Rechte:** SMART braucht `CAP_SYS_RAWIO` und Lesezugriff auf die Platten. Der Agent hat ohnehin Docker-Socket und `SYS_ADMIN` (gleichwertig zu root), das Override verschiebt die Grenze also kaum; es gibt bewusst kein Schreibrecht (`w`) auf Blockgeräte. Ohne Override zeigt die Zentrale Platten, RAID und Volumes, aber keine SMART-Werte, und sagt das.
- **Anbindungen (M14):** Pi-hole nur ab v6 (REST-API), v5 nicht. Uptime Kuma wird über `/metrics` gelesen (das ist die einzige stabile Schnittstelle mit API-Key); Kuma-Benachrichtigungen und Statusseiten werden nicht übernommen. DNS-Blocken lässt sich nur befristet pausieren (5–60 Min). Wake-on-LAN geht nur im selben LAN (Broadcast), nie über Tailscale. Meldungskanäle folgen denselben Regeln wie Push (Ruhezeit, Bündeln), mit eigenem Mindest-Level pro Kanal.

- **Game-Relay (M15):** Die Gameserver sehen bei Relay-Verbindungen die Tailscale-IP des Eingangs statt der Spieler-IP; IP-Bans im Spiel wirken deshalb nicht pro Spieler (Whitelist nutzen). Pro Spieler-IP sind höchstens 16 TCP-Verbindungen und 16 UDP-Sitzungen erlaubt. Gefälschte UDP-Absender können bei voller Route alte Sitzungen verdrängen. Wird ein Gameserver mit Relay gelöscht, bleibt sein Cloudflare-Eintrag stehen (von Hand löschen). DuckDNS kann Einträge nicht löschen. Die DNS-Anbindung zieht später in das Modul Domains (M20) um.

- **Trivy-Ausnahme (bis 15.01.2027):** Im Agent-Image steckt das offizielle `docker compose`-Binary mit einer HIGH-Lücke in `golang.org/x/net` (HTML-Parser, CVE-2026-78661). Compose parst kein fremdes HTML, und es gibt noch keine Version mit Fix. Die Ausnahme steht in `apps/agent/.trivyignore` und läuft am 15.01.2027 ab; dann schlägt CI wieder an.

- **Geplante Aufgaben (M20):** Verpasste Läufe (Zentrale war aus) werden nicht nachgeholt. Gameserver-Container sind für Aufgaben gesperrt (dafür gibt es die Zeitpläne im Gameserver). Container müssen beim Anlegen im Inventar bekannt sein.
- **Selbstheilung (M20):** „Absturz“ heißt Exit-Code ungleich 0 bei einem Container, den die Zentrale laufen gesehen hat. Ein einzelner Neustart erscheint im Verlauf und im Protokoll, aber nicht als Push; erst „aufgegeben“ meldet sich (CRIT).
- **Zertifikate (M20):** Schlägt eine Verlängerung fehl, bleibt das alte Zertifikat gültig, die Zentrale versucht es nach 1 h, 6 h und 24 h erneut und meldet sich spätestens 14 Tage vor Ablauf. Für die DNS-Prüfung fragt die Zentrale 1.1.1.1 und 8.8.8.8, nicht den Heim-DNS (Split-DNS würde sonst täuschen). DuckDNS kennt nur einen TXT-Eintrag pro Subdomain, deshalb laufen die Bestätigungen nacheinander.
- **Compose-Projektnamen (M21):** Ein neuer Stack bekommt seinen Projektnamen fest per `-p`; ist der Name schon von einem anderen Stack belegt (oder gehört dazu die Zentrale/der Agent), lehnt der Agent ab. Ein Repo, dessen `compose.yml` den Projektnamen aus einer Variable baut (`name: ${…}`), wird beim ersten Deploy abgelehnt; dann `name:` fest eintragen.
- **App-Store (M21):** Compose-Dateien werden streng geprüft (nur bekannte Optionen; kein privileged, kein Docker-Socket, keine Host-Pfade, kein Host-Netz). Parameterwerte stehen in `.env` in einfachen Anführungszeichen, `'` und `\` sind darin nicht erlaubt. Eigene Vorlagen dürfen Muster (Regex) für Textfelder angeben; da nur der Admin Vorlagen anlegt, ist das kein Angriffsweg von außen.

- Sicherheitstests liegen in Dateien mit `security` im Namen und laufen zusätzlich als eigener Job `security tests` in GitHub Actions.

- **Eigene Container geschützt:** Agent und Core tragen das Label `hz.role` (in den Compose-Dateien unter `deploy/`). Der Agent lehnt Stoppen, Neustart und Update dafür ab (auch für den eigenen Container über die Container-ID). Wer den Agent schon vor M3 ohne Label installiert hat, startet ihn einmal neu mit der neuen Compose-Datei (`deploy/install-agent.sh` erneut ausführen). Die Knöpfe sind in der Oberfläche noch sichtbar und liefern dann „nicht erlaubt“; ausblenden kommt später.
- **Kleinigkeiten aus dem M3-Review, später:** Ein neuer Container, der beim Update sofort mit Exit 0 endet, gilt als Erfolg (kein Rollback). Fehler in Docker-Event-Handlern werden still verworfen. Der Log-Demuxer hat keine Obergrenze für die Frame-Größe (Docker ist vertrauenswürdig).

- **Kleinigkeiten aus dem M9-Review, später:** Eine offene Konsole läuft über die 15 Min Step-up hinaus weiter (bis 15 Min ohne Eingabe bzw. 60 Min gesamt). TOTP neu einrichten beendet die anderen Sessions, erzeugt aber keine neuen Wiederherstellungscodes. Der Wandmodus nutzt eigene Schriftgrößen statt der `wall-*`-Klassen und ein flexibles Raster statt fix 2×2. Die Bundle-Grenze (400 kB gzip, derzeit etwa 160 kB beim Start) wird nicht automatisch im CI geprüft. Für die Repo-Detailseite gibt es keinen Screenshot, weil die Tests keinen GitHub-Token haben.

## Zukunftsideen

Sortiert nach Bereich. Nichts davon ist in den Meilensteinen, alles wäre ein eigener kleiner Ausbau.

### Server und Betrieb
- Alexa-Skill für Freunde über das Share-Gateway (Status abfragen, Gameserver starten per Stimme mit Benutzerlink-Rechten), falls Sprachsteuerung ohne Home Assistant gewünscht ist.
- Log-Suche als gespeicherte Suche mit Meldung („Melde mich, wenn `OutOfMemory` vorkommt“).
- NAS als Backup-Ziel auch für Server ohne eingebundene Freigabe: Backups über die Zentrale an den Server mit Freigabe weiterreichen (heute kopiert jeder Server nur seine eigenen Spiele).
- Wiederherstellen direkt vom NAS (Backup-Liste zeigt auch die Kopien auf dem NAS).
- RAID-Prüfung (Scrub) per Zeitplan anstoßen und das Ergebnis melden; btrfs-Scrub und -Fehlerzähler auslesen.
- Speicherplatz-Prognose: „/volume1 ist in etwa 40 Tagen voll“ aus dem Verlauf.
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
- Deploy-Freigabe per Push-Nachricht („Deploy von my-app auf raspi freigeben?“).
- Secrets-Verwaltung für `.env`-Dateien der Apps (verschlüsselt im Core, beim Deploy geschrieben).
- GitHub-App statt Token, damit Rechte feiner sind.
- Release-Notes automatisch aus Commits beim Deploy.

### Gameserver
- Umgesetzt in M12: Schlafmodus mit Aufwecken beim Verbinden, Zeitpläne (Neustart/Backup), Discord-Webhook, Spielerstatistik, Mods/Plugins über Modrinth, Welt-Download und Whitelist-Anfragen über Benutzerlinks, Backup wiederherstellen, 7 neue Vorlagen, Netz-Feld am Server, Erkennung über das Label `homelab.game`. Befehlspalette und Ports ändern gab es schon.
- Noch offen: Mods für Forge/NeoForge und CurseForge (braucht API-Key), Modpacks (`.mrpack`), Bedrock-Addons.

### Websites und Meldungen
- ntfy als zweiter Push-Kanal (selbst gehostet), E-Mail als dritter.
- Statusseite nur fürs Tailnet oder öffentlich über das Share-Gateway.
- Check für DNS-Einträge (erwarteter A-Record = Heim-IP), für DDNS-Ausfälle.
- Lighthouse-Werte der eigenen Websites wöchentlich.
- Wartungsfenster: Meldungen für einen Server für 2 h stummschalten.
- Eskalation: crit 15 Min unbestätigt → zweite Push oder Anruf über Home Assistant.

### Wohnung
- Morgen-Briefing auf dem Wandtablet: Wetter, Öffi-Abfahrten, Termine, Müllabfuhr.
- Stromverbrauch pro Server (Shelly-Steckdosen) und Kosten pro Gameserver im Monat.
- Szenen („Gaming-Abend“: Licht dimmen, Minecraft starten).
- Anwesenheit: Gameserver stoppen, wenn niemand online ist und der Admin nicht zu Hause.

### Bedienung
- KI-Befehle in der Befehlspalette („Starte den Minecraft-Server“, „Warum ist oracle-a1 langsam?“).
- Sprachsteuerung über Home Assistant Assist.
- iOS/Android-Widgets über die PWA-Shortcuts.
- Tastatur-Makros und eigene Aktionen in der Palette.
- Dunkles Wandmodus-Layout für Smart Displays.

- Konsole: mehrere Tabs, Datei-Upload per Drag & Drop, gespeicherte Befehle.
- Wandmodus: Kalender, Wetter und Öffi-Abfahrten als Kacheln.
- Export automatisch jede Nacht auf einen zweiten Server (verschlüsselt).

### Sonstiges
- Statistiken eigener Spiele.
- Steuerung eigener Apps (z. B. FastAPI auf dem Pi): Status, Neustart, Logs.
- Paket-Tracking (Post, DHL) als Kachel.
- Tailscale-Geräteliste mit „zuletzt online“ und Ablauf der Schlüssel.
- Zertifikats- und Domain-Übersicht für alle Domains an einem Ort.

## Ideen aus M16/M17 (26.11.2026, Alex fragte „was könnte ich noch einbauen“)
- „Disk voll in X Tagen“: Vorhersage aus dem Verlauf, Meldung eine Woche vorher.
- Auto-Update für eigene Container, pro Container einschaltbar, mit demselben Rollback wie bei der Zentrale.
- Vor einem Update zeigen, was kommt (Commits zwischen den Versionen aus GitHub, wenn das Modul an ist).
- Gestaffelte Updates: zuerst ein Testserver (z. B. der Pi), die anderen erst am nächsten Tag, wenn der gesund blieb.
- Prozess beenden mit Step-up.
- Traffic pro Monat je Server, Warnung vor dem Kontingent der Cloud-VM.
- Sicherheits-Updates getrennt von allen Updates (über `unattended-upgrades`, falls installiert).
- Firewall-Übersicht (ufw/nftables) nur lesend.
