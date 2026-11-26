import type {
  CheckSummary,
  ContainerSummary,
  SelfhealMode,
  SelfhealResponse,
  SelfhealRule,
  SelfhealState,
} from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Alert, Button, ServiceRow, StatusDot, Tile } from '@hz/ui';
import { shownError } from '../../components/ConfirmDialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { SelectField, type SelectOption } from '../../components/SelectField.js';
import { checkTarget } from '../../lib/checks.js';
import { formatWhen } from '../../lib/format.js';
import {
  EVENT_STATUS,
  PHASE_STATUS,
  PHASE_TEXT,
  REASON_TEXT,
  SELFHEAL_MODES,
  SELFHEAL_MODE_LABELS,
  SETTINGS_FIELDS,
  attemptsText,
  deleteSelfhealRule,
  draftToSettings,
  eventText,
  resetSelfheal,
  saveSelfhealRule,
  saveSelfhealSettings,
  selfhealKey,
  settingsToDraft,
  sortStates,
  type SettingsDraft,
  type SettingsErrors,
} from '../../lib/selfheal.js';

const MODE_OPTIONS: SelectOption[] = SELFHEAL_MODES.map((m) => ({
  value: m,
  label: SELFHEAL_MODE_LABELS[m],
}));

function patch(
  qc: ReturnType<typeof useQueryClient>,
  fn: (old: SelfhealResponse) => SelfhealResponse,
): void {
  qc.setQueryData<SelfhealResponse>(selfhealKey, (old) => (old ? fn(old) : old));
}

/** Settings of the loop guard and the default mode. */
export function SelfhealSettingsTile({
  data,
  span = 2,
}: {
  data: SelfhealResponse;
  span?: 2 | 4;
}): ReactElement {
  const qc = useQueryClient();
  const [edited, setEdited] = useState<SettingsDraft | null>(null);
  const [errors, setErrors] = useState<SettingsErrors>({});
  const draft = edited ?? settingsToDraft(data.settings);
  const save = useMutation({
    mutationFn: saveSelfhealSettings,
    onSuccess: (settings) => {
      patch(qc, (old) => ({ ...old, settings }));
      setEdited(null);
    },
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    const res = draftToSettings(draft);
    if (!res.ok) {
      setErrors(res.errors);
      return;
    }
    setErrors({});
    save.mutate(res.settings);
  }

  const set = (key: keyof SettingsDraft, value: string): void => {
    setEdited({ ...draft, [key]: value });
    setErrors((x) => ({ ...x, [key]: undefined }));
    save.reset();
  };

  return (
    <Tile title="Selbstheilung" icon="refresh" span={span}>
      <form className="hz-form" onSubmit={submit} noValidate>
        <p className="app-text">
          Startet Container neu, die hängen. Nie Zentrale und Agent, nie von dir oder M10 gestoppte
          Container. Abgestürzte „wichtig“-Container startet schon die Priorität neu.
        </p>
        <SelectField
          label="Standard für alle Container"
          value={draft.defaultMode}
          options={MODE_OPTIONS}
          onChange={(e) => set('defaultMode', e.target.value as SelfhealMode)}
          hint="„unhealthy“ braucht einen Docker-Healthcheck im Container."
        />
        <div className="app-threshold-grid">
          {SETTINGS_FIELDS.map((f) => (
            <Field
              key={f.key}
              label={f.label}
              mono
              inputMode="numeric"
              value={draft[f.key]}
              onChange={(e) => set(f.key, e.target.value)}
              error={errors[f.key]}
            />
          ))}
        </div>
        <p className="app-text">
          Danach „aufgegeben“ mit CRIT-Meldung, bis der Container 10 Min gesund ist oder du ihn
          zurücksetzt.
        </p>
        {shownError(save.error) ? <FormError title={shownError(save.error) ?? ''} /> : null}
        {save.isSuccess && !edited ? <Alert tone="ok" title="Gespeichert." /> : null}
        <div className="hz-form-actions">
          <Button type="submit" disabled={save.isPending || !edited}>
            {save.isPending ? 'Speichert …' : 'Speichern'}
          </Button>
        </div>
      </form>
    </Tile>
  );
}

/** Containers with a problem or restarts in the window; "Zurücksetzen" after aufgegeben. */
export function SelfhealStateTile({
  data,
  now,
  span = 2,
}: {
  data: SelfhealResponse;
  now: Date;
  span?: 2 | 4;
}): ReactElement {
  const list = sortStates(data.state);
  const gaveUp = list.filter((s) => s.phase === 'gave_up').length;
  return (
    <Tile
      title="Zustand"
      className="app-wrap-tile"
      icon="container"
      count={gaveUp ? `${list.length} · ${gaveUp} aufgegeben` : String(list.length)}
      status={gaveUp ? 'crit' : undefined}
      statusLabel={gaveUp ? 'aufgegeben' : undefined}
      span={span}
      flush
    >
      {list.length === 0 ? (
        <p className="app-empty app-pad">Kein Container auffällig.</p>
      ) : (
        list.map((s) => (
          <StateRow key={`${s.serverId}/${s.container}`} s={s} data={data} now={now} />
        ))
      )}
    </Tile>
  );
}

export function StateRow({
  s,
  data,
  now,
}: {
  s: SelfhealState;
  data: SelfhealResponse;
  now: Date;
}): ReactElement {
  const qc = useQueryClient();
  const reset = useMutation({
    mutationFn: () => resetSelfheal(s.serverId, s.container),
    onSuccess: () => {
      patch(qc, (old) => ({
        ...old,
        state: old.state.map((x) =>
          x.serverId === s.serverId && x.container === s.container
            ? { ...x, phase: 'watching', attempts: 0 }
            : x,
        ),
      }));
      void qc.invalidateQueries({ queryKey: selfhealKey });
    },
  });
  const why = s.lastReason ? REASON_TEXT[s.lastReason] : 'auffällig';
  const last = s.lastRestartAt ? ` · zuletzt ${formatWhen(new Date(s.lastRestartAt), now)}` : '';
  const err = shownError(reset.error);
  return (
    <>
      <ServiceRow
        name={s.container}
        host={`${s.serverName} · ${PHASE_TEXT[s.phase]} · ${why}${last}`}
        status={PHASE_STATUS[s.phase]}
        meta={
          <span title={attemptsText(s.attempts, data.settings)}>
            {s.attempts}/{data.settings.maxRestarts} Neustarts
          </span>
        }
        actions={
          s.phase === 'gave_up' ? (
            <Button
              size="sm"
              disabled={reset.isPending}
              aria-label={`${s.container} auf ${s.serverName} zurücksetzen`}
              onClick={() => reset.mutate()}
            >
              Zurücksetzen
            </Button>
          ) : undefined
        }
      />
      {err ? (
        <div className="app-ctr-error">
          <Alert tone="crit" title={`${s.container}: ${err}`} />
        </div>
      ) : null}
    </>
  );
}

const ruleKey = (r: Pick<SelfhealRule, 'serverId' | 'container'>): string =>
  `${r.serverId}/${r.container}`;

/** Own rule per container: mode and an optional website check. */
export function SelfhealRulesTile({
  data,
  containers,
  checks,
}: {
  data: SelfhealResponse;
  containers: readonly ContainerSummary[];
  checks: readonly CheckSummary[];
}): ReactElement {
  const qc = useQueryClient();
  const [ctr, setCtr] = useState('');
  const [mode, setMode] = useState<SelfhealMode>('unhealthy_or_exited');
  const [checkId, setCheckId] = useState('');
  const save = useMutation({
    mutationFn: (v: { serverId: string; container: string; mode: SelfhealMode; checkId: string }) =>
      saveSelfhealRule(v.serverId, v.container, {
        mode: v.mode,
        checkId: v.mode === 'off' || !v.checkId ? null : v.checkId,
      }),
    onSuccess: (rule) => {
      patch(qc, (old) => ({
        ...old,
        rules: [...old.rules.filter((r) => ruleKey(r) !== ruleKey(rule)), rule],
      }));
      setCtr('');
      setCheckId('');
    },
  });
  const remove = useMutation({
    mutationFn: (r: SelfhealRule) => deleteSelfhealRule(r.serverId, r.container),
    onSuccess: (_v, r) =>
      patch(qc, (old) => ({ ...old, rules: old.rules.filter((x) => ruleKey(x) !== ruleKey(r)) })),
  });

  const ruled = new Set(data.rules.map(ruleKey));
  const candidates = containers
    .filter((c) => !c.protected && !ruled.has(`${c.serverId}/${c.name}`))
    .sort(
      (a, b) =>
        a.serverName.localeCompare(b.serverName, 'de') || a.name.localeCompare(b.name, 'de'),
    );
  const ctrOptions: SelectOption[] = [
    { value: '', label: candidates.length ? 'Container wählen' : 'Kein Container ohne Regel' },
    ...candidates.map((c) => ({
      value: `${c.serverId}/${c.name}`,
      label: `${c.serverName} · ${c.name}`,
    })),
  ];
  const checkOptions: SelectOption[] = [
    { value: '', label: 'kein Website-Check' },
    ...checks.map((c) => ({ value: c.id, label: checkTarget(c.def) })),
  ];
  const checkName = (id: string | null): string | null => {
    if (!id) return null;
    const c = checks.find((x) => x.id === id);
    return c ? checkTarget(c.def) : 'Check gelöscht';
  };
  const rules = [...data.rules].sort((a, b) => ruleKey(a).localeCompare(ruleKey(b), 'de'));
  const serverName = (id: string): string =>
    containers.find((c) => c.serverId === id)?.serverName ??
    data.state.find((s) => s.serverId === id)?.serverName ??
    id;

  function add(e: FormEvent): void {
    e.preventDefault();
    const c = candidates.find((x) => `${x.serverId}/${x.name}` === ctr);
    if (!c) return;
    save.mutate({ serverId: c.serverId, container: c.name, mode, checkId });
  }

  const err = shownError(save.error) ?? shownError(remove.error);

  return (
    <Tile
      title="Regeln pro Container"
      className="app-wrap-tile"
      icon="container"
      count={String(rules.length)}
      span={4}
      flush
      footer={
        <span className="app-foot-text">
          Ohne Regel gilt der Standard · ein verknüpfter Check startet den Container neu, wenn die
          Website DOWN ist
        </span>
      }
    >
      {rules.length === 0 ? (
        <p className="app-empty app-pad">Keine eigene Regel. Alle Container nutzen den Standard.</p>
      ) : (
        rules.map((r) => {
          const check = checkName(r.checkId);
          return (
            <ServiceRow
              key={ruleKey(r)}
              name={r.container}
              host={`${serverName(r.serverId)}${check ? ` · Website ${check}` : ''}`}
              status={r.mode === 'off' ? 'off' : 'ok'}
              meta={SELFHEAL_MODE_LABELS[r.mode]}
              actions={
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Regel für ${r.container} entfernen`}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(r)}
                >
                  Standard
                </Button>
              }
            />
          );
        })
      )}
      <form className="app-pad hz-form" onSubmit={add} noValidate>
        <div className="app-fields">
          <SelectField
            label="Container"
            value={ctr}
            options={ctrOptions}
            onChange={(e) => setCtr(e.target.value)}
          />
          <SelectField
            label="Neustart"
            value={mode}
            options={MODE_OPTIONS}
            onChange={(e) => setMode(e.target.value as SelfhealMode)}
          />
          <SelectField
            label="Website-Check"
            value={mode === 'off' ? '' : checkId}
            options={checkOptions}
            disabled={mode === 'off'}
            onChange={(e) => setCheckId(e.target.value)}
            hint="Neustart, wenn dieser Check DOWN ist."
          />
        </div>
        {err ? <FormError title={err} /> : null}
        <div className="hz-form-actions">
          <Button type="submit" icon="plus" disabled={!ctr || save.isPending}>
            Regel speichern
          </Button>
        </div>
      </form>
    </Tile>
  );
}

/** Restarts, give-ups and recoveries of the last 30 days, newest first. */
export function SelfhealEventsTile({
  data,
  now,
}: {
  data: SelfhealResponse;
  now: Date;
}): ReactElement {
  const events = [...data.events].sort((a, b) => b.at - a.at).slice(0, 50);
  return (
    <Tile
      title="Verlauf"
      className="app-wrap-tile"
      icon="bell"
      count={String(data.events.length)}
      span={4}
      flush
      footer={<span className="app-foot-text">Neustarts als INFO im Meldungs-Feed, ohne Push</span>}
    >
      {events.length === 0 ? (
        <p className="app-empty app-pad">Noch kein Neustart durch die Selbstheilung.</p>
      ) : (
        events.map((e) => (
          <div key={e.id} className="hz-row" data-testid="selfheal-event">
            <StatusDot status={EVENT_STATUS[e.action]} />
            <div className="hz-row-main">
              <span className="hz-row-name">{e.container}</span>
              <span className="hz-row-sub">
                {e.serverName} · {eventText(e)}
              </span>
            </div>
            <div className="hz-row-meta">{formatWhen(new Date(e.at), now)}</div>
          </div>
        ))
      )}
    </Tile>
  );
}
