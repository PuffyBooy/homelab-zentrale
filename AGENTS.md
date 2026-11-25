# AGENTS.md: Anweisungen für Coding-Agents

Diese Datei gilt für jeden Agent, der an diesem Repo arbeitet (Codex, Claude Code, Sub-Agents). Lies sie ganz, bevor du Code schreibst.

## Was gebaut wird

Die **Homelab-Zentrale** ist ein privates Kontrollzentrum für einen einzigen Admin (Alex). Sie zeigt und steuert:

- alle Server (Heimserver in Wien, Oracle-Cloud-VM, Raspberry Pi, weitere VPS)
- Docker-Container auf allen Servern
- Gameserver, die man in Minuten aus Vorlagen aufsetzt, plus Benutzerlinks für Freunde
- das GitHub-Konto (Repos, CI, Deploy per Knopf, Rollback)
- Websites und Ports (Uptime, HTTP-Code, Antwortzeit, SSL- und Domain-Ablauf)
- Meldungen mit Push aufs Handy
- die Wohnung über Home Assistant
- eine Web-Konsole und einen Wandmodus fürs Tablet

Die vollständige Beschreibung steht in `docs/SPEC.md`. Wie es gebaut wird, steht in `docs/ARCHITECTURE.md`, in welcher Reihenfolge in `docs/ROADMAP.md`.

## Lesereihenfolge

1. `AGENTS.md` (diese Datei)
2. `docs/SPEC.md`: was das Produkt kann
3. `docs/ARCHITECTURE.md`: Stack, Ordner, Datenmodell, Agent-Protokoll
4. `docs/SECURITY.md` und `docs/NETWORK.md`: **nicht verhandelbar**
5. `docs/ROADMAP.md`: Meilensteine mit Abnahmekriterien. Arbeite sie der Reihe nach ab.
6. `design/README.md`: das Designsystem. Jede Oberfläche wird daraus gebaut.

## Feste Entscheidungen (nicht ändern ohne Rückfrage)

- **Monorepo** mit pnpm-Workspaces, Node 22 LTS, TypeScript `strict` überall.
- **Core:** Fastify 5, SQLite über better-sqlite3 + Drizzle ORM, zod für jede Eingabe, WebSocket für Live-Daten.
- **Web:** React 18 + Vite + TypeScript, React Router, TanStack Query, PWA (vite-plugin-pwa), xterm.js für die Konsole. **Kein Tailwind, kein UI-Kit** (kein MUI, shadcn, Chakra …). Styles kommen ausschließlich aus `design/` (Tokens + `hz-`-Klassen).
- **Agent:** eigener kleiner TypeScript-Dienst, läuft als Docker-Container auf jedem Server und baut die Verbindung **zum Core** auf (ausgehend, WebSocket über Tailscale).
- **Netzwerk:** Die Zentrale ist **nie öffentlich erreichbar**. Sie lauscht nur auf `127.0.0.1` und wird ausschließlich über `tailscale serve` (HTTPS auf `*.ts.net`) freigegeben. Keine Portweiterleitung für Core oder Agent. Siehe `docs/NETWORK.md`.
- **Tests:** Vitest für Unit- und Integrationstests, Playwright für einen E2E-Smoke-Test pro Meilenstein.
- **Sprache:** UI-Texte auf Deutsch (österreichisches Zahlenformat: `7,8 GB`, `23:04`). Code, Bezeichner, Commits und Kommentare auf Englisch.

## Arbeitsweise

- **Ein Meilenstein nach dem anderen** (`docs/ROADMAP.md`). Ein Meilenstein ist erst fertig, wenn alle Abnahmekriterien erfüllt sind und `pnpm check` grün ist.
- **Sub-Agents** dürfen parallel arbeiten, aber nur an den Arbeitspaketen, die die Roadmap als parallel markiert. Jedes Paket hat einen klaren Ordner. Zwei Agents ändern nie dieselbe Datei gleichzeitig. Gemeinsame Typen ändert nur, wer `packages/shared` besitzt (siehe Roadmap).
- **Erst Schema, dann Code:** Neue API-Routen und Agent-Nachrichten bekommen zuerst ein zod-Schema in `packages/shared`.
- **Kleine Commits** mit Conventional Commits (`feat(core): …`, `fix(web): …`). Pro Meilenstein ein eigener Branch `m<N>-<name>` und am Ende ein PR auf `main`.
- **Nichts erfinden:** Wenn eine Spezifikation fehlt oder sich widerspricht, schreib die Frage in `docs/QUESTIONS.md` und nimm die sicherste, einfachste Variante.
- **Keine Mock-Daten in Produktion.** Demo-Daten nur hinter `HZ_DEMO=1` (für Screenshots und Tests).

## Befehle

```bash
pnpm install
pnpm dev          # core + web + ein lokaler agent im Watch-Modus
pnpm check        # lint + typecheck + test (muss vor jedem Commit grün sein)
pnpm build
pnpm e2e          # Playwright-Smoke-Tests
docker compose -f deploy/docker-compose.core.yml up -d --build
```

Diese Skripte legst du in Meilenstein 0 an.

## Design-Regeln (Kurzfassung, Details in `design/README.md`)

- Tokens aus `design/tokens.css` (CSS-Variablen), Komponenten-Styles aus `design/components.css`. Beides wird in `packages/ui` importiert.
- `design/reference/bundle.js` ist die **Referenzimplementierung** jeder Komponente (React ohne JSX). Portiere sie 1:1 nach TSX in `packages/ui/src/`, mit denselben Props (`design/reference/index.d.ts`) und denselben Klassennamen.
- `design/reference/previews/*.html` zeigen jede Komponente mit Beispieldaten. Die Dashboard-Vorschau ist die Vorlage für die Startseite.
- Drei Themes über `data-theme` auf `<html>`: `dark` (Standard), `light`, `wall`.
- Status immer mit Form **und** Text (UP/WARN/DOWN/OFF), nie nur über Farbe.
- Bernstein (`--accent`) nur für die eine Hauptaktion, den aktiven Nav-Punkt, den Fokus und Git-Hashes.
- Keine Verläufe, keine Glas-Effekte, keine Emojis, keine Schatten auf Kacheln.

## Sicherheit (Kurzfassung, Details in `docs/SECURITY.md`)

- Jede Route außer `/api/health` und `/s/*` (Share-Gateway) braucht eine Admin-Session.
- Login: Passwort (argon2id) + TOTP. Sessions als httpOnly-Cookie, `SameSite=Strict`, `Secure`.
- Secrets (GitHub-Token, HA-Token, Agent-Tokens, RCON-Passwörter) werden mit AES-256-GCM verschlüsselt in der DB gespeichert. Der Schlüssel kommt aus `HZ_SECRET_KEY`.
- Der Agent führt **keine beliebigen Befehle** aus, nur die Aktionen aus der Allowlist im Protokoll. Die Web-Konsole ist eine eigene, ausdrücklich eingeschaltete Fähigkeit pro Server.
- Kein Secret im Repo, im Log oder in einer Fehlermeldung.
