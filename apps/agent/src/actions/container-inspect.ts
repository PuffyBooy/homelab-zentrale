import {
  containerDetailsDataSchema,
  type ContainerDetailsData,
  type ContainerStats,
  type MountInfo,
  type RpcParams,
} from '@hz/shared';
import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_SERVICE_LABEL,
  dockerOf,
  isoOrNull,
  labelOf,
  statusOf,
  withTimeout,
} from './docker-common.js';
import { isProtectedContainer } from './protected.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * container.inspect: details of one container plus one stats sample while it runs.
 *
 * Env VALUES never leave the agent: only the part before the first '=' of each
 * Config.Env entry is reported (envKeys). Cmd, Entrypoint, labels other than the
 * compose project/service and HostConfig are not reported either (they may carry
 * secrets). The result is validated against containerDetailsDataSchema.
 */

export const STATS_TIMEOUT_MS = 3000;

export interface InspectRaw {
  Id: string;
  Name?: string;
  Image?: string;
  Created?: string;
  RestartCount?: number;
  State?: {
    Status?: string;
    Running?: boolean;
    Paused?: boolean;
    Restarting?: boolean;
    ExitCode?: number;
    StartedAt?: string;
    FinishedAt?: string;
    Health?: { Status?: string } | null;
  } | null;
  Config?: {
    Image?: string;
    Env?: string[] | null;
    Labels?: Record<string, string> | null;
  } | null;
  HostConfig?: {
    RestartPolicy?: { Name?: string } | null;
    Memory?: number;
  } | null;
  Mounts?:
    { Type?: string; Name?: string; Source?: string; Destination?: string; RW?: boolean }[] | null;
  NetworkSettings?: {
    Networks?: Record<string, { IPAddress?: string } | null> | null;
    Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null> | null;
  } | null;
}

export interface StatsRaw {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] | null };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: {
    usage?: number;
    limit?: number;
    stats?: Record<string, number> | null;
  };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }> | null;
  blkio_stats?: {
    io_service_bytes_recursive?: { op?: string; value?: number }[] | null;
  } | null;
  pids_stats?: { current?: number } | null;
}

interface InspectDocker {
  getContainer(id: string): {
    inspect(): Promise<unknown>;
    stats(opts: { stream: false }): Promise<unknown>;
  };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** Docker's own CPU formula (`docker stats`): percent of one core. */
export function computeStats(s: StatsRaw, memoryLimitSet: boolean): ContainerStats {
  const cpuDelta =
    num(s.cpu_stats?.cpu_usage?.total_usage) - num(s.precpu_stats?.cpu_usage?.total_usage);
  const sysDelta = num(s.cpu_stats?.system_cpu_usage) - num(s.precpu_stats?.system_cpu_usage);
  const online = num(s.cpu_stats?.online_cpus) || s.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
  const cpuPercent = cpuDelta > 0 && sysDelta > 0 ? (cpuDelta / sysDelta) * online * 100 : 0;

  const ms = s.memory_stats?.stats ?? {};
  // cgroup v2: inactive_file, cgroup v1: total_inactive_file, very old: cache.
  const inactive =
    ms.inactive_file !== undefined
      ? num(ms.inactive_file)
      : ms.total_inactive_file !== undefined
        ? num(ms.total_inactive_file)
        : num(ms.cache);
  const usage = num(s.memory_stats?.usage);
  const memBytes = Math.max(0, usage - (inactive < usage ? inactive : 0));
  const limit = num(s.memory_stats?.limit);

  let rx = 0;
  let tx = 0;
  for (const n of Object.values(s.networks ?? {})) {
    rx += num(n?.rx_bytes);
    tx += num(n?.tx_bytes);
  }
  let read = 0;
  let write = 0;
  for (const e of s.blkio_stats?.io_service_bytes_recursive ?? []) {
    const op = (e?.op ?? '').toLowerCase();
    if (op === 'read') read += num(e.value);
    else if (op === 'write') write += num(e.value);
  }
  return {
    cpuPercent: Math.round(cpuPercent * 100) / 100,
    memBytes,
    memLimitBytes: memoryLimitSet && limit > 0 ? limit : null,
    netRxBytes: rx,
    netTxBytes: tx,
    blockReadBytes: read,
    blockWriteBytes: write,
    pids: Math.floor(num(s.pids_stats?.current)),
  };
}

const HEALTH = new Set(['healthy', 'unhealthy', 'starting']);
const MOUNT_TYPES = new Set<MountInfo['type']>([
  'bind',
  'volume',
  'tmpfs',
  'npipe',
  'cluster',
  'image',
]);
const PROTOCOLS = new Set(['tcp', 'udp', 'sctp']);

function portNum(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/** Only the names of the env variables; values are dropped here and never copied. */
export function envKeysOf(env: readonly unknown[] | null | undefined): string[] {
  const keys: string[] = [];
  for (const e of env ?? []) {
    if (typeof e !== 'string') continue;
    const i = e.indexOf('=');
    const key = i < 0 ? e : e.slice(0, i);
    if (key.length === 0 || key.length > 200) continue;
    keys.push(key);
    if (keys.length >= 300) break;
  }
  return keys;
}

export function mapInspect(info: InspectRaw, stats: ContainerStats | null): ContainerDetailsData {
  const st = info.State ?? {};
  const running = st.Running === true;
  const labels = info.Config?.Labels ?? null;
  const health = st.Health?.Status;
  const startedAt = isoOrNull(st.StartedAt);

  const mounts: MountInfo[] = [];
  for (const m of info.Mounts ?? []) {
    const type = m?.Type as MountInfo['type'];
    if (!MOUNT_TYPES.has(type)) continue;
    const source =
      type === 'volume' ? str(m.Name, 1000) : type === 'tmpfs' ? '' : str(m.Source, 1000);
    mounts.push({ type, source, destination: str(m.Destination, 1000), rw: m.RW !== false });
    if (mounts.length >= 100) break;
  }

  const networks = Object.entries(info.NetworkSettings?.Networks ?? {})
    .slice(0, 50)
    .map(([name, n]) => ({
      name: name.slice(0, 256),
      ip: n?.IPAddress ? n.IPAddress.slice(0, 64) : null,
    }));

  const ports: ContainerDetailsData['ports'] = [];
  for (const [key, bindings] of Object.entries(info.NetworkSettings?.Ports ?? {})) {
    const [p, proto = 'tcp'] = key.split('/');
    const privatePort = portNum(p);
    if (privatePort === null || !PROTOCOLS.has(proto)) continue;
    const protocol = proto as 'tcp' | 'udp' | 'sctp';
    if (!bindings || bindings.length === 0) {
      ports.push({ privatePort, publicPort: null, protocol, ip: null });
    } else {
      for (const b of bindings) {
        ports.push({
          privatePort,
          publicPort: portNum(b?.HostPort),
          protocol,
          ip: b?.HostIp ? b.HostIp.slice(0, 64) : null,
        });
      }
    }
    if (ports.length >= 200) break;
  }

  const data: ContainerDetailsData = {
    id: info.Id,
    name: str(info.Name, 257).replace(/^\//, '').slice(0, 256),
    image: str(info.Config?.Image, 300),
    imageId: str(info.Image, 80),
    createdAt: isoOrNull(info.Created) ?? new Date(0).toISOString(),
    startedAt,
    finishedAt: running ? null : isoOrNull(st.FinishedAt),
    state: str(st.Status, 20) || 'unknown',
    health:
      health && HEALTH.has(health) ? (health as 'healthy' | 'unhealthy' | 'starting') : 'none',
    exitCode:
      running || startedAt === null || !Number.isInteger(st.ExitCode)
        ? null
        : (st.ExitCode as number),
    restartCount: Math.floor(num(info.RestartCount)),
    restartPolicy: str(info.HostConfig?.RestartPolicy?.Name, 30) || 'no',
    envKeys: envKeysOf(info.Config?.Env),
    mounts,
    networks,
    ports: ports.slice(0, 200),
    composeProject: labelOf(labels, COMPOSE_PROJECT_LABEL),
    composeService: labelOf(labels, COMPOSE_SERVICE_LABEL),
    protected: isProtectedContainer({ id: info.Id, labels }),
    stats,
  };
  const parsed = containerDetailsDataSchema.safeParse(data);
  if (!parsed.success) throw new ActionError('failed', 'unexpected inspect data', false);
  return parsed.data;
}

export async function containerInspect(
  params: RpcParams<'container.inspect'>,
  ctx: ActionContext,
  opts: { statsTimeoutMs?: number } = {},
): Promise<ContainerDetailsData> {
  const docker = dockerOf<InspectDocker>(ctx);
  const c = docker.getContainer(params.id);
  let info: InspectRaw;
  try {
    info = (await c.inspect()) as InspectRaw;
  } catch (err) {
    if (statusOf(err) === 404) throw new ActionError('not_found', 'container not found', false);
    throw new ActionError('failed', 'container inspect failed', false);
  }
  let stats: ContainerStats | null = null;
  if (info.State?.Running === true && info.State.Paused !== true) {
    try {
      const raw = (await withTimeout(
        c.stats({ stream: false }),
        opts.statsTimeoutMs ?? STATS_TIMEOUT_MS,
      )) as StatsRaw;
      stats = computeStats(raw, num(info.HostConfig?.Memory) > 0);
    } catch {
      stats = null;
    }
  }
  return mapInspect(info, stats);
}
