# M27 Gameserver Plus und M28 Projekte hosten (Plan)

Stand: Plan vom 27.11.2026, gebaut wird frühestens ab 29.11.2026 18:00 (Wien), nach M23/M11b. Auswahl des Admins aus der Ideenliste vom 27.11.2026: Gameserver 1, 2, 3, 4, 5 und GitHub-Hosting 8, 9, 10, 12, 13.

---

## M27: Gameserver Plus

Baut auf M6/M12 (Vorlagen, Mods über Modrinth, Backups, Statistik, Discord), M15 (Relay, feste Adresse), M22 (Azure), M24 (Einstellungen als Formular, Testwelt) und M26 (Freunde).

### 1. Spiel-Katalog mit einem Klick
Es gibt schon 13 Vorlagen (Minecraft Java/Bedrock, Valheim, Terraria, Palworld, CS2, Satisfactory, Enshrouded, Factorio, Project Zomboid, ARK, Rust, V Rising). Neu:
- Minecraft-Typen **Forge** und **NeoForge** zusätzlich zu Paper/Vanilla/Fabric (gleiches Image `itzg/minecraft-server`, `TYPE=FORGE|NEOFORGE`).
- **Profile pro Vorlage** (`template.json → presets[]`): z. B. Minecraft „Survival mit Freunden“, „Kreativ“, „Modded“; Valheim „Entspannt“, „Hardcore“. Ein Klick füllt RAM, Einstellungen (M24 `settings[]`), Schlafzeit und Backup-Zeitplan; der Zielserver wird nach freiem RAM und Architektur vorgeschlagen (inkl. „Neuer Azure-Server“).
- Katalogseite mit Bild, RAM-Bedarf, Spielerzahl und „läuft auf: Heimserver / Pi / Azure“.

### 2. Modpacks aus Modrinth und CurseForge
- **Modrinth:** `.mrpack` per Suche oder Link installieren; Version, Loader und Mods kommen aus dem Index; Dateien nur von `cdn.modrinth.com`, sha512 geprüft; Client-only-Mods werden ausgelassen.
- **CurseForge:** braucht einen kostenlosen API-Key (console.curseforge.com), verschlüsselt gespeichert, nur `api.curseforge.com`/`edge.forgecdn.net`. Server-Packs bevorzugt; Mods ohne erlaubten Drittanbieter-Download werden gemeldet statt geladen.
- Vorher automatisches Backup, danach Prüfung „Server startet“ (Log-Muster + Query), sonst zurück zum Backup. Update eines Packs zeigt die Änderungen (neu, entfernt, aktualisiert).
- Freunde bekommen auf ihrer Link-Seite die passende Client-Pack-Datei bzw. den Modrinth-Link.

### 3. Welten-Verwaltung
- Mehrere Welten pro Gameserver unter `worlds/<name>/`, eine ist aktiv. „Welt wechseln“: sauber stoppen, Backup der aktiven, Ziel aktivieren, starten.
- Neue Welt (Seed, Typ), Welt aus Backup oder hochgeladener ZIP (Größe begrenzt, nur in den Welt-Ordner entpackt, keine Pfade mit `..`, keine Symlinks), Welt umbenennen, löschen (Step-up, Name).
- **An Freunde schicken:** ZIP der Welt über einen befristeten Download auf der Link-Seite (vorhandenes Recht „Welt herunterladen“, Ablauf 24 h, einmal pro Stunde).

### 4. Eingeschränkte Live-Konsole für Freunde
- Neues Link-Recht `console` mit **Befehls-Allowlist pro Freund und Gameserver** (z. B. nur `time`, `weather`, `tp <Spieler> <Spieler>`), Argumente nach festen Mustern geprüft (Spielername, Zahl, Auswahl). Kein freier Text an RCON.
- Freund sieht nur die Ausgabe seiner eigenen Befehle und die Chat-/Join-Zeilen (gefiltert, keine IPs, keine Admin-Befehle anderer).
- Rate-Limit pro Freund, Protokoll in `share_audit`, Admin kann Befehle pro Vorlage als Bausteine anbieten („Wetter“, „Zeit“, „Spieler teleportieren“).

### 5. Auto-Skalierung auf Azure
- Regel pro Gameserver (Standard aus): „Ab N Spielern oder TPS unter X für 5 Min auf Größe Y umziehen“, „Unter M Spielern für 30 Min zurück“. Umziehen nur, wenn **niemand online** ist oder zu einer eingestellten Uhrzeit (Spieler würden sonst getrennt), mit Ankündigung per RCON und Discord.
- Ablauf: Backup → Ziel-VM (M22, Größe aus der Empfehlungsliste) starten oder bestellen → Welt übertragen (über Tailscale, sha256 geprüft) → Relay-Ziel (M15) umstellen → alten Container stoppen. Freunde behalten die Adresse.
- Zwei Varianten: dieselbe VM größer machen (Azure „resize“, nur im deallocated-Zustand) oder zwischen Heimserver und VM wechseln. Budget-Sperre aus M22 gilt; ohne bestätigte Preisliste kein Umzug.

### Abnahme M27
NeoForge-Profil legt einen startenden Server an; ein `.mrpack` installiert sich, ein kaputtes Pack fällt aufs Backup zurück; Welt wechseln und als ZIP herunterladen über den Link; Freund mit `console` darf `time set day`, `op` wird abgelehnt; Sim-Server mit 6 Spielern zieht nach Leerstand auf die größere Azure-Attrappe und die Relay-Adresse bleibt gleich.
**Sicherheitstests:** ZIP-Upload ohne Pfadausbruch/Symlinks/Zip-Bombe (Größe und Dateianzahl begrenzt); CurseForge-Key nie in Antwort/Log; Downloads nur von festen Hosts mit Prüfsumme; Konsole für Freunde nur Allowlist, kein Zeilenumbruch/Steuerzeichen, kein `;`; Auto-Skalierung nie mit Spielern online (außer Uhrzeit-Regel), nie über Budget.

---

## M28: Projekte hosten (Repo-Link einfügen → läuft)

Baut auf M5 (Deploy-Ziele, Deploy-Key, Rollback), M20 (Domains, ACME), M21 (Compose-Prüfung), M23 (Stacks), M24 (Stack-Versionen mit Health-Gate) und M25 (GitHub-Ausbau). Funktioniert auch ohne GitHub-Modul mit jedem Git-Repo per HTTPS-URL und Deploy-Key.

### 8. Repo-Link einfügen → läuft
- Neue Einheit **Projekt**: Repo, Branch, Zielserver, Art, Port, Domain, Variablen.
- **Erkennung** (in dieser Reihenfolge): `compose.yml` → Compose (durch die M21-Prüfung); `Dockerfile` → bauen; `package.json` → Node (Start aus `scripts.start`, Build aus `scripts.build`, Paketmanager aus der Lock-Datei); `requirements.txt`/`pyproject.toml` → Python (Start aus `Procfile`, `main.py`/`app.py`, erkennt FastAPI/Flask/Discord-Bot); nur `index.html` bzw. `dist/` nach Build → statische Seite (Caddy). Ergebnis wird angezeigt und ist änderbar, bevor etwas läuft.
- Ohne Dockerfile erzeugt die Zentrale eines aus **festen Vorlagen** (`templates/runtimes/node|python|static`, Basis-Images gepinnt, non-root, read-only wo möglich). Gebaut wird auf dem Zielserver (Agent `deploy.run`, Methode `build`), mit RAM- und Zeitgrenze.
- Hintergrunddienste ohne Port (Bots) laufen als „Worker“ ohne Domain.

### 9. Eigene Subdomain mit HTTPS
- Pro Projekt `name.<eigene-domain>` über das Domains-Modul (M20). **Standard: nur im Tailnet** (A-Record auf die Tailscale-IP des Servers, Zertifikat per DNS-01). Ein kleiner Caddy pro Server (Rolle `hz.role=proxy`, nur auf der Tailscale-IP) verteilt nach Hostname.
- **Öffentlich** nur auf ausdrücklichen Wunsch pro Projekt mit Step-up: über einen Eingang-Server (M15/M26 Weg B) oder einen eigenen Funnel-Knoten wie M26 Weg A. Core und Agent bleiben unberührt.

### 10. Push to deploy mit Rollback
- Neuer Commit auf dem Branch → bauen → neue Revision starten → Health-Gate (HTTP-Pfad oder „Container läuft 60 s“ bei Workern) → umschalten. Schlägt es fehl, läuft die alte Revision weiter und es gibt eine Meldung mit „Warum?“ (M24). Wenn das Repo CI hat, wartet der Deploy auf grünes CI (wie M5).
- Erkennung neuer Commits per Polling (M25 adaptiv) oder optional „Push aus dem CI“ (M25). Die letzten 10 Revisionen bleiben, Rollback per Knopf.

### 12. Variablen und Secrets pro Projekt
- Variablen (sichtbar) und Secrets (AES-256-GCM, nur schreibbar, „gesetzt“) pro Projekt und optional pro Umgebung (Preview aus M25 / Produktion). Beim Deploy schreibt der Agent `.env` mit 0600 neben die Compose-Datei; Secrets erscheinen nie in Build-Logs (Schwärzung), Antworten oder im Rezept-Export (M24).
- Ändern verlangt Step-up; Ändern eines Secrets bietet „Neu starten“.

### 13. Logs und Neustart pro Projekt
- Projektseite mit Status, Live-Logs (Build und Laufzeit, geschwärzt), Neustart, Stoppen, Ressourcen (CPU/RAM aus den Metriken), Revisionen, Domain-Status, Priorität (M10) und Selbstheilung (M20).

### Arbeitspakete M28
- **WP Schema** (`packages/shared`): `api/projects.ts`, `agent-deploy`-Erweiterung (`build`-Methode, `proxy.set`), Migration nächste freie Nummer.
- **WP Core ∥** (`apps/core/src/projects`): Erkennung (liest nur die nötigen Dateien über die GitHub-API bzw. über den Agent nach dem Klonen), Dockerfile aus Vorlagen, Revisionen, Health-Gate, Secrets, Domains/Proxy.
- **WP Agent ∥** (`apps/agent`, `templates/runtimes`): Build mit Limits, Proxy-Container, `.env` schreiben, Revisionen aufräumen.
- **WP Web ∥** (`apps/web`): „Projekt hinzufügen“ (Repo-Link, Erkennung, Vorschau), Projektliste, Projektseite.

### Abnahme M28
Ein Node-, ein Python-Bot- und ein statisches Test-Repo laufen nach Einfügen des Links auf einem Sim-Server; die Node-App ist unter `app.test.local` per HTTPS im Tailnet erreichbar; ein kaputter Commit wird nicht live und die alte Revision läuft weiter; ein Secret steht in der App zur Verfügung, aber in keinem Log.
**Sicherheitstests:** keine Compose-Option aus der M21-Verbotsliste, auch nicht über das erzeugte Dockerfile; Build ohne `--privileged`, ohne Docker-Socket, mit Speicher-/Zeitlimit; Repo-Inhalte (Dateinamen, Skripte) nie in Shell-Befehlen der Zentrale; Proxy nur auf der Tailscale-IP, öffentlich nur mit Step-up; Secrets nie in Antwort, Log, Export; Projektnamen nur `[a-z0-9-]`, nie `hz.role`-Namen.
