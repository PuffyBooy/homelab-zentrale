# Changelog

## Unreleased
- M0: `apps/core` mit Fastify, `GET /api/health` → `{ok:true}`, zod-geprüfter Config aus der Env (Start bricht ohne gültigen `HZ_SECRET_KEY` ab) und Auslieferung der Web-App aus `HZ_WEB_DIR` mit SPA-Fallback. `apps/web` mit Vite + React 18, lädt Tokens und Komponenten-Styles aus `design/` und zeigt eine leere Seite mit `NavRail` (aus `packages/ui`). Playwright-Smoke-Test `e2e/m0-shell.spec.ts`.
- M0: Monorepo-Gerüst mit pnpm-Workspaces (`apps/{core,web,agent,share}`, `packages/{shared,ui}`), TypeScript strict, ESLint (flat config), Prettier, Vitest und Playwright. Skripte `dev`, `check`, `build`, `e2e`.
- Spezifikation, Architektur, Sicherheits- und Netzwerkregeln, Roadmap und Designsystem angelegt.
