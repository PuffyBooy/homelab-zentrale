import {
  BUILTIN_NETWORKS,
  dockerImagesDataSchema,
  dockerNetworksDataSchema,
  dockerVolumesDataSchema,
  imageIdSchema,
  imagePullDataSchema,
  networkIdSchema,
  volumeNameSchema,
  type DockerImage,
  type DockerImagesData,
  type DockerNetwork,
  type DockerNetworksData,
  type DockerVolume,
  type DockerVolumesData,
  type ImagePullData,
  type RpcParams,
} from '@hz/shared';
import {
  allContainers,
  COMPOSE_PROJECT_LABEL,
  containerName,
  dockerOf,
  isoFromUnix,
  isoOrNull,
  isProtectedListed,
  labelOf,
  mapLimit,
  NOT_ALLOWED_PROTECTED,
  statusOf,
  withTimeout,
  type ListedContainer,
} from './docker-common.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * M23 images, volumes and networks: lists and single removals.
 *
 * - Nothing is forced and nothing is pruned: Docker refuses an image, volume or
 *   network that is still in use, which becomes `busy`.
 * - Whatever a protected container (hz.role agent/core/updater, the agent itself)
 *   uses, in any state, is refused with `not_allowed` before Docker is asked.
 * - image.pull sends no registry credentials.
 */

// ---- images ---------------------------------------------------------------------

interface ImageListEntry {
  Id: string;
  RepoTags?: string[] | null;
  Size?: number;
  Created?: number;
}

interface ImagesDocker {
  listContainers(opts: { all: boolean }): Promise<unknown[]>;
  listImages(opts?: object): Promise<unknown[]>;
  getImage(ref: string): {
    inspect(): Promise<unknown>;
    remove(opts: { force: boolean; noprune: boolean }): Promise<unknown>;
  };
  pull(ref: string, opts?: object): Promise<NodeJS.ReadableStream>;
  modem: {
    followProgress(
      stream: NodeJS.ReadableStream,
      onFinished: (err: Error | null, output: unknown[]) => void,
    ): void;
  };
}

const NONE_TAG = '<none>:<none>';
const realTags = (tags: readonly unknown[] | null | undefined): string[] =>
  (tags ?? [])
    .filter((t): t is string => typeof t === 'string' && t.length > 0 && t !== NONE_TAG)
    .map((t) => t.slice(0, 300))
    .slice(0, 50);
const nonNeg = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;

export function buildImages(images: unknown[], containers: ListedContainer[]): DockerImagesData {
  const users = new Map<string, number>();
  const protectedIds = new Set<string>();
  for (const c of containers) {
    if (!c.ImageID) continue;
    users.set(c.ImageID, (users.get(c.ImageID) ?? 0) + 1);
    if (isProtectedListed(c)) protectedIds.add(c.ImageID);
  }
  const out: DockerImage[] = [];
  for (const raw of images as ImageListEntry[]) {
    if (!imageIdSchema.safeParse(raw?.Id).success) continue;
    const tags = realTags(raw.RepoTags);
    out.push({
      id: raw.Id,
      tags,
      sizeBytes: nonNeg(raw.Size),
      createdAt: isoFromUnix(raw.Created),
      containers: users.get(raw.Id) ?? 0,
      dangling: tags.length === 0,
      protected: protectedIds.has(raw.Id),
    });
    if (out.length >= 2000) break;
  }
  return dockerImagesDataSchema.parse({ images: out });
}

export async function dockerImages(_p: unknown, ctx: ActionContext): Promise<DockerImagesData> {
  const docker = dockerOf<ImagesDocker>(ctx);
  let images: unknown[];
  try {
    images = await docker.listImages({ all: false });
  } catch {
    throw new ActionError('failed', 'listing images failed', false);
  }
  return buildImages(images, await allContainers(docker));
}

export const PULL_TIMEOUT_MS = 15 * 60_000;

/**
 * dockerode's pull splits `repo:tag@digest` at the '@' into fromImage `repo:tag` and
 * tag `sha256:...`, which Docker refuses; a digest wins, so the tag is dropped.
 */
export function pullTarget(ref: string): string {
  const at = ref.indexOf('@');
  if (at < 0) return ref;
  const name = ref.slice(0, at);
  const slash = name.lastIndexOf('/');
  const colon = name.lastIndexOf(':');
  const repo = colon > slash ? name.slice(0, colon) : name;
  return `${repo}${ref.slice(at)}`;
}

class PullError extends Error {
  constructor(readonly notFound: boolean) {
    super('pull failed');
  }
}

const NOT_FOUND_TEXT = /not found|manifest unknown|does not exist|repository .* not found/i;

async function pullAndWait(docker: ImagesDocker, ref: string, timeoutMs: number): Promise<void> {
  // No auth argument: registry credentials are not supported here.
  const stream = await docker.pull(ref, {});
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      (stream as unknown as { destroy?: () => void }).destroy?.();
      reject(new Error('timeout'));
    }, timeoutMs);
    timer.unref?.();
    docker.modem.followProgress(stream, (err, output) => {
      clearTimeout(timer);
      if (err) return reject(new PullError(NOT_FOUND_TEXT.test(err.message)));
      const failed = (output ?? []).find(
        (o): o is { error?: unknown } => typeof o === 'object' && o !== null && 'error' in o,
      );
      if (failed) {
        return reject(new PullError(NOT_FOUND_TEXT.test(String(failed.error ?? ''))));
      }
      resolve();
    });
  });
}

export async function imagePull(
  params: RpcParams<'image.pull'>,
  ctx: ActionContext,
  opts: { timeoutMs?: number } = {},
): Promise<ImagePullData> {
  const docker = dockerOf<ImagesDocker>(ctx);
  const ref = pullTarget(params.ref);
  try {
    await pullAndWait(docker, ref, opts.timeoutMs ?? PULL_TIMEOUT_MS);
  } catch (err) {
    if (statusOf(err) === 404 || (err instanceof PullError && err.notFound)) {
      throw new ActionError('not_found', 'image not found in the registry', false);
    }
    if (err instanceof Error && err.message === 'timeout') {
      throw new ActionError('timeout', 'image pull timed out', false);
    }
    throw new ActionError('failed', 'image pull failed', false);
  }
  let info: { Id?: string; RepoTags?: string[] | null };
  try {
    info = (await docker.getImage(ref).inspect()) as typeof info;
  } catch {
    throw new ActionError('failed', 'pulled image not found locally', false);
  }
  const parsed = imagePullDataSchema.safeParse({ id: info.Id, tags: realTags(info.RepoTags) });
  if (!parsed.success) throw new ActionError('failed', 'unexpected image data', false);
  ctx.log.info('image pulled', { image: ref.slice(0, 300) });
  return parsed.data;
}

export async function imageRemove(
  params: RpcParams<'image.remove'>,
  ctx: ActionContext,
): Promise<null> {
  const docker = dockerOf<ImagesDocker>(ctx);
  const users = (await allContainers(docker)).filter((c) => c.ImageID === params.id);
  if (users.some(isProtectedListed)) throw new ActionError('not_allowed', NOT_ALLOWED_PROTECTED);
  try {
    await docker.getImage(params.id).remove({ force: false, noprune: false });
  } catch (err) {
    const status = statusOf(err);
    if (status === 404) throw new ActionError('not_found', 'image not found', false);
    if (status === 409) {
      throw new ActionError('busy', 'image is in use or tagged in several repositories', false);
    }
    throw new ActionError('failed', 'image remove failed', false);
  }
  ctx.log.info('image removed', { image: params.id });
  return null;
}

// ---- volumes --------------------------------------------------------------------

interface VolumeEntry {
  Name: string;
  Driver?: string;
  CreatedAt?: string;
  Labels?: Record<string, string> | null;
}

interface VolumesDocker {
  listContainers(opts: { all: boolean }): Promise<unknown[]>;
  listVolumes(): Promise<unknown>;
  df(): Promise<unknown>;
  getVolume(name: string): { remove(opts: { force: boolean }): Promise<unknown> };
}

export const DF_TIMEOUT_MS = 20_000;

/** Volume name -> container names (any state) that mount it, and the protected volume names. */
function volumeUsers(containers: ListedContainer[]) {
  const users = new Map<string, string[]>();
  const protectedNames = new Set<string>();
  for (const c of containers) {
    for (const m of c.Mounts ?? []) {
      if (m?.Type !== 'volume' || typeof m.Name !== 'string') continue;
      const list = users.get(m.Name) ?? [];
      list.push(containerName(c));
      users.set(m.Name, list);
      if (isProtectedListed(c)) protectedNames.add(m.Name);
    }
  }
  return { users, protectedNames };
}

export function buildVolumes(
  raw: unknown,
  df: unknown,
  containers: ListedContainer[],
): DockerVolumesData {
  const list = ((raw as { Volumes?: VolumeEntry[] | null } | null)?.Volumes ?? []).filter(
    (v) => typeof v?.Name === 'string',
  );
  const sizes = new Map<string, number>();
  for (const v of (
    df as { Volumes?: { Name?: string; UsageData?: { Size?: number } | null }[] | null } | null
  )?.Volumes ?? []) {
    const size = v?.UsageData?.Size;
    if (
      typeof v?.Name === 'string' &&
      typeof size === 'number' &&
      Number.isFinite(size) &&
      size >= 0
    ) {
      sizes.set(v.Name, size);
    }
  }
  const { users, protectedNames } = volumeUsers(containers);
  const out: DockerVolume[] = [];
  for (const v of list) {
    if (!volumeNameSchema.safeParse(v.Name).success) continue;
    out.push({
      name: v.Name,
      driver: (v.Driver ?? '').slice(0, 100),
      createdAt: isoOrNull(v.CreatedAt),
      sizeBytes: sizes.get(v.Name) ?? null,
      containers: (users.get(v.Name) ?? []).slice(0, 200),
      composeProject: labelOf(v.Labels, COMPOSE_PROJECT_LABEL),
      protected: protectedNames.has(v.Name),
    });
    if (out.length >= 2000) break;
  }
  return dockerVolumesDataSchema.parse({ volumes: out });
}

export async function dockerVolumes(_p: unknown, ctx: ActionContext): Promise<DockerVolumesData> {
  const docker = dockerOf<VolumesDocker>(ctx);
  let raw: unknown;
  try {
    raw = await docker.listVolumes();
  } catch {
    throw new ActionError('failed', 'listing volumes failed', false);
  }
  // Sizes are optional: a slow or failing df only leaves them null.
  const df = await withTimeout(docker.df(), DF_TIMEOUT_MS).catch(() => null);
  return buildVolumes(raw, df, await allContainers(docker));
}

export async function volumeRemove(
  params: RpcParams<'volume.remove'>,
  ctx: ActionContext,
): Promise<null> {
  const docker = dockerOf<VolumesDocker>(ctx);
  const { protectedNames } = volumeUsers(await allContainers(docker));
  if (protectedNames.has(params.name)) throw new ActionError('not_allowed', NOT_ALLOWED_PROTECTED);
  try {
    await docker.getVolume(params.name).remove({ force: false });
  } catch (err) {
    const status = statusOf(err);
    if (status === 404) throw new ActionError('not_found', 'volume not found', false);
    if (status === 409) throw new ActionError('busy', 'volume is in use', false);
    throw new ActionError('failed', 'volume remove failed', false);
  }
  ctx.log.info('volume removed', { volume: params.name });
  return null;
}

// ---- networks -------------------------------------------------------------------

interface NetworkEntry {
  Id: string;
  Name?: string;
  Driver?: string;
  Scope?: string;
  Internal?: boolean;
  Labels?: Record<string, string> | null;
  Containers?: Record<string, { Name?: string } | null> | null;
}

interface NetworksDocker {
  listContainers(opts: { all: boolean }): Promise<unknown[]>;
  listNetworks(): Promise<unknown[]>;
  getNetwork(id: string): { inspect(): Promise<unknown>; remove(): Promise<unknown> };
}

/** At most this many network inspects per docker.networks, 8 at a time. */
export const MAX_NETWORK_INSPECTS = 200;

const builtin = (name: string): boolean => (BUILTIN_NETWORKS as readonly string[]).includes(name);

/** Containers (any state) attached to the network with this id or name. */
function attached(containers: ListedContainer[], id: string, name: string): ListedContainer[] {
  return containers.filter((c) =>
    Object.entries(c.NetworkSettings?.Networks ?? {}).some(
      ([n, e]) => n === name || (e?.NetworkID !== undefined && e.NetworkID === id),
    ),
  );
}

export function buildNetworks(
  networks: NetworkEntry[],
  containers: ListedContainer[],
): DockerNetworksData {
  const out: DockerNetwork[] = [];
  for (const n of networks) {
    if (!networkIdSchema.safeParse(n?.Id).success) continue;
    const name = (n.Name ?? '').slice(0, 256);
    const users = attached(containers, n.Id, name);
    const names = new Set(users.map(containerName));
    const protectedIds = new Set(users.filter(isProtectedListed).map((c) => c.Id));
    for (const [cid, e] of Object.entries(n.Containers ?? {})) {
      if (e?.Name) names.add(e.Name.replace(/^\//, '').slice(0, 256));
      const listed = containers.find((c) => c.Id === cid);
      if (listed && isProtectedListed(listed)) protectedIds.add(cid);
    }
    out.push({
      id: n.Id,
      name,
      driver: (n.Driver ?? '').slice(0, 100),
      scope: (n.Scope ?? '').slice(0, 20),
      builtin: builtin(name),
      internal: n.Internal === true,
      containers: [...names].slice(0, 500),
      composeProject: labelOf(n.Labels, COMPOSE_PROJECT_LABEL),
      protected: protectedIds.size > 0,
    });
    if (out.length >= 1000) break;
  }
  return dockerNetworksDataSchema.parse({ networks: out });
}

export async function dockerNetworks(_p: unknown, ctx: ActionContext): Promise<DockerNetworksData> {
  const docker = dockerOf<NetworksDocker>(ctx);
  let listed: NetworkEntry[];
  try {
    listed = ((await docker.listNetworks()) as NetworkEntry[]).filter(
      (n) => typeof n?.Id === 'string',
    );
  } catch {
    throw new ActionError('failed', 'listing networks failed', false);
  }
  // The list endpoint leaves Containers empty; inspect (bounded) for the attached endpoints.
  const inspected = await mapLimit(listed.slice(0, MAX_NETWORK_INSPECTS), 8, async (n) => {
    try {
      const info = (await docker.getNetwork(n.Id).inspect()) as NetworkEntry;
      return { ...n, Containers: info?.Containers ?? n.Containers ?? null };
    } catch {
      return n;
    }
  });
  const networks = [...inspected, ...listed.slice(MAX_NETWORK_INSPECTS)];
  return buildNetworks(networks, await allContainers(docker));
}

export async function networkRemove(
  params: RpcParams<'network.remove'>,
  ctx: ActionContext,
): Promise<null> {
  const docker = dockerOf<NetworksDocker>(ctx);
  const net = docker.getNetwork(params.id);
  let info: NetworkEntry;
  try {
    info = (await net.inspect()) as NetworkEntry;
  } catch (err) {
    if (statusOf(err) === 404) throw new ActionError('not_found', 'network not found', false);
    throw new ActionError('failed', 'network inspect failed', false);
  }
  const name = info.Name ?? '';
  if (builtin(name)) throw new ActionError('not_allowed', 'built-in networks cannot be removed');
  const containers = await allContainers(docker);
  const users = attached(containers, info.Id ?? params.id, name);
  const endpointIds = Object.keys(info.Containers ?? {});
  const endpointUsers = containers.filter((c) => endpointIds.includes(c.Id));
  if ([...users, ...endpointUsers].some(isProtectedListed)) {
    throw new ActionError('not_allowed', NOT_ALLOWED_PROTECTED);
  }
  try {
    await net.remove();
  } catch (err) {
    const status = statusOf(err);
    if (status === 404) throw new ActionError('not_found', 'network not found', false);
    if (status === 409 || status === 403) {
      throw new ActionError('busy', 'network is in use', false);
    }
    throw new ActionError('failed', 'network remove failed', false);
  }
  ctx.log.info('network removed', { network: params.id.slice(0, 12), name: name.slice(0, 100) });
  return null;
}
