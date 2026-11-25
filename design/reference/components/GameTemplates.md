# GameTemplates

Gameserver schnell aufsetzen: Spiel wählen, und die Zentrale startet den passenden Docker-Container mit Port, Volume und sinnvollen Einstellungen.

- Jede Vorlage nennt das Docker-Image, den RAM-Bedarf und den Port.
- Passt eine Vorlage nicht auf den gewählten Server, steht „zu wenig RAM frei“ in Bernstein. Auswählen kann man sie trotzdem.
- Nach der Auswahl folgt ein kurzer Schritt: Name, Server, Version und Spielerzahl. Dann „Aufsetzen“ (Primary).
- Neue Vorlagen sind einfache Docker-Compose-Dateien im Repo.
