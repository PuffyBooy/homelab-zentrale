# StatusDot

Zustand eines Dienstes, Servers oder Geräts als Punkt mit kurzem Tag in Mono, wie in einem Terminal. Die Form trägt die Bedeutung mit: Kreis = läuft, Raute = Warnung, Quadrat = ausgefallen, Ring = gestoppt.

| status | Tag | Langform (Tooltip, Screenreader) |
| --- | --- | --- |
| `ok` | UP | Läuft |
| `warn` | WARN | Warnung |
| `crit` | DOWN (pulsiert) | Ausgefallen |
| `off` | OFF | Gestoppt |
| `info` | INFO | Info |
| `busy` | BOOT (pulsiert) | Startet |

- In dichten Listen `hideLabel`: Dann bleibt nur der Punkt sichtbar, die Langform wird vorgelesen.
- `label` überschreibt den Tag (z. B. „CI ✓“).
