# M31: Tür und Gegensprechanlage (Plan)

Stand: Plan vom 27.11.2026, gebaut wird ab 29.11.2026 18:00 (Wien).
Wunsch des Admins: Die Gegensprechanlage (BTicino, App „Door Entry“) in die Zentrale einbauen. Vorhanden: eine Innenstation **mit WLAN und Kamera** (Classe 100X) und eine zweite **ohne Kamera und WLAN** am selben Bus.

Heute (M8, SPEC 10): Ein Türöffner aus Home Assistant erscheint als Button mit Bestätigung und Step-up (TOTP), mit Rate-Limit. M31 macht daraus eine eigene Tür-Funktion mit Klingeln, Bild und Verlauf. Modul `door` (Standard aus, Einschalten mit Step-up), setzt das Modul `homeassistant` voraus.

## Anbindung
- **Nur die WLAN-Station ist anbindbar.** Die Station ohne WLAN klingelt weiter wie bisher; sie sieht die Zentrale nicht (läuft nur am Bus). Alles, was die Zentrale macht, geht über die Classe 100X bzw. die BTicino-/Netatmo-Cloud dahinter.
- **Weg 1 (Standard): Home Assistant.** Die Zentrale nutzt die HA-Entitäten der Gegensprechanlage (Klingel-Ereignis, Türöffner, wenn vorhanden Kamera-Bild) über die bestehende HA-Verbindung. Welche HA-Integration die Classe 100X heute zuverlässig abbildet (offizielle Netatmo-Integration oder eine Community-Integration über HACS), wird vor dem Bau am echten Gerät geprüft und in `docs/QUESTIONS.md` festgehalten. Die Zentrale selbst spricht nicht mit der BTicino-Cloud und speichert keine BTicino-Zugangsdaten.
- **Weg 2 (Rückfall ohne Cloud):** Wenn die Integration fehlt oder das Öffnen nicht freigibt: ein **Shelly** (z. B. Shelly Plus 1 / i4) parallel zum Türöffner-Kontakt bzw. am Klingel-Ausgang der Anlage, eingebaut von einer Elektrofachkraft, angebunden über HA oder direkt (M14-Stil). Ob die Anlage dafür einen potentialfreien Kontakt hat, hängt vom Modell der Außenstation ab (vor dem Kauf prüfen).

## Funktionen
- **Klingeln:** Push aufs Handy („Es klingelt an der Haustür“, 23:04) mit Bild, wenn vorhanden; Wandmodus zeigt eine große Kachel mit Bild und Knopf „Öffnen“ für 60 s; Ansage auf Echo/Alexa über die Sprachsteuerung (M18, HA-Helfer); optional Discord (nur „es klingelt“, nie Bild). Ruhezeit aus den Push-Einstellungen gilt nicht für das Klingeln (abschaltbar).
- **Bild/Kamera:** Schnappschuss beim Klingeln (Speicher 7 Tage, einstellbar, nur lokal in der Zentrale), Live-Bild nur, wenn die Integration es anbietet, nur mit Session. Keine Bilder an Dritte.
- **Öffnen:** wie heute mit Bestätigung **und** Step-up (TOTP gilt 15 Min) und Rate-Limit; im Wandmodus nur „Öffnen“ innerhalb der 60 s nach einem Klingeln und nur, wenn das Wandgerät dafür ausdrücklich freigeschaltet ist (Step-up beim Freischalten, Standard aus). Freunde-Links (M26) können die Tür nie öffnen.
- **Nach Hause kommen:** Über die HA-Companion-App (Standort) kommt bei Ankunft eine Push „Tür öffnen?“ mit Knopf, der in die Zentrale führt (Step-up wie immer). **Nie automatisch öffnen.**
- **Verlauf:** jedes Klingeln, Öffnen (wer, von wo: Handy, Wand, Sprache abgelehnt) und Fehler im `audit_log`; Seite „Tür“ mit den letzten 50 Ereignissen und Bildern.
- **Sicherheitsregeln:** Sprachsteuerung (M18) darf die Tür nie öffnen; Automatik (M20) und KI (M24) haben keine Aktion „Tür öffnen“; der Türöffner ist nie ein Toggle.

## Arbeitspakete
- **WP Schema** (`packages/shared`): `api/door.ts` (Ereignisse, Einstellungen, Wandgerät-Freigabe), Modul `door`.
- **WP Core ∥** (`apps/core/src/door`): HA-Ereignisse abonnieren (Klingel-Entität), Schnappschuss holen und speichern, Push/Wand/Echo/Discord auslösen, Öffnen über den bestehenden HA-Türöffner-Pfad, Ankunfts-Push über HA-Ereignis.
- **WP Web ∥** (`apps/web`): Seite „Tür“, Klingel-Kachel im Wandmodus und in der Übersicht, Einstellungen (Entitäten wählen, Speicherdauer, Wandfreigabe, Ankunfts-Push).

## Abnahme
Mit der HA-Demo-Instanz und simulierten Entitäten: Ein Klingel-Ereignis erzeugt binnen 2 s eine Push mit Bild und eine Wandkachel; Öffnen verlangt Step-up, ein zweites Öffnen in kurzer Folge wird gebremst; das Wandgerät ohne Freigabe zeigt keinen Öffnen-Knopf; eine Ankunft erzeugt „Tür öffnen?“, aber öffnet nicht.
**Sicherheitstests:** Öffnen ohne Step-up = 403; kein Öffnen über Sprache, Automatik, KI oder Freundes-Link; Bilder nur mit Session, nie im Gateway; Modul aus = 404; Schnappschüsse werden nach der Frist gelöscht.

## Was der Admin tun muss
- In Home Assistant die passende Integration für die Classe 100X einrichten (Anleitung kommt beim Bau, nachdem geprüft ist, welche funktioniert) und die HA-Companion-App mit Standort aufs Handy, wenn der Ankunfts-Push gewünscht ist.
- Falls nötig später: Shelly vom Elektriker anschließen lassen.
