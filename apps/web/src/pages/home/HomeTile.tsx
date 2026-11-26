import type { HaState } from '@hz/shared';
import type { ReactElement } from 'react';
import { Link } from 'react-router';
import { Metric, Tile, cx } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { formatNumber } from '../../lib/format.js';
import { STATUS_TEXT, formatEur, formatKwh, haTileStatus, overviewItems } from '../../lib/ha.js';
import { HaControl, useHaToggle } from './HaControls.js';

/**
 * Overview tile "Wohnung" (SPEC 4 item 6): Klima (metrics marked "in Übersicht"),
 * Strom and the most important switches. Only shown while HA is set up.
 */
export function HomeTile({ state }: { state: HaState }): ReactElement {
  const { toggle, error } = useHaToggle();
  const { metrics, controls } = overviewItems(state);
  const e = state.energy;
  const stale = state.status !== 'connected';
  const down = state.status === 'unreachable';

  return (
    <Tile
      title="Wohnung"
      icon="home"
      status={haTileStatus(state)}
      statusLabel={down ? 'Home Assistant nicht erreichbar' : STATUS_TEXT[state.status]}
      span={4}
      className={cx('app-ha-overview', down && 'app-ha-down')}
      footer={
        <Link className="app-more" to="/home">
          Alle Räume
        </Link>
      }
    >
      {down ? (
        <p className="app-text">
          Home Assistant nicht erreichbar{state.error ? `: ${state.error}` : ''}. Werte zeigen den
          letzten Stand.
        </p>
      ) : null}
      {metrics.length || e ? (
        <div className="app-metrics">
          {e ? (
            <Metric
              label="Strom jetzt"
              value={e.powerW === null ? '—' : formatNumber(e.powerW, 0)}
              unit={e.powerW === null ? undefined : 'W'}
              className={cx(stale && 'app-ha-stale')}
            />
          ) : null}
          {e ? (
            <Metric
              label="Im Monat"
              value={e.monthKwh === null ? '—' : formatKwh(e.monthKwh)}
              unit={e.monthKwh === null ? undefined : 'kWh'}
              hint={e.monthEur === null ? undefined : `≈ ${formatEur(e.monthEur)}`}
              className={cx(stale && 'app-ha-stale')}
            />
          ) : null}
          {metrics.map((i) => (
            <HaControl key={i.entityId} state={state} item={i} onToggle={toggle} />
          ))}
        </div>
      ) : null}
      {controls.length ? (
        <div className="app-ha-controls app-ha-controls-cols">
          {controls.map((i) => (
            <HaControl key={i.entityId} state={state} item={i} onToggle={toggle} />
          ))}
        </div>
      ) : null}
      {!metrics.length && !controls.length && !e ? (
        <p className="app-empty">
          Noch nichts für die Übersicht gewählt.{' '}
          <Link to="/settings#ha">In den Einstellungen „in Übersicht“ setzen</Link>
        </p>
      ) : null}
      {error ? <FormError title={error} /> : null}
    </Tile>
  );
}
