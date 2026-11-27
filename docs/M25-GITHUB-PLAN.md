# M25: GitHub-Ausbau (Plan)

Stand: Plan vom 27.11.2026, gebaut wird frühestens ab 29.11.2026 18:00 (Wien).
Wunsch des Admins: „Mach die Git-Einbindung besser, du hast Read und Write für viele Sachen.“

Heute (M5, SPEC 7): Token nur lesend, Repos mit CI-Status, Commits, Deploy per Knopf (compose/script), Auto-Deploy bei grünem CI, Rollback auf früher deployte Commits, Polling alle 60 s mit ETag. Das Modul `github` bleibt optional und ist ab Werk aus.

## Grundsätze

1. **Lesen bleibt Standard, Schreiben wird freigeschaltet.** Schreibende Funktionen gibt es nur, wenn der Admin sie pro Repo einschaltet (Einstellungen → GitHub → Repo → „Schreibzugriff“, mit Step-up). Ohne Freischaltung ruft der Client keine schreibende Route auf, auch wenn das Token es könnte.
2. **Feste Liste erlaubter GitHub-Aufrufe.** Der Client kennt nur `api.github.com` und eine Allowlist aus Methode + Pfadmuster (`GITHUB_CALLS` in `packages/shared`). Nie: Repo löschen, Branch-Schutz ändern, Secrets lesen/schreiben, Mitglieder/Rechte ändern, Force-Push, fremde Branches löschen. Die Zentrale schreibt Branches nur unter `hz/…`.
3. **Rechte prüfen statt glauben.** Beim Verbinden liest die Zentrale, was das Token darf (Header `X-Accepted-GitHub-Permissions` und Probe-Aufrufe, bei klassischen Tokens `X-OAuth-Scopes`), zeigt eine Tabelle „gebraucht / vorhanden / zu viel“ und warnt bei zu breiten Rechten (klassisches Token mit `repo`, `admin:*`, `delete_repo`, `workflow` ohne Bedarf).
4. **Alles protokolliert.** Jeder schreibende Aufruf landet im Audit-Log (wer, was, Repo, Ergebnis), nie mit Token. Merge, Release und Rollback verlangen Step-up.
5. **Keine Webhooks von außen.** Die Zentrale bleibt privat. Statt Webhooks: adaptives Polling (60 s normal, 10 s solange ein Run läuft oder ein Deploy wartet, 5 Min für ruhige Repos), alles mit ETag, Anzeige des Rate-Limits. Optional (Standard aus) „Push aus dem CI“: Ein Workflow-Schritt meldet sich über das Tailnet mit HMAC-signierter Nachricht an `/api/github/notify` (nur Hinweis „bitte jetzt abfragen“, keine Daten werden vertraut).
6. **GitHub-Text ist Fremdtext.** PR-Titel, Beschreibungen, Commit-Nachrichten, Logs werden nie als HTML gerendert und gehen an die KI (M24) nur gekennzeichnet als Fremdtext; daraus entsteht nie direkt eine Aktion.

## Empfohlenes Token (geringste Rechte)

Fine-grained Personal Access Token, „Only select repositories“, Ablauf 90 Tage (die Zentrale erinnert 14 Tage vorher):

| Recht | Stufe | Wofür |
|---|---|---|
| Metadata | Read | Pflicht |
| Contents | Read and write | Commits lesen, `hz/…`-Branches für Update-PRs, Releases/Tags |
| Pull requests | Read and write | PR-Übersicht, Update-PRs, Mergen |
| Actions | Read and write | Runs und Logs, Re-run, Workflow manuell starten |
| Commit statuses | Read and write | „deployed auf heimserver“ am Commit |
| Deployments | Read and write | Deploy-Verlauf in GitHub (Environments) |
| Issues | Read and write | nur wenn „Meldung als Issue“ gewünscht |
| Dependabot alerts, Code scanning alerts | Read | Sicherheitsfunde als Vorschläge |
| Workflows | – | nicht nötig (die Zentrale ändert keine Workflow-Dateien) |
| Administration, Secrets, Variables, Environments, Webhooks, Members | – | nie geben |

Wer nur lesen will, gibt alles „Read“; dann sind die Schreibfunktionen ausgegraut mit Hinweis, welches Recht fehlt. Später möglich: GitHub-App statt Token (feinere Rechte, kein Ablauf), Schema schon vorsehen.

## Arbeitspakete

### WP Schema (`packages/shared`, zuerst)
`api/github.ts` erweitern: Repo-Schreibfreigabe, Rechte-Bericht, PRs, Runs/Jobs, Releases, Update-PRs, Preview-Deploys, Issue-Regeln; `GITHUB_CALLS`-Allowlist; Migration: nächste freie Nummer (nach M24).

### WP Core ∥ (`apps/core/src/github`)
1. **Rechte-Bericht und Token-Ablauf** (Grundsatz 3), Erinnerung als `warn`.
2. **PR-Übersicht:** offene PRs aller verbundenen Repos mit CI-Status, Reviews, Konflikt ja/nein, Alter. Aktionen (nur mit Schreibfreigabe): „Branch aktualisieren“, „Mergen“ (nur wenn CI grün und GitHub `mergeable`, Methode wie im Repo eingestellt, Step-up), „Schließen“. Optional „Nach Merge automatisch deployen“ nutzt das bestehende Auto-Deploy.
3. **Actions:** Runs live (Status pro Job), Log des fehlgeschlagenen Jobs (letzte 300 Zeilen, geschwärzt), „Fehlgeschlagene Jobs neu starten“, „Workflow starten“ für Workflows mit `workflow_dispatch` inkl. Eingaben nach deren Definition (Typen aus der Workflow-Datei, Werte geprüft). „Warum?“ (M24) an rotem Run.
4. **Preview-Deploys:** PR oder Branch per Knopf auf einen gewählten Testserver deployen, eigenes Compose-Projekt `pr-<nr>`, eigener Port aus einem Bereich, nur auf der Tailscale-IP. Link in der Zentrale und optional als PR-Kommentar. Wird beim Merge/Schließen automatisch entfernt, spätestens nach 7 Tagen. RAM-Reserve (M10) gilt.
5. **Releases und Rollback:** „Release erstellen“ vom LIVE-Commit (Tag `vJJJJ.MM.TT-N` oder eigenes Muster, Notizen aus den Commits seit dem letzten Release), Deploy nach Release-Tag statt Branch, Rollback auf jedes frühere Release (nicht nur früher deployte Commits), mit Health-Gate und automatischem Zurück wie M17/M24.
6. **Deploy-Status nach GitHub:** Commit-Status `homelab/<ziel>` und Deployment mit Environment = Servername, damit GitHub zeigt, was wo läuft.
7. **Update-PRs (Renovate light):** Für Repos mit `compose.yml` sucht die Zentrale täglich neuere Image-Versionen (gleiche Registries wie M24) und öffnet einen PR auf `hz/update-<image>-<version>` mit geänderter Zeile und Release-Notes-Link. Höchstens 5 offene Update-PRs pro Repo, gleiche Updates werden zusammengefasst, Patch/Minor/Major einstellbar. CI läuft in GitHub; nach Merge greift Auto-Deploy, wenn eingeschaltet.
8. **Meldung als Issue** (pro Repo, Standard aus): fehlgeschlagener Deploy oder CRIT-Meldung eines deployten Containers erzeugt ein Issue mit geschwärzter Zusammenfassung (nie Logs mit Secrets, nie Servernamen, wenn pseudonymisieren an ist); geht das Problem weg, kommentiert und schließt die Zentrale es. Höchstens ein offenes Issue pro Ursache.
9. **Sicherheitsfunde:** Dependabot- und Code-Scanning-Alarme (nur lesen) erscheinen als Vorschläge (M24) beim Repo und beim Server, auf dem es läuft.
10. **Repos anlegen aus Vorlage (optional):** keine Repo-Erstellung durch die Zentrale (bräuchte Administration-Recht); stattdessen Anleitung „Repo aus dieser Vorlage erstellen“ mit Link.

### WP Agent ∥ (`apps/agent`)
`deploy.run` um Projektnamen-Präfix `pr-` und Port-Bereich für Previews erweitern, `deploy.remove` für Previews (nur `pr-*`-Projekte, nie andere). Sonst keine neuen Rechte.

### WP Web ∥ (`apps/web`)
Seite „GitHub“ mit Reitern Repos, Pull Requests, Actions, Releases, Updates; Repo-Detail mit Deploy-Zielen, Previews, Release-Verlauf; Einstellungen → GitHub mit Rechte-Tabelle, Schreibfreigabe pro Repo, Polling-Anzeige, optional „Push aus dem CI“ mit Anleitung.

## Abnahme
Gegen eine GitHub-Attrappe (Test und e2e): Rechte-Bericht erkennt ein zu breites klassisches Token; ein grüner PR wird mit Step-up gemergt, ein roter bietet keinen Knopf; ein Preview-Deploy entsteht und verschwindet beim Schließen; ein fehlgeschlagener Job wird neu gestartet; ein Release wird erstellt, Rollback auf das vorige Release läuft, ein kaputtes Release fällt automatisch zurück; ein Update-PR wird geöffnet und nicht doppelt.

**Sicherheitstests:** Modul aus = 404; ohne Schreibfreigabe keine schreibende Anfrage (Client-Test auf die Attrappe); jeder Aufruf außerhalb `GITHUB_CALLS` wird lokal abgelehnt; nur `api.github.com`, keine Weiterleitungen; Branch-Schreiben nur unter `hz/`; kein Force-Push, kein Löschen fremder Branches; Token nie in Antwort, Log, Fehler, Issue, PR-Kommentar, Preview-Umgebung; PR-Text mit HTML/Skript wird als Text angezeigt; `/api/github/notify` ohne gültige HMAC = 401 und nur über das Tailnet; `deploy.remove` nur für `pr-*`; Merge ohne Step-up abgelehnt.

## Reihenfolge
M25 hängt nicht an der KI und kann direkt nach M23/M11b vor oder parallel zu M24 gebaut werden (Schema-Teil nacheinander, weil beide `packages/shared` ändern). „Warum?“ am roten Run und Sicherheitsfunde als Vorschläge kommen, sobald M24 da ist.

## Was der Admin tun muss (nach dem Merge)
Unter github.com → Settings → Developer settings → Fine-grained tokens ein neues Token mit den Rechten aus der Tabelle oben anlegen, nur für die gewünschten Repos, und unter Einstellungen → GitHub in der Zentrale eintragen (nicht im Chat). Das alte Lese-Token danach löschen. Pro Repo „Schreibzugriff“ einschalten, wo gewünscht.
