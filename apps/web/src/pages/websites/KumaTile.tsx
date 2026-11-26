import type { KumaMonitor, ServerSummary } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactElement } from 'react';
import { Link } from 'react-router';
import { Alert, Badge, Button, Tile, WebCheckRow } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { NotConfigured } from '../../components/NotConfigured.js';
import { SelectField } from '../../components/SelectField.js';
import { isApiError } from '../../lib/api.js';
import { checksKey } from '../../lib/checks.js';
import { errorText } from '../../lib/errors.js';
import { formatAgo, plural } from '../../lib/format.js';
import { useIntegrationSettings } from '../../lib/integrations.js';
import {
  IMPORT_AS_LABEL,
  KUMA_STATUS_TEXT,
  canImport,
  fetchKumaMonitors,
  importKumaMonitors,
  importSummary,
  kumaMonitorsKey,
  kumaStatus,
  monitorTarget,
  needsPingAgent,
  sortMonitors,
  type KumaImportResult,
  type KumaMonitors,
} from '../../lib/kuma.js';
import { useNow } from '../../lib/useNow.js';

/** Websites → "Uptime Kuma" (SPEC 16, module uptimekuma). */
export function KumaSection({ servers }: { servers: ServerSummary[] }): ReactElement | null {
  const qc = useQueryClient();
  const settings = useIntegrationSettings('uptimekuma');
  const monitors = useQuery({
    queryKey: kumaMonitorsKey,
    queryFn: ({ signal }) => fetchKumaMonitors(signal),
    enabled: settings.configured === true,
    refetchInterval: 60_000,
  });
  const now = useNow(30_000);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [pingFrom, setPingFrom] = useState('');
  const run = useMutation({
    mutationFn: () => importKumaMonitors([...selected], pingFrom || undefined),
    onSuccess: () => {
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: kumaMonitorsKey });
      void qc.invalidateQueries({ queryKey: checksKey });
    },
  });

  if (settings.configured === false) {
    return (
      <NotConfigured
        integration="uptimekuma"
        title="Uptime Kuma"
        icon="globe"
        span={4}
        text="Uptime Kuma ist noch nicht eingerichtet. Trag Adresse und API-Key ein, dann siehst du hier die Monitore und kannst sie als eigene Checks übernehmen."
      />
    );
  }
  if (monitors.isError && !monitors.data) {
    return (
      <Tile title="Uptime Kuma" icon="globe" span={4}>
        <FormError title={errorText(monitors.error)} />
      </Tile>
    );
  }
  if (!monitors.data) return null;

  return (
    <KumaView
      data={monitors.data}
      servers={servers}
      now={now}
      selected={selected}
      onToggle={(name, on) => {
        run.reset();
        setSelected((prev) => {
          const next = new Set(prev);
          if (on) next.add(name);
          else next.delete(name);
          return next;
        });
      }}
      pingFrom={pingFrom}
      onPingFrom={setPingFrom}
      busy={run.isPending}
      result={run.data ?? null}
      error={run.error && !isApiError(run.error, 'step_up_required') ? errorText(run.error) : null}
      onImport={() => run.mutate()}
    />
  );
}

export interface KumaViewProps {
  data: KumaMonitors;
  servers: ServerSummary[];
  now: Date;
  selected: ReadonlySet<string>;
  onToggle: (name: string, on: boolean) => void;
  pingFrom: string;
  onPingFrom: (id: string) => void;
  busy: boolean;
  result: KumaImportResult | null;
  error: string | null;
  onImport: () => void;
}

export function KumaView({
  data,
  servers,
  now,
  selected,
  onToggle,
  pingFrom,
  onPingFrom,
  busy,
  result,
  error,
  onImport,
}: KumaViewProps): ReactElement {
  const list = useMemo(() => sortMonitors(data.monitors), [data.monitors]);
  const chosen = list.filter((m) => selected.has(m.name));
  const down = list.filter((m) => m.status === 'down').length;
  const imported = list.filter((m) => m.checkId !== null).length;
  const fetched = data.fetchedAt ? new Date(data.fetchedAt) : null;
  const ping = needsPingAgent(chosen);

  return (
    <Tile
      title="Uptime Kuma"
      icon="globe"
      count={`${list.length}${down ? ` · ${plural(down, 'nicht erreichbar', 'nicht erreichbar')}` : ''}${
        imported ? ` · ${imported} übernommen` : ''
      }`}
      span={4}
      flush
      footer={
        <span className="app-foot-text">
          {fetched ? `gelesen ${formatAgo(fetched, now)} · ` : ''}aus /metrics · Übernehmen legt
          eigene Checks an, danach kann Kuma aus
        </span>
      }
    >
      {data.error ? (
        <div className="app-pad">
          <Alert
            tone="crit"
            title={`Uptime Kuma nicht erreichbar: ${data.error}`}
            action={
              <Link
                className="hz-btn hz-btn-secondary hz-btn-sm"
                to="/settings#anbindung-uptimekuma"
              >
                <span>Einstellungen</span>
              </Link>
            }
          />
        </div>
      ) : null}
      {list.length === 0 ? (
        <p className="app-empty app-pad">Uptime Kuma meldet keine Monitore.</p>
      ) : (
        list.map((m) => (
          <KumaRow
            key={m.name}
            m={m}
            checked={selected.has(m.name)}
            disabled={busy}
            onToggle={(on) => onToggle(m.name, on)}
          />
        ))
      )}
      <div className="app-pad app-kuma-foot">
        {ping ? (
          <SelectField
            label="Ping-Checks laufen auf"
            value={pingFrom}
            onChange={(e) => onPingFrom(e.target.value)}
            options={[
              { value: '', label: 'keinem (Ping-Monitore überspringen)' },
              ...servers.map((s) => ({
                value: s.id,
                label: s.connected ? s.name : `${s.name} (offline)`,
              })),
            ]}
            hint="Ping braucht einen Agent. HTTP- und Port-Checks laufen von der Zentrale."
          />
        ) : null}
        {error ? <FormError title={error} /> : null}
        {result ? (
          <Alert tone={result.created ? 'ok' : 'info'} title={importSummary(result)}>
            {result.skipped.length ? (
              <ul className="app-kuma-skipped" aria-label="Übersprungen">
                {result.skipped.map((s) => (
                  <li key={s.name}>
                    <span className="app-kuma-skipped-name">{s.name}</span> · {s.reason}
                  </li>
                ))}
              </ul>
            ) : undefined}
          </Alert>
        ) : null}
        <div className="hz-form-actions">
          <Button icon="plus" disabled={busy || chosen.length === 0} onClick={onImport}>
            {chosen.length
              ? `${plural(chosen.length, 'Monitor', 'Monitore')} übernehmen`
              : 'Übernehmen'}
          </Button>
        </div>
      </div>
    </Tile>
  );
}

function KumaRow({
  m,
  checked,
  disabled,
  onToggle,
}: {
  m: KumaMonitor;
  checked: boolean;
  disabled: boolean;
  onToggle: (on: boolean) => void;
}): ReactElement {
  const type = m.importAs ? IMPORT_AS_LABEL[m.importAs] : m.type;
  return (
    <WebCheckRow
      url={m.name}
      host={`${monitorTarget(m)} · ${KUMA_STATUS_TEXT[m.status]}`}
      status={kumaStatus(m)}
      code={type}
      ms={m.responseMs == null ? null : Math.round(m.responseMs)}
      sslDays={m.certDaysRemaining ?? undefined}
      actions={
        <span className="app-kuma-action">
          {m.checkId !== null ? (
            <Badge icon="check">übernommen</Badge>
          ) : canImport(m) ? (
            <label className="app-check">
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(e) => onToggle(e.target.checked)}
              />
              <span className="hz-sr">{m.name} übernehmen</span>
            </label>
          ) : (
            <Badge>Typ nicht unterstützt</Badge>
          )}
        </span>
      }
    />
  );
}
