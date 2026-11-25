# Deploy

## Core (Heimserver)

Ein Image: Der Core liefert die gebaute Web-App mit aus.

```bash
cp .env.example .env            # HZ_SECRET_KEY setzen: openssl rand -base64 32
docker compose -f deploy/docker-compose.core.yml up -d --build
curl http://127.0.0.1:8080/api/health   # {"ok":true}
```

- Der Port ist nur an `127.0.0.1:8080` gebunden. Im Container lauscht der Core auf `0.0.0.0`, damit die Portzuordnung funktioniert; von außen ist er trotzdem nicht erreichbar.
- Die SQLite-Daten liegen im Volume `hz-data` (im Container `/data`).
- Der Container läuft als Benutzer `node`, mit schreibgeschütztem Dateisystem, ohne Capabilities und mit `no-new-privileges`.

## Freigabe im Tailnet

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8080
```

Danach ist die Zentrale unter `https://heimserver.<tailnet>.ts.net` erreichbar. Nie `tailscale funnel` und nie eine Portweiterleitung für den Core (siehe `docs/NETWORK.md`).
