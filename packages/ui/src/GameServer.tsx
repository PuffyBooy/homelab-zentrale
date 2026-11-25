import type { ReactElement } from 'react';
import { Button } from './Button.js';
import { copyText } from './clipboard.js';
import { cx } from './cx.js';
import { Icon } from './Icon.js';
import { StatusDot } from './StatusDot.js';
import type { Status } from './types.js';
import { UsageBar } from './UsageBar.js';

export interface GameServerProps {
  name: string;
  game: string;
  version?: string | undefined;
  address: string;
  status?: Status | undefined;
  players?: [number, number] | undefined;
  ram?: number | undefined;
  ramDetail?: string | undefined;
  tps?: number | null | undefined;
  online?: string[] | undefined;
  host: string;
}

/** 1:1 port of GameServer from design/reference/bundle.js. */
export function GameServer({
  name,
  game,
  version,
  address,
  status,
  players,
  ram,
  ramDetail,
  tps,
  online,
  host,
}: GameServerProps): ReactElement {
  const pl = players || [0, 0];
  return (
    <section className={cx('hz-tile hz-game', status === 'crit' && 'hz-tile-crit')}>
      <header className="hz-tile-head">
        <div className="hz-tile-title">
          <Icon name="gamepad" size={12} />
          <span>{name}</span>
        </div>
        <StatusDot status={status || 'ok'} />
      </header>
      <div className="hz-game-body">
        <div className="hz-game-top">
          <div>
            <div className="hz-label">{game + (version ? ' · ' + version : '')}</div>
            <button
              type="button"
              className="hz-addr"
              onClick={() => copyText(address)}
              title="Adresse kopieren"
            >
              <span>{address}</span>
              <Icon name="copy" size={12} />
            </button>
          </div>
          <div className="hz-game-players">
            <span className="hz-num">{pl[0]}</span>
            <span className="hz-unit">{'/' + pl[1]}</span>
            <div className="hz-label">Spieler</div>
          </div>
        </div>
        <div className="hz-game-stats">
          <UsageBar label="RAM" value={ram || 0} cells={12} detail={ramDetail} />
          <UsageBar
            label="TPS"
            value={tps != null ? (tps / 20) * 100 : 0}
            cells={12}
            warnAt={101}
            critAt={101}
            detail={tps != null ? String(tps) : '—'}
          />
        </div>
        {online && online.length ? (
          <div className="hz-game-online">
            {online.map((n) => (
              <span key={n}>{n}</span>
            ))}
          </div>
        ) : null}
      </div>
      <footer className="hz-game-actions">
        {status === 'off' ? (
          <Button size="sm" variant="primary" icon="play">
            Start
          </Button>
        ) : (
          <Button size="sm" icon="stop">
            Stop
          </Button>
        )}
        <Button size="sm" icon="refresh">
          Restart
        </Button>
        <Button size="sm" icon="terminal">
          Konsole
        </Button>
        <Button size="sm" variant="ghost" icon="link">
          Teilen
        </Button>
        <span className="hz-game-host">{host}</span>
      </footer>
    </section>
  );
}
