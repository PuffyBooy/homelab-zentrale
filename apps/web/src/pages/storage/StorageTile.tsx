import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { Alert, Badge, ServiceRow, Tile, UsageBar } from '@hz/ui';
import { isApiError } from '../../lib/api.js';
import { errorText } from '../../lib/errors.js';
import { formatAgo, formatBytesOf } from '../../lib/format.js';
import {
  SMART_HINT,
  arrayView,
  diskView,
  fetchStorage,
  storageKey,
  storageStatus,
} from '../../lib/storage.js';
import { useModules } from '../../lib/useModules.js';
import { useNow } from '../../lib/useNow.js';

/**
 * "Speicher" in the server detail (ROADMAP M13): RAID arrays, volumes and disks with
 * SMART. Hidden while the module is off or the server sent no storage data.
 */
export function StorageTile({ serverId }: { serverId: string }): ReactElement | null {
  const modules = useModules();
  const now = useNow(30_000);
  const q = useQuery({
    queryKey: storageKey(serverId),
    queryFn: ({ signal }) => fetchStorage(serverId, signal),
    enabled: modules.storage,
    refetchInterval: 30_000,
    retry: (n, err) => !isApiError(err, 'not_found') && n < 2,
  });
  if (!modules.storage) return null;
  if (q.error) {
    if (isApiError(q.error, 'not_found')) return null;
    return (
      <Tile title="Speicher" icon="server" span={4}>
        <Alert tone="crit" title={errorText(q.error)} />
      </Tile>
    );
  }
  const s = q.data;
  if (!s) return null;
  const st = s.storage;
  const hint = SMART_HINT[st.smart];
  const status = storageStatus(s);

  return (
    <Tile
      title="Speicher"
      icon="server"
      span={4}
      status={status}
      count={`${st.disks.length} Platten`}
      actions={st.platform.kind === 'ugreen' ? <Badge tone="neutral">UGREEN-NAS</Badge> : undefined}
      footer={
        <span className="app-foot-text">gemeldet {formatAgo(new Date(s.updatedAt), now)}</span>
      }
    >
      {s.problems.length ? (
        <div className="app-stack" aria-label="Speicher-Probleme">
          {s.problems.map((p) => (
            <Alert key={p.key} tone={p.level} title={p.title}>
              {p.body}
            </Alert>
          ))}
        </div>
      ) : null}

      {st.arrays.length ? (
        <section aria-label="RAID">
          <h3 className="hz-label app-storage-head">RAID</h3>
          <div className="app-rows">
            {st.arrays.map((a) => {
              const v = arrayView(a);
              return (
                <ServiceRow
                  key={a.name}
                  name={a.name}
                  host={v.detail}
                  status={v.status}
                  meta={v.label}
                />
              );
            })}
          </div>
        </section>
      ) : null}

      {st.volumes.length ? (
        <section aria-label="Volumes">
          <h3 className="hz-label app-storage-head">Volumes</h3>
          <div className="app-bars">
            {st.volumes.map((v) => (
              <UsageBar
                key={v.mount}
                label={`${v.mount} (${v.fs})`}
                value={v.totalBytes > 0 ? (v.usedBytes / v.totalBytes) * 100 : 0}
                detail={formatBytesOf(v.usedBytes, v.totalBytes)}
                warnAt={80}
                critAt={90}
              />
            ))}
          </div>
        </section>
      ) : null}

      {st.disks.length ? (
        <section aria-label="Festplatten">
          <h3 className="hz-label app-storage-head">Festplatten</h3>
          <div className="app-rows">
            {st.disks.map((d) => {
              const v = diskView(d);
              return (
                <ServiceRow
                  key={d.name}
                  name={v.title}
                  host={`${v.label} · ${v.sub}`}
                  status={v.status}
                  meta={v.meta}
                />
              );
            })}
          </div>
        </section>
      ) : null}

      {hint ? <p className="app-text">{hint}</p> : null}
    </Tile>
  );
}
