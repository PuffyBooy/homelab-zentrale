import type { ReactElement } from 'react';
import { BlockBar } from './BlockBar.js';
import { cx } from './cx.js';
import { StatusDot } from './StatusDot.js';
import type { Status } from './types.js';

export interface ServerInfo {
  id: string;
  name: string;
  where: string;
  ip?: string | undefined;
  status?: Status | undefined;
  cpu?: number | undefined;
  ram?: number | undefined;
  disk?: number | undefined;
  uptime?: string | undefined;
  note?: string | undefined;
}

export interface ServerListProps {
  servers: ServerInfo[];
  active?: string | undefined;
  onSelect?: ((id: string) => void) | undefined;
}

function pct(v: number | undefined): string {
  return v == null ? '—' : v + '%';
}

/** 1:1 port of ServerList from design/reference/bundle.js. */
export function ServerList({ servers, active, onSelect }: ServerListProps): ReactElement {
  return (
    <div className="hz-srvlist" role="list">
      <div className="hz-srvlist-head hz-label">
        <span>Server</span>
        <span>CPU</span>
        <span>RAM</span>
        <span>Disk</span>
        <span>Up</span>
      </div>
      {(servers || []).map((s) => {
        const on = s.id === active;
        return (
          <button
            key={s.id}
            type="button"
            role="listitem"
            className={cx('hz-srv', on && 'hz-srv-on', s.status === 'crit' && 'hz-srv-crit')}
            onClick={() => onSelect?.(s.id)}
          >
            <span className="hz-srv-name">
              <StatusDot status={s.status || 'ok'} hideLabel={true} />
              <span>
                <b>{s.name}</b>
                <small>{s.where + (s.ip ? ' · ' + s.ip : '')}</small>
              </span>
            </span>
            {s.status === 'crit' ? (
              <span className="hz-srv-down">{s.note || 'nicht erreichbar'}</span>
            ) : (
              <>
                <span className="hz-srv-cell">
                  <BlockBar value={s.cpu ?? 0} cells={6} label="CPU" />
                  <i>{pct(s.cpu)}</i>
                </span>
                <span className="hz-srv-cell">
                  <BlockBar value={s.ram ?? 0} cells={6} label="RAM" />
                  <i>{pct(s.ram)}</i>
                </span>
                <span className="hz-srv-cell">
                  <BlockBar value={s.disk ?? 0} cells={6} label="Disk" />
                  <i>{pct(s.disk)}</i>
                </span>
                <span className="hz-srv-up">{s.uptime}</span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
