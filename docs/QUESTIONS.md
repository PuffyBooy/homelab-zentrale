# Offene Fragen

Agents tragen hier Fragen ein, wenn die Spezifikation fehlt oder sich widerspricht. Format: Datum, Meilenstein, Frage, gewählte Annahme.

- 2026-11-25, M0: `NavRail` im Referenz-Bundle liest `item.key` für das Tastenkürzel, `index.d.ts` kennt das Feld aber nicht. Annahme: `key?: string` ist in `packages/ui` optional ergänzt (für die Konsole mit `` ` ``), sonst gilt die Position 1–9.
- 2026-11-25, M0: Die NavRail-Links sind wie in der Referenz einfache `<a href>`, d. h. ein Klick lädt die Seite neu. Annahme: In M1 (Shell) kommt clientseitige Navigation mit Tastenkürzeln dazu, ohne die Props zu ändern.
- 2026-11-25, M0: SECURITY.md verlangt, dass der Core nur an `127.0.0.1` bindet. Im Core-Container muss er aber an `0.0.0.0` lauschen, damit Docker den Port weiterreichen kann. Annahme: `HZ_HOST` erlaubt jede IPv4, Standard `127.0.0.1`. Bei einer Nicht-Loopback-Adresse warnt der Core beim Start, und `deploy/docker-compose.core.yml` veröffentlicht den Port nur auf `127.0.0.1:8080`.
- 2026-11-25, M0: Die CSP erlaubt vorerst `fonts.googleapis.com` und `fonts.gstatic.com`, weil `design/components.css` die Schriften von dort lädt. Annahme: Mit dem PWA-Teil in M1 werden die Schriften unter `apps/web/public/fonts` selbst gehostet, dann fallen die beiden Hosts aus der CSP.
