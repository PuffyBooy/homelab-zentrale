# M30: 3D-Drucker Bambu Lab (Plan)

Stand: Plan vom 27.11.2026, gebaut wird frühestens ab 29.11.2026 18:00 (Wien).
Wunsch des Admins: „Plan auch eine Bambu-Lab-Einknüpfung.“ Neues optionales Modul `printer` (Standard aus), angelegt wie die Anbindungen aus M14.

## Zwei Anbindungswege
1. **Direkt im LAN (Standard):** Der Drucker spricht im LAN-Modus MQTT über TLS (Port 8883, Benutzer `bblp`, Passwort = Zugangscode, Themen `device/<Seriennummer>/report|request`) und FTPS (Port 990) für Dateien. Die Verbindung baut der Agent eines gewählten Servers im selben LAN auf (Heimserver), nicht der Core, damit nichts zusätzlich ins Tailnet muss. Das TLS-Zertifikat des Druckers wird über die mitgelieferte Bambu-CA bzw. beim ersten Verbinden per Fingerabdruck festgenagelt (nie `rejectUnauthorized: false`).
2. **Über Home Assistant (M8):** Wenn die Bambu-Integration in HA läuft, liest die Zentrale deren Entitäten (Status, Fortschritt, Temperaturen, Kamera-Bild) und ruft deren Knöpfe auf. Kein Zugangscode in der Zentrale nötig.
Die Bambu-Cloud wird nicht benutzt.

Hinweis: Seit Firmware-Ständen ab Anfang 2025 erlaubt Bambu Steuern über Fremdsoftware im LAN nur mit **„LAN-Modus“ und „Entwicklermodus“** am Drucker. Ohne Entwicklermodus zeigt die Zentrale den Status (soweit der Drucker ihn liefert), Steuern ist dann ausgegraut.

## Funktionen
- **Kachel „3D-Drucker“** (Übersicht und Wandmodus): Status (druckt/pausiert/fertig/Fehler, Form + Text), Dateiname, Fortschritt in %, Restzeit und Fertig-Uhrzeit (`23:04`), Schicht x/y, Düse/Bett/Kammer-Temperatur, AMS-Filamente mit Farbe und Rest.
- **Kamera:** Standbild alle 10 s in der Kachel, Live-Ansicht in der Detailseite (X1/H2: RTSPS Port 322 über den Agent als MJPEG weitergereicht; P1/A1: JPEG-Strom Port 6000). Bilder laufen nur über Agent und Core, nie direkt vom Browser zum Drucker.
- **Meldungen (Push, M4):** Druck fertig (`info`), Fehler/HMS-Code mit deutschem Text (`warn`/`crit`), Filament leer, Druck pausiert, Drucker offline > 10 Min während eines Drucks.
- **Steuern:** Pause, Fortsetzen, Licht an/aus, Druckgeschwindigkeit (Leise/Standard/Sport/Ludicrous); **Abbrechen** mit Step-up und Bestätigung. Keine G-Code-Eingabe, nur feste Befehle aus einer Allowlist.
- **Dateien:** `.3mf`/`.gcode` hochladen (Größenlimit, nur diese Endungen, Name geprüft) auf die SD-Karte per FTPS, Liste der Dateien, „Drucken“ mit Platte, AMS-Zuordnung und Bed-Leveling-Häkchen (Step-up). Löschen auf der SD nur für Dateien, die die Zentrale hochgeladen hat.
- **Verlauf und Statistik:** Drucke mit Dauer, Erfolg/Abbruch, Filament-Verbrauch; optional Stromkosten über eine Shelly-/HA-Steckdose (M8).
- **Automatik (M20):** z. B. „nach fertigem Druck 10 Min warten, dann Steckdose aus“ über HA.

## Arbeitspakete
- **WP Schema** (`packages/shared`): `api/printer.ts`, Agent-Aktionen `printer.connect|status|command|upload|files|camera` in `agent-printer.ts`, Modul `printer`.
- **WP Agent ∥** (`apps/agent/src/printer`): MQTT-Client mit festgenageltem Zertifikat, nur private IPv4-Ziele und die Ports 8883/990/322/6000, Befehls-Allowlist, FTPS-Upload mit Limit, Kamera-Weiterleitung mit Bildraten-Grenze.
- **WP Core ∥** (`apps/core/src/printer`): Drucker verwalten (Name, IP, Seriennummer, Zugangscode verschlüsselt, Agent), Zustand, Meldungen, Verlauf, HA-Weg.
- **WP Web ∥** (`apps/web`): Kachel, Wandmodus-Kachel, Detailseite mit Kamera, Dateien, Steuern, Verlauf, Einstellungen → Anbindungen → 3D-Drucker.

## Abnahme
Gegen eine MQTT-/FTPS-Attrappe (Test, e2e): Status und Fortschritt erscheinen live, Fertig erzeugt eine Push, Pause/Fortsetzen wirken, Abbrechen verlangt Step-up, eine `.3mf` wird hochgeladen und gestartet, die Kachel zeigt im Wandmodus Restzeit und Kamerabild.
**Sicherheitstests:** Zugangscode nie in Antwort/Log; nur private IPs und feste Ports; kein freier G-Code; Upload nur `.3mf`/`.gcode`, kein Pfadausbruch im Namen; Kamera nur über Agent mit Session; Modul aus = 404.

## Was der Admin liefern muss (nach dem Bauen)
- Druckermodell (X1C, P1S, P1P, A1, A1 mini, H2D …).
- Am Drucker: **LAN-Modus** einschalten und **Zugangscode** ablesen (Einstellungen → Netzwerk), für Steuern zusätzlich **Entwicklermodus**. Seriennummer (Einstellungen → Gerät) und IP-Adresse (am besten im Router fest vergeben).
- Alles trägt er selbst in der Zentrale ein, nicht im Chat. Alternative: vorhandene Bambu-Integration in Home Assistant nutzen.
