# Deploy

## Core (Heimserver)

Ein Image: Der Core liefert die gebaute Web-App mit aus.

```bash
cp .env.example .env            # HZ_SECRET_KEY setzen: openssl rand -base64 32
docker compose -f deploy/docker-compose.core.yml up -d --build
curl http://127.0.0.1:8080/api/health   # {"ok":true}
```

- Der Core-Container nutzt das Host-Netz (`network_mode: host`) und lauscht nur auf `127.0.0.1:8080`. `tailscale serve` erreicht ihn über Loopback, dadurch stimmen auch die Client-IPs (X-Forwarded-For) fürs Login-Rate-Limit.
- Die SQLite-Daten liegen im Volume `hz-data` (im Container `/data`).
- Der Container läuft als Benutzer `node`, mit schreibgeschütztem Dateisystem, ohne Capabilities und mit `no-new-privileges`.

## Freigabe im Tailnet

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8080
```

Danach ist die Zentrale unter `https://heimserver.<tailnet>.ts.net` erreichbar. Nie `tailscale funnel` und nie eine Portweiterleitung für den Core (siehe `docs/NETWORK.md`).
