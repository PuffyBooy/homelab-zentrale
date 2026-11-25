# ServiceRow

Eine Zeile pro Dienst, Container oder Website: Status, Name, Ort (`server · port`), ein Wert und Aktionen.

- Name ist der technische Name in Kleinschreibung (`homeassistant`, `minecraft-paper`).
- `host` nennt immer den Server. Bei mehreren Servern ist das die wichtigste Info.
- `meta` zeigt den einen Wert, der für den aktuellen Status zählt: Uptime bei ok, RAM bei warn, HTTP-Code bei crit.
- Höchstens zwei Ghost-Buttons als Aktionen. Mehr kommt ins Detail.
