# Metric

Eine Zahl mit Label, Einheit und optional Trend oder Hinweis. Die Zahl ist das Erste, was man sieht.

- Label in Versalien (`label`), Zahl in `metric-xl`, Einheit klein in `ink-muted`.
- Zahlen im österreichischen Format: Komma als Dezimaltrennzeichen, Leerzeichen vor der Einheit („7,8 GB“, „38 W“).
- Mehr als eine Nachkommastelle braucht es fast nie.
- `size="wall"` für den Wandmodus: 96-px-Zahl, aus der Entfernung lesbar.
- Ein Delta bekommt nur dann einen Ton (`ok`/`warn`/`crit`), wenn die Richtung gut oder schlecht bedeutet.
