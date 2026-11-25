# Button

Vier Varianten: Primary (Bernstein) für die eine Hauptaktion einer Ansicht, Secondary für normale Aktionen, Ghost für Nebenaktionen in Zeilen und Danger für alles, was einen Dienst unterbricht.

- **Primary höchstens einmal pro Kachel oder Seite.** Beispiel: „Neu deployen“.
- **Danger** für Neustart, Stoppen und Löschen. Danach kommt immer eine Bestätigung mit dem Namen des Dienstes („minecraft neu starten?“).
- Beschriftung: Verb im Infinitiv, kurz, keine Ausrufezeichen: „Starten“, „Logs öffnen“, „Backup jetzt“.
- Größen: `md` (36 px) Standard, `sm` (28 px) in Zeilen. Am Handy mindestens `md`.
- Ein Button nur mit Icon braucht `aria-label`.
