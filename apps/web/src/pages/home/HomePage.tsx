import type { HaState } from '@hz/shared';
import type { ReactElement } from 'react';
import { Link } from 'react-router';
import { Alert, Metric, Tile, cx } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { errorText } from '../../lib/errors.js';
import { formatNumber, formatTime } from '../../lib/format.js';
import { formatEurAmount, groupByRoom, priceToText, type RoomGroup } from '../../lib/ha.js';
import { useHaView } from '../../lib/haActions.js';
import { useLiveTopic } from '../../lib/live.js';
import { HaControl, useHaToggle } from './HaControls.js';

/**
 * /home "Wohnung" (SPEC 10): one tile per room with Metric for sensors, Toggle for
 * switches and a Button with confirm for door openers; energy on top. Live over `ha`.
 */
export function HomePage(): ReactElement | null {
  useLiveTopic('ha');
  const { query, view } = useHaView();
  const { toggle, error } = useHaToggle();

  if (query.isError && !view) return <FormError title={errorText(query.error)} />;
  if (!view) return null;

  if (view.status === 'off') return <NotConnected />;

  const rooms = groupByRoom(view);
  const down = view.status === 'unreachable';

  return (
    <>
      {down ? <UnreachableAlert state={view} /> : null}
      {error ? <FormError title={error} /> : null}
      <div className={cx('hz-grid app-grid', down && 'app-ha-down')}>
        {view.energy ? <EnergyTile state={view} /> : null}
        {rooms.length === 0 ? (
          <Tile title="Räume" icon="home" span={4}>
            <p className="app-empty">
              Noch keine Geräte gewählt.{' '}
              <Link to="/settings#ha">Geräte und Räume in den Einstellungen wählen</Link>
            </p>
          </Tile>
        ) : (
          rooms.map((r) => <RoomTile key={r.id ?? '-'} state={view} room={r} onToggle={toggle} />)
        )}
      </div>
    </>
  );
}

export function UnreachableAlert({ state }: { state: HaState }): ReactElement {
  return (
    <Alert
      tone="crit"
      title="Home Assistant nicht erreichbar"
      time={formatTime(new Date(state.updatedAt))}
    >
      {state.error ? `${state.error}. ` : ''}Werte zeigen den letzten Stand, Schalten geht erst
      wieder mit Verbindung.
    </Alert>
  );
}

function NotConnected(): ReactElement {
  return (
    <Tile title="Wohnung" icon="home" status="off" statusLabel="nicht verbunden">
      <p className="app-empty">
        Home Assistant ist nicht verbunden. Mit URL und Long-Lived Access Token erscheinen hier
        Räume, Schalter und Sensoren.
      </p>
      <p className="app-text">
        <Link to="/settings#ha">Home Assistant in den Einstellungen verbinden</Link>
      </p>
    </Tile>
  );
}

function RoomTile({
  state,
  room,
  onToggle,
}: {
  state: HaState;
  room: RoomGroup;
  onToggle: Parameters<typeof HaControl>[0]['onToggle'];
}): ReactElement {
  const metrics = room.items.filter((i) => i.kind === 'metric');
  const controls = room.items.filter((i) => i.kind !== 'metric');
  const on = controls.filter((i) => i.kind === 'toggle' && i.state === 'on').length;
  const toggles = controls.filter((i) => i.kind === 'toggle').length;
  return (
    <Tile
      title={room.name}
      icon="home"
      count={toggles ? `${on} von ${toggles} an` : String(room.items.length)}
      span={2}
      className="app-ha-room"
    >
      {metrics.length ? (
        <div className="app-metrics">
          {metrics.map((i) => (
            <HaControl key={i.entityId} state={state} item={i} onToggle={onToggle} />
          ))}
        </div>
      ) : null}
      {controls.length ? (
        <div className="app-ha-controls">
          {controls.map((i) => (
            <HaControl key={i.entityId} state={state} item={i} onToggle={onToggle} />
          ))}
        </div>
      ) : null}
    </Tile>
  );
}

/** Strom jetzt (W), kWh im Monat and the € estimate. */
export function EnergyTile({ state }: { state: HaState }): ReactElement | null {
  const e = state.energy;
  if (!e) return null;
  return (
    <Tile
      title="Strom"
      icon="plug"
      count={`${priceToText(e.pricePerKwh)} €/kWh`}
      span={4}
      className="app-ha-energy"
    >
      <div className="app-metrics" data-testid="ha-energy">
        <Metric
          label="Strom jetzt"
          value={e.powerW === null ? '—' : formatNumber(e.powerW, 0)}
          unit={e.powerW === null ? undefined : 'W'}
          className={cx(state.status !== 'connected' && 'app-ha-stale')}
        />
        <Metric
          label="Im Monat"
          value={e.monthKwh === null ? '—' : formatNumber(e.monthKwh, 1)}
          unit={e.monthKwh === null ? undefined : 'kWh'}
          hint="seit dem 1., 00:00"
          className={cx(state.status !== 'connected' && 'app-ha-stale')}
        />
        <Metric
          label="Kosten im Monat"
          value={e.monthEur === null ? '—' : `≈ ${formatEurAmount(e.monthEur)}`}
          unit={e.monthEur === null ? undefined : '€'}
          hint="Schätzung"
          className={cx(state.status !== 'connected' && 'app-ha-stale')}
        />
      </div>
    </Tile>
  );
}
