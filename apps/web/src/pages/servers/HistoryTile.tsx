import type { HistoryResponse, ServerDetail } from '@hz/shared';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { Button, Sparkline, Tile } from '@hz/ui';
import { errorText } from '../../lib/errors.js';
import { formatPercent, formatRate, formatTemp } from '../../lib/format.js';
import { bucket } from '../../lib/history.js';
import {
  HISTORY_RANGES,
  HISTORY_RANGE_LABEL,
  known,
  seriesStats,
  statsText,
  type HistoryRange,
} from '../../lib/serverAdmin.js';
import { fetchHistory, historyKey } from '../../lib/servers.js';

const SPARK_BARS = 60;
type Point = HistoryResponse['points'][number];

interface Row {
  label: string;
  pick: (p: Point) => number | null | undefined;
  fmt: (v: number) => string;
  now: string;
  tone?: 'accent' | 'ok' | 'info' | 'muted';
  /** Hidden when no point and no current value has it (no sensor, old agent). */
  optional?: boolean;
}

function rows(d: ServerDetail): Row[] {
  const s = d.server;
  return [
    { label: 'CPU', pick: (p) => p.cpu, fmt: formatPercent, now: formatPercent(s.cpu) },
    { label: 'RAM', pick: (p) => p.ramPct, fmt: formatPercent, now: formatPercent(s.ramPct) },
    {
      label: 'Netz ein',
      pick: (p) => p.netIn,
      fmt: formatRate,
      now: formatRate(d.net?.rxBps),
      tone: 'info',
    },
    {
      label: 'Netz aus',
      pick: (p) => p.netOut,
      fmt: formatRate,
      now: formatRate(d.net?.txBps),
      tone: 'muted',
    },
    {
      label: 'Temperatur',
      pick: (p) => p.temp,
      fmt: formatTemp,
      now: formatTemp(s.temp),
      optional: s.temp == null,
    },
    {
      label: 'Disk',
      pick: (p) => p.diskMax,
      fmt: formatPercent,
      now: formatPercent(s.diskPct),
      optional: s.diskPct == null,
    },
  ];
}

/**
 * "Verlauf" in the server detail (ROADMAP M16): 1 h / 24 h / 7 Tage / 30 Tage for CPU,
 * RAM, Netz, Temperatur and the fullest disk, each with Min, Ø and Max.
 */
export function HistoryTile({ detail }: { detail: ServerDetail }): ReactElement {
  const id = detail.server.id;
  const [range, setRange] = useState<HistoryRange>('24h');
  const q = useQuery({
    queryKey: historyKey(id, range),
    queryFn: ({ signal }) => fetchHistory(id, range, signal),
    refetchInterval: range === '1h' ? 60_000 : 5 * 60_000,
  });
  return (
    <div className="hz-span-2 app-anchor" id="verlauf">
      <HistoryView
        detail={detail}
        range={range}
        onRange={setRange}
        history={q.data}
        loading={q.isFetching}
        error={q.error ? errorText(q.error) : null}
      />
    </div>
  );
}

export function HistoryView({
  detail,
  range,
  onRange,
  history,
  loading = false,
  error = null,
}: {
  detail: ServerDetail;
  range: HistoryRange;
  onRange: (r: HistoryRange) => void;
  history: HistoryResponse | undefined;
  loading?: boolean;
  error?: string | null;
}): ReactElement {
  const points = history?.points ?? [];
  const list = rows(detail).filter((r) => !r.optional || points.some((p) => r.pick(p) != null));
  return (
    <Tile
      title="Verlauf"
      icon="cpu"
      span={2}
      actions={
        <div className="app-range" role="group" aria-label="Zeitraum">
          {HISTORY_RANGES.map((r) => (
            <Button
              key={r}
              size="sm"
              variant={r === range ? 'secondary' : 'ghost'}
              aria-pressed={r === range}
              onClick={() => onRange(r)}
            >
              {HISTORY_RANGE_LABEL[r]}
            </Button>
          ))}
        </div>
      }
      footer={
        <span className="app-foot-text" aria-live="polite">
          {error ??
            (loading && !history
              ? `Lade ${HISTORY_RANGE_LABEL[range]} …`
              : `${HISTORY_RANGE_LABEL[range]} · rechts der aktuelle Wert`)}
        </span>
      }
    >
      <div className="app-hist" aria-label={`Verlauf ${HISTORY_RANGE_LABEL[range]}`} role="list">
        {list.map((r) => {
          const values = points.map(r.pick);
          const data = bucket(known(values), SPARK_BARS);
          return (
            <div className="app-hist-row" role="listitem" key={r.label}>
              <span className="hz-usage-label">{r.label}</span>
              <div className="app-hist-chart">
                {data.length >= 2 ? (
                  <Sparkline data={data} width={360} height={24} tone={r.tone} />
                ) : (
                  <span className="app-spark-empty">zu wenig Daten</span>
                )}
                <span className="app-hist-stats">{statsText(seriesStats(values), r.fmt)}</span>
              </div>
              <span className="hz-usage-val">{r.now}</span>
            </div>
          );
        })}
      </div>
    </Tile>
  );
}
