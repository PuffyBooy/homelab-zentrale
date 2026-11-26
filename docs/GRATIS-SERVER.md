# Dauerhaft kostenlose Server (Stand November 2026)

Welche Cloud-Server kosten dauerhaft nichts und taugen als weiterer Server für die Zentrale (Agent per Einzeiler, siehe M11)? Gemeint sind VMs ohne Ablaufdatum, keine 12-Monats-Testphasen.

Quellen sind Vergleichsseiten und Erfahrungsberichte von Februar bis Oktober 2026 (unten verlinkt), nicht die Anbieter selbst. Die genauen Grenzen deines Kontos siehst du in der Konsole des Anbieters.

## Echt dauerhaft kostenlos

| Anbieter | Was gratis ist | Gut für | Haken |
| --- | --- | --- | --- |
| **Oracle Cloud Always Free** | ARM (Ampere A1): **2 OCPU und 12 GB RAM** (seit Juni 2026, vorher 4 OCPU und 24 GB), dazu 2 kleine AMD-VMs (je 1/8 OCPU, 1 GB). 200 GB Block-Speicher, 10 TB Traffic im Monat. | Gameserver (Minecraft, Terraria, Valheim nur amd64), Checks von außen, Share-Gateway | Kreditkarte nötig. Heimatregion ist fest. Oft „Out of host capacity“ in beliebten Regionen. Oracle holt VMs zurück, die 7 Tage lang unter 20 % CPU, Netz und RAM liegen. Über dem Limit droht Abrechnung oder Löschung. Ältere Konten haben laut einer Quelle noch 4 OCPU und 24 GB (nicht bestätigt). |
| **Google Cloud Free Tier** | 1 × e2-micro (2 geteilte vCPU, 1 GB RAM), 30 GB Platte, 1 GB Traffic im Monat aus Nordamerika | Kleiner Außen-Checker (Agent mit `from_agent_id`), Uptime-Prüfung von außen | Nur `us-west1`, `us-central1`, `us-east1`. Kreditkarte nötig. 1 GB RAM reicht nicht für Gameserver. Traffic über 1 GB kostet. |

## Nur auf Zeit (keine Dauerlösung)

- **AWS:** Neue Konten (seit 15.07.2025) bekommen 100 bis 200 USD Guthaben für höchstens 6 Monate. Ein dauerhaft freies EC2 gibt es nicht mehr. Alte Konten haben noch 12 Monate t2/t3.micro.
- **Azure:** 200 USD für 30 Tage, B1s/B2pts/B2ats für 12 Monate.
- **DigitalOcean, Linode/Akamai, Vultr, Hetzner:** nur Startguthaben für 60 Tage oder Aktionen.
- **Fly.io** (seit 2024) und **Heroku** (seit 2022): kein Gratis-Angebot mehr.
- **Render, Koyeb, Cloudflare Workers, Vercel, Netlify:** keine VMs, kein Docker-Host für den Agent. Render-Gratisdienste schlafen nach 15 Min ein.
- **IBM, Alibaba, Tencent:** nur kleine Gratis-Dienste, keine dauerhaft freie VM.

## Empfehlung für die Zentrale

1. **Oracle ARM** als zweiter großer Server: Gameserver für Freunde (öffentliche IP, keine Portweiterleitung zu Hause), Share-Gateway, Checks von außen. Die eingebaute Lastverschiebung (M11) zieht Gameserver dorthin. Damit Oracle die VM nicht als „leer“ zurückholt, läuft dort am besten dauerhaft etwas (Gameserver mit Schlafmodus aus oder ein kleiner Dienst).
2. **Google e2-micro** als kleiner Außenposten in den USA, nur für Checks von außen (Agent ohne Gameserver).
3. Beide bekommen den Agent wie jeder andere Server: Tailscale installieren, Docker installieren, unter Server → „Server hinzufügen“ den Einzeiler ausführen. Für Oracle die Ports der Gameserver in der Security List **und** in iptables auf der VM öffnen (`docs/NETWORK.md`).

## Quellen

- [cloud-free-tier-2026 (GitHub, Feb. 2026)](https://github.com/emmanuelakwasi/cloud-free-tier-2026)
- [Oracle Cloud Always Free Tier Cut 2026 (Juni 2026)](https://braindetox.kr/en/posts/oracle_always_free_tier_reduced_2026.html)
- [Free VPS in 2026: 6 Real Options (Okt. 2026)](https://klymentiev.com/blog/free-vps)
- [5 Best Free VPS Tiers in 2026 (Aug. 2026)](https://www.mrplanb.com/datacenter/free-vps-tiers)
- [Oracle Free Tier vs AWS/GCP for game servers (Okt. 2026)](https://unixgaming.org/oracle-cloud-free-tier-vs-aws-gcp-game-servers-2026/)
