import type { CloudMachine, GameSummary } from '@hz/shared';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Link } from 'react-router';
import { Alert, Button, ServiceRow, Tile } from '@hz/ui';
import {
  formatEur,
  formatEurHour,
  formatEurMonth,
  idleMinutesError,
  isTransitional,
  machineStateText,
  machineStatus,
  regionLabel,
  shortSize,
  sizeSpec,
} from '../../lib/cloud.js';
import { formatNumber, plural } from '../../lib/format.js';
import { parseNumber } from '../../lib/games.js';

export type MachineAction = 'start' | 'stop' | 'delete';

export interface MachinesTileProps {
  machines: readonly CloudMachine[];
  games: readonly Pick<GameSummary, 'id' | 'name'>[] | undefined;
  /** Highlighted machine (just ordered). */
  focusId?: string | null | undefined;
  /** Machine with a running action. */
  pendingId?: string | null | undefined;
  rowError?: { id: string; text: string } | null | undefined;
  onAction: (m: CloudMachine, action: MachineAction) => void;
  onIdle: (m: CloudMachine, minutes: number) => void;
}

/** "Läuft", "Wird eingerichtet" … with shape and short tag (ServiceRow), costs and games. */
export function MachinesTile({
  machines,
  games,
  focusId,
  pendingId,
  rowError,
  onAction,
  onIdle,
}: MachinesTileProps): ReactElement {
  const running = machines.filter((m) => m.state === 'running').length;
  return (
    <Tile
      title="Cloud-Server"
      icon="cloud"
      count={`${running} von ${machines.length} laufen`}
      span={4}
      flush
      footer={
        <span className="app-foot-text">
          Kosten sind Schätzungen · Löschen braucht einen Code und den Namen
        </span>
      }
    >
      {machines.length === 0 ? (
        <p className="app-empty app-pad">
          Noch kein Cloud-Server. Bestell einen unten oder beim Anlegen eines Gameservers mit dem
          Ziel „Neuer Azure-Server“.
        </p>
      ) : (
        machines.map((m) => (
          <MachineRow
            key={m.id}
            machine={m}
            games={games}
            focused={focusId === m.id}
            pending={pendingId === m.id}
            disabled={pendingId != null}
            error={rowError?.id === m.id ? rowError.text : null}
            onAction={(a) => onAction(m, a)}
            onIdle={(n) => onIdle(m, n)}
          />
        ))
      )}
    </Tile>
  );
}

export interface MachineRowProps {
  machine: CloudMachine;
  games: readonly Pick<GameSummary, 'id' | 'name'>[] | undefined;
  focused?: boolean;
  pending?: boolean;
  disabled?: boolean;
  error?: string | null;
  onAction: (action: MachineAction) => void;
  onIdle: (minutes: number) => void;
}

export function MachineRow({
  machine: m,
  games,
  focused,
  pending,
  disabled,
  error,
  onAction,
  onIdle,
}: MachineRowProps): ReactElement {
  const busy = isTransitional(m.state);
  const off = disabled || pending || busy;
  const linked = m.gameIds.map((id) => ({
    id,
    name: games?.find((g) => g.id === id)?.name ?? id,
  }));
  const hasGames = m.gameIds.length > 0;

  return (
    <div
      className="app-machine"
      data-testid="cloud-machine"
      data-focused={focused ? '' : undefined}
      aria-busy={busy || undefined}
    >
      <ServiceRow
        name={m.name}
        host={`${shortSize(m.size)} · ${sizeSpec(m)} · ${regionLabel(m.region)}`}
        status={machineStatus(m.state)}
        meta={<span className="app-machine-state">{machineStateText(m)}</span>}
        actions={
          <span className="app-guest-actions">
            {m.state === 'deallocated' || m.state === 'failed' ? (
              <Button
                size="sm"
                icon="play"
                disabled={off || (m.state === 'failed' && m.serverId === null)}
                onClick={() => onAction('start')}
              >
                Starten
              </Button>
            ) : null}
            {m.state === 'running' ? (
              <Button size="sm" icon="stop" disabled={off} onClick={() => onAction('stop')}>
                Schlafen legen
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              disabled={off || hasGames || m.state === 'deleting'}
              title={hasGames ? 'Erst die Gameserver darauf löschen' : 'Löschen'}
              onClick={() => onAction('delete')}
            >
              Löschen
            </Button>
          </span>
        }
      />
      <div className="app-machine-body">
        <dl className="app-kv">
          <dt>Öffentliche IP</dt>
          <dd>{m.publicIp ?? (m.state === 'creating' ? 'wird vergeben' : 'keine')}</dd>
          <dt>Kosten</dt>
          <dd>
            läuft {formatEurHour(m.cost.runningEurPerHour)} · schläft{' '}
            {formatEurMonth(m.cost.sleepingEurPerMonth)}
          </dd>
          <dt>Diesen Monat</dt>
          <dd>
            {formatNumber(m.monthHours)} h · {formatEur(m.monthEur)}
          </dd>
          <dt>Gameserver</dt>
          <dd>
            {linked.length
              ? linked.map((g, i) => (
                  <span key={g.id}>
                    {i ? ', ' : ''}
                    <Link to={`/games/${encodeURIComponent(g.id)}`}>{g.name}</Link>
                  </span>
                ))
              : m.pendingGameName
                ? `${m.pendingGameName} (wird angelegt, sobald der Server bereit ist)`
                : 'keine'}
          </dd>
        </dl>
        <IdleForm machine={m} disabled={off} onSave={onIdle} />
        {hasGames && m.state !== 'deleting' ? (
          <p className="app-foot-text">
            Löschen geht erst ohne Gameserver (
            {plural(m.gameIds.length, 'Gameserver', 'Gameserver')} darauf).
          </p>
        ) : null}
      </div>
      {m.error ? (
        <div className="app-ctr-error">
          <Alert tone="crit" title={`${m.name}: ${m.error}`}>
            {m.state === 'failed'
              ? 'Details im Log des Core. Löschen räumt alles bei Azure weg.'
              : undefined}
          </Alert>
        </div>
      ) : null}
      {error ? (
        <div className="app-ctr-error">
          <Alert tone="crit" title={`${m.name}: ${error}`} />
        </div>
      ) : null}
    </div>
  );
}

function IdleForm({
  machine: m,
  disabled,
  onSave,
}: {
  machine: CloudMachine;
  disabled: boolean;
  onSave: (minutes: number) => void;
}): ReactElement {
  const [value, setValue] = useState(String(m.idleMinutes));
  const [err, setErr] = useState<string | null>(null);
  const dirty = value.trim() !== String(m.idleMinutes);

  function submit(e: FormEvent): void {
    e.preventDefault();
    const e1 = idleMinutesError(value);
    setErr(e1);
    if (e1 || !dirty) return;
    onSave(parseNumber(value));
  }

  return (
    <form className="app-inline-field" onSubmit={submit} noValidate>
      <label className="hz-field-label" htmlFor={`idle-${m.id}`}>
        Schlafen nach … Min ohne Spiel
      </label>
      <input
        id={`idle-${m.id}`}
        className="hz-input hz-input-mono app-machine-idle"
        inputMode="numeric"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setErr(null);
        }}
        aria-invalid={err ? true : undefined}
        autoComplete="off"
      />
      <Button size="sm" type="submit" disabled={disabled || !dirty}>
        Speichern
      </Button>
      {err ? <span className="hz-field-error">{err}</span> : null}
    </form>
  );
}
