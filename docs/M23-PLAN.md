# M23 Docker komplett: Stand und Plan

Stand 2026-11-27 (Arbeit pausiert auf Wunsch des Admins, weiter ab Sonntag 18:00 Wien).
Branch `claude/project-thread-nigeir`. Ziel und Abnahme: `docs/ROADMAP.md` M23, Funktionen: `docs/SPEC.md` 6.1b und 11.

## Fertig (WIP-Commit, noch nicht reviewt)
- **Schemas** (`packages/shared/src/agent-docker.ts`, `api/docker.ts`, `pty.open` + Konsole mit `container`), mit Sicherheitstests.
- **Core** (`apps/core/src/docker/`, `terminal/`): alle Routen aus `api/docker.ts`, Step-up und Namensbestätigung, Absichten bei Stack-Stopp, Audit, Konsole mit Container-Ziel, `ContainerService.forget()`. 43 Tests, ganze Core-Suite grün.
- **Agent** (`apps/agent/src/actions/`): Handler für alle neuen Aktionen, Container-Shell in `pty.ts`, Tests. Typecheck und Agent-Suite grün; der Builder wurde mitten in den Stack-Tests angehalten.
- **Web** (`apps/web`): Details-Dialog, Entfernen-Dialog, Stack-Aktionen, Docker-Bereich (Images/Volumes/Netzwerke), Konsolen-Ziel. Typecheck und vorhandene Tests grün; Routen, Seitentitel und CSS waren gerade in Arbeit.

## Offen (Reihenfolge)
1. Agent: Stack-Tests fertig (`apps/agent/test/stack.security.test.ts`), Host-Pfadprüfung und `down` ohne `--volumes` abdecken.
2. Web: Route/Nav/Seitentitel für den Docker-Bereich fertig, CSS nur aus `design/`, neue Web-Tests (Aktionen sichtbar/versteckt, Name nötig, Step-up, keine Env-Werte, Konsolen-URL mit `container`).
3. Fehlercode: `agent_outdated` in `errorCodeSchema` (shared) aufnehmen und in `apps/core/src/docker/routes.ts` `dockerHttpError` nutzen (heute 409 `conflict` mit Text „Agent zu alt, bitte aktualisieren“); Web zeigt den Text.
4. e2e: `e2e/helpers/sim-agent.ts` um die neuen Aktionen erweitern, `e2e/m23-docker.spec.ts` (Containerseite, Details, Docker-Bereich).
5. `pnpm check` und `pnpm e2e` grün, dann `reviewer` (Sicherheit, Design, Abnahme).
6. Commits aufräumen (Conventional Commits), PR auf `main`, CI grün, selbst mergen.
7. Kurzes Update an den Admin: was neu ist und wie man es benutzt.
