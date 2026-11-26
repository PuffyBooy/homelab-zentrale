import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { Link } from 'react-router';
import { ServiceRow, Tile } from '@hz/ui';
import { formatBytesOf, plural } from '../../lib/format.js';
import {
  STORAGE_STATUS_TEXT,
  fetchStorageList,
  storageListKey,
  storageStatus,
} from '../../lib/storage.js';

/**
 * Overview tile "Speicher" (ROADMAP M13): one row per server with storage data
 * (NAS first by problems). Renders nothing without data. Polled, no live topic.
 */
export function StorageOverviewTile({
  serverId,
}: {
  serverId?: string | undefined;
}): ReactElement | null {
  const q = useQuery({
    queryKey: storageListKey,
    queryFn: ({ signal }) => fetchStorageList(signal),
    refetchInterval: 60_000,
  });
  const list = (q.data ?? []).filter(
    (s) =>
      (!serverId || s.serverId === serverId) &&
      (s.storage.arrays.length > 0 || s.storage.platform.kind === 'ugreen'),
  );
  if (!list.length) return null;
  const rank = { crit: 0, warn: 1, busy: 2, ok: 3, info: 4, off: 5 } as const;
  const rows = list
    .map((s) => ({ s, status: storageStatus(s) }))
    .sort((a, b) => rank[a.status] - rank[b.status] || a.s.name.localeCompare(b.s.name));
  const problems = list.reduce((n, s) => n + s.problems.length, 0);
  return (
    <div className="hz-grid app-grid">
      <Tile
        title="Speicher"
        icon="server"
        span={2}
        count={problems ? plural(problems, 'Problem', 'Probleme') : undefined}
        status={rows[0]?.status}
      >
        <div className="app-rows">
          {rows.map(({ s, status }) => {
            const used = s.storage.volumes.reduce((n, v) => n + v.usedBytes, 0);
            const total = s.storage.volumes.reduce((n, v) => n + v.totalBytes, 0);
            const first = s.problems[0];
            return (
              <ServiceRow
                key={s.serverId}
                name={s.name}
                host={
                  first
                    ? first.title
                    : `${s.storage.arrays.length} RAID · ${plural(s.storage.disks.length, 'Platte', 'Platten')}${
                        total > 0 ? ` · ${formatBytesOf(used, total)}` : ''
                      }`
                }
                status={status}
                meta={STORAGE_STATUS_TEXT[status]}
                actions={
                  <Link className="hz-btn hz-btn-ghost hz-btn-sm" to={`/servers/${s.serverId}`}>
                    Ansehen
                  </Link>
                }
              />
            );
          })}
        </div>
      </Tile>
    </div>
  );
}
