import type { GameSummary } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent, type ReactElement } from 'react';
import { Alert, Badge, Button, Tile, Toggle } from '@hz/ui';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { SelectField } from '../../components/SelectField.js';
import { errorText } from '../../lib/errors.js';
import {
  DAY_LONG,
  DAY_SHORT,
  daysText,
  emptySchedule,
  fetchSchedules,
  MAX_SCHEDULES,
  nextRunText,
  saveSchedules,
  scheduleDrafts,
  SCHEDULE_KIND_TEXT,
  schedulesKey,
  toggleDay,
  validateSchedules,
  type GameSchedules,
  type ScheduleDraft,
  type ScheduleErrors,
} from '../../lib/gameFeatures.js';

const KIND_OPTIONS = [
  { value: 'backup', label: SCHEDULE_KIND_TEXT.backup },
  { value: 'restart', label: SCHEDULE_KIND_TEXT.restart },
];

/**
 * Zeitpläne (M12, SPEC 6.5): restart or backup on weekdays at HH:MM (HZ_TIMEZONE).
 * The whole list is saved at once (PUT), at most 10 entries.
 */
export function SchedulesTile({ game, now }: { game: GameSummary; now: Date }): ReactElement {
  const q = useQuery({
    queryKey: schedulesKey(game.id),
    queryFn: ({ signal }) => fetchSchedules(game.id, signal),
  });
  const count = q.data ? String(q.data.schedules.length) : undefined;
  return (
    <Tile
      title="Zeitpläne"
      icon="refresh"
      count={count}
      span={2}
      footer={
        <span className="app-foot-text">
          Neustart warnt die Spieler 5 und 1 Min vorher · schlafende Server werden nicht geweckt
        </span>
      }
    >
      {q.error && !q.data ? <FormError title={errorText(q.error)} /> : null}
      {q.data ? <SchedulesForm game={game} data={q.data} now={now} /> : null}
    </Tile>
  );
}

function SchedulesForm({
  game,
  data,
  now,
}: {
  game: GameSummary;
  data: GameSchedules;
  now: Date;
}): ReactElement {
  const qc = useQueryClient();
  /** Null while untouched: the form shows the saved list (fresh data replaces it). */
  const [edited, setEdited] = useState<ScheduleDraft[] | null>(null);
  const [errors, setErrors] = useState<ScheduleErrors>({});
  const dirty = edited !== null;
  const drafts = edited ?? scheduleDrafts(data.schedules);
  const save = useMutation({
    mutationFn: (list: Parameters<typeof saveSchedules>[1]) => saveSchedules(game.id, list),
    onSuccess: (next) => {
      qc.setQueryData(schedulesKey(game.id), next);
      setEdited(null);
    },
  });

  const edit = (fn: (list: ScheduleDraft[]) => ScheduleDraft[]): void => {
    setEdited(fn(drafts));
    save.reset();
  };

  const change = (i: number, patch: Partial<ScheduleDraft>): void => {
    edit((list) => list.map((d, j) => (j === i ? { ...d, ...patch } : d)));
    setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== String(i))));
  };

  function submit(e: FormEvent): void {
    e.preventDefault();
    const res = validateSchedules(drafts);
    if (!res.ok) {
      setErrors(res.errors);
      return;
    }
    setErrors({});
    save.mutate(res.schedules);
  }

  return (
    <form className="hz-form" onSubmit={submit} noValidate>
      {drafts.length === 0 ? (
        <p className="app-empty">Kein Zeitplan. Zum Beispiel jede Nacht um 04:00 ein Backup.</p>
      ) : null}
      {drafts.map((d, i) => (
        <ScheduleRow
          key={i}
          index={i}
          draft={d}
          error={errors[i]}
          next={dirty ? undefined : data.next[i]}
          now={now}
          onChange={(patch) => change(i, patch)}
          onRemove={() => {
            edit((list) => list.filter((_, j) => j !== i));
            setErrors({});
          }}
        />
      ))}
      {!game.rcon && drafts.some((d) => d.kind === 'restart') ? (
        <Alert tone="info" title="Ohne RCON keine Warnung an die Spieler.">
          Der Neustart läuft trotzdem zur eingestellten Zeit.
        </Alert>
      ) : null}
      {save.error ? <FormError title={errorText(save.error)} /> : null}
      {save.isSuccess && !dirty ? <Alert tone="ok" title="Zeitpläne gespeichert." /> : null}
      <div className="hz-form-actions">
        <Button
          icon="plus"
          disabled={drafts.length >= MAX_SCHEDULES}
          onClick={() => edit((list) => [...list, emptySchedule()])}
        >
          {drafts.length >= MAX_SCHEDULES ? `Höchstens ${MAX_SCHEDULES}` : 'Eintrag hinzufügen'}
        </Button>
        <Button type="submit" disabled={save.isPending || !dirty}>
          {save.isPending ? 'Speichert …' : 'Speichern'}
        </Button>
      </div>
    </form>
  );
}

function ScheduleRow({
  index,
  draft,
  error,
  next,
  now,
  onChange,
  onRemove,
}: {
  index: number;
  draft: ScheduleDraft;
  error: string | undefined;
  /** Undefined while the form has unsaved changes. */
  next: string | null | undefined;
  now: Date;
  onChange: (patch: Partial<ScheduleDraft>) => void;
  onRemove: () => void;
}): ReactElement {
  const daysId = useId();
  const n = index + 1;
  return (
    <div className="app-window" role="group" aria-label={`Zeitplan ${n}`}>
      <div className="app-window-head">
        <span className="hz-label">
          {SCHEDULE_KIND_TEXT[draft.kind]} · {daysText(draft.days)} · {draft.time}
        </span>
        {next !== undefined ? (
          <Badge tone={next ? 'info' : 'neutral'}>{nextRunText(next, now)}</Badge>
        ) : null}
        <Button size="sm" variant="ghost" aria-label={`Zeitplan ${n} entfernen`} onClick={onRemove}>
          Entfernen
        </Button>
      </div>
      <div className="app-form-row">
        <SelectField
          label="Art"
          value={draft.kind}
          options={KIND_OPTIONS}
          onChange={(e) => onChange({ kind: e.target.value === 'restart' ? 'restart' : 'backup' })}
        />
        <Field
          label="Uhrzeit"
          mono
          inputMode="numeric"
          value={draft.time}
          placeholder="04:00"
          maxLength={5}
          autoComplete="off"
          error={error}
          onChange={(e) => onChange({ time: e.target.value })}
        />
      </div>
      <div className="hz-field">
        <span className="hz-field-label" id={daysId}>
          Wochentage
        </span>
        <div className="app-days" role="group" aria-labelledby={daysId}>
          {DAY_SHORT.map((label, i) => {
            const day = i + 1;
            const on = draft.days.includes(day);
            return (
              <Button
                key={label}
                size="sm"
                variant={on ? 'secondary' : 'ghost'}
                aria-pressed={on}
                title={DAY_LONG[i]}
                onClick={() => onChange({ days: toggleDay(draft.days, day, !on) })}
              >
                {label}
              </Button>
            );
          })}
        </div>
      </div>
      <Toggle label="Aktiv" checked={draft.enabled} onChange={(on) => onChange({ enabled: on })} />
    </div>
  );
}
