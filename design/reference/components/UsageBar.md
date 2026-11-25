# UsageBar

Auslastung als Terminal-Blockbalken (`████░░░░`) mit Label und Wert in einer Zeile. Unter `warnAt` (75) ist er grau, darüber Bernstein, ab `critAt` (90) rot.

- Normalbetrieb ist absichtlich unauffällig. Farbe heißt „hinschauen“.
- `detail` ersetzt die Prozentzahl durch echte Werte („389 / 480 GB“).
- `cells` legt die Breite fest: 20 in Detailansichten, 6 in der Server-Leiste, 12 in Gameserver-Kacheln.
