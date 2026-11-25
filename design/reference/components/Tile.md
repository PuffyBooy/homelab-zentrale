# Tile

Die Kachel ist die Grundeinheit jeder Seite: ein Server, ein Dienst, ein Raum oder ein Projekt pro Kachel.

- Aufbau: Kopf (Icon, Titel, Status, Aktionen), Körper, optionaler Fuß mit Host und „vor X s“.
- Raster mit 4 Spalten am Desktop, 2 am Tablet, 1 am Handy, Abstand `space-4`. Breite über `span` (2, 3, 4).
- Keine Schatten. Kacheln trennen sich über `line` vom Hintergrund.
- `status="crit"` färbt Rahmen und Kopf rot. So springt eine ausgefallene Kachel sofort ins Auge. Nur dafür, nicht für Warnungen.
- Der Körper enthält, was der Aufrufer mitgibt (Metric, UsageBar, ServiceRow …).
