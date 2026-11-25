# RepoRow

Ein GitHub-Repo: letzter Commit, CI-Status, auf welchen Server es deployt ist und ob es neue Commits gibt, die noch nicht live sind.

- Die Daten kommen über die GitHub-API (Repos, Actions) und den Webhook für Pushes.
- „2 neu“ (Bernstein) heißt: Auf GitHub ist ein neuerer Stand als auf dem Server. Daneben steht der Primary-Button „Deploy“.
- „aktuell“ (grün) heißt: Der Server läuft auf dem neuesten Commit.
- Ist CI rot, wird der Deploy-Button nicht angeboten.
