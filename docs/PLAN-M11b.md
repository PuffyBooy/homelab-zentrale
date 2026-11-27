# M11b: Rest-Plan (Stand 27.11.2026, Ausführung ab Sonntag 18:00)

Gebaut und lokal getestet (Onboarding-, Install- und Tailscale-Tests grün), noch nicht durch `pnpm check`:
Bootstrap-Befehl (`buildBootstrapCommand`), Tailscale-OAuth-Client mit Einweg-Keys (`apps/core/src/servers/tailscale.ts`, `/api/tailscale`),
`install.sh` installiert Docker/Compose, fängt Snap, CPU, DNS und Erreichbarkeit ab, UI (Befehl im Dialog, Kachel Einstellungen → Tailscale), Doku.

Offen:
1. `pnpm check` (lint, typecheck, alle Tests) grün machen; neue Tests mit `HZ_DEBUG`-Resten prüfen.
2. Projekt-Datei `homelab/OFFENE-FRAGEN-UND-IDEEN.md` um Punkt 28 ergänzen (dort fehlt die Überschrift „## Entschieden“, also ans Ende der To-do-Liste setzen).
3. Web-Test für `TailscaleTile` (Status, Snippet, kein Secret im HTML).
4. `reviewer` laufen lassen (Sicherheit, Design-Treue), Befunde beheben.
5. Push, PR auf `main`, CI grün (Semgrep, Gitleaks: Fake-Keys sind zerteilt), selbst mergen.
6. Optional: M22-Cloud nutzt den OAuth-Client statt des festen Auth-Keys.
