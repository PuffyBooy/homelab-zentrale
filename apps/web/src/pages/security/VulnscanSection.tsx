import type { VulnScanResult, VulnScanSettings, VulnScanState } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent, type ReactElement } from 'react';
import { Alert, Button, StatusDot, Tile, UsageBar } from '@hz/ui';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { SelectField } from '../../components/SelectField.js';
import { isApiError } from '../../lib/api.js';
import { errorText } from '../../lib/errors.js';
import { formatAgo, formatNumber, formatWhen, plural, retryMinutes } from '../../lib/format.js';
import {
  fetchVulnscan,
  runVulnscan,
  saveVulnscanSettings,
  TIME_RE,
  vulnscanKey,
  vulnscanSentence,
  vulnStatus,
} from '../../lib/ops.js';

export function runErrorText(err: unknown): string {
  // 409 busy (contract), conflict as fallback for a 409 without a known code.
  if (isApiError(err, 'busy') || isApiError(err, 'conflict')) return 'Prüfung läuft schon.';
  if (isApiError(err, 'rate_limited'))
    return `Höchstens eine Prüfung alle 10 Min. Wieder möglich in ${retryMinutes(err.retryAfter)} Min.`;
  return errorText(err);
}

/** Sicherheit → Schwachstellen (module vulnscan). Polls every 5 s while a scan runs. */
export function VulnscanSection(): ReactElement {
  const qc = useQueryClient();
  const state = useQuery({
    queryKey: vulnscanKey,
    queryFn: ({ signal }) => fetchVulnscan(signal),
    refetchInterval: (q) => (q.state.data?.running ? 5000 : false),
  });
  const run = useMutation({
    mutationFn: runVulnscan,
    onSuccess: (next) => qc.setQueryData(vulnscanKey, next),
  });

  if (state.isError && !state.data) {
    return (
      <Tile title="Schwachstellen" icon="lock" span={4}>
        <FormError title={errorText(state.error)} />
      </Tile>
    );
  }
  if (!state.data) {
    return (
      <Tile title="Schwachstellen" icon="lock" span={4}>
        <p className="app-empty">Lade Scan-Ergebnisse …</p>
      </Tile>
    );
  }
  return (
    <>
      <VulnscanTile
        state={state.data}
        running={state.data.running}
        onRun={() => run.mutate()}
        runBusy={run.isPending}
        runError={run.error ? runErrorText(run.error) : null}
      />
      <VulnscanSettingsTile settings={state.data.settings} />
    </>
  );
}

export function VulnscanTile({
  state,
  running,
  onRun,
  runBusy,
  runError,
}: {
  state: VulnScanState;
  running: boolean;
  onRun: () => void;
  runBusy: boolean;
  runError: string | null;
}): ReactElement {
  const crit = state.results.some((r) => r.scan.counts.critical > 0);
  const high = state.results.some((r) => r.scan.counts.high > 0);
  const p = state.progress;
  return (
    <Tile
      title="Schwachstellen"
      icon="lock"
      span={4}
      count={state.results.length ? formatNumber(state.results.length, 0) : undefined}
      status={
        running ? 'busy' : crit ? 'crit' : high ? 'warn' : state.results.length ? 'ok' : undefined
      }
      statusLabel={running ? 'prüft' : vulnscanSentence(state)}
      actions={
        <Button size="sm" variant="primary" onClick={onRun} disabled={runBusy || running}>
          {running ? 'Prüft …' : 'Jetzt prüfen'}
        </Button>
      }
      flush
    >
      <div className="app-pad app-stack">
        <dl className="app-kv">
          <dt>Letzter Lauf</dt>
          <dd>
            {state.lastRunAt
              ? `${formatWhen(new Date(state.lastRunAt))} · ${formatAgo(new Date(state.lastRunAt))}`
              : 'noch nie'}
          </dd>
          <dt>Nächster Lauf</dt>
          <dd>{state.nextRunAt ? formatWhen(new Date(state.nextRunAt)) : '—'}</dd>
        </dl>
        {running ? (
          <div role="status">
            <UsageBar
              label="Fortschritt"
              value={p && p.total ? (p.done / p.total) * 100 : 0}
              detail={
                p
                  ? `${formatNumber(p.done, 0)} von ${plural(p.total, 'Container', 'Containern')}`
                  : 'startet …'
              }
            />
          </div>
        ) : null}
        {runError ? <FormError title={runError} /> : null}
        {state.skippedServers.length ? (
          <Alert
            tone="warn"
            title={`Nicht geprüft: ${state.skippedServers.map((s) => s.name).join(', ')}.`}
          >
            Server offline oder Agent zu alt für den Scan. Agent aktualisieren, dann erneut prüfen.
          </Alert>
        ) : null}
      </div>
      {state.results.length === 0 ? (
        <p className="app-empty app-pad">
          {state.lastRunAt
            ? 'Keine laufenden Container geprüft.'
            : 'Noch kein Scan gelaufen. „Jetzt prüfen“ startet den ersten.'}
        </p>
      ) : (
        state.results.map((r) => <VulnRow key={`${r.serverId}:${r.containerName}`} result={r} />)
      )}
    </Tile>
  );
}

export function VulnRow({
  result,
  initialOpen = false,
}: {
  result: VulnScanResult;
  initialOpen?: boolean;
}): ReactElement {
  const [open, setOpen] = useState(initialOpen);
  const listId = useId();
  const st = vulnStatus(result);
  const s = result.scan;
  return (
    <div data-testid="vuln-row">
      <div className="hz-row">
        <div className="hz-row-main">
          <span className="hz-row-name">{result.containerName}</span>
          <span className="hz-row-sub">
            {result.serverName} · <span className="hz-mono">{s.image}</span>
          </span>
        </div>
        <div className="hz-row-meta app-meta-gap">
          {s.scannable ? (
            <span className="app-steps">
              {formatNumber(s.counts.critical, 0)} CRIT · {formatNumber(s.counts.high, 0)} HIGH
            </span>
          ) : null}
          <StatusDot status={st.status} label={st.label} />
        </div>
        <div className="hz-row-actions">
          {s.vulns.length ? (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={open}
              aria-controls={listId}
              aria-label={`Lücken in ${result.containerName} ${open ? 'zuklappen' : 'zeigen'}`}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? 'Zuklappen' : 'Lücken'}
            </Button>
          ) : null}
        </div>
      </div>
      {open && s.vulns.length ? (
        <div className="app-scroll-x app-pad" id={listId}>
          <table className="app-cves">
            <thead>
              <tr>
                <th scope="col">CVE</th>
                <th scope="col">Stufe</th>
                <th scope="col">Paket</th>
                <th scope="col">installiert</th>
                <th scope="col">behoben in</th>
                <th scope="col">Titel</th>
              </tr>
            </thead>
            <tbody>
              {s.vulns.map((v) => (
                <tr key={`${v.id}:${v.pkg}:${v.installed}`}>
                  <td className="hz-mono">{v.id}</td>
                  <td>
                    <StatusDot
                      status={v.severity === 'CRITICAL' ? 'crit' : 'warn'}
                      label={v.severity === 'CRITICAL' ? 'CRIT' : 'HIGH'}
                      pulse={false}
                    />
                  </td>
                  <td className="hz-mono">{v.pkg}</td>
                  <td className="hz-mono">{v.installed}</td>
                  <td className="hz-mono">{v.fixed ?? '—'}</td>
                  <td>{v.title}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function VulnscanSettingsTile({ settings }: { settings: VulnScanSettings }): ReactElement {
  const qc = useQueryClient();
  const [time, setTime] = useState(settings.time);
  const [alertFrom, setAlertFrom] = useState(settings.alertFrom);
  const [timeError, setTimeError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: saveVulnscanSettings,
    onSuccess: (next) => {
      qc.setQueryData(vulnscanKey, next);
      setSaved(true);
    },
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    const t = time.trim();
    if (!TIME_RE.test(t)) {
      setTimeError('Uhrzeit wie 03:30 eintragen.');
      return;
    }
    setTimeError(null);
    save.mutate({ time: t, alertFrom });
  }

  const dirty = time !== settings.time || alertFrom !== settings.alertFrom;
  return (
    <Tile title="Scan-Einstellungen" icon="refresh" span={2}>
      <form className="hz-form" onSubmit={submit} noValidate>
        <div className="app-fields">
          <Field
            label="Uhrzeit"
            mono
            inputMode="numeric"
            maxLength={5}
            value={time}
            onChange={(e) => {
              setTime(e.target.value);
              setSaved(false);
            }}
            hint="Jede Nacht, Zeitzone der Zentrale."
            error={timeError}
          />
          <SelectField
            label="Melden ab"
            value={alertFrom}
            onChange={(e) => {
              setAlertFrom(e.target.value === 'high' ? 'high' : 'critical');
              setSaved(false);
            }}
            options={[
              { value: 'critical', label: 'kritisch' },
              { value: 'high', label: 'hoch' },
            ]}
            hint="Meldung pro Container mit Lücken ab dieser Stufe."
          />
        </div>
        {save.error ? <FormError title={errorText(save.error)} /> : null}
        {saved && !dirty ? (
          <p className="app-text" role="status">
            Gespeichert.
          </p>
        ) : null}
        <div className="hz-form-actions">
          <Button type="submit" disabled={save.isPending || !dirty}>
            Speichern
          </Button>
        </div>
      </form>
    </Tile>
  );
}
