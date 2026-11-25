# Alert

Eine Meldung als Logzeile: Uhrzeit, Level (OK/INFO/WARN/CRIT), Titel und Details in einer Zeile. Derselbe Text geht als Push-Nachricht ans Handy.

- Titel = Was + Wo: „web-vps nicht erreichbar“. Details = seit wann und was hilft.
- Nur `crit` bekommt eine rote Fläche und einen Rahmen. Alles andere bleibt ruhig, die Farbe steckt nur im Level.
- `floating` mit `raise`-Schatten für Toasts unten rechts.
- Höchstens eine Aktion („Ansehen“).
