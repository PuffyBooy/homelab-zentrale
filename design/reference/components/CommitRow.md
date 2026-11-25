# CommitRow

Ein einzelner Commit oder Deploy: Hash vorne (Mono, Bernstein), Nachricht, Repo/Branch und Zeit, Build-Status und was live ist.

- Status: `ok` gebaut, `busy` Deploy läuft, `crit` Build fehlgeschlagen.
- `live` zeigt das Badge LIVE für den Commit, der gerade läuft. Pro Repo und Server gibt es genau einen.
- Die Aktion ist der eine nächste Schritt: „Deploy“ (Primary) oder „Rollback“ (Danger).
- Für die Übersicht pro Repo gibt es `RepoRow`. CommitRow ist die Verlaufsliste darunter.
