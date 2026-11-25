# Offene Fragen

Agents tragen hier Fragen ein, wenn die Spezifikation fehlt oder sich widerspricht. Format: Datum, Meilenstein, Frage, gewählte Annahme.

- 2026-11-25, M0: `NavRail` im Referenz-Bundle liest `item.key` für das Tastenkürzel, `index.d.ts` kennt das Feld aber nicht. Annahme: `key?: string` ist in `packages/ui` optional ergänzt (für die Konsole mit `` ` ``), sonst gilt die Position 1–9.
- 2026-11-25, M0: Die NavRail-Links sind wie in der Referenz einfache `<a href>`, d. h. ein Klick lädt die Seite neu. Annahme: In M1 (Shell) kommt clientseitige Navigation mit Tastenkürzeln dazu, ohne die Props zu ändern.
