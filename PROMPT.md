# Startprompt für Codex / Claude Code

Kopiere den Block unten als ersten Auftrag in Codex (Projekt mit diesem Repo) oder in Claude Code. Danach reicht pro Meilenstein: „Weiter mit M<N>.“

---

```text
Du baust die „Homelab-Zentrale“: mein privates Kontrollzentrum für alle meine Server,
Docker-Container, Gameserver (mit Benutzerlinks für Freunde), mein GitHub-Konto mit Deploy,
Website-Checks, Push-Meldungen und Home Assistant. Alles steht im Repo.

1. Lies zuerst AGENTS.md vollständig und halte die Lesereihenfolge dort ein:
   docs/SPEC.md → docs/ARCHITECTURE.md → docs/SECURITY.md → docs/NETWORK.md →
   docs/ROADMAP.md → design/README.md.
2. Die festen Entscheidungen in AGENTS.md (Stack, kein Tailwind/UI-Kit, nie öffentlich
   erreichbar, Agent-Allowlist) sind verbindlich. Weich nicht davon ab. Wenn etwas fehlt
   oder sich widerspricht, trag es in docs/QUESTIONS.md ein und nimm die sicherste,
   einfachste Variante.
3. Arbeite die Meilensteine aus docs/ROADMAP.md der Reihe nach ab, beginnend mit M0.
   Pro Meilenstein: eigener Branch m<N>-<name>, kleine Commits (Conventional Commits),
   am Ende ein PR auf main mit Zusammenfassung, Screenshots (falls UI) und abgehakten
   Abnahmekriterien.
4. Setz Sub-Agents nur für die Arbeitspakete ein, die in der Roadmap mit ∥ markiert sind.
   Jeder Sub-Agent arbeitet nur in seinem Besitzer-Ordner. packages/shared (Schemas)
   wird zuerst fertig gemacht, bevor die parallelen Pakete starten.
5. Jede Oberfläche entsteht aus design/: Tokens aus design/tokens.css, Styles aus
   design/components.css, Komponenten als TSX-Port von design/reference/bundle.js mit den
   Props aus design/reference/index.d.ts. design/reference/previews/Dashboard.html ist die
   Vorlage für die Startseite. Prüf deine UI per Playwright-Screenshot gegen die Previews,
   in allen drei Themes (dark, light, wall).
6. Ein Meilenstein ist erst fertig, wenn `pnpm check` und die Playwright-Smoke-Tests grün
   sind und jede Regel aus docs/SECURITY.md eingehalten ist. Ohne grüne Checks nicht
   weitermachen.
7. Am Ende jedes Meilensteins: docs/CHANGELOG.md ergänzen und mir in 5–10 Zeilen sagen,
   was fertig ist, was ich selbst tun muss (z. B. Tailscale, Deco, Tokens eintragen) und
   was als Nächstes kommt.

Starte jetzt mit M0.
```

---

## Was du selbst vorbereiten musst

Diese Dinge kann kein Agent für dich machen. Du brauchst sie spätestens beim jeweiligen Meilenstein:

| Wann | Was |
| --- | --- |
| M0 | Auf dem Heimserver: Docker installiert, Repo geklont, `.env` aus `.env.example`, `HZ_SECRET_KEY` mit `openssl rand -base64 32` |
| M1 | Tailscale auf Heimserver, Handy und Laptop; im Tailscale-Admin MagicDNS und HTTPS-Zertifikate einschalten; dann `tailscale serve --bg --https=443 http://127.0.0.1:8080` |
| M2 | Tailscale und den Agent (Einzeiler aus der Zentrale) auf `oracle-a1`, `soundos-pi` und jedem weiteren Server |
| M4 | Die Zentrale am Handy als App installieren (Teilen → „Zum Home-Bildschirm“), dann Push erlauben |
| M5 | GitHub → Settings → Developer settings → Fine-grained token (nur Lesen: Contents, Actions, Metadata) und in der Zentrale eintragen |
| M6 | Für Gameserver von außen: Ports in der Oracle Security List öffnen bzw. Portweiterleitung im Deco auf den Heimserver |
| M7 | Nur wenn Freunde ohne Tailscale steuern sollen: Share-Gateway auf `oracle-a1` mit deinem DDNS-Namen |
| M8 | Home Assistant → Profil → Long-Lived Access Token, in der Zentrale eintragen |
