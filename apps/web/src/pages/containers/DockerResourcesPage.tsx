import type { DockerImage, DockerNetwork, DockerVolume, ServerSummary } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import { Alert, Badge, Button, StatusDot, Tile } from '@hz/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { NameConfirmDialog } from '../../components/NameConfirmDialog.js';
import { SelectField } from '../../components/SelectField.js';
import { useServerFilter, useServers } from '../../lib/data.js';
import {
  dockerErrorText,
  dockerImagesKey,
  dockerNetworksKey,
  dockerVolumesKey,
  fetchImages,
  fetchNetworks,
  fetchVolumes,
  imageName,
  imageRemoveBlocked,
  networkRemoveBlocked,
  pickDockerServer,
  pullImage,
  pullRefError,
  removeImage,
  removeNetwork,
  removeVolume,
  sortByName,
  sortImages,
  volumeRemoveBlocked,
} from '../../lib/docker.js';
import { formatAgo, formatBytes, formatTime, plural } from '../../lib/format.js';
import { useNow } from '../../lib/useNow.js';
import { NoServers } from '../servers/ServerListTile.js';
import { ContainersNav } from './ContainersNav.js';

/** /containers/docker (SPEC 6.1b): images, volumes and networks of one server. */
export function DockerResourcesPage(): ReactElement | null {
  const servers = useServers();
  const [filter, setFilter] = useServerFilter();
  if (!servers.data) return null;
  if (servers.data.length === 0) return <NoServers />;
  const serverId = pickDockerServer(servers.data, filter);
  const server = servers.data.find((s) => s.id === serverId);
  if (!server) return null;
  return (
    <div className="hz-grid app-grid">
      <div className="hz-span-4">
        <ContainersNav />
        <div className="app-docker-pick">
          <SelectField
            label="Server"
            value={server.id}
            onChange={(e) => setFilter(e.target.value)}
            options={sortByName(servers.data).map((s) => ({
              value: s.id,
              label: s.connected ? s.name : `${s.name} (offline)`,
            }))}
          />
        </div>
      </div>
      {server.connected ? null : (
        <div className="hz-span-4">
          <Alert tone="warn" title={`${server.name}: Agent offline.`}>
            Images, Volumes und Netzwerke kommen wieder, sobald sich der Server meldet.
          </Alert>
        </div>
      )}
      <ImagesTile server={server} />
      <VolumesTile server={server} />
      <NetworksTile server={server} />
    </div>
  );
}

interface ServerProp {
  server: ServerSummary;
}

function Loading({ what }: { what: string }): ReactElement {
  return (
    <p className="app-empty app-pad" aria-live="polite">
      <StatusDot status="busy" label={`Lade ${what} vom Agent …`} />
    </p>
  );
}

function ListError({ err }: { err: unknown }): ReactElement {
  return (
    <div className="app-pad">
      <FormError title={dockerErrorText(err)} />
    </div>
  );
}

function stand(updatedAt: number): ReactNode {
  return updatedAt ? (
    <span className="app-foot-text">Stand {formatTime(new Date(updatedAt))}</span>
  ) : null;
}

// ---------------------------------------------------------------------------
// Images

function ImagesTile({ server }: ServerProp): ReactElement {
  const q = useQuery({
    queryKey: dockerImagesKey(server.id),
    queryFn: ({ signal }) => fetchImages(server.id, signal),
    enabled: server.connected,
    retry: false,
  });
  const [remove, setRemove] = useState<DockerImage | null>(null);
  const list = q.data ? sortImages(q.data) : [];
  const total = list.reduce((s, i) => s + i.sizeBytes, 0);
  return (
    <Tile
      title="Images"
      icon="cloud"
      count={q.data ? `${list.length} · ${formatBytes(total)}` : undefined}
      span={4}
      flush
      footer={stand(q.dataUpdatedAt)}
    >
      <PullForm server={server} />
      {q.isLoading ? <Loading what="Images" /> : null}
      {q.error ? <ListError err={q.error} /> : null}
      {q.data && !list.length ? <p className="app-empty app-pad">Keine Images.</p> : null}
      {list.length ? (
        <ul className="app-rows" aria-label={`Images auf ${server.name}`}>
          {list.map((i) => (
            <ImageRow key={i.id} i={i} offline={!server.connected} onRemove={() => setRemove(i)} />
          ))}
        </ul>
      ) : null}
      {remove ? (
        <RemoveImageDialog server={server} image={remove} onClose={() => setRemove(null)} />
      ) : null}
    </Tile>
  );
}

export function ImageRow({
  i,
  offline,
  onRemove,
}: {
  i: DockerImage;
  offline: boolean;
  onRemove: () => void;
}): ReactElement {
  const now = useNow(60_000);
  const blocked = imageRemoveBlocked(i);
  const name = imageName(i);
  const users = i.containers
    ? `benutzt von ${plural(i.containers, 'Container', 'Containern')}`
    : 'unbenutzt';
  return (
    <li className="hz-row" data-testid="docker-image">
      <div className="hz-row-main">
        <span className="hz-row-name">
          <span className="hz-mono app-break">{name}</span>
          {i.dangling ? <Badge tone="warn">ohne Tag</Badge> : null}
          {i.protected ? <Badge icon="lock">geschützt</Badge> : null}
        </span>
        <span className="hz-row-sub">
          {i.tags.length > 1 ? `${i.tags.slice(1).join(', ')} · ` : ''}
          erstellt {formatAgo(new Date(i.createdAt), now)} · {users}
        </span>
      </div>
      <span className="hz-row-meta">{formatBytes(i.sizeBytes)}</span>
      <div className="hz-row-actions">
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Image ${name} entfernen`}
          title={blocked ? `Nicht möglich: ${blocked}` : undefined}
          disabled={offline || blocked !== null}
          onClick={onRemove}
        >
          Entfernen
        </Button>
      </div>
    </li>
  );
}

function PullForm({ server }: ServerProp): ReactElement {
  const qc = useQueryClient();
  const [ref, setRef] = useState('');
  const [touched, setTouched] = useState(false);
  const pull = useMutation({
    mutationFn: (r: string) => pullImage(server.id, r),
    onSuccess: () => {
      setRef('');
      setTouched(false);
      void qc.invalidateQueries({ queryKey: dockerImagesKey(server.id) });
    },
  });
  const invalid = pullRefError(ref);

  function submit(e: FormEvent): void {
    e.preventDefault();
    setTouched(true);
    if (invalid || pull.isPending) return;
    pull.mutate(ref.trim());
  }

  return (
    <form className="app-pad app-docker-pull" onSubmit={submit} noValidate>
      <Field
        label="Image ziehen"
        mono
        value={ref}
        onChange={(e) => {
          setRef(e.target.value);
          pull.reset();
        }}
        placeholder="nginx:1.27"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        disabled={!server.connected || pull.isPending}
        error={touched ? invalid : null}
        hint="Öffentliche Registries, ohne Anmeldung. Kann bei großen Images ein paar Minuten dauern."
      />
      <Button
        type="submit"
        variant="primary"
        icon="cloud"
        disabled={!server.connected || pull.isPending}
      >
        {pull.isPending ? 'Zieht …' : 'Ziehen'}
      </Button>
      <div className="app-docker-pull-state" aria-live="polite">
        {pull.isSuccess ? (
          <StatusDot status="ok" label={`${pull.data.tags[0] ?? 'Image'} gezogen.`} pulse={false} />
        ) : null}
        {pull.error ? <FormError title={dockerErrorText(pull.error)} /> : null}
      </div>
    </form>
  );
}

function RemoveImageDialog({
  server,
  image,
  onClose,
}: ServerProp & { image: DockerImage; onClose: () => void }): ReactElement {
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: () => removeImage(server.id, image.id),
    onSuccess: () => {
      qc.setQueryData<DockerImage[]>(dockerImagesKey(server.id), (old) =>
        old ? old.filter((x) => x.id !== image.id) : old,
      );
      onClose();
    },
  });
  return (
    <ConfirmDialog
      title={`Image ${imageName(image)} entfernen?`}
      action="Entfernen"
      busy={run.isPending}
      error={run.error}
      errorTextOf={dockerErrorText}
      onConfirm={() => run.mutate()}
      onClose={onClose}
    >
      Gibt {formatBytes(image.sizeBytes)} auf {server.name} frei (docker rmi, ohne force). Wird es
      später gebraucht, zieht Docker es neu.
    </ConfirmDialog>
  );
}

// ---------------------------------------------------------------------------
// Volumes

function VolumesTile({ server }: ServerProp): ReactElement {
  const q = useQuery({
    queryKey: dockerVolumesKey(server.id),
    queryFn: ({ signal }) => fetchVolumes(server.id, signal),
    enabled: server.connected,
    retry: false,
  });
  const [remove, setRemove] = useState<DockerVolume | null>(null);
  const list = q.data ? sortByName(q.data) : [];
  const total = list.reduce((s, v) => s + (v.sizeBytes ?? 0), 0);
  return (
    <Tile
      title="Volumes"
      icon="lock"
      count={q.data ? `${list.length} · ${formatBytes(total)}` : undefined}
      span={2}
      flush
      footer={stand(q.dataUpdatedAt)}
    >
      {q.isLoading ? <Loading what="Volumes" /> : null}
      {q.error ? <ListError err={q.error} /> : null}
      {q.data && !list.length ? <p className="app-empty app-pad">Keine Volumes.</p> : null}
      {list.length ? (
        <ul className="app-rows" aria-label={`Volumes auf ${server.name}`}>
          {list.map((v) => (
            <VolumeRow
              key={v.name}
              v={v}
              offline={!server.connected}
              onRemove={() => setRemove(v)}
            />
          ))}
        </ul>
      ) : null}
      {remove ? (
        <RemoveVolumeDialog server={server} volume={remove} onClose={() => setRemove(null)} />
      ) : null}
    </Tile>
  );
}

export function VolumeRow({
  v,
  offline,
  onRemove,
}: {
  v: DockerVolume;
  offline: boolean;
  onRemove: () => void;
}): ReactElement {
  const blocked = volumeRemoveBlocked(v);
  const users = v.containers.length ? v.containers.join(', ') : 'unbenutzt';
  return (
    <li className="hz-row" data-testid="docker-volume">
      <div className="hz-row-main">
        <span className="hz-row-name">
          <span className="hz-mono app-break">{v.name}</span>
          {v.protected ? <Badge icon="lock">geschützt</Badge> : null}
        </span>
        <span className="hz-row-sub">
          {v.composeProject ? `compose · ${v.composeProject} · ` : ''}
          {users}
        </span>
      </div>
      <span className="hz-row-meta">{v.sizeBytes == null ? '—' : formatBytes(v.sizeBytes)}</span>
      {blocked ? null : (
        <div className="hz-row-actions">
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Volume ${v.name} entfernen`}
            disabled={offline}
            onClick={onRemove}
          >
            Entfernen
          </Button>
        </div>
      )}
    </li>
  );
}

function RemoveVolumeDialog({
  server,
  volume,
  onClose,
}: ServerProp & { volume: DockerVolume; onClose: () => void }): ReactElement {
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: () => removeVolume(server.id, volume.name),
    onSuccess: () => {
      qc.setQueryData<DockerVolume[]>(dockerVolumesKey(server.id), (old) =>
        old ? old.filter((x) => x.name !== volume.name) : old,
      );
    },
  });
  return (
    <NameConfirmDialog
      title={`Volume ${volume.name} entfernen`}
      name={volume.name}
      label="Volume-Name"
      action="Entfernen"
      busy={run.isPending}
      error={run.error}
      errorTextOf={dockerErrorText}
      done={run.isSuccess ? `Volume ${volume.name} ist entfernt.` : null}
      onConfirm={() => run.mutate()}
      onClose={onClose}
    >
      Löscht das Volume {volume.name} auf {server.name} mit allen Daten darin
      {volume.sizeBytes == null ? '' : ` (${formatBytes(volume.sizeBytes)})`}. Das lässt sich nicht
      rückgängig machen. Zum Bestätigen den Namen eintippen, danach fragt die Zentrale nach dem Code
      aus der App.
    </NameConfirmDialog>
  );
}

// ---------------------------------------------------------------------------
// Networks

function NetworksTile({ server }: ServerProp): ReactElement {
  const q = useQuery({
    queryKey: dockerNetworksKey(server.id),
    queryFn: ({ signal }) => fetchNetworks(server.id, signal),
    enabled: server.connected,
    retry: false,
  });
  const [remove, setRemove] = useState<DockerNetwork | null>(null);
  const list = q.data ? sortByName(q.data) : [];
  return (
    <Tile
      title="Netzwerke"
      icon="wifi"
      count={q.data ? list.length : undefined}
      span={2}
      flush
      footer={stand(q.dataUpdatedAt)}
    >
      {q.isLoading ? <Loading what="Netzwerke" /> : null}
      {q.error ? <ListError err={q.error} /> : null}
      {list.length ? (
        <ul className="app-rows" aria-label={`Netzwerke auf ${server.name}`}>
          {list.map((n) => (
            <NetworkRow
              key={n.id}
              n={n}
              offline={!server.connected}
              onRemove={() => setRemove(n)}
            />
          ))}
        </ul>
      ) : null}
      {remove ? (
        <RemoveNetworkDialog server={server} network={remove} onClose={() => setRemove(null)} />
      ) : null}
    </Tile>
  );
}

export function NetworkRow({
  n,
  offline,
  onRemove,
}: {
  n: DockerNetwork;
  offline: boolean;
  onRemove: () => void;
}): ReactElement {
  const blocked = networkRemoveBlocked(n);
  const users = n.containers.length ? n.containers.join(', ') : 'keine Container';
  return (
    <li className="hz-row" data-testid="docker-network">
      <div className="hz-row-main">
        <span className="hz-row-name">
          <span className="hz-mono app-break">{n.name}</span>
          {n.builtin ? <Badge>eingebaut</Badge> : null}
          {n.protected ? <Badge icon="lock">geschützt</Badge> : null}
          {n.internal ? <Badge tone="info">intern</Badge> : null}
        </span>
        <span className="hz-row-sub">
          {n.driver} · {n.scope} · {users}
        </span>
      </div>
      <div className="hz-row-actions">
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Netzwerk ${n.name} entfernen`}
          title={blocked ? `Nicht möglich: ${blocked}` : undefined}
          disabled={offline || blocked !== null}
          onClick={onRemove}
        >
          Entfernen
        </Button>
      </div>
    </li>
  );
}

function RemoveNetworkDialog({
  server,
  network,
  onClose,
}: ServerProp & { network: DockerNetwork; onClose: () => void }): ReactElement {
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: () => removeNetwork(server.id, network.id),
    onSuccess: () => {
      qc.setQueryData<DockerNetwork[]>(dockerNetworksKey(server.id), (old) =>
        old ? old.filter((x) => x.id !== network.id) : old,
      );
      onClose();
    },
  });
  return (
    <ConfirmDialog
      title={`Netzwerk ${network.name} entfernen?`}
      action="Entfernen"
      busy={run.isPending}
      error={run.error}
      errorTextOf={dockerErrorText}
      onConfirm={() => run.mutate()}
      onClose={onClose}
    >
      Entfernt das Netzwerk {network.name} ({network.driver}) auf {server.name}. Kein Container
      hängt daran.
    </ConfirmDialog>
  );
}
