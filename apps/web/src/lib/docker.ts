import {
  containerDetailsResponseSchema,
  dockerImageListResponseSchema,
  dockerNetworkListResponseSchema,
  dockerVolumeListResponseSchema,
  imagePullRefSchema,
  imagePullResponseSchema,
  okResponseSchema,
  stackActionResponseSchema,
  type ContainerDetailsData,
  type ContainerSummary,
  type DockerImage,
  type DockerNetwork,
  type DockerVolume,
  type MountInfo,
  type ServerSummary,
  type StackAction,
} from '@hz/shared';
import { api, isApiError } from './api.js';
import { errorText } from './errors.js';
import { formatBytes, formatNumber, plural } from './format.js';

/**
 * M23 Docker komplett (SPEC 6.1b, packages/shared api/docker.ts): container details,
 * removal, stack operations, images, volumes and networks per server, plus the pure
 * helpers the views use (unit tested). Step-up comes from lib/api on
 * `step_up_required`; typed names are checked by the core again.
 */

const ctr = (id: string): string => `/api/containers/${encodeURIComponent(id)}`;
const srv = (id: string): string => `/api/servers/${encodeURIComponent(id)}`;

export const containerDetailsKey = (id: string) => ['containers', id, 'details'] as const;
export const dockerImagesKey = (serverId: string) => ['docker', serverId, 'images'] as const;
export const dockerVolumesKey = (serverId: string) => ['docker', serverId, 'volumes'] as const;
export const dockerNetworksKey = (serverId: string) => ['docker', serverId, 'networks'] as const;

export async function fetchContainerDetails(
  id: string,
  signal?: AbortSignal,
): Promise<ContainerDetailsData> {
  const res = await api(`${ctr(id)}/details`, { schema: containerDetailsResponseSchema, signal });
  return res.details;
}

/** POST /api/containers/:id/remove (step-up, typed name). */
export async function removeContainer(
  id: string,
  confirmName: string,
  removeVolumes: boolean,
): Promise<void> {
  await api(`${ctr(id)}/remove`, {
    method: 'POST',
    body: { confirmName, removeVolumes },
    schema: okResponseSchema,
  });
}

/** POST /api/servers/:serverId/stacks/:project/:op; down needs the typed project name. */
export async function runStackAction(
  serverId: string,
  project: string,
  op: StackAction,
  confirmName?: string,
): Promise<ContainerSummary[]> {
  const res = await api(`${srv(serverId)}/stacks/${encodeURIComponent(project)}/${op}`, {
    method: 'POST',
    body: confirmName === undefined ? {} : { confirmName },
    schema: stackActionResponseSchema,
  });
  return res.containers;
}

export async function fetchImages(serverId: string, signal?: AbortSignal): Promise<DockerImage[]> {
  const res = await api(`${srv(serverId)}/docker/images`, {
    schema: dockerImageListResponseSchema,
    signal,
  });
  return res.images;
}

export async function pullImage(
  serverId: string,
  ref: string,
): Promise<{ id: string; tags: string[] }> {
  const res = await api(`${srv(serverId)}/docker/images/pull`, {
    method: 'POST',
    body: { ref },
    schema: imagePullResponseSchema,
  });
  return res.image;
}

/** The route takes the 64 hex digits without "sha256:". */
export function imageHex(id: string): string {
  return id.startsWith('sha256:') ? id.slice(7) : id;
}

export async function removeImage(serverId: string, imageId: string): Promise<void> {
  await api(`${srv(serverId)}/docker/images/${imageHex(imageId)}/remove`, {
    method: 'POST',
    body: {},
    schema: okResponseSchema,
  });
}

export async function fetchVolumes(
  serverId: string,
  signal?: AbortSignal,
): Promise<DockerVolume[]> {
  const res = await api(`${srv(serverId)}/docker/volumes`, {
    schema: dockerVolumeListResponseSchema,
    signal,
  });
  return res.volumes;
}

/** POST /api/servers/:serverId/docker/volumes/:name/remove (step-up, typed name). */
export async function removeVolume(serverId: string, name: string): Promise<void> {
  await api(`${srv(serverId)}/docker/volumes/${encodeURIComponent(name)}/remove`, {
    method: 'POST',
    body: { confirmName: name },
    schema: okResponseSchema,
  });
}

export async function fetchNetworks(
  serverId: string,
  signal?: AbortSignal,
): Promise<DockerNetwork[]> {
  const res = await api(`${srv(serverId)}/docker/networks`, {
    schema: dockerNetworkListResponseSchema,
    signal,
  });
  return res.networks;
}

export async function removeNetwork(serverId: string, networkId: string): Promise<void> {
  await api(`${srv(serverId)}/docker/networks/${encodeURIComponent(networkId)}/remove`, {
    method: 'POST',
    body: {},
    schema: okResponseSchema,
  });
}

// ---------------------------------------------------------------------------
// Presentation helpers (pure, unit tested)

/** Client-side check of "Image ziehen"; null when the reference is fine. */
export function pullRefError(ref: string): string | null {
  const v = ref.trim();
  if (!v) return 'Image-Referenz fehlt, z. B. nginx:1.27.';
  return imagePullRefSchema.safeParse(v).success
    ? null
    : 'Ungültige Referenz. Form: [registry/]name[:tag], klein geschrieben, ohne https://.';
}

/** Error text for the M23 routes: old agents and the refusals of the core first. */
export function dockerErrorText(err: unknown): string {
  if (isApiError(err, 'agent_outdated')) return 'Agent zu alt, bitte aktualisieren.';
  if (isApiError(err, 'forbidden')) {
    return 'Geschützt: Zentrale, Agent und Updater werden nie verändert.';
  }
  if (isApiError(err, 'confirm_mismatch')) return 'Name stimmt nicht. Genau so eintippen.';
  if (isApiError(err, 'busy'))
    return 'Noch in Benutzung. Erst den Container stoppen oder entfernen.';
  return errorText(err);
}

export type GuardedContainer = Pick<
  ContainerSummary,
  'state' | 'protected' | 'game' | 'gameId' | 'name'
>;

export function isGameContainer(c: Pick<ContainerSummary, 'game' | 'gameId'>): boolean {
  return c.game != null || c.gameId != null;
}

/** Why "Entfernen" is not offered; null when it is. */
export function removeBlocked(c: GuardedContainer): string | null {
  if (c.protected) return 'geschützt';
  if (isGameContainer(c)) return 'über die Gameserver-Seite';
  if (c.state === 'running' || c.state === 'restarting' || c.state === 'paused') return 'läuft';
  if (c.state === 'removing') return 'wird schon entfernt';
  return null;
}

/** "Shell" only for a running, unprotected container on a server with the terminal on. */
export function shellAllowed(
  c: Pick<ContainerSummary, 'state' | 'protected'>,
  server: Pick<ServerSummary, 'allowTerminal' | 'connected'> | undefined,
): boolean {
  return (
    !!server && server.allowTerminal && server.connected && c.state === 'running' && !c.protected
  );
}

/** /console with server and container preselected. */
export function shellHref(c: Pick<ContainerSummary, 'serverId' | 'id'>): string {
  return `/console?server=${encodeURIComponent(c.serverId)}&container=${encodeURIComponent(c.id)}`;
}

/** Why the stack actions of a compose project are not offered; null when they are. */
export function stackBlocked(list: readonly GuardedContainer[]): string | null {
  if (list.some((c) => c.protected)) return 'enthält Zentrale oder Agent, nur einzeln steuerbar';
  if (list.some(isGameContainer)) return 'Gameserver, über die Gameserver-Seite';
  return null;
}

export const STACK_LABEL: Record<StackAction, string> = {
  start: 'Start',
  stop: 'Stopp',
  restart: 'Neustart',
  update: 'Aktualisieren',
  down: 'Entfernen',
};

export const STACK_PENDING: Record<StackAction, string> = {
  start: 'startet …',
  stop: 'stoppt …',
  restart: 'startet neu …',
  update: 'zieht Images und startet neu …',
  down: 'wird entfernt …',
};

export const STACK_DONE: Record<StackAction, string> = {
  start: 'gestartet',
  stop: 'gestoppt',
  restart: 'neu gestartet',
  update: 'aktualisiert',
  down: 'entfernt, Volumes bleiben erhalten',
};

/**
 * Replaces the project's containers in the cached list with the ones the core
 * returned after the operation (after down: none).
 */
export function mergeStack(
  old: readonly ContainerSummary[],
  serverId: string,
  project: string,
  next: readonly ContainerSummary[],
): ContainerSummary[] {
  const rest = old.filter((c) => !(c.serverId === serverId && c.composeProject === project));
  return [...rest, ...next];
}

const RESTART_POLICY: Record<string, string> = {
  no: 'keine',
  '': 'keine',
  always: 'immer',
  'unless-stopped': 'immer, außer gestoppt',
  'on-failure': 'bei Fehler',
};

export function restartPolicyText(p: string): string {
  return RESTART_POLICY[p] ?? p;
}

export function mountText(m: MountInfo): string {
  const src = m.type === 'tmpfs' ? 'tmpfs' : m.source || m.type;
  return `${src} → ${m.destination}`;
}

export function portText(p: ContainerDetailsData['ports'][number]): string {
  const proto = p.protocol === 'tcp' ? '' : `/${p.protocol}`;
  if (p.publicPort == null) return `${p.privatePort}${proto} (nicht veröffentlicht)`;
  const ip = p.ip && p.ip !== '0.0.0.0' && p.ip !== '::' ? p.ip : '';
  return `${ip}:${p.publicPort} → ${p.privatePort}${proto}`;
}

/** "RAM 312 MB von 1 GB" or "RAM 312 MB · ohne Limit". */
export function memText(s: NonNullable<ContainerDetailsData['stats']>): string {
  return s.memLimitBytes == null
    ? `${formatBytes(s.memBytes)} · ohne Limit`
    : `${formatBytes(s.memBytes)} von ${formatBytes(s.memLimitBytes)}`;
}

export function cpuText(pct: number): string {
  return `${formatNumber(pct, pct < 10 ? 1 : 0)} %`;
}

/** Image name of a row: the first tag, or the short id for dangling images. */
export function imageName(i: Pick<DockerImage, 'id' | 'tags'>): string {
  return i.tags[0] ?? `<ohne Tag> ${imageHex(i.id).slice(0, 12)}`;
}

/** Why an image cannot be removed; null when it can. */
export function imageRemoveBlocked(
  i: Pick<DockerImage, 'protected' | 'containers'>,
): string | null {
  if (i.protected) return 'geschützt';
  if (i.containers > 0) return `benutzt von ${plural(i.containers, 'Container', 'Containern')}`;
  return null;
}

export function volumeRemoveBlocked(
  v: Pick<DockerVolume, 'protected' | 'containers'>,
): string | null {
  if (v.protected) return 'geschützt';
  if (v.containers.length > 0) {
    return `benutzt von ${plural(v.containers.length, 'Container', 'Containern')}`;
  }
  return null;
}

export function networkRemoveBlocked(
  n: Pick<DockerNetwork, 'builtin' | 'protected' | 'containers'>,
): string | null {
  if (n.builtin) return 'eingebaut';
  if (n.protected) return 'geschützt';
  if (n.containers.length > 0) {
    return `benutzt von ${plural(n.containers.length, 'Container', 'Containern')}`;
  }
  return null;
}

/** By name, dangling images at the end. */
export function sortImages(list: readonly DockerImage[]): DockerImage[] {
  return [...list].sort(
    (a, b) =>
      Number(a.dangling) - Number(b.dangling) || imageName(a).localeCompare(imageName(b), 'de-AT'),
  );
}

export function sortByName<T extends { name: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name, 'de-AT'));
}

/** Server for the Docker resources: the filter, else the first connected one, else the first. */
export function pickDockerServer(
  servers: readonly Pick<ServerSummary, 'id' | 'connected'>[],
  wanted: string | null,
): string | null {
  if (wanted && servers.some((s) => s.id === wanted)) return wanted;
  return servers.find((s) => s.connected)?.id ?? servers[0]?.id ?? null;
}
