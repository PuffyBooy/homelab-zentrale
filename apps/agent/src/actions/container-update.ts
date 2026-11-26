import { isDeepStrictEqual } from 'node:util';
import type Docker from 'dockerode';
import type { RpcParams } from '@hz/shared';
import type { Logger } from '../log.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * container.update for standalone containers (not compose): pull the image and
 * recreate the container with the same configuration.
 *
 *   inspect -> pull -> rename old -> create new (same name) -> connect networks
 *   -> stop old -> start new -> check it stays up -> remove old
 *
 * Any failure after the rename rolls back: remove the new container, give the
 * old one its name back and start it again if it was running. Volumes are never
 * removed (named and anonymous volumes are carried over to the new container).
 *
 * Compose containers are refused: they are updated with compose.pull + compose.up.
 */

/** Subset of `docker inspect <container>` we use. */
export interface UpdateInspect {
  Id: string;
  Name: string;
  Image: string;
  State: { Running: boolean; Restarting?: boolean; Paused?: boolean };
  Config: {
    Hostname?: string;
    Domainname?: string;
    User?: string;
    AttachStdin?: boolean;
    AttachStdout?: boolean;
    AttachStderr?: boolean;
    ExposedPorts?: Record<string, object> | null;
    Tty?: boolean;
    OpenStdin?: boolean;
    StdinOnce?: boolean;
    Env?: string[] | null;
    Cmd?: string[] | null;
    Image: string;
    Volumes?: Record<string, object> | null;
    WorkingDir?: string;
    Entrypoint?: string | string[] | null;
    Labels?: Record<string, string> | null;
    StopSignal?: string;
    StopTimeout?: number;
    Healthcheck?: object;
    Shell?: string[] | null;
  };
  HostConfig: Docker.HostConfig & { Mounts?: Docker.MountSettings[] };
  Mounts?: { Type: string; Name?: string; Destination: string; RW?: boolean }[];
  NetworkSettings?: {
    Networks?: Record<
      string,
      {
        IPAMConfig?: Docker.IPAMConfig | null;
        Links?: string[] | null;
        Aliases?: string[] | null;
        DriverOpts?: Record<string, string> | null;
      }
    >;
  };
}

/** Subset of `docker image inspect` we use. */
export interface ImageConfigLike {
  Id: string;
  Config?: {
    Env?: string[] | null;
    Cmd?: string[] | null;
    Entrypoint?: string | string[] | null;
    Labels?: Record<string, string> | null;
    WorkingDir?: string;
    User?: string;
    ExposedPorts?: Record<string, object> | null;
    Volumes?: Record<string, object> | null;
    Healthcheck?: object;
    StopSignal?: string;
    Shell?: string[] | null;
  } | null;
}

export interface RecreatePlan {
  create: Docker.ContainerCreateOptions;
  /** Networks to connect after create (Docker allows one at create on older APIs). */
  extraNetworks: [string, Docker.EndpointSettings][];
}

const COMPOSE_LABEL = 'com.docker.compose.project';

/** An image reference we can pull (not a bare image id). */
export function pullableRef(ref: string): boolean {
  if (!ref || ref.length > 256) return false;
  if (/^sha256:/.test(ref) || /^[0-9a-f]{12,64}$/.test(ref)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(ref);
}

const same = (a: unknown, b: unknown) => isDeepStrictEqual(a ?? null, b ?? null);

function withoutKeys<T extends object>(
  obj: Record<string, T> | null | undefined,
  drop: Record<string, unknown> | null | undefined,
): Record<string, T> | undefined {
  if (!obj) return undefined;
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(obj)) if (!drop || !Object.hasOwn(drop, k)) out[k] = v;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Builds the create options for the new container. Values that only came from
 * the old image (env, labels, cmd ...) are left out, so the new image's defaults
 * apply; everything the user set is kept.
 */
export function buildRecreatePlan(
  info: UpdateInspect,
  oldImage: ImageConfigLike | null,
  imageRef: string,
): RecreatePlan {
  const cfg = info.Config;
  const img = oldImage?.Config ?? null;
  const shortId = info.Id.slice(0, 12);
  const create: Docker.ContainerCreateOptions = {
    name: info.Name.replace(/^\//, ''),
    Image: imageRef,
  };
  const set = <K extends keyof Docker.ContainerCreateOptions>(
    k: K,
    v: Docker.ContainerCreateOptions[K] | null | undefined,
  ) => {
    if (v !== undefined && v !== null) create[k] = v;
  };

  // Docker sets the hostname to the short id unless one was given.
  if (cfg.Hostname && cfg.Hostname !== shortId) set('Hostname', cfg.Hostname);
  if (cfg.Domainname) set('Domainname', cfg.Domainname);
  set('AttachStdin', cfg.AttachStdin);
  set('AttachStdout', cfg.AttachStdout);
  set('AttachStderr', cfg.AttachStderr);
  set('Tty', cfg.Tty);
  set('OpenStdin', cfg.OpenStdin);
  set('StdinOnce', cfg.StdinOnce);
  if (cfg.StopTimeout !== undefined) set('StopTimeout', cfg.StopTimeout);

  if (!img) {
    set('User', cfg.User || undefined);
    set('Env', cfg.Env);
    set('Cmd', cfg.Cmd);
    set('Entrypoint', cfg.Entrypoint);
    set('Labels', cfg.Labels);
    set('WorkingDir', cfg.WorkingDir || undefined);
    set('ExposedPorts', cfg.ExposedPorts);
    set('Volumes', cfg.Volumes);
    set('Healthcheck', cfg.Healthcheck as Docker.HealthConfig | undefined);
    set('StopSignal', cfg.StopSignal || undefined);
    set('Shell', cfg.Shell);
  } else {
    const imgEnv = new Set(img.Env ?? []);
    const env = (cfg.Env ?? []).filter((e) => !imgEnv.has(e));
    if (env.length > 0) create.Env = env;
    const labels: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.Labels ?? {})) {
      if (img.Labels?.[k] !== v) labels[k] = v;
    }
    if (Object.keys(labels).length > 0) create.Labels = labels;
    // A custom entrypoint resets the image's Cmd in Docker, so keep both then.
    if (!same(cfg.Entrypoint, img.Entrypoint)) {
      set('Entrypoint', cfg.Entrypoint ?? []);
      set('Cmd', cfg.Cmd);
    } else if (!same(cfg.Cmd, img.Cmd)) {
      set('Cmd', cfg.Cmd);
    }
    if (cfg.WorkingDir && cfg.WorkingDir !== (img.WorkingDir ?? ''))
      set('WorkingDir', cfg.WorkingDir);
    if (cfg.User && cfg.User !== (img.User ?? '')) set('User', cfg.User);
    set('ExposedPorts', withoutKeys(cfg.ExposedPorts, img.ExposedPorts));
    set('Volumes', withoutKeys(cfg.Volumes, img.Volumes));
    if (cfg.Healthcheck && !same(cfg.Healthcheck, img.Healthcheck)) {
      set('Healthcheck', cfg.Healthcheck as Docker.HealthConfig);
    }
    if (cfg.StopSignal && cfg.StopSignal !== (img.StopSignal ?? ''))
      set('StopSignal', cfg.StopSignal);
    if (cfg.Shell && !same(cfg.Shell, img.Shell)) set('Shell', cfg.Shell);
  }

  // HostConfig as is, plus anonymous volumes so their data survives.
  const host: Docker.HostConfig = { ...info.HostConfig };
  const targets = new Set<string>();
  for (const b of host.Binds ?? []) {
    const dst = b.split(':')[1];
    if (dst) targets.add(dst);
  }
  const mounts: Docker.MountSettings[] = [...(host.Mounts ?? [])];
  for (const m of mounts) targets.add(m.Target);
  for (const m of info.Mounts ?? []) {
    if (m.Type !== 'volume' || !m.Name || targets.has(m.Destination)) continue;
    mounts.push({
      Type: 'volume',
      Source: m.Name,
      Target: m.Destination,
      ReadOnly: m.RW === false,
    });
    targets.add(m.Destination);
  }
  if (mounts.length > 0) host.Mounts = mounts;
  create.HostConfig = host;

  // Networks: the primary one at create, the others with connect.
  const mode = host.NetworkMode ?? 'default';
  const extraNetworks: [string, Docker.EndpointSettings][] = [];
  if (!['host', 'none'].includes(mode) && !mode.startsWith('container:')) {
    const primary = mode === 'default' ? 'bridge' : mode;
    const nets = info.NetworkSettings?.Networks ?? {};
    const endpoint = (name: string): Docker.EndpointSettings => {
      const n = nets[name] ?? {};
      const ep: Docker.EndpointSettings = {};
      if (n.IPAMConfig) ep.IPAMConfig = n.IPAMConfig;
      if (n.Links && n.Links.length > 0) ep.Links = n.Links;
      // Docker adds the short id (and on new versions the name) itself; the default
      // bridge does not support aliases at all.
      const aliases = (n.Aliases ?? []).filter(
        (a) => a !== shortId && a !== info.Id && a !== create.name,
      );
      if (aliases.length > 0 && name !== 'bridge') ep.Aliases = aliases;
      if (n.DriverOpts) ep.DriverOpts = n.DriverOpts;
      return ep;
    };
    create.NetworkingConfig = { EndpointsConfig: { [primary]: endpoint(primary) } };
    for (const name of Object.keys(nets)) {
      if (name !== primary) extraNetworks.push([name, endpoint(name)]);
    }
  }
  return { create, extraNetworks };
}

/** The parts of dockerode used by the update (fakes in tests implement these). */
export interface UpdateDocker {
  getContainer(id: string): {
    inspect(): Promise<unknown>;
    rename(opts: { name: string }): Promise<unknown>;
    stop(opts?: { t?: number }): Promise<unknown>;
    start(): Promise<unknown>;
    remove(opts?: { v?: boolean; force?: boolean }): Promise<unknown>;
  };
  getImage(ref: string): { inspect(): Promise<unknown> };
  createContainer(opts: Docker.ContainerCreateOptions): Promise<{ id: string }>;
  getNetwork(name: string): { connect(opts: object): Promise<unknown> };
  pull(ref: string): Promise<NodeJS.ReadableStream>;
  modem: {
    followProgress(
      stream: NodeJS.ReadableStream,
      onFinished: (err: Error | null, output: unknown[]) => void,
    ): void;
  };
}

export interface UpdateOptions {
  /** Wait after start before checking the new container is still up. Default 3 s. */
  settleMs?: number;
  pullTimeoutMs?: number;
  now?: () => number;
  log: Logger;
}

export interface UpdateResult {
  updated: boolean;
  imageId: string;
  previousImageId: string;
  /** False when the pull failed and a newer local image with this tag was used. */
  pulled: boolean;
  oldRemoved?: boolean;
}

const statusOf = (err: unknown) => (err as { statusCode?: number } | null)?.statusCode;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function pullImage(docker: UpdateDocker, ref: string, timeoutMs: number): Promise<void> {
  const stream = await docker.pull(ref);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      (stream as unknown as { destroy?: () => void }).destroy?.();
      reject(new Error('pull timeout'));
    }, timeoutMs);
    docker.modem.followProgress(stream, (err, output) => {
      clearTimeout(timer);
      if (err) return reject(err);
      const failed = (output ?? []).find(
        (o) => typeof o === 'object' && o !== null && 'error' in o,
      );
      if (failed) return reject(new Error('pull reported an error'));
      resolve();
    });
  });
}

const busy = new Set<string>();

/**
 * Docker ids of old containers while their update runs. Inventory and events skip
 * them: the renamed `<name>-hz-old-*` container is an implementation detail and
 * would otherwise show up (and raise an alert) as a new, stopped container.
 * If a rollback fails, the id is released and the leftover becomes visible.
 */
export const hiddenDuringUpdate = new Set<string>();

export async function updateContainer(
  docker: UpdateDocker,
  ref: string,
  opts: UpdateOptions,
): Promise<UpdateResult> {
  let info: UpdateInspect;
  try {
    info = (await docker.getContainer(ref).inspect()) as UpdateInspect;
  } catch (err) {
    if (statusOf(err) === 404) throw new ActionError('not_found', 'container not found');
    throw new ActionError('failed', 'container inspect failed');
  }
  if (info.Config.Labels?.[COMPOSE_LABEL]) {
    throw new ActionError(
      'invalid_params',
      'compose container: update the project with compose.pull and compose.up',
      false,
    );
  }
  const imageRef = info.Config.Image;
  if (!pullableRef(imageRef)) {
    throw new ActionError(
      'invalid_params',
      'container was created from an image id, not a tag',
      false,
    );
  }
  if (busy.has(info.Id)) throw new ActionError('busy', 'update already running');
  busy.add(info.Id);
  hiddenDuringUpdate.add(info.Id);
  try {
    return await recreate(docker, info, imageRef, opts);
  } finally {
    busy.delete(info.Id);
    hiddenDuringUpdate.delete(info.Id);
  }
}

async function recreate(
  docker: UpdateDocker,
  info: UpdateInspect,
  imageRef: string,
  opts: UpdateOptions,
): Promise<UpdateResult> {
  const log = opts.log;
  const previousImageId = info.Image;
  let pulled = true;
  try {
    await pullImage(docker, imageRef, opts.pullTimeoutMs ?? 10 * 60_000);
  } catch {
    // Offline registry or a local-only tag: a newer local image is still an update.
    pulled = false;
    log.warn('image pull failed, trying the local image', { image: imageRef });
  }
  let newImageId: string;
  try {
    newImageId = ((await docker.getImage(imageRef).inspect()) as ImageConfigLike).Id;
  } catch {
    throw new ActionError('failed', 'image pull failed');
  }
  if (newImageId === previousImageId) {
    if (!pulled) throw new ActionError('failed', 'image pull failed');
    return { updated: false, imageId: newImageId, previousImageId, pulled };
  }

  // If the old image was removed meanwhile, the config is copied as is.
  const oldImage = (await docker
    .getImage(previousImageId)
    .inspect()
    .catch(() => null)) as ImageConfigLike | null;
  const plan = buildRecreatePlan(info, oldImage, imageRef);
  const name = plan.create.name as string;
  const now = opts.now ?? Date.now;
  const tmpName = `${name}-hz-old-${now().toString(36)}`.slice(0, 120);
  const wasRunning = info.State.Running || info.State.Restarting === true;
  const old = docker.getContainer(info.Id);

  try {
    await old.rename({ name: tmpName });
  } catch {
    throw new ActionError('failed', 'update failed at rename, nothing changed');
  }

  let step = 'create';
  let createdId: string | null = null;
  try {
    const created = await docker.createContainer(plan.create);
    createdId = created.id;
    step = 'network';
    for (const [net, ep] of plan.extraNetworks) {
      await docker.getNetwork(net).connect({ Container: createdId, EndpointConfig: ep });
    }
    if (wasRunning) {
      step = 'stop';
      try {
        await old.stop({ t: 30 });
      } catch (err) {
        if (statusOf(err) !== 304) throw err;
      }
      step = 'start';
      await docker.getContainer(createdId).start();
      step = 'check';
      const settle = opts.settleMs ?? 3000;
      if (settle > 0) await sleep(settle);
      const s = (await docker.getContainer(createdId).inspect()) as {
        State?: { Running?: boolean; Restarting?: boolean; ExitCode?: number };
      };
      const st = s.State ?? {};
      if (st.Restarting || (!st.Running && (st.ExitCode ?? 0) !== 0)) {
        throw new Error('new container is not running');
      }
    }
  } catch {
    log.warn('container update failed, rolling back', { container: name, step });
    if (createdId) {
      await docker
        .getContainer(createdId)
        .remove({ force: true, v: false })
        .catch(() => log.error('rollback: removing the new container failed', { container: name }));
    }
    let restored = true;
    await old.rename({ name }).catch(() => {
      restored = false;
      log.error('rollback: renaming the old container back failed', { container: tmpName });
    });
    if (wasRunning) {
      await old.start().catch((err: unknown) => {
        if (statusOf(err) !== 304) {
          restored = false;
          log.error('rollback: starting the old container failed', { container: name });
        }
      });
    }
    throw new ActionError(
      'failed',
      restored
        ? `update failed at ${step}, rolled back to the old container`
        : `update failed at ${step}, rollback incomplete (old container: ${tmpName})`,
    );
  }

  let oldRemoved = true;
  try {
    await old.remove({ v: false, force: true });
  } catch {
    oldRemoved = false;
    log.warn('old container could not be removed', { container: tmpName });
  }
  return { updated: true, imageId: newImageId, previousImageId, pulled, oldRemoved };
}

export async function containerUpdate(
  params: RpcParams<'container.update'>,
  ctx: ActionContext,
): Promise<UpdateResult> {
  const docker = ctx.host.docker;
  if (!docker) throw new ActionError('failed', 'docker not available');
  return updateContainer(docker as unknown as UpdateDocker, params.id, { log: ctx.log });
}
