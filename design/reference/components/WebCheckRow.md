# WebCheckRow

Eine Zeile pro Website oder Endpunkt: Status, URL, wo sie läuft, HTTP-Code, Antwortzeit und wie lange das SSL-Zertifikat noch gilt.

- Geprüft wird jede Minute. Fällt etwas aus, kommt sofort ein `Alert` und eine Push-Nachricht.
- Antwortzeiten über 800 ms werden Bernstein. SSL unter 14 Tagen wird Bernstein, unter 5 Tagen rot.
- Auch nicht-HTTP-Dienste wie ein Gameserver-Port können als Check laufen (`code: 'TCP'`).
- `host` nennt den Server und die Technik, damit man weiß, wo man nachschauen muss.
