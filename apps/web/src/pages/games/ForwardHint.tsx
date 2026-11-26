import type { ServerSummary } from '@hz/shared';
import type { ReactElement } from 'react';
import { forwardPlace, forwardRules, type Protocol } from '../../lib/games.js';

export interface ForwardHintProps {
  ports: readonly { name: string; port: number; protocol: Protocol; count?: number | undefined }[];
  server: ServerSummary | undefined;
}

/**
 * SPEC 6.2 step 4: which ports to open so friends reach the game from outside. Text
 * only, the Zentrale never changes the router or the cloud firewall.
 */
export function ForwardHint({ ports, server }: ForwardHintProps): ReactElement {
  const rules = forwardRules(ports);
  const place = forwardPlace(server);
  const list = (
    <ul className="app-rules">
      {rules.map((r) => (
        <li key={r.name}>
          <span className="app-rule-port">
            {r.ports}/{r.protocol}
          </span>
          <span className="app-rule-name">{r.name}</span>
        </li>
      ))}
    </ul>
  );
  const where = server ? server.name : 'dem Server';
  return (
    <div className="app-forward">
      <p className="app-text">
        Nur nötig, wenn Freunde ohne Tailscale spielen sollen. Im Tailnet reicht die Adresse so.
        Freigeben auf {where}:
      </p>
      {list}
      {place !== 'oracle' ? (
        <>
          <h3 className="hz-label">Zuhause (Deco-Router)</h3>
          <ol className="app-howto">
            <li>Deco-App öffnen: Mehr → Erweitert → NAT-Weiterleitung → Port-Weiterleitung.</li>
            <li>
              Pro Zeile oben einen Eintrag: Ziel ist die LAN-IP von {where}, interner und externer
              Port gleich, Protokoll wie angegeben.
            </li>
            <li>Für eine feste Adresse den DDNS-Namen als externe Adresse eintragen.</li>
          </ol>
        </>
      ) : null}
      {place !== 'home' ? (
        <>
          <h3 className="hz-label">Oracle Cloud (Security List)</h3>
          <ol className="app-howto">
            <li>
              Konsole: Networking → Virtual Cloud Networks → VCN → Security Lists → Default Security
              List.
            </li>
            <li>
              Pro Zeile oben eine Ingress-Regel: Quelle 0.0.0.0/0, Protokoll wie angegeben,
              Ziel-Port wie angegeben (bei TCP und UDP zwei Regeln).
            </li>
            <li>
              Auf der VM selbst blockiert die iptables-Firewall des Oracle-Images die Ports
              zusätzlich. Dort dieselben Ports erlauben.
            </li>
          </ol>
        </>
      ) : null}
    </div>
  );
}
