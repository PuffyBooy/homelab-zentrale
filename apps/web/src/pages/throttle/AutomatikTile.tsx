import type { ServerThrottleResponse, ServerThrottleUpdateRequest } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { Alert, Badge, Button, StatusDot, Tile, Toggle } from '@hz/ui';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { SelectField } from '../../components/SelectField.js';
import { isApiError } from '../../lib/api.js';
import { errorText } from '../../lib/errors.js';
import {
  MAX_SCHEDULE_WINDOWS,
  SETTINGS_FIELDS,
  WEEKDAYS,
  changedSettings,
  fetchServerThrottle,
  newWindowDraft,
  parseSettings,
  parseWindows,
  phaseStatus,
  phaseText,
  ramStatusText,
  serverThrottleKey,
  settingsDraft,
  toggleDay,
  updateServerThrottle,
  windowDraft,
  type SettingsDraft,
  type SettingsErrors,
  type WindowDraft,
  type WindowErrors,
} from '../../lib/throttle.js';
import { useAuthState } from '../../lib/useAuthState.js';

const TIER_OPTIONS = [
  { value: 'niedrig', label: 'niedrig' },
  { value: 'normal', label: 'normal' },
] as const;

const MODE_OPTIONS = [
  { value: 'no_throttle', label: 'ohne Drosselung' },
  { value: 'cpus', label: 'mit X Kernen' },
] as const;

/** Server detail, section "Automatik" (SPEC 6a, ROADMAP M10). */
export function AutomatikTile({
  serverId,
  serverName,
}: {
  serverId: string;
  serverName: string;
}): ReactElement {
  const q = useQuery({
    queryKey: serverThrottleKey(serverId),
    queryFn: ({ signal }) => fetchServerThrottle(serverId, signal),
    refetchInterval: 15_000,
  });
  const auth = useAuthState();
  return (
    <Tile title="Automatik" icon="cpu" span={4}>
      {q.data ? (
        <AutomatikForm
          key={serverId}
          data={q.data}
          serverName={serverName}
          timeZone={auth.data?.timeZone}
        />
      ) : q.isError ? (
        <FormError title={errorText(q.error)} />
      ) : (
        <p className="app-empty" role="status">
          Lade Automatik …
        </p>
      )}
    </Tile>
  );
}

export function AutomatikForm({
  data,
  serverName,
  timeZone,
}: {
  data: ServerThrottleResponse;
  serverName: string;
  timeZone: string | undefined;
}): ReactElement {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<SettingsDraft>(() => settingsDraft(data.settings));
  const [windows, setWindows] = useState<WindowDraft[]>(() => data.schedules.map(windowDraft));
  const [errors, setErrors] = useState<SettingsErrors>({});
  const [winErrors, setWinErrors] = useState<WindowErrors[]>([]);
  const formRef = useRef<HTMLFormElement>(null);
  const save = useMutation({
    mutationFn: (body: ServerThrottleUpdateRequest) => updateServerThrottle(data.serverId, body),
    onSuccess: (next) => qc.setQueryData(serverThrottleKey(data.serverId), next),
  });
  const s = data.status;

  function touch(): void {
    save.reset();
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    const set = parseSettings(draft);
    const win = parseWindows(windows);
    setErrors(set.ok ? {} : set.errors);
    setWinErrors(win.ok ? [] : win.errors);
    if (!set.ok || !win.ok) {
      requestAnimationFrame(() =>
        formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
      return;
    }
    const patch = changedSettings(data.settings, set.value);
    const schedulesChanged = JSON.stringify(win.value) !== JSON.stringify(data.schedules);
    save.mutate({
      ...(Object.keys(patch).length ? { settings: patch } : {}),
      ...(schedulesChanged ? { schedules: win.value } : {}),
    });
  }

  function setWindow(i: number, next: Partial<WindowDraft>): void {
    setWindows((list) => list.map((w, j) => (j === i ? { ...w, ...next } : w)));
    setWinErrors((list) => list.map((e, j) => (j === i ? {} : e)));
    touch();
  }

  const full = windows.length >= MAX_SCHEDULE_WINDOWS;

  return (
    <form ref={formRef} className="hz-form" onSubmit={submit} noValidate>
      <dl className="app-kv">
        <dt>Zustand</dt>
        <dd>
          <StatusDot
            status={phaseStatus(s.phase)}
            label={phaseText(s, data.settings)}
            className="app-status-auto"
          />
        </dd>
        <dt>RAM</dt>
        <dd>{ramStatusText(s)}</dd>
      </dl>
      <Toggle
        label="Automatik"
        hint={`Aus: auf ${serverName} wird nichts automatisch gedrosselt, gestoppt oder neu gestartet.`}
        checked={draft.enabled}
        onChange={(v) => {
          setDraft((d) => ({ ...d, enabled: v }));
          touch();
        }}
      />
      <fieldset className="app-fieldset">
        <legend className="hz-label">Schwellen</legend>
        <div className="app-threshold-grid">
          {SETTINGS_FIELDS.map((f) => (
            <Field
              key={f.key}
              label={f.label}
              mono
              inputMode="decimal"
              value={draft[f.key]}
              hint={f.hint}
              error={errors[f.key]}
              autoComplete="off"
              onChange={(e) => {
                const v = e.target.value;
                setDraft((d) => ({ ...d, [f.key]: v }));
                setErrors((x) => ({ ...x, [f.key]: undefined }));
                touch();
              }}
            />
          ))}
        </div>
      </fieldset>
      <fieldset className="app-fieldset">
        <legend className="hz-label">
          Zeitpläne · {windows.length} von {MAX_SCHEDULE_WINDOWS}
        </legend>
        <p className="app-text">
          Zeitzone: {timeZone ?? 'unbekannt'}. In einem Fenster gilt für die Stufe etwas anderes, z.
          B. niedrig Mo–Fr 18:00–23:00 ohne Drosselung.
        </p>
        {windows.length === 0 ? <p className="app-empty">Kein Zeitfenster.</p> : null}
        {windows.map((w, i) => (
          <WindowRow
            key={w.key}
            index={i}
            w={w}
            errors={winErrors[i] ?? {}}
            active={s.activeWindows.includes(i)}
            onChange={(next) => setWindow(i, next)}
            onRemove={() => {
              setWindows((list) => list.filter((_, j) => j !== i));
              setWinErrors((list) => list.filter((_, j) => j !== i));
              touch();
            }}
          />
        ))}
        <div className="hz-form-actions">
          <Button
            icon="plus"
            disabled={full}
            onClick={() => {
              setWindows((list) => [...list, newWindowDraft()]);
              touch();
            }}
          >
            Zeitfenster hinzufügen
          </Button>
          {full ? (
            <span className="app-text">Höchstens {MAX_SCHEDULE_WINDOWS} Zeitfenster.</span>
          ) : null}
        </div>
      </fieldset>
      {save.error && !isApiError(save.error, 'step_up_required') ? (
        <FormError title={errorText(save.error)} />
      ) : null}
      {save.isSuccess ? <Alert tone="ok" title="Automatik gespeichert." /> : null}
      <div className="hz-form-actions">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Speichert …' : 'Speichern'}
        </Button>
      </div>
    </form>
  );
}

function WindowRow({
  index,
  w,
  errors,
  active,
  onChange,
  onRemove,
}: {
  index: number;
  w: WindowDraft;
  errors: WindowErrors;
  active: boolean;
  onChange: (next: Partial<WindowDraft>) => void;
  onRemove: () => void;
}): ReactElement {
  const daysId = useId();
  const n = index + 1;
  return (
    <div className="app-window" role="group" aria-label={`Zeitfenster ${n}`}>
      <div className="app-window-head">
        <span className="hz-label">Fenster {n}</span>
        {active ? <Badge tone="info">aktiv</Badge> : null}
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Zeitfenster ${n} entfernen`}
          onClick={onRemove}
        >
          Entfernen
        </Button>
      </div>
      <div className="app-window-grid">
        <SelectField
          label="Stufe"
          value={w.tier}
          options={TIER_OPTIONS}
          onChange={(e) => onChange({ tier: e.target.value === 'normal' ? 'normal' : 'niedrig' })}
        />
        <Field
          label="Von"
          mono
          inputMode="numeric"
          value={w.from}
          placeholder="18:00"
          maxLength={5}
          error={errors.from}
          autoComplete="off"
          onChange={(e) => onChange({ from: e.target.value })}
        />
        <Field
          label="Bis"
          mono
          inputMode="numeric"
          value={w.to}
          placeholder="23:00"
          maxLength={5}
          error={errors.to}
          autoComplete="off"
          onChange={(e) => onChange({ to: e.target.value })}
        />
        <SelectField
          label="Modus"
          value={w.mode}
          options={MODE_OPTIONS}
          onChange={(e) => onChange({ mode: e.target.value === 'cpus' ? 'cpus' : 'no_throttle' })}
        />
        {w.mode === 'cpus' ? (
          <Field
            label="Kerne"
            mono
            inputMode="decimal"
            value={w.cpus}
            hint="0,1 bis 64"
            error={errors.cpus}
            autoComplete="off"
            onChange={(e) => onChange({ cpus: e.target.value })}
          />
        ) : null}
      </div>
      <div className="hz-field">
        <span className="hz-field-label" id={daysId}>
          Tage
        </span>
        <div className="app-days" role="group" aria-labelledby={daysId}>
          {WEEKDAYS.map((d) => {
            const on = w.days.includes(d.id);
            return (
              <Button
                key={d.id}
                size="sm"
                variant={on ? 'secondary' : 'ghost'}
                aria-pressed={on}
                title={d.long}
                onClick={() => onChange({ days: toggleDay(w.days, d.id) })}
              >
                {d.label}
              </Button>
            );
          })}
        </div>
        {errors.days ? <span className="hz-field-error">{errors.days}</span> : null}
      </div>
    </div>
  );
}
