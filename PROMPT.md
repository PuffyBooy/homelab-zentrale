# Start mit Claude Code Projects

Dieses Repo ist für **Claude Code Projects** vorbereitet: Ein Koordinator verteilt die Arbeit auf Threads. Jeder Thread ist eine eigene Cloud-Sitzung mit eigenem Branch.

## Einrichten
1. claude.ai/code (oder Code-Tab in der Desktop-App) → Seitenleiste **Projects** → neues Projekt „Homelab-Zentrale“
2. Repo `PuffyBooy/homelab-zentrale` hinzufügen
3. Den Block unten als erste Nachricht an den Koordinator schicken

Jeder Thread liest automatisch `CLAUDE.md`, und damit `AGENTS.md` und die Sub-Agents in `.claude/agents/`.

> Achtung Verbrauch: Jeder Thread ist eine volle Claude-Code-Sitzung. Parallele Threads verbrauchen dein Limit entsprechend schneller. Der Prompt begrenzt sie deshalb auf höchstens 3 gleichzeitig.

---

```text
Projekt: die „Homelab-Zentrale“ im Repo PuffyBooy/homelab-zentrale. Das ist mein privates
Kontrollzentrum für alle meine Server, Docker-Container, Gameserver (mit Benutzerlinks für
Freunde), mein GitHub-Konto mit Deploy, Website-Checks, Push-Meldungen und Home Assistant.
Alles Nötige steht im Repo: AGENTS.md, docs/ und design/.

Deine Rolle als Koordinator:
1. Lies AGENTS.md, docs/ROADMAP.md und docs/SPEC.md. Die festen Entscheidungen in AGENTS.md
   (Stack, kein Tailwind/UI-Kit, nie öffentlich erreichbar, Agent-Allowlist) sind verbindlich.
2. Arbeite die Meilensteine aus docs/ROADMAP.md der Reihe nach ab, beginnend mit M0.
   Der nächste Meilenstein startet erst, wenn der vorige gemergt ist.
3. Pro Meilenstein:
   - Zuerst ein Thread für das Arbeitspaket „Schema“ (packages/shared), falls es eines gibt.
   - Danach ein eigener Thread pro Arbeitspaket, das in der Roadmap mit ∥ markiert ist.
     Höchstens 3 Threads gleichzeitig. Jeder Thread arbeitet nur in seinem Besitzer-Ordner.
   - Pakete ohne ∥ laufen nacheinander in einem Thread.
   - Jeder Thread: eigener Branch m<N>-<paket>, kleine Commits, `pnpm check` grün, PR auf main.
4. Wenn alle Pakete eines Meilensteins fertig sind: ein Review-Thread mit dem Sub-Agent
   `reviewer` (siehe .claude/agents/). Erst wenn er „kann gemergt werden“ sagt, ist der
   Meilenstein fertig.
5. Frag mich nur, wenn eine Entscheidung nicht rückgängig zu machen ist oder etwas meine
   Zugangsdaten bzw. Geräte braucht (Tailscale, Tokens, Ports). Alles andere entscheidest du
   nach den Docs. Offene Punkte kommen in docs/QUESTIONS.md.
6. Nach jedem Meilenstein schick mir ein kurzes Update: was fertig ist, welche PRs ich mergen
   soll, was ich selbst tun muss (Tabelle unten in PROMPT.md) und was als Nächstes kommt.

Starte mit M0.
```

---

## Ohne Projects (normales Claude Code)

Im geklonten Repo `claude` starten und schreiben: „Lies CLAUDE.md und starte mit M0 aus docs/ROADMAP.md.“ Claude setzt dann für parallele Pakete die Sub-Agents aus `.claude/agents/` ein. Danach pro Meilenstein: „Weiter mit M<N>.“

## Was du selbst vorbereiten musst

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
