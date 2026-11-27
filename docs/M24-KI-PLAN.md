# M24: KI-Vorschläge, schneller Docker-Wechsel, interaktive Gameserver (Plan)

Stand: Plan vom 27.11.2026, gebaut wird frühestens ab 29.11.2026 18:00 (Wien).
Wunsch des Admins: „Vorschläge, was ich bei den Servern besser machen kann, schnelles Docker-Switching, Vorschläge, wie ich Server schnell aufbaue, und beim Gameserver mehr interaktiv einstellen und automatisch Vorschläge. Ich kann einen Cloud-API-Key geben.“

Baut auf: M10 (Prioritäten, RAM-Reserve), M12 (Gameserver, Statistik, Modrinth), M16 (Server im Detail), M17 (Updates, Health-Gate mit Rollback), M18 (Schwachstellen-Scan, Fail2ban), M21 (App-Store, eigene Vorlagen), M22 (Azure mit Preisen), M23 (Docker komplett, Stacks). M23 und M11b müssen vorher gemergt sein.

## Grundsätze

1. **Zwei Stufen.** Stufe 1 sind feste Regeln im Core (ohne KI, ohne Key, kostenlos, testbar). Stufe 2 ist das Sprachmodell: Es sortiert, erklärt, fasst zusammen und beantwortet freie Fragen. Ohne Key läuft Stufe 1 trotzdem. So hängen gute Vorschläge nie allein an der KI.
2. **Vorschlag, nie Aktion.** Die KI führt nichts aus. Ein Vorschlag kann höchstens auf eine Aktion aus der festen Liste `SUGGESTION_ACTIONS` zeigen, die eine bestehende API-Route mit deren Schema aufruft. Der Admin klickt „Anwenden“, sieht vorher die Änderung (Diff), und Step-up und Namensbestätigung gelten wie bei der Hand-Aktion.
3. **Datensparsam.** An den Anbieter geht nur ein typisierter Schnappschuss (zod-Schema `aiContextSchema`) aus erlaubten Feldern, nie Rohdateien, Umgebungsvariablen, Logs, Tokens, Passwörter, RCON, Benutzerlinks, Tailscale-IPs. Danach läuft ein Schwärzer (Muster für Tokens, Keys, URLs mit Zugangsdaten, private Schlüssel). Optional werden Server- und Containernamen durch Kürzel ersetzt (`server-1`) und in der Antwort zurückübersetzt. „Was geht raus?“ zeigt den exakten Text vor dem Senden.
4. **Anbieter-neutral.** `AI_PROVIDERS = anthropic | openai | ollama`, eine Schnittstelle `AiProvider.complete({system, input, schema, maxTokens})`. Antworten müssen JSON nach zod-Schema sein (Tool-Aufruf bzw. Structured Output); was nicht passt, wird verworfen.
5. **Kosten im Griff.** Monatsbudget (Standard 5 €), Grenze pro Anfrage (Tokens), höchstens 30 Anfragen pro Stunde, Cache über den Hash des Schnappschusses (gleiche Lage = keine neue Anfrage). Tägliche automatische Analyse ist aus, bis der Admin sie einschaltet. Ab 80 % Budget `warn`, ab 100 % nur noch Stufe 1.

## Arbeitspakete

### WP Schema (`packages/shared`, zuerst fertig)
- `api/ai.ts`: Einstellungen (Anbieter, Modell, Key gesetzt ja/nein, Ollama-URL, Budget, Pseudonymisieren, Auto-Analyse mit Uhrzeit), Vorschlag (`id, area: server|security|docker|setup|game, severity: info|warn|crit, title, why, evidence[], action?`), Verlauf, Verbrauch.
- `SUGGESTION_ACTIONS`: z. B. `container.setLimit`, `container.setRestartPolicy`, `stack.pinImage`, `stack.switchRevision`, `update.applyNow`, `game.setSetting`, `game.setRam`, `game.setSleep`, `game.installMod`, `game.move`, `cleanup.run`, `app.install`. Jede zeigt auf eine vorhandene Route; neue Routen kommen nur über die WPs unten.
- `aiContextSchema` (erlaubte Felder) und `agent-docker`-Erweiterung für Stack-Versionen.
- Modul `ai` in `MODULES` (Standard aus, Einschalten mit Step-up). Migration: nächste freie Nummer beim Bauen (voraussichtlich 20).

### WP Core: KI-Kern ∥ (`apps/core/src/ai`)
- Anbieter-Clients nur gegen feste Hosts: `api.anthropic.com`, `api.openai.com`; Ollama nur auf `127.0.0.1`, `100.64.0.0/10` oder `*.ts.net` (kein öffentliches Ollama). Keine Weiterleitungen, Zeitlimit 60 s.
- Key AES-256-GCM verschlüsselt (wie GitHub-/HA-Token), nach dem Speichern nie wieder angezeigt („gesetzt“), Ändern mit Step-up, „Verbindung testen“ mit einer Mini-Anfrage. Key nie in Antwort, Log, Fehler, Export.
- Kontext-Bauer, Schwärzer, Pseudonymisierer, Budget-Zähler (Tokens × Preisliste pro Modell, Preise als Datei in `packages/shared`, vom Admin überschreibbar).
- Seite „Frag die Zentrale“: freie Frage plus Schnappschuss, Antwort als Text plus optionale Vorschläge (gleiches Schema, gleiche Aktionsliste).

### WP Core: Regeln ∥ (`apps/core/src/advisor`)
Stufe-1-Regeln, jede mit Test und Begründungstext:
- **Ressourcen:** RAM dauerhaft über 85 % (7-Tage-Werte), Container ohne Speicherlimit, Platte voll in < 14 Tagen (Trend), Swap aktiv, Docker-Müll > 5 GB (M16 `dockerDf`), Server dauerhaft leer und ein anderer voll (Umzug vorschlagen, M11).
- **Sicherheit:** kritische Lücken (M18), Port auf `0.0.0.0` statt Tailscale-IP (M11 Port-Abgleich), `privileged`/Docker-Socket in fremden Stacks (M23), OS-Updates offen > 14 Tage (M17), Neustart nötig, Fail2ban aus bei offenem SSH.
- **Konfiguration:** Image mit `:latest`, keine Restart-Policy, kein Healthcheck, Logs ohne Größenlimit, kein Backup für Gameserver mit Spielern.
- Vorschläge entstehen nach jedem Inventar-Lauf, werden zusammengeführt (gleiche Ursache = ein Vorschlag) und verschwinden selbst, wenn die Ursache weg ist. „Ausblenden“ und „In 7 Tagen wieder zeigen“.

### WP Docker schnell wechseln ∥ (`apps/core/src/containers`, `apps/agent`)
- **Stack-Versionen:** Bei jedem `compose.up` durch die Zentrale speichert sie eine Revision (Compose-Datei, `.env` ohne Secrets, Image-Digests). Liste „Versionen“ am Stack, Knopf „Zu dieser Version wechseln“.
- **Wechsel mit Sicherheitsnetz:** neue Version starten, Health-Gate 3 Min wie M17, sonst automatisch zurück zur letzten guten Revision. Volumes bleiben immer.
- **Image-Tag wechseln:** Auswahl aus den Tags der Registry (nur `registry-1.docker.io`, `ghcr.io`, `lscr.io`, `quay.io`), Vorschau als Diff, „Auf Digest festnageln“.
- **Als Vorlage speichern:** laufender Stack wird eigene M21-Vorlage (durch dieselbe Sicherheitsprüfung, Passwörter werden Parameter).
- KI-Anteil: „Lohnt sich das Update?“ fasst die Release-Notes zusammen (nur GitHub-Releases des Image-Projekts, öffentlicher Text).

### WP Server schnell aufbauen ∥ (`apps/core/src/advisor/setup`)
- Assistent „Was soll der Server können?“: Auswahl aus Zielen (Mediaserver, Passwörter, Dateien, Gameserver für N Freunde …) oder freier Text (KI).
- Ergebnis ist ein **Bauplan** nur aus Bausteinen, die es gibt: M21-Apps, Gameserver-Vorlagen, Aufgaben (M20), Selbstheilung, Checks. Dazu: welcher Server (freier RAM, Architektur, Reserve), welche Ports, geschätzter RAM.
- „Bauplan ausführen“ arbeitet Schritt für Schritt mit Bestätigung pro Schritt; jeder Schritt nutzt die normale Route. Ohne Key gibt es feste Baupläne als Vorlagen.
- Für neue Server: Verweis auf den Einzeiler (M11b) und auf passende Azure-Größe (M22).

### WP Gameserver interaktiv ∥ (`apps/core/src/games`, `templates/games`)
- **Einstellungen als Formular:** `template.json` bekommt `settings[]` (Schlüssel, Typ, Bereich, Beschreibung auf Deutsch, `live: rcon-Befehl | restart`). Minecraft zuerst (`server.properties` + Gamerules: Schwierigkeit, PvP, Sichtweite, Simulationsweite, max. Spieler, MOTD, Whitelist, Spawn-Schutz, keepInventory …), danach Valheim, Satisfactory, Factorio, Palworld nach Bedarf.
- **Live ändern:** wo möglich sofort über RCON (Gamerules, Whitelist, Schwierigkeit), sonst Markierung „wirkt nach Neustart“ mit Knopf. RCON nur mit fest erlaubten Befehlen pro Vorlage, Werte nach Schema geprüft, kein freier Befehl über diesen Weg.
- **Automatische Vorschläge (Stufe 1):**
  - RAM: aus Spielerzahl, TPS und GC-Spitzen der letzten 7 Tage („6 GB reichen, 10 GB belegt“ oder „TPS fällt bei 6 Spielern, auf 8 GB erhöhen“), mit M10-Reserve geprüft.
  - Schlafzeit: aus der Stunden-Statistik (M12), z. B. „nachts nie Spieler, Schlaf nach 5 statt 15 Min“, plus Zeitplan für Neustart/Backup in die leerste Stunde.
  - Version: neue Spielversion verfügbar, aber nur vorschlagen, wenn alle installierten Mods dafür eine Version haben (Modrinth).
  - Mods: Leistungs-Mods für den Loader (Fabric: Lithium, FerriteCore; Paper: eingebaut), Mods ohne Update für die aktuelle Version.
  - Host: Vergleich der eigenen Server (freier RAM, CPU, Last zur Spielzeit) und der Azure-Größe mit Kosten im Schlafmodus (M22), Umzug über M11.
- KI-Anteil: „Erklär mir diese Einstellung“, „Stell den Server für 4 Freunde mit Kindern ein“ (Antwort ist ein Satz `game.setSetting`-Vorschläge, die der Admin abhakt).

### WP Web ∥ (`apps/web`)
- Seite „Vorschläge“: Liste nach Bereich und Schwere (Form + Text, nie nur Farbe), pro Vorschlag Begründung, Belege, „Anwenden“ (einzige Bernstein-Aktion), „Ausblenden“, „Später“.
- Vorschläge-Abschnitt im Server-Detail (M16), im Gameserver-Detail neuer Reiter „Einstellungen“ (Formular) und „Vorschläge“, am Stack Reiter „Versionen“.
- Einstellungen → KI: Anbieter, Modell, Key (Passwortfeld, danach „gesetzt“), Ollama-URL, Budget mit Verbrauch im Monat, Pseudonymisieren, Auto-Analyse, „Was geht raus?“.
- Neue Komponenten (Vorschlagskarte, Diff-Ansicht) zuerst als Vorschlag in `docs/QUESTIONS.md`, sonst aus `packages/ui`.

## Abnahme
- Ohne Key: Ein Sim-Server mit Container ohne Limit, `:latest`-Image und offenem Port auf `0.0.0.0` bekommt drei Vorschläge; „Limit setzen“ verlangt die gleiche Bestätigung wie von Hand; nach dem Fix verschwindet der Vorschlag.
- Mit Anbieter-Attrappe (Test, e2e): Analyse liefert sortierte Vorschläge; eine Antwort mit unbekannter Aktion oder falschem Schema wird verworfen; Budget 100 % schaltet auf Stufe 1.
- Stack wechselt auf eine neue Revision, ein absichtlich kaputtes Image fällt nach dem Health-Gate auf die alte Revision zurück.
- Minecraft: Schwierigkeit wird live per RCON geändert, Sichtweite zeigt „wirkt nach Neustart“; RAM- und Schlafvorschlag entstehen aus Sim-Statistik.
- Bauplan „Vaultwarden + Minecraft für 5“ wird auf dem passenden Sim-Server Schritt für Schritt angelegt.

**Sicherheitstests:** Modul aus = 404; keine Route ohne Session; Key nie in Antwort/Log/Fehler/Export; Kontext enthält nachweislich keine Secrets (Test mit gefälschten Tokens in Env, Labels, Compose); nur feste Anbieter-Hosts, Ollama nur lokal/Tailnet; Prompt-Injection über Containernamen, MOTD oder Release-Notes kann keine Aktion außerhalb `SUGGESTION_ACTIONS` und keine Parameter außerhalb der Schemas auslösen; „Anwenden“ ohne Step-up dort, wo die Hand-Aktion Step-up braucht, wird abgelehnt; RCON nur erlaubte Befehle; Registry-Abfragen nur zu erlaubten Hosts; gespeicherte Revisionen enthalten keine Secrets.

## Reihenfolge beim Bauen
1. Schema (`packages/shared`), dann parallel Regeln, KI-Kern, Docker-Wechsel, Gameserver-Einstellungen, danach Web, Bauplan zuletzt.
2. Regeln und Gameserver-Formular bringen schon ohne Key sichtbaren Nutzen und kommen zuerst in den PR.

## Was der Admin liefern muss
- **Einen API-Key**, erst wenn M24 gemergt ist, eingetragen unter Einstellungen → KI (nie im Chat, nie im Repo). Empfehlung: Anthropic-Key (console.anthropic.com → API Keys) oder OpenAI-Key (platform.openai.com → API keys), beide mit Ausgabenlimit beim Anbieter. Ohne Key laufen die Regel-Vorschläge trotzdem. Kostenlos geht auch Ollama auf einem eigenen Rechner im Tailnet (dann schwächere Vorschläge).
- Entscheidungen (sonst gelten die Annahmen): Anbieter (Annahme: Anthropic), Monatsbudget (Annahme: 5 €), Server-/Containernamen pseudonymisieren (Annahme: an), tägliche Auto-Analyse (Annahme: aus).
