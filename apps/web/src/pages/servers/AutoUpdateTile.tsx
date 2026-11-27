import type {
  UpdateComponentState,
  UpdatePolicy,
  UpdateRun,
  UpdateServerState,
  UpdateTarget,
} from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent, type ReactElement } from 'react';
import { Alert, Button, StatusDot, Tile, Toggle } from '@hz/ui';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { SelectField } from '../../components/SelectField.js';
import { errorText } from '../../lib/errors.js';
import { formatAgo, formatWhen } from '../../lib/format.js';
import { useLiveTopic } from '../../lib/live.js';
import {
  DURATION_OPTIONS,
  ISO_WEEKDAYS,
  RUN_STATUS,
  RUN_TARGET_LABEL,
  availableText,
  checkUpdate,
  durationText,
  fetchUpdates,
  fromToText,
  hasUpdate,
  lastRunOf,
  osText,
  parseStart,
  patchUpdateComponent,
  patchUpdateServer,
  saveUpdatePolicy,
  toggleIsoDay,
  updateNow,
  updatesKey,
  versionText,
  type UpdateNowTarget,
} from '../../lib/updates.js';
import { useAuthState } from '../../lib/useAuthState.js';
import { useNow } from '../../lib/useNow.js';

/** The updates of all servers (GET /api/updates, live topic `updates`). */
export function useUpdates() {
  useLiveTopic('updates');
  return useQuery({
    queryKey: updatesKey,
    queryFn: ({ signal }) => fetchUpdates(signal),
    refetchInterval: 60_000,
  });
}

/**
 * "Auto-Update" in the server detail (ROADMAP M17): policy, versions of agent and core,
 * "Jetzt prüfen", "Jetzt aktualisieren", the last run and the next window.
 */
/**
 * `primaryAllowed` false: another action on the page already is the one primary
 * (Aufräumen on a disk problem), "Jetzt aktualisieren" stays secondary then.
 */
export function AutoUpdateTile({
  serverId,
  primaryAllowed = true,
}: {
  serverId: string;
  primaryAllowed?: boolean;
}): ReactElement {
  const q = useUpdates();
  const auth = useAuthState();
  const now = useNow(30_000);
  const state = q.data?.servers.find((s) => s.serverId === serverId);
  return (
    <div className="hz-span-4 app-anchor" id="updates">
      {state ? (
        <AutoUpdateView
          key={serverId}
          state={state}
          last={lastRunOf(q.data?.runs ?? [], serverId)}
          timeZone={auth.data?.timeZone}
          now={now}
          primaryAllowed={primaryAllowed}
        />
      ) : (
        <Tile title="Auto-Update" icon="refresh" span={4}>
          {q.error ? (
            <FormError title={errorText(q.error)} />
          ) : (
            <p className="app-empty" role="status">
              {q.data
                ? 'Für diesen Server gibt es noch keinen Update-Stand.'
                : 'Lade Auto-Update …'}
            </p>
          )}
        </Tile>
      )}
    </div>
  );
}

export function AutoUpdateView({
  state,
  last,
  timeZone,
  now,
  primaryAllowed = true,
}: {
  state: UpdateServerState;
  last: UpdateRun | undefined;
  timeZone: string | undefined;
  now: Date;
  primaryAllowed?: boolean;
}): ReactElement {
  const qc = useQueryClient();
  const id = state.serverId;
  const check = useMutation({
    mutationFn: (target: UpdateTarget) => checkUpdate(id, target),
    onSuccess: (res, target) => patchUpdateComponent(qc, id, target, res),
  });
  const apply = useMutation({
    mutationFn: (target: UpdateNowTarget) => updateNow(id, target),
    onSettled: () => void qc.invalidateQueries({ queryKey: updatesKey, exact: true }),
  });
  const busy = state.running != null || apply.isPending;
  const offline = !state.connected;

  // One primary action: the first component with an update waiting.
  const targets: UpdateTarget[] = state.hostsCore && state.core ? ['agent', 'core'] : ['agent'];
  const primary = !primaryAllowed
    ? undefined
    : targets.find((t) => hasUpdate(t === 'core' ? state.core : state.agent));

  return (
    <Tile
      title="Auto-Update"
      icon="refresh"
      span={4}
      status={state.running ? 'busy' : undefined}
      statusLabel={state.running ? `${RUN_TARGET_LABEL[state.running]} läuft` : undefined}
      footer={
        <span className="app-foot-text">
          {state.nextWindow
            ? `Nächstes Fenster ${formatWhen(new Date(state.nextWindow), now)}`
            : 'Kein Fenster geplant'}
          {timeZone ? ` · Zeitzone ${timeZone}` : ''}
        </span>
      }
    >
      <div className="app-update">
        <section aria-label="Versionen" className="app-stack">
          {targets.map((t) => {
            const c = t === 'core' ? state.core : state.agent;
            if (!c) return null;
            return (
              <ComponentRow
                key={t}
                label={t === 'core' ? 'Zentrale' : 'Agent'}
                c={c}
                now={now}
                running={state.running === t}
                disabled={offline || busy}
                checking={check.isPending && check.variables === t}
                primary={primary === t}
                onCheck={() => check.mutate(t)}
                onUpdate={() => apply.mutate(t)}
              />
            );
          })}
          <div className="app-update-row">
            <div className="app-update-main">
              <span className="hz-label">OS-Pakete</span>
              <span className="app-text">
                {osText(state.os)}
                {state.rebootRequired ? ' · Neustart nötig' : ''}
              </span>
            </div>
            <div className="app-actions">
              {state.running === 'os' ? <StatusDot status="busy" label="aktualisiert …" /> : null}
              <Button
                size="sm"
                disabled={offline || busy || !state.os || state.os.total === 0}
                onClick={() => apply.mutate('os')}
              >
                Pakete aktualisieren
              </Button>
            </div>
          </div>
          {offline ? (
            <p className="app-text">Agent offline. Prüfen und Aktualisieren gehen dann nicht.</p>
          ) : null}
          {check.error ? <FormError title={errorText(check.error)} /> : null}
          {apply.error ? <FormError title={errorText(apply.error)} /> : null}
          {apply.isSuccess && !state.running ? (
            <Alert tone="info" title="Update gestartet. Das Ergebnis kommt als Meldung." />
          ) : null}
          <LastRun last={last} now={now} />
        </section>
        <PolicyForm state={state} />
      </div>
    </Tile>
  );
}

function ComponentRow({
  label,
  c,
  now,
  running,
  disabled,
  checking,
  primary,
  onCheck,
  onUpdate,
}: {
  label: string;
  c: UpdateComponentState;
  now: Date;
  running: boolean;
  disabled: boolean;
  checking: boolean;
  primary: boolean;
  onCheck: () => void;
  onUpdate: () => void;
}): ReactElement {
  const update = hasUpdate(c);
  return (
    <div className="app-update-row">
      <div className="app-update-main">
        <span className="hz-label">{label}</span>
        <span className="app-update-ver">{versionText(c.current)}</span>
        <span className="app-text">
          {running ? (
            <StatusDot status="busy" label="wird aktualisiert …" />
          ) : update ? (
            <StatusDot status="info" label={availableText(c)} />
          ) : c.upToDate ? (
            <StatusDot status="ok" label="aktuell" />
          ) : (
            availableText(c)
          )}
          {c.checkedAt ? ` · geprüft ${formatAgo(new Date(c.checkedAt), now)}` : ''}
        </span>
      </div>
      <div className="app-actions">
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || checking}
          aria-label={`${label}: jetzt prüfen`}
          onClick={onCheck}
        >
          {checking ? 'Prüft …' : 'Jetzt prüfen'}
        </Button>
        <Button
          size="sm"
          variant={primary ? 'primary' : 'secondary'}
          disabled={disabled || !update}
          aria-label={`${label}: jetzt aktualisieren`}
          onClick={onUpdate}
        >
          Jetzt aktualisieren
        </Button>
      </div>
    </div>
  );
}

function LastRun({ last, now }: { last: UpdateRun | undefined; now: Date }): ReactElement {
  if (!last) return <p className="app-text">Noch kein Update-Lauf.</p>;
  const st = RUN_STATUS[last.status];
  return (
    <div className="app-update-row" role="group" aria-label="Letzter Lauf">
      <div className="app-update-main">
        <span className="hz-label">Letzter Lauf</span>
        <span className="app-text">
          <StatusDot status={st.status} label={st.label} />{' '}
          {`${RUN_TARGET_LABEL[last.target]} · ${fromToText(last)} · ${formatWhen(new Date(last.startedAt), now)}`}
          {last.trigger === 'manual' ? ' · von Hand' : ''}
        </span>
        {last.message ? <span className="app-text">{last.message}</span> : null}
      </div>
    </div>
  );
}

interface PolicyErrors {
  start?: string | undefined;
  days?: string | undefined;
}

interface Draft {
  agent: boolean;
  core: boolean;
  os: boolean;
  reboot: boolean;
  days: number[];
  start: string;
  durationMin: number;
}

function draftOf(p: UpdatePolicy): Draft {
  return {
    agent: p.agent,
    core: p.core,
    os: p.os,
    reboot: p.reboot,
    days: [...p.window.days],
    start: p.window.start,
    durationMin: p.window.durationMin,
  };
}

export function PolicyForm({ state }: { state: UpdateServerState }): ReactElement {
  const qc = useQueryClient();
  const daysId = useId();
  const [d, setD] = useState<Draft>(() => draftOf(state.policy));
  const [errors, setErrors] = useState<PolicyErrors>({});
  const save = useMutation({
    mutationFn: (p: UpdatePolicy) => saveUpdatePolicy(state.serverId, p),
    onSuccess: (next) => {
      patchUpdateServer(qc, next);
      setD(draftOf(next.policy));
    },
  });

  function set(next: Partial<Draft>): void {
    setD((x) => ({ ...x, ...next }));
    save.reset();
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    const start = parseStart(d.start);
    const errs: PolicyErrors = {};
    if (!start) errs.start = 'Uhrzeit wie 03:00.';
    if (!d.days.length) errs.days = 'Mindestens ein Tag.';
    setErrors(errs);
    if (!start || !d.days.length) return;
    save.mutate({
      agent: d.agent,
      core: d.core,
      os: d.os,
      reboot: d.reboot,
      window: { days: d.days, start, durationMin: d.durationMin },
    });
  }

  const durations = DURATION_OPTIONS.includes(d.durationMin as (typeof DURATION_OPTIONS)[number])
    ? [...DURATION_OPTIONS]
    : [...DURATION_OPTIONS, d.durationMin].sort((a, b) => a - b);
  const rebootOn = d.reboot && !state.policy.reboot;

  return (
    <form className="hz-form" onSubmit={submit} noValidate aria-label="Richtlinie">
      <span className="hz-label">Richtlinie</span>
      <Toggle
        label="Agent"
        hint="Agent im Fenster aktualisieren"
        checked={d.agent}
        onChange={(v) => set({ agent: v })}
      />
      {state.hostsCore ? (
        <Toggle
          label="Zentrale"
          hint="Läuft auf diesem Server. Wird zuletzt aktualisiert."
          checked={d.core}
          onChange={(v) => set({ core: v })}
        />
      ) : null}
      <Toggle
        label="OS-Pakete"
        hint="apt-get upgrade, entfernt nichts"
        checked={d.os}
        onChange={(v) => set({ os: v })}
      />
      <Toggle
        label="Neustart bei Bedarf"
        hint="Nur im Fenster und nur wenn nötig. Einschalten braucht einen Code."
        checked={d.reboot}
        onChange={(v) => set({ reboot: v })}
      />
      <div className="hz-field">
        <span className="hz-field-label" id={daysId}>
          Wochentage
        </span>
        <div className="app-days" role="group" aria-labelledby={daysId}>
          {ISO_WEEKDAYS.map((w) => {
            const on = d.days.includes(w.id);
            return (
              <Button
                key={w.id}
                size="sm"
                variant={on ? 'secondary' : 'ghost'}
                aria-pressed={on}
                title={w.long}
                onClick={() => {
                  set({ days: toggleIsoDay(d.days, w.id) });
                  setErrors((x) => ({ ...x, days: undefined }));
                }}
              >
                {w.label}
              </Button>
            );
          })}
        </div>
        {errors.days ? <span className="hz-field-error">{errors.days}</span> : null}
      </div>
      <div className="app-update-fields">
        <Field
          label="Start"
          mono
          inputMode="numeric"
          value={d.start}
          placeholder="03:00"
          maxLength={5}
          error={errors.start}
          autoComplete="off"
          onChange={(e) => {
            set({ start: e.target.value });
            setErrors((x) => ({ ...x, start: undefined }));
          }}
        />
        <SelectField
          label="Dauer"
          value={String(d.durationMin)}
          options={durations.map((m) => ({ value: String(m), label: durationText(m) }))}
          onChange={(e) => set({ durationMin: Number(e.target.value) })}
        />
      </div>
      {save.error ? <FormError title={errorText(save.error)} /> : null}
      {save.isSuccess ? <Alert tone="ok" title="Richtlinie gespeichert." /> : null}
      <div className="hz-form-actions">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Speichert …' : 'Speichern'}
        </Button>
        {rebootOn ? <span className="app-text">Speichern fragt nach einem Code.</span> : null}
      </div>
    </form>
  );
}
