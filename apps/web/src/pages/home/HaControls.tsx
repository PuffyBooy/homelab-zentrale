import type { HaItem, HaState } from '@hz/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type ReactElement } from 'react';
import { Button, Metric, Toggle, cx } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { FormError } from '../../components/FormError.js';
import { isApiError } from '../../lib/api.js';
import { errorText } from '../../lib/errors.js';
import { formatTime } from '../../lib/format.js';
import {
  haStateKey,
  isOn,
  itemUsable,
  metricParts,
  pressHaEntity,
  pressLabel,
  replaceItem,
  toggleHint,
} from '../../lib/ha.js';
import { pendingToggles, runToggle } from '../../lib/haActions.js';

/** Error text for a failed HA action; a closed step-up dialog is no error. */
export function haActionError(err: unknown): string | null {
  if (!err || isApiError(err, 'step_up_required')) return null;
  // ha_error carries a fixed German hint from the core ("Home Assistant nicht erreichbar").
  if (isApiError(err, 'ha_error') && !err.hint)
    return 'Home Assistant nicht erreichbar oder hat abgelehnt. Schalten geht wieder, sobald die Verbindung steht.';
  if (isApiError(err, 'conflict') && !err.hint)
    return 'Gerät in Home Assistant gerade nicht verfügbar.';
  if (isApiError(err, 'not_found') && !err.hint)
    return 'Gerät ist nicht mehr ausgewählt. Seite neu laden.';
  return errorText(err);
}

/** Toggle runner with one error line per area (page, tile). */
export function useHaToggle(): {
  toggle: (item: HaItem, on: boolean) => void;
  error: string | null;
} {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const toggle = useCallback(
    (item: HaItem, on: boolean) => {
      // One request per switch at a time; further clicks wait for HA.
      if (item.pending || pendingToggles.get(item.entityId)?.inFlight) return;
      setError(null);
      runToggle(qc, item.entityId, on).catch((err: unknown) =>
        setError(`${item.label}: ${haActionError(err) ?? 'nicht geschaltet'}`),
      );
    },
    [qc],
  );
  return { toggle, error };
}

/** One HA item: Toggle, Metric or the door button. */
export function HaControl({
  state,
  item,
  onToggle,
  wall,
}: {
  state: HaState;
  item: HaItem;
  onToggle: (item: HaItem, on: boolean) => void;
  wall?: boolean;
}): ReactElement {
  const usable = itemUsable(state, item);
  if (item.kind === 'toggle') {
    return (
      <div className="app-ha-toggle" data-testid="ha-toggle" data-entity={item.entityId}>
        <Toggle
          label={item.label}
          hint={toggleHint(state, item)}
          checked={isOn(item)}
          disabled={!usable}
          onChange={(next) => onToggle(item, next)}
        />
      </div>
    );
  }
  if (item.kind === 'button') return <PressRow state={state} item={item} />;
  return <HaMetric state={state} item={item} wall={wall} />;
}

export function HaMetric({
  state,
  item,
  wall,
}: {
  state: HaState;
  item: HaItem;
  wall?: boolean | undefined;
}): ReactElement {
  const stale = state.status !== 'connected';
  const { value, unit } = metricParts(item, stale);
  return (
    <div data-testid="ha-metric" data-entity={item.entityId}>
      <Metric
        label={item.label}
        value={value}
        unit={unit}
        size={wall ? 'wall' : 'default'}
        hint={stale ? 'letzter Stand' : !item.available ? 'nicht verfügbar' : undefined}
        className={cx(stale && 'app-ha-stale')}
      />
    </div>
  );
}

/**
 * Door opener / intercom (SPEC 10): a Button with an explicit confirm dialog, never a
 * Toggle. The press route needs step-up; api() asks for the code after "Tür öffnen".
 */
export function PressRow({ state, item }: { state: HaState; item: HaItem }): ReactElement {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneAt, setDoneAt] = useState<Date | null>(null);
  const usable = itemUsable(state, item);
  const verb = pressLabel(item);

  async function press(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const next = await pressHaEntity(item.entityId);
      qc.setQueryData<HaState>(haStateKey, (old) => (old ? replaceItem(old, next) : old));
      setDoneAt(new Date());
      setConfirm(false);
    } catch (err) {
      const text = haActionError(err);
      if (text) setError(text);
      else setConfirm(false);
    } finally {
      setBusy(false);
    }
  }

  const hint = !usable
    ? state.status !== 'connected'
      ? 'Home Assistant nicht erreichbar'
      : 'nicht verfügbar'
    : item.pending || busy
      ? 'wird ausgelöst …'
      : doneAt
        ? `ausgelöst ${formatTime(doneAt)}`
        : 'nur mit Bestätigung';

  return (
    <div
      className={cx('app-ha-press', !usable && 'app-ha-press-off')}
      data-testid="ha-press"
      data-entity={item.entityId}
    >
      <span className="hz-toggle-text">
        {item.label}
        <small>{hint}</small>
      </span>
      <Button
        icon="door"
        size="sm"
        disabled={!usable || busy || item.pending}
        aria-label={`${item.label}: ${verb}`}
        onClick={() => {
          setError(null);
          setConfirm(true);
        }}
      >
        {verb}
      </Button>
      {confirm ? (
        <Dialog open onClose={() => !busy && setConfirm(false)} title={`${item.label}: ${verb}?`}>
          <div className="hz-dialog-body">
            <p className="hz-dialog-text">
              {verb === 'Tür öffnen'
                ? `${item.label} öffnet sofort. Das geht nur mit einem frischen Code aus der App.`
                : `${item.label} wird sofort ausgelöst. Das geht nur mit einem frischen Code aus der App.`}
            </p>
            {error ? <FormError title={error} /> : null}
            <div className="hz-dialog-foot">
              <Button onClick={() => setConfirm(false)} disabled={busy} data-autofocus="">
                Abbrechen
              </Button>
              <Button variant="danger" icon="door" disabled={busy} onClick={() => void press()}>
                {verb}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
