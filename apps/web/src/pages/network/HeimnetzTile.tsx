import type { DnsFilterStatus, FritzStatus } from '@hz/shared';
import type { ReactElement } from 'react';
import { Link } from 'react-router';
import { Metric, StatusDot, Tile } from '@hz/ui';
import {
  INTERNET_TEXT,
  blockingState,
  blockingStatus,
  blockingText,
  formatBlockedPct,
  internetState,
  internetStatus,
} from '../../lib/network.js';

export interface HeimnetzTileProps {
  fritz?: FritzStatus | undefined;
  dns?: DnsFilterStatus | undefined;
  fritzOn: boolean;
  dnsOn: boolean;
}

/**
 * Overview tile "Heimnetz" (SPEC 16): internet state and "X % blockiert heute". The whole
 * tile turns crit while the internet line is down (problem first, design README).
 */
export function HeimnetzTile({ fritz, dns, fritzOn, dnsOn }: HeimnetzTileProps): ReactElement {
  const inet = fritzOn && fritz ? internetState(fritz) : null;
  const down = inet === 'down';
  const block = dnsOn && dns ? blockingState(dns) : null;
  const status = down
    ? 'crit'
    : inet === 'unknown' || (block !== null && block !== 'on')
      ? 'warn'
      : inet === 'up' || block === 'on'
        ? 'ok'
        : undefined;
  return (
    <Tile
      title="Heimnetz"
      icon="wifi"
      span={2}
      status={status}
      statusLabel={down ? 'Internet getrennt' : undefined}
      footer={
        <Link className="app-more" to="/network">
          Netzwerk
        </Link>
      }
    >
      <div className="app-metrics">
        {inet !== null ? (
          <div className="app-heimnetz-item">
            <span className="hz-label">Internet</span>
            <StatusDot status={internetStatus(inet)} label={INTERNET_TEXT[inet]} />
            {fritz?.error ? <span className="app-foot-text">FRITZ!Box: {fritz.error}</span> : null}
          </div>
        ) : null}
        {block !== null && dns ? (
          dns.error || block !== 'on' ? (
            <div className="app-heimnetz-item">
              <span className="hz-label">DNS-Filter</span>
              <StatusDot status={blockingStatus(block)} label={blockingText(dns)} />
            </div>
          ) : (
            <Metric
              label="DNS-Filter"
              value={formatBlockedPct(dns.percentBlocked).replace(' %', '')}
              unit={dns.percentBlocked == null ? undefined : '%'}
              hint="blockiert heute"
            />
          )
        ) : null}
      </div>
      {inet === null && block === null ? <p className="app-empty">Lade Heimnetz …</p> : null}
    </Tile>
  );
}
