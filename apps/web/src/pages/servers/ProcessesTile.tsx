import type { ProcessSort, ProcessesResponse } from '@hz/shared';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { Button, Tile } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { errorText } from '../../lib/errors.js';
import { formatBytes, formatNumber, formatTime, plural } from '../../lib/format.js';
import { fetchProcesses, processesKey } from '../../lib/serverAdmin.js';

const SORT_LABEL: Record<ProcessSort, string> = { cpu: 'CPU', mem: 'RAM' };

/**
 * "Prozesse" (ROADMAP M16): top 25 by CPU or RAM, names only (never command lines).
 * Refreshes every 10 s while the tab is visible.
 */
export function ProcessesTile({
  serverId,
  offline,
}: {
  serverId: string;
  offline: boolean;
}): ReactElement {
  const [sort, setSort] = useState<ProcessSort>('cpu');
  const q = useQuery({
    queryKey: processesKey(serverId, sort),
    queryFn: ({ signal }) => fetchProcesses(serverId, sort, signal),
    enabled: !offline,
    refetchInterval: 10_000,
    retry: false,
  });
  return (
    <div className="hz-span-4 app-anchor" id="prozesse">
      <ProcessesView
        sort={sort}
        onSort={setSort}
        data={q.data}
        offline={offline}
        loading={q.isFetching}
        error={q.error ? errorText(q.error) : null}
        updatedAt={q.dataUpdatedAt ? new Date(q.dataUpdatedAt) : null}
        onRefresh={() => void q.refetch()}
      />
    </div>
  );
}

export function ProcessesView({
  sort,
  onSort,
  data,
  offline,
  loading,
  error,
  updatedAt,
  onRefresh,
}: {
  sort: ProcessSort;
  onSort: (s: ProcessSort) => void;
  data: ProcessesResponse | undefined;
  offline: boolean;
  loading: boolean;
  error: string | null;
  updatedAt: Date | null;
  onRefresh: () => void;
}): ReactElement {
  return (
    <Tile
      title="Prozesse"
      icon="cpu"
      span={4}
      count={data ? `Top ${formatNumber(data.list.length, 0)}` : undefined}
      actions={
        <>
          <div className="app-range" role="group" aria-label="Sortieren nach">
            {(['cpu', 'mem'] as const).map((s) => (
              <Button
                key={s}
                size="sm"
                variant={s === sort ? 'secondary' : 'ghost'}
                aria-pressed={s === sort}
                onClick={() => onSort(s)}
              >
                {SORT_LABEL[s]}
              </Button>
            ))}
          </div>
          <Button
            size="sm"
            variant="ghost"
            icon="refresh"
            aria-label="Prozesse neu laden"
            disabled={offline || loading}
            onClick={onRefresh}
          />
        </>
      }
      footer={
        data ? (
          <span className="app-foot-text">
            {plural(data.total, 'Prozess', 'Prozesse')} gesamt
            {updatedAt ? ` · Stand ${formatTime(updatedAt)}` : ''} · nur Namen, keine Kommandozeilen
          </span>
        ) : undefined
      }
    >
      {offline ? (
        <p className="app-empty">Agent offline.</p>
      ) : error ? (
        <FormError title={error} />
      ) : !data ? (
        <p className="app-empty" role="status">
          Lade Prozesse …
        </p>
      ) : (
        <div className="app-scroll-x" tabIndex={0} role="region" aria-label="Prozessliste">
          <table className="app-table app-proc" aria-label={`Prozesse nach ${SORT_LABEL[sort]}`}>
            <thead>
              <tr>
                <th scope="col">PID</th>
                <th scope="col">Name</th>
                <th scope="col">Benutzer</th>
                <th scope="col" aria-sort={sort === 'cpu' ? 'descending' : undefined}>
                  CPU
                </th>
                <th scope="col" aria-sort={sort === 'mem' ? 'descending' : undefined}>
                  RAM
                </th>
                <th scope="col">Container</th>
              </tr>
            </thead>
            <tbody>
              {data.list.map((p) => (
                <tr key={p.pid}>
                  <td>{p.pid}</td>
                  <th scope="row">{p.name}</th>
                  <td>{p.user}</td>
                  <td>{`${formatNumber(p.cpu, 1)} %`}</td>
                  <td>{formatBytes(p.memBytes)}</td>
                  <td>{p.container ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Tile>
  );
}
