import type { ReactElement } from 'react';
import { Button } from './Button.js';
import { copyText } from './clipboard.js';
import { cx } from './cx.js';
import { Icon } from './Icon.js';
import { StatusDot } from './StatusDot.js';
import type { Status } from './types.js';
import { UsageBar } from './UsageBar.js';

/** The four footer actions of the tile (Start and Stop share one slot). */
export type GameServerAction = 'start' | 'stop' | 'restart' | 'console' | 'share';

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
  /**
   * Additions to the reference (docs/QUESTIONS.md, M1 and M6). Without them the
   * markup is the same as in bundle.js.
   */
  /** Formatted TPS ("19,8"); default is the raw number like the reference. */
  tpsDetail?: string | undefined;
  onStart?: (() => void) | undefined;
  onStop?: (() => void) | undefined;
  onRestart?: (() => void) | undefined;
  onConsole?: (() => void) | undefined;
  onShare?: (() => void) | undefined;
  /** Called after a click on the address copied it. */
  onCopy?: ((address: string) => void) | undefined;
  /** Footer buttons rendered as disabled (busy, not available yet). */
  disabledActions?: readonly GameServerAction[] | undefined;
}

/** 1:1 port of GameServer from design/reference/bundle.js, plus optional handlers. */
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
  tpsDetail,
  onStart,
  onStop,
  onRestart,
  onConsole,
  onShare,
  onCopy,
  disabledActions,
}: GameServerProps): ReactElement {
  const pl = players || [0, 0];
  const off = (a: GameServerAction): true | undefined =>
    disabledActions?.includes(a) ? true : undefined;
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
              onClick={() => {
                copyText(address);
                onCopy?.(address);
              }}
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
            detail={tps != null ? (tpsDetail ?? String(tps)) : '—'}
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
          <Button size="sm" variant="primary" icon="play" onClick={onStart} disabled={off('start')}>
            Start
          </Button>
        ) : (
          <Button size="sm" icon="stop" onClick={onStop} disabled={off('stop')}>
            Stop
          </Button>
        )}
        <Button size="sm" icon="refresh" onClick={onRestart} disabled={off('restart')}>
          Restart
        </Button>
        <Button size="sm" icon="terminal" onClick={onConsole} disabled={off('console')}>
          Konsole
        </Button>
        <Button size="sm" variant="ghost" icon="link" onClick={onShare} disabled={off('share')}>
          Teilen
        </Button>
        <span className="hz-game-host">{host}</span>
      </footer>
    </section>
  );
}
