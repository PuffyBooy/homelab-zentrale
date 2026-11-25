# ServerList

Die Leiste mit allen Servern auf einen Blick: Status, Name, Ort und IP, CPU, RAM, Disk und Uptime. Ein Klick filtert die ganze Seite auf diesen Server.

- Eine Zeile pro Server, egal wo er steht (zu Hause, Oracle, VPS, Pi). Die Daten kommen vom Agent auf jedem Server.
- Die Blockbalken (`█░`) sind grau, solange alles normal ist, ab 75 % Bernstein und ab 90 % rot. Farbe heißt „hinschauen“.
- Ist ein Server nicht erreichbar, ersetzt eine rote Zeile die Werte und sagt, seit wann und warum („kein Ping seit 23:02“).
- Probleme stehen oben: Server mit `crit` und dann `warn` werden zuerst sortiert.
- Der ausgewählte Server bekommt eine Bernstein-Kante links.
