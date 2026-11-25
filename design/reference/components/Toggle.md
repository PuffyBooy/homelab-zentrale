# Toggle

Ein Schalter mit den Zuständen AN/AUS als Segment, wie bei einem Hardware-Schalter. Er ist für Smart-Home-Geräte und Einstellungen gedacht, die sofort wirken.

- Beschriftung: Gerät und Raum („Licht Wohnzimmer“), darunter optional der aktuelle Wert.
- AN ist Bernstein, AUS ist neutral.
- Was einen Dienst oder das Netz unterbricht (Server-Steckdose, Router), fragt vor dem Ausschalten nach.
- Einmalige Aktionen wie den Türöffner nie als Toggle bauen, sondern als Button mit Bestätigung.
- Der Aufrufer hält den Zustand (`checked`, `onChange`).
