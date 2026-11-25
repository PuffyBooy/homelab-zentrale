# CLAUDE.md

@AGENTS.md

## Claude-Code-spezifisch

- Arbeite die Meilensteine in `docs/ROADMAP.md` der Reihe nach ab. Starte jeden Meilenstein im Plan-Modus: Lies die relevanten Docs, schreib einen kurzen Plan mit den Arbeitspaketen und leg dann los.
- Für die mit ∥ markierten Arbeitspakete setzt du die Sub-Agents aus `.claude/agents/` ein (Task-Tool). Sie laufen parallel, jeder nur in seinem Ordner:
  - `ui-builder`: `packages/ui`, `apps/web`
  - `core-builder`: `apps/core`, `packages/shared`
  - `agent-builder`: `apps/agent`, `templates/games`, `deploy/`
  - `reviewer`: prüft am Ende jedes Meilensteins Sicherheit, Design-Treue und Abnahmekriterien. Er ändert nichts, er meldet nur.
- `packages/shared` (Schemas) ist zuerst fertig, bevor parallele Pakete starten.
- Vor jedem Commit muss `pnpm check` grün sein. Vor jedem PR läuft der `reviewer`.
- Halte eine Aufgabenliste (TodoWrite) pro Meilenstein mit den Abnahmekriterien als Punkte.
