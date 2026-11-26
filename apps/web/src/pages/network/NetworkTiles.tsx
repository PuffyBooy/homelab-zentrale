import type { DnsFilterStatus, FritzStatus } from '@hz/shared';
import { useMemo, type ReactElement } from 'react';
import { Link } from 'react-router';
import { Alert, Button, Metric, StatusDot, Tile } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { formatAgo, formatUptime } from '../../lib/format.js';
import {
  INTERFACE_LABEL,
  INTERNET_TEXT,
  PAUSE_MINUTES,
  blockingState,
  blockingStatus,
  blockingText,
  filterDevices,
  formatBlockedPct,
  formatCount,
  mbitValue,
  internetState,
  internetStatus,
  type DeviceFilter,
  type PauseMinutes,
} from '../../lib/network.js';

export const FRITZ_SETTINGS_HREF = '/settings#anbindung-fritzbox';
export const DNS_SETTINGS_HREF = '/settings#anbindung-dnsfilter';

function Unreachable({
  what,
  error,
  fetchedAt,
  href,
  now,
}: {
  what: string;
  error: string;
  fetchedAt: string | null;
  href: string;
  now: Date;
}): ReactElement {
  return (
    <Alert
      tone="crit"
      title={`${what} nicht erreichbar: ${error}`}
      action={
        <Link className="hz-btn hz-btn-secondary hz-btn-sm" to={href}>
          <span>Einstellungen</span>
        </Link>
      }
    >
      {fetchedAt
        ? `Werte zeigen den Stand von ${formatAgo(new Date(fetchedAt), now)}.`
        : 'Adresse und Zugangsdaten prüfen. Die Zentrale versucht es weiter.'}
    </Alert>
  );
}

// ---------------------------------------------------------------------------
// Internet (FRITZ!Box)

export interface InternetTileProps {
  fritz: FritzStatus;
  now: Date;
  onReboot: () => void;
  rebootDone?: boolean;
}

export function InternetTile({
  fritz: f,
  now,
  onReboot,
  rebootDone,
}: InternetTileProps): ReactElement {
  const state = internetState(f);
  const i = f.internet;
  return (
    <Tile
      title="Internet"
      icon="globe"
      status={internetStatus(state)}
      statusLabel={INTERNET_TEXT[state]}
      span={2}
      footer={
        <span className="app-foot-text">
          {f.model ?? 'FRITZ!Box'}
          {f.firmware ? ` · FRITZ!OS ${f.firmware}` : ''}
        </span>
      }
    >
      {f.error ? (
        <Unreachable
          what="FRITZ!Box"
          error={f.error}
          fetchedAt={f.fetchedAt}
          href={FRITZ_SETTINGS_HREF}
          now={now}
        />
      ) : null}
      {i ? (
        <>
          <div className="app-metrics">
            <Metric
              label="Download max"
              value={mbitValue(i.maxDownBps)}
              unit={i.maxDownBps == null ? undefined : 'Mbit/s'}
            />
            <Metric
              label="Upload max"
              value={mbitValue(i.maxUpBps)}
              unit={i.maxUpBps == null ? undefined : 'Mbit/s'}
            />
          </div>
          <dl className="app-kv">
            <dt>Leitung</dt>
            <dd>{i.linkStatus ?? '—'}</dd>
            <dt>Verbunden seit</dt>
            <dd>{i.connected ? formatUptime(i.uptimeS) : '—'}</dd>
            <dt>Externe IP</dt>
            <dd>{i.externalIp ?? '—'}</dd>
          </dl>
        </>
      ) : f.error ? null : (
        <p className="app-empty">Die FRITZ!Box meldet keinen Internet-Status.</p>
      )}
      {rebootDone ? (
        <Alert tone="info" title="Neustart der FRITZ!Box ausgelöst.">
          Internet und WLAN sind gleich für einige Minuten weg.
        </Alert>
      ) : null}
      <div className="hz-form-actions app-actions-start">
        <Button
          variant="danger"
          icon="power"
          disabled={!!f.error && !f.fetchedAt}
          onClick={onReboot}
        >
          FRITZ!Box neu starten
        </Button>
      </div>
    </Tile>
  );
}

// ---------------------------------------------------------------------------
// Geräte im Netz

export interface DevicesTileProps {
  fritz: FritzStatus;
  filter: DeviceFilter;
  onFilter: (f: DeviceFilter) => void;
}

export function DevicesTile({ fritz, filter, onFilter }: DevicesTileProps): ReactElement {
  const list = useMemo(() => filterDevices(fritz.devices, filter), [fritz.devices, filter]);
  const active = fritz.devices.filter((d) => d.active).length;
  return (
    <Tile
      title="Geräte im Netz"
      icon="wifi"
      count={`${active} aktiv · ${fritz.devices.length} bekannt`}
      span={4}
      flush
      actions={
        <span className="app-seg" role="group" aria-label="Geräte filtern">
          <Button
            size="sm"
            variant={filter === 'active' ? 'secondary' : 'ghost'}
            aria-pressed={filter === 'active'}
            onClick={() => onFilter('active')}
          >
            Aktive
          </Button>
          <Button
            size="sm"
            variant={filter === 'all' ? 'secondary' : 'ghost'}
            aria-pressed={filter === 'all'}
            onClick={() => onFilter('all')}
          >
            Alle
          </Button>
        </span>
      }
    >
      {list.length === 0 ? (
        <p className="app-empty app-pad">
          {fritz.devices.length
            ? 'Gerade ist kein Gerät aktiv.'
            : 'Die FRITZ!Box meldet keine Geräte.'}
        </p>
      ) : (
        <ul className="app-devices" aria-label="Geräte">
          {list.map((d, i) => (
            <li key={`${d.mac ?? d.name}-${i}`} className="hz-row">
              <StatusDot
                status={d.active ? 'ok' : 'off'}
                label={d.active ? 'aktiv' : 'inaktiv'}
                hideLabel
              />
              <div className="hz-row-main">
                <span className="hz-row-name">{d.name || d.mac || 'ohne Namen'}</span>
                <span className="hz-row-sub">{d.mac ?? ''}</span>
              </div>
              <div className="hz-row-meta app-device-meta">
                <span className="app-device-ip">{d.ip ?? '—'}</span>
                <span className="app-device-if">{INTERFACE_LABEL[d.interface]}</span>
                <span className="app-device-state">{d.active ? 'aktiv' : 'inaktiv'}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Tile>
  );
}

// ---------------------------------------------------------------------------
// DNS-Filter

export interface DnsFilterTileProps {
  dns: DnsFilterStatus;
  now: Date;
  busy: boolean;
  error?: string | null;
  onBlocking: (minutes: PauseMinutes | null) => void;
}

export function DnsFilterTile({
  dns: d,
  now,
  busy,
  error,
  onBlocking,
}: DnsFilterTileProps): ReactElement {
  const state = blockingState(d);
  const name =
    d.variant === 'adguard' ? 'AdGuard Home' : d.variant === 'pihole' ? 'Pi-hole' : 'DNS-Filter';
  return (
    <Tile
      title="DNS-Filter"
      icon="lock"
      status={blockingStatus(state)}
      statusLabel={blockingText(d)}
      span={2}
      footer={<span className="app-foot-text">{name} · Zählung seit Mitternacht</span>}
    >
      {d.error ? (
        <Unreachable
          what={name}
          error={d.error}
          fetchedAt={d.fetchedAt}
          href={DNS_SETTINGS_HREF}
          now={now}
        />
      ) : null}
      <div className="app-metrics">
        <Metric label="Anfragen heute" value={formatCount(d.queriesToday)} />
        <Metric
          label="Blockiert heute"
          value={formatCount(d.blockedToday)}
          hint={
            d.percentBlocked == null
              ? undefined
              : `${formatBlockedPct(d.percentBlocked)} der Anfragen`
          }
        />
        <Metric label="Auf den Listen" value={formatCount(d.domainsOnLists)} unit="Domains" />
      </div>
      {error ? <FormError title={error} /> : null}
      {state === 'on' ? (
        <div className="app-actions" role="group" aria-label="Blocken pausieren">
          <span className="app-text">Pausieren:</span>
          {PAUSE_MINUTES.map((m) => (
            <Button
              key={m}
              size="sm"
              disabled={busy}
              aria-label={`${m} Min pausieren`}
              onClick={() => onBlocking(m)}
            >
              {m === 5 ? '5 Min pausieren' : `${m} Min`}
            </Button>
          ))}
        </div>
      ) : state === 'paused' || state === 'off' ? (
        <div className="app-actions">
          <Button variant="primary" icon="lock" disabled={busy} onClick={() => onBlocking(null)}>
            Wieder blocken
          </Button>
          <span className="app-text">
            {state === 'paused'
              ? 'Danach blockt der Filter von selbst wieder.'
              : 'Der Filter blockt gerade nichts.'}
          </span>
        </div>
      ) : null}
    </Tile>
  );
}
