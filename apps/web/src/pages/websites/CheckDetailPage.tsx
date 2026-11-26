import type { CheckSummary } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactElement } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Alert, Button, Metric, Sparkline, StatusDot, Tile } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { FormError } from '../../components/FormError.js';
import {
  CHECK_RANGES,
  KIND_LABEL,
  checkHistoryKey,
  checkTarget,
  checksKey,
  daysUntil,
  deleteCheck,
  fetchCheckHistory,
  formatDays,
  formatMs,
  formatUptime,
  historyStats,
  outages,
  runFromName,
  type CheckRange,
} from '../../lib/checks.js';
import { useChecks, useServers } from '../../lib/data.js';
import { errorText } from '../../lib/errors.js';
import { formatAgo, formatDateTime, formatNumber, formatWhen } from '../../lib/format.js';
import { useLiveTopic } from '../../lib/live.js';
import { useNow } from '../../lib/useNow.js';
import { CheckDialog } from './CheckDialog.js';
import { useRunCheck } from './useRunCheck.js';

const RANGE_LABEL: Record<CheckRange, string> = { '24h': '24 h', '7d': '7 T', '30d': '30 T' };

/** /websites/:id: summary, history with range switch, edit, run now, delete. */
export function CheckDetailPage(): ReactElement | null {
  useLiveTopic('checks');
  const { id = '' } = useParams();
  const checks = useChecks();
  const check = checks.data?.find((c) => c.id === id);

  if (checks.isError && !checks.data) return <FormError title={errorText(checks.error)} />;
  if (!checks.data) return null;
  if (!check) {
    return (
      <Tile title="Check" icon="globe">
        <p className="app-empty">
          Diesen Check gibt es nicht mehr. <Link to="/websites">Zu allen Websites</Link>
        </p>
      </Tile>
    );
  }
  return <Detail check={check} />;
}

function Detail({ check: c }: { check: CheckSummary }): ReactElement {
  const servers = useServers();
  const serverList = servers.data ?? [];
  const [range, setRange] = useState<CheckRange>('24h');
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const run = useRunCheck();
  const now = useNow(30_000);
  const qc = useQueryClient();

  const history = useQuery({
    queryKey: checkHistoryKey(c.id, range),
    queryFn: ({ signal }) => fetchCheckHistory(c.id, range, signal),
    staleTime: 60_000,
  });

  // A new result arrived live: the history has one more point.
  useEffect(() => {
    if (!c.lastCheckedAt) return;
    void qc.invalidateQueries({ queryKey: [...checksKey, c.id, 'history'] });
  }, [c.id, c.lastCheckedAt, qc]);

  const stats = historyStats(history.data ?? []);
  const downs = outages(history.data ?? []);
  const ssl = daysUntil(c.sslExpiresAt, now);
  const domain = daysUntil(c.domainExpiresAt, now);
  const linked = c.def.serverId ? serverList.find((s) => s.id === c.def.serverId) : undefined;
  const summaryUptime = range === '24h' ? c.uptime24h : range === '7d' ? c.uptime7d : c.uptime30d;

  return (
    <div className="hz-grid app-grid">
      {c.status === 'crit' && c.reason ? (
        <div className="hz-span-4">
          <Alert
            tone="crit"
            title={`${checkTarget(c.def)} ist offline`}
            time={c.lastCheckedAt ? formatWhen(new Date(c.lastCheckedAt), now) : undefined}
          >
            {c.reason} · {plural2(c.consecutiveFailures)} hintereinander fehlgeschlagen.
          </Alert>
        </div>
      ) : null}

      <Tile
        title={c.def.name}
        icon="globe"
        status={c.def.enabled ? c.status : 'off'}
        statusLabel={c.def.enabled ? undefined : 'PAUSE'}
        span={2}
        actions={
          <Button
            size="sm"
            variant="primary"
            icon="refresh"
            disabled={run.isPending}
            onClick={() => run.mutate(c.id)}
          >
            Jetzt prüfen
          </Button>
        }
      >
        <dl className="app-kv">
          <dt>Art</dt>
          <dd>{KIND_LABEL[c.def.kind]}</dd>
          <dt>Ziel</dt>
          <dd className="app-break">{c.def.kind === 'http' ? c.def.url : checkTarget(c.def)}</dd>
          <dt>Prüft von</dt>
          <dd>{runFromName(c.def.runFrom, serverList)}</dd>
          <dt>Intervall</dt>
          <dd>{formatNumber(c.def.intervalS, 0)} s</dd>
          {c.def.kind === 'http' ? (
            <>
              <dt>Erwartet</dt>
              <dd>
                HTTP {c.def.expectStatusMin}–{c.def.expectStatusMax}
                {c.def.contains ? ` · enthält „${c.def.contains}“` : ''}
              </dd>
            </>
          ) : null}
          <dt>Gehört zu</dt>
          <dd>{linked ? <Link to={`/servers/${linked.id}`}>{linked.name}</Link> : '—'}</dd>
          <dt>Zuletzt</dt>
          <dd>
            {c.lastCheckedAt
              ? `${formatWhen(new Date(c.lastCheckedAt), now)} · ${formatAgo(new Date(c.lastCheckedAt), now)}`
              : 'noch nicht geprüft'}
          </dd>
          <dt>Ergebnis</dt>
          <dd>
            {c.def.kind === 'http' && c.lastCode != null ? `HTTP ${c.lastCode} · ` : ''}
            {formatMs(c.lastMs)}
            {c.reason ? ` · ${c.reason}` : ''}
          </dd>
          {c.def.kind === 'http' && c.def.certCheck ? (
            <>
              <dt>SSL</dt>
              <dd className={sslClass(ssl, 14, 5)}>
                {c.sslExpiresAt
                  ? `${formatDays(ssl)} · bis ${formatDateTime(new Date(c.sslExpiresAt))}`
                  : '—'}
              </dd>
              <dt>Domain</dt>
              <dd className={sslClass(domain, 30, null)}>
                {c.domainExpiresAt
                  ? `${formatDays(domain)} · bis ${formatDateTime(new Date(c.domainExpiresAt))}`
                  : '—'}
              </dd>
            </>
          ) : null}
        </dl>
        {run.error ? <FormError title={errorText(run.error)} /> : null}
        <div className="hz-form-actions">
          <Button onClick={() => setEditing(true)}>Bearbeiten</Button>
          <Button variant="danger" onClick={() => setDeleting(true)}>
            Löschen
          </Button>
        </div>
      </Tile>

      <Tile
        title={`Verlauf ${RANGE_LABEL[range]}`}
        icon="cpu"
        span={2}
        actions={
          <div className="app-range" role="group" aria-label="Zeitraum">
            {CHECK_RANGES.map((r) => (
              <Button
                key={r}
                size="sm"
                variant={r === range ? 'secondary' : 'ghost'}
                aria-pressed={r === range}
                onClick={() => setRange(r)}
              >
                {RANGE_LABEL[r]}
              </Button>
            ))}
          </div>
        }
      >
        <div className="app-metrics">
          <MetricSplit label="Uptime" text={formatUptime(stats.uptime ?? summaryUptime)} />
          <MetricSplit label="Ø Antwort" text={formatMs(stats.avgMs)} />
          <MetricSplit label="Max" text={formatMs(stats.maxMs)} />
          <Metric label="Fehlschläge" value={formatNumber(stats.failures, 0)} />
        </div>
        <div className="app-bars">
          <div className="app-spark-row">
            <span className="hz-usage-label">Antwort</span>
            {stats.spark.length >= 2 ? (
              <Sparkline data={stats.spark} width={192} height={24} tone="muted" />
            ) : (
              <span className="app-spark-empty">
                {history.isPending ? 'lädt …' : 'zu wenig Daten'}
              </span>
            )}
            <span className="hz-usage-val">{formatMs(c.lastMs)}</span>
          </div>
        </div>
        {history.error ? <FormError title={errorText(history.error)} /> : null}
        <div>
          <div className="hz-label">Ausfälle</div>
          {downs.length ? (
            <ul className="app-outages">
              {downs.map((o) => (
                <li key={o.from}>
                  <StatusDot status="crit" pulse={false} />
                  <span>
                    {formatWhen(new Date(o.from), now)}
                    {o.to !== o.from ? `–${formatWhen(new Date(o.to), now)}` : ''}
                  </span>
                  <span className="app-outage-meta">
                    {o.code != null ? `HTTP ${o.code} · ` : ''}
                    {plural2(o.count)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="app-empty">Keine Ausfälle in {RANGE_LABEL[range]}.</p>
          )}
        </div>
      </Tile>

      {editing ? (
        <CheckDialog open onClose={() => setEditing(false)} servers={serverList} check={c} />
      ) : null}
      <DeleteDialog check={c} open={deleting} onClose={() => setDeleting(false)} />
    </div>
  );
}

/** "99,95 %" -> value "99,95", unit "%"; "—" stays without unit. */
function MetricSplit({ label, text }: { label: string; text: string }): ReactElement {
  const i = text.lastIndexOf(' ');
  if (i === -1) return <Metric label={label} value={text} />;
  return <Metric label={label} value={text.slice(0, i)} unit={text.slice(i + 1)} />;
}

function plural2(n: number): string {
  return n === 1 ? '1 Prüfung' : `${formatNumber(n, 0)} Prüfungen`;
}

function sslClass(days: number | undefined, warn: number, crit: number | null): string | undefined {
  if (days === undefined) return undefined;
  if (crit != null && days < crit) return 'hz-t-crit';
  if (days < warn) return 'hz-t-warn';
  return undefined;
}

function DeleteDialog({
  check,
  open,
  onClose,
}: {
  check: CheckSummary;
  open: boolean;
  onClose: () => void;
}): ReactElement {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const del = useMutation({
    mutationFn: () => deleteCheck(check.id),
    onSuccess: () => {
      qc.setQueryData<CheckSummary[]>(checksKey, (old) => old?.filter((x) => x.id !== check.id));
      onClose();
      void navigate('/websites');
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title={`${check.def.name} löschen`}>
      <div className="hz-dialog-body">
        <p className="hz-dialog-text">Der Check und sein Verlauf werden gelöscht.</p>
        {del.error ? <FormError title={errorText(del.error)} /> : null}
        <div className="hz-dialog-foot">
          <Button onClick={onClose} data-autofocus="">
            Abbrechen
          </Button>
          <Button variant="danger" disabled={del.isPending} onClick={() => del.mutate()}>
            Löschen
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
