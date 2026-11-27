import type { ServerSummary, SpeedtestResponse, SpeedtestSettings } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Alert, Button, Metric, Sparkline, StatusDot, Tile } from '@hz/ui';
import { shownError } from '../../components/ConfirmDialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { SelectField, type SelectOption } from '../../components/SelectField.js';
import { isApiError } from '../../lib/api.js';
import { errorText } from '../../lib/errors.js';
import { formatBytes, formatPercent, formatWhen, plural } from '../../lib/format.js';
import {
  SPEEDTEST_INTERVALS,
  SPEEDTEST_RANGES,
  SPEEDTEST_SLOW_STREAK,
  downloadBars,
  formatMbps,
  formatMs,
  intervalLabel,
  isSlow,
  mbpsParts,
  parseThreshold,
  runSpeedtest,
  saveSpeedtestSettings,
  speedtestAllKey,
  trafficText,
  type SpeedtestDays,
} from '../../lib/speedtest.js';

const TABLE_ROWS = 10;

function runErrorText(err: unknown): string {
  if (isApiError(err, 'rate_limited')) {
    return 'Letzte Messung vor weniger als 5 Min. Kurz warten, dann erneut messen.';
  }
  if (isApiError(err, 'busy')) return 'Eine Messung läuft gerade.';
  if (isApiError(err, 'conflict'))
    return err.hint ?? 'Kein Server gewählt oder der Server ist offline.';
  return errorText(err);
}

/** Ø Download/Upload/Ping of the range, the download history as bars, "Jetzt messen". */
export function SpeedtestSummaryTile({
  data,
  days,
  onDays,
  now,
}: {
  data: SpeedtestResponse;
  days: SpeedtestDays;
  onDays: (d: SpeedtestDays) => void;
  now: Date;
}): ReactElement {
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: runSpeedtest,
    onSettled: () => void qc.invalidateQueries({ queryKey: speedtestAllKey }),
  });
  const s = data.summary;
  const down = mbpsParts(s.avgDownMbps);
  const up = mbpsParts(s.avgUpMbps);
  const bars = downloadBars(data.results);
  const upBars = downloadBars(data.results, (r) => r.uploadMbps);
  const noServer = !data.settings.serverId;
  const running = data.running || run.isPending;
  const err = shownError(run.error, runErrorText);

  return (
    <Tile
      title="Speedtest"
      icon="wifi"
      count={plural(s.count, 'Messung', 'Messungen')}
      span={2}
      actions={
        <div className="app-range" role="group" aria-label="Zeitraum">
          {SPEEDTEST_RANGES.map((r) => (
            <Button
              key={r}
              size="sm"
              variant={r === days ? 'secondary' : 'ghost'}
              aria-pressed={r === days}
              onClick={() => onDays(r)}
            >
              {r} Tage
            </Button>
          ))}
        </div>
      }
      footer={
        <span className="app-foot-text">
          gegen speed.cloudflare.com ·{' '}
          {data.nextRunAt
            ? `nächste Messung ${formatWhen(new Date(data.nextRunAt), now)}`
            : 'keine Messung geplant'}
        </span>
      }
    >
      <div className="hz-form">
        <div className="app-metrics">
          <Metric label="Ø Download" value={down.value} unit={down.unit} />
          <Metric label="Ø Upload" value={up.value} unit={up.unit} />
          <Metric
            label="Ø Ping"
            value={s.avgLatencyMs == null ? '—' : formatMs(s.avgLatencyMs).replace(' ms', '')}
            unit={s.avgLatencyMs == null ? undefined : 'ms'}
          />
        </div>
        {bars.length >= 2 ? (
          <div className="app-stats-hours">
            <span className="hz-label">Download</span>
            <Sparkline data={bars} width={280} height={36} tone="info" />
            <span className="hz-label">Upload</span>
            <Sparkline data={upBars} width={280} height={24} tone="muted" />
            <span className="hz-sr">
              Download zwischen {formatMbps(s.minDownMbps)} und {formatMbps(s.maxDownMbps)} in den
              letzten {days} Tagen.
            </span>
          </div>
        ) : (
          <p className="app-empty">
            {noServer
              ? 'Noch kein Server gewählt. Unten den Server wählen, der misst.'
              : 'Noch zu wenige Messungen für einen Verlauf.'}
          </p>
        )}
        {s.slowShare != null ? (
          <p className="app-text">
            {formatPercent(s.slowShare * 100)} der Messungen unter der Schwelle.
          </p>
        ) : null}
        {err ? <FormError title={err} /> : null}
        <div className="hz-form-actions">
          <Button
            variant="primary"
            icon="play"
            disabled={running || noServer}
            onClick={() => run.mutate()}
          >
            {running ? 'Misst …' : 'Jetzt messen'}
          </Button>
        </div>
      </div>
    </Tile>
  );
}

interface Draft {
  serverId: string;
  intervalHours: string;
  maxMb: string;
  minDown: string;
  minUp: string;
}

function toDraft(s: SpeedtestSettings): Draft {
  return {
    serverId: s.serverId ?? '',
    intervalHours: String(s.intervalHours),
    maxMb: String(s.maxMb),
    minDown: s.minDownMbps == null ? '' : String(s.minDownMbps).replace('.', ','),
    minUp: s.minUpMbps == null ? '' : String(s.minUpMbps).replace('.', ','),
  };
}

/** Which server measures, how often, how much data, and the thresholds. */
export function SpeedtestSettingsTile({
  data,
  servers,
}: {
  data: SpeedtestResponse;
  servers: readonly ServerSummary[];
}): ReactElement {
  const qc = useQueryClient();
  const [edited, setEdited] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({});
  const d = edited ?? toDraft(data.settings);
  const save = useMutation({
    mutationFn: saveSpeedtestSettings,
    onSuccess: () => {
      setEdited(null);
      void qc.invalidateQueries({ queryKey: speedtestAllKey });
    },
  });
  const set = (key: keyof Draft, value: string): void => {
    setEdited({ ...d, [key]: value });
    setErrors((e) => ({ ...e, [key]: undefined }));
    save.reset();
  };

  const maxMbNum = Number(d.maxMb);
  const interval = Number(d.intervalHours) as SpeedtestSettings['intervalHours'];
  const traffic =
    Number.isInteger(maxMbNum) && maxMbNum >= 10 && maxMbNum <= 1024
      ? trafficText({ maxMb: maxMbNum, intervalHours: interval })
      : null;

  function submit(e: FormEvent): void {
    e.preventDefault();
    const errs: Partial<Record<keyof Draft, string>> = {};
    const mb = Number(d.maxMb);
    if (!Number.isInteger(mb) || mb < 10 || mb > 1024) errs.maxMb = '10 bis 1024 MB';
    const down = parseThreshold(d.minDown);
    const up = parseThreshold(d.minUp);
    if (!down.ok) errs.minDown = 'Zahl in Mbit/s oder leer';
    if (!up.ok) errs.minUp = 'Zahl in Mbit/s oder leer';
    if (Object.keys(errs).length || !down.ok || !up.ok) {
      setErrors(errs);
      return;
    }
    save.mutate({
      serverId: d.serverId || null,
      intervalHours: interval,
      maxMb: mb,
      minDownMbps: down.value,
      minUpMbps: up.value,
    });
  }

  const serverOptions: SelectOption[] = [
    { value: '', label: 'kein Server (Speedtest aus)' },
    ...servers.map((s) => ({ value: s.id, label: s.connected ? s.name : `${s.name} · offline` })),
  ];
  const intervalOptions: SelectOption[] = SPEEDTEST_INTERVALS.map((h) => ({
    value: String(h),
    label: intervalLabel(h),
  }));

  return (
    <Tile title="Messung" icon="wifi" span={2}>
      <form className="hz-form" onSubmit={submit} noValidate>
        <div className="app-fields">
          <SelectField
            label="Server, der misst"
            value={d.serverId}
            options={serverOptions}
            onChange={(e) => set('serverId', e.target.value)}
            hint="Meist der Heimserver, dann misst du deinen Anschluss."
          />
          <SelectField
            label="Intervall"
            value={d.intervalHours}
            options={intervalOptions}
            onChange={(e) => set('intervalHours', e.target.value)}
          />
          <Field
            label="Datenmenge pro Richtung in MB"
            mono
            inputMode="numeric"
            value={d.maxMb}
            onChange={(e) => set('maxMb', e.target.value)}
            error={errors.maxMb}
            hint="Mehr Daten messen schnelle Leitungen genauer."
          />
          <div />
          <Field
            label="Download mindestens (Mbit/s)"
            mono
            inputMode="decimal"
            value={d.minDown}
            onChange={(e) => set('minDown', e.target.value)}
            placeholder="leer = keine Meldung"
            error={errors.minDown}
          />
          <Field
            label="Upload mindestens (Mbit/s)"
            mono
            inputMode="decimal"
            value={d.minUp}
            onChange={(e) => set('minUp', e.target.value)}
            placeholder="leer = keine Meldung"
            error={errors.minUp}
          />
        </div>
        {traffic ? (
          <Alert tone="info" title="Verbraucht Datenvolumen.">
            {traffic}. Bei Volumentarif oder LTE-Router lieber selten und mit wenig Daten messen.
          </Alert>
        ) : null}
        <p className="app-text">
          Meldung nach {SPEEDTEST_SLOW_STREAK} langsamen Messungen in Folge, die nächste gute
          schließt sie. Verlauf 90 Tage.
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

/** The last measurements, newest first. */
export function SpeedtestTableTile({
  data,
  now,
}: {
  data: SpeedtestResponse;
  now: Date;
}): ReactElement {
  const rows = [...data.results].sort((a, b) => b.at - a.at).slice(0, TABLE_ROWS);
  return (
    <Tile title="Letzte Messungen" icon="wifi" count={String(data.results.length)} span={4}>
      {rows.length === 0 ? (
        <p className="app-empty">Noch keine Messung.</p>
      ) : (
        <div className="app-scroll-x">
          <table className="app-table app-table-cols" aria-label="Letzte Messungen">
            <thead>
              <tr>
                <th scope="col">Zeit</th>
                <th scope="col">Status</th>
                <th scope="col">Download</th>
                <th scope="col">Upload</th>
                <th scope="col">Ping</th>
                <th scope="col">Jitter</th>
                <th scope="col">Daten</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const slow = isSlow(r, data.settings);
                return (
                  <tr key={r.id} data-testid="speedtest-row">
                    <th scope="row">
                      {formatWhen(new Date(r.at), now)}
                      <small>
                        {r.trigger === 'manual' ? 'von Hand' : 'Zeitplan'}
                        {r.colo ? ` · ${r.colo}` : ''}
                      </small>
                    </th>
                    <td>
                      <StatusDot
                        status={!r.ok ? 'crit' : slow ? 'warn' : 'ok'}
                        label={!r.ok ? 'FAIL' : slow ? 'SLOW' : 'OK'}
                      />
                      {!r.ok && r.error ? <small className="app-cell-note">{r.error}</small> : null}
                    </td>
                    <td>{formatMbps(r.downloadMbps)}</td>
                    <td>{formatMbps(r.uploadMbps)}</td>
                    <td>{formatMs(r.latencyMs)}</td>
                    <td>{formatMs(r.jitterMs)}</td>
                    <td>{formatBytes(r.bytes)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Tile>
  );
}
