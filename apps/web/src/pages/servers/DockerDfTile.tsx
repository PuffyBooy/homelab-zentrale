import type { DockerDfResponse } from '@hz/shared';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { Button, Tile } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { errorText } from '../../lib/errors.js';
import { formatBytes, formatNumber } from '../../lib/format.js';
import { dockerDfKey, fetchDockerDf } from '../../lib/serverAdmin.js';

/** "Docker-Belegung" (ROADMAP M16): images, containers, volumes and build cache with the unused part. */
export function DockerDfTile({
  serverId,
  offline,
}: {
  serverId: string;
  offline: boolean;
}): ReactElement {
  const q = useQuery({
    queryKey: dockerDfKey(serverId),
    queryFn: ({ signal }) => fetchDockerDf(serverId, signal),
    enabled: !offline,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return (
    <DockerDfView
      data={q.data}
      offline={offline}
      loading={q.isFetching}
      error={q.error ? errorText(q.error) : null}
      onRefresh={() => void q.refetch()}
    />
  );
}

const n0 = (v: number): string => formatNumber(v, 0);

export function DockerDfView({
  data,
  offline,
  loading,
  error,
  onRefresh,
}: {
  data: DockerDfResponse | undefined;
  offline: boolean;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}): ReactElement {
  const total = data
    ? data.images.bytes + data.containers.bytes + data.volumes.bytes + data.buildCache.bytes
    : 0;
  const unused = data
    ? data.images.unusedBytes + data.volumes.unusedBytes + data.buildCache.unusedBytes
    : 0;
  return (
    <Tile
      title="Docker-Belegung"
      icon="container"
      span={2}
      count={data ? formatBytes(total) : undefined}
      actions={
        <Button
          size="sm"
          variant="ghost"
          icon="refresh"
          aria-label="Docker-Belegung neu laden"
          disabled={offline || loading}
          onClick={onRefresh}
        />
      }
      footer={
        <span className="app-foot-text">
          Aufräumen entfernt ungenutzte Images und den Build-Cache. Container und Volumes bleiben.
        </span>
      }
    >
      {offline ? (
        <p className="app-empty">Agent offline.</p>
      ) : error ? (
        <FormError title={error} />
      ) : !data ? (
        <p className="app-empty" role="status">
          Lade Docker-Belegung …
        </p>
      ) : (
        <table className="app-table app-df" aria-label="Docker-Belegung">
          <thead>
            <tr>
              <th scope="col">Art</th>
              <th scope="col">Belegt</th>
              <th scope="col">Ungenutzt</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">
                Images
                <small>
                  {n0(data.images.count)} · {n0(data.images.unusedCount)} ungenutzt
                </small>
              </th>
              <td>{formatBytes(data.images.bytes)}</td>
              <td>{formatBytes(data.images.unusedBytes)}</td>
            </tr>
            <tr>
              <th scope="row">
                Container
                <small>
                  {n0(data.containers.count)} · {n0(data.containers.running)} laufen
                </small>
              </th>
              <td>{formatBytes(data.containers.bytes)}</td>
              <td>—</td>
            </tr>
            <tr>
              <th scope="row">
                Volumes
                <small>
                  {n0(data.volumes.count)} · {n0(data.volumes.unusedCount)} ungenutzt
                </small>
              </th>
              <td>{formatBytes(data.volumes.bytes)}</td>
              <td>{formatBytes(data.volumes.unusedBytes)}</td>
            </tr>
            <tr>
              <th scope="row">
                Build-Cache
                <small>{n0(data.buildCache.count)} Einträge</small>
              </th>
              <td>{formatBytes(data.buildCache.bytes)}</td>
              <td>{formatBytes(data.buildCache.unusedBytes)}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Summe</th>
              <td>{formatBytes(total)}</td>
              <td>{formatBytes(unused)}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </Tile>
  );
}
