import type { DuResponse } from '@hz/shared';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { BlockBar, Button, StatusDot, Tile } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { formatBytes, formatPercent } from '../../lib/format.js';
import {
  DU_PATH_MAX,
  duBlocked,
  duErrorText,
  duKey,
  fetchDu,
  joinPath,
  pathCrumbs,
  pctOfTotal,
} from '../../lib/serverAdmin.js';

/**
 * "Größte Ordner" (ROADMAP M16): du -x -d1 from `/`, click a folder to go deeper.
 * Measuring reads the whole tree and can take up to a minute (and would wake sleeping
 * NAS disks), so it only starts on request; each folder click measures that folder.
 */
export function DuTile({
  serverId,
  offline,
}: {
  serverId: string;
  offline: boolean;
}): ReactElement {
  const [path, setPath] = useState('/');
  const [started, setStarted] = useState(false);
  const q = useQuery({
    queryKey: duKey(serverId, path),
    queryFn: ({ signal }) => fetchDu(serverId, path, signal),
    enabled: started && !offline,
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return (
    <div className="hz-span-2 app-anchor" id="speicher">
      <DuView
        path={path}
        started={started}
        offline={offline}
        loading={q.isFetching}
        data={q.data?.path === path ? q.data : undefined}
        error={q.error ? duErrorText(q.error) : null}
        onStart={() => setStarted(true)}
        onOpen={(p) => {
          setStarted(true);
          setPath(p);
        }}
        onRetry={() => void q.refetch()}
      />
    </div>
  );
}

export function DuView({
  path,
  started,
  offline,
  loading,
  data,
  error,
  onStart,
  onOpen,
  onRetry,
}: {
  path: string;
  started: boolean;
  offline: boolean;
  loading: boolean;
  data: DuResponse | undefined;
  error: string | null;
  onStart: () => void;
  onOpen: (path: string) => void;
  onRetry: () => void;
}): ReactElement {
  const crumbs = pathCrumbs(path);
  return (
    <Tile
      title="Größte Ordner"
      icon="server"
      span={2}
      count={data ? formatBytes(data.totalBytes) : undefined}
      footer={
        <span className="app-foot-text">
          Nur lesend, bleibt auf einem Dateisystem. /proc, /sys, /dev und /run nie.
        </span>
      }
    >
      <nav className="app-crumbs" aria-label="Pfad">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <span key={c.path} className="app-crumb">
              {i > 1 ? (
                <span className="app-crumb-sep" aria-hidden="true">
                  /
                </span>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                aria-current={last ? 'location' : undefined}
                disabled={offline || (last && !error && (!started || loading))}
                onClick={() => (last ? onRetry() : onOpen(c.path))}
                aria-label={last ? `${c.path} neu messen` : `Zurück zu ${c.path}`}
              >
                {c.label}
              </Button>
            </span>
          );
        })}
      </nav>

      {offline ? (
        <p className="app-empty">Agent offline. Messen geht wieder, sobald er sich meldet.</p>
      ) : !started ? (
        <div className="app-actions">
          <Button icon="refresh" onClick={onStart}>
            Ab / messen
          </Button>
          <span className="app-text">Liest alle Ordner, das kann bis zu 1 Min dauern.</span>
        </div>
      ) : loading && !data ? (
        <p className="app-empty" role="status">
          <StatusDot status="busy" label={`Misst ${path} …`} /> Das kann bis zu 1 Min dauern.
        </p>
      ) : error ? (
        <div className="app-stack">
          <FormError title={error} />
          <div className="app-actions">
            <Button size="sm" onClick={onRetry}>
              Erneut messen
            </Button>
          </div>
        </div>
      ) : data ? (
        <DuList data={data} onOpen={onOpen} />
      ) : null}
    </Tile>
  );
}

function DuList({
  data,
  onOpen,
}: {
  data: DuResponse;
  onOpen: (path: string) => void;
}): ReactElement {
  if (!data.entries.length) return <p className="app-empty">{data.path} ist leer.</p>;
  const tooLong = data.entries.some(
    (e) => e.dir && duBlocked(joinPath(data.path, e.name)) === 'too_long',
  );
  return (
    <>
      <ul className="app-du" aria-label={`Ordner in ${data.path}`}>
        {data.entries.map((e) => {
          const p = pctOfTotal(e.bytes, data.totalBytes);
          const target = joinPath(data.path, e.name);
          const open = e.dir && duBlocked(target) === null;
          return (
            <li key={e.name} className="hz-usage app-du-row">
              {open ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="app-du-name"
                  aria-label={`${target} öffnen`}
                  onClick={() => onOpen(target)}
                >
                  {`${e.name}/`}
                </Button>
              ) : (
                <span className="app-du-name app-du-file">{e.dir ? `${e.name}/` : e.name}</span>
              )}
              <BlockBar value={p} cells={20} warnAt={101} critAt={101} label={target} />
              <span className="hz-usage-val">
                {formatBytes(e.bytes)} · {formatPercent(p)}
              </span>
            </li>
          );
        })}
      </ul>
      {tooLong ? (
        <p className="app-text">
          Pfad länger als {DU_PATH_MAX} Zeichen. Tiefer geht es hier nicht, diese Ordner misst die
          Zentrale nicht einzeln.
        </p>
      ) : null}
      {data.truncated ? (
        <p className="app-text">
          Mehr Einträge als gezeigt oder Zeitlimit erreicht. Die Größen sind Untergrenzen.
        </p>
      ) : null}
    </>
  );
}
