import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import Docker from 'dockerode';
import {
  containerInfoSchema,
  gameFolderNameSchema,
  type ContainerHealth,
  type ContainerInfo,
  type PortMapping,
} from '@hz/shared';

/**
 * Container inventory over the Docker socket (/var/run/docker.sock).
 *
 * Cost model (a Pi runs this too):
 * - one `listContainers` per inventory,
 * - `inspect` only for containers that are new or changed (cache, invalidated by
 *   Docker events and refreshed at least every 10 min) for startedAt, restartCount,
 *   exit code and health,
 * - one-shot stats (no 2 s sampling wait) for running containers at most every
 *   ~60 s, 4 in parallel. CPU % is the delta between two of our samples.
 */

export async function openDocker(socketPath: string): Promise<Docker | null> {
  try {
    // Read and write: as a non-root user without access we report docker: false.
    await access(socketPath, constants.R_OK | constants.W_OK);
  } catch {
    return null;
  }
  return new Docker({ socketPath, timeout: 120_000 });
}

const STATES = new Set([
  'created',
  'running',
  'paused',
  'restarting',
  'removing',
  'exited',
  'dead',
]);
const HEALTH = new Set(['healthy', 'unhealthy', 'starting', 'none']);

export function healthFromStatus(status: string): ContainerInfo['health'] {
  if (/\(healthy\)/.test(status)) return 'healthy';
  if (/\(unhealthy\)/.test(status)) return 'unhealthy';
  if (/\(health: starting\)/.test(status)) return 'starting';
  return 'none';
}

/** What we keep from `docker inspect` (fields the list does not have). */
export interface ContainerDetails {
  startedAt?: string;
  restartCount?: number;
  exitCode?: number;
  health?: ContainerHealth;
  /** --cpus limit (HostConfig.NanoCpus / 1e9), null without one. */
  cpuLimit?: number | null;
}

/** Subset of the inspect result we read (also what tests fake). */
export interface InspectLike {
  Id: string;
  RestartCount?: number;
  State?: {
    Status?: string;
    Running?: boolean;
    ExitCode?: number;
    StartedAt?: string;
    Health?: { Status?: string } | undefined;
  };
  HostConfig?: { NanoCpus?: number | null } | null;
}

/** Docker timestamps have nanoseconds; "0001-01-01T00:00:00Z" means never. */
export function normalizeDockerTime(t: string | undefined): string | undefined {
  if (!t || t.startsWith('0001-')) return undefined;
  const ms = Date.parse(t);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

export function detailsFromInspect(i: InspectLike): ContainerDetails {
  const d: ContainerDetails = {};
  const started = normalizeDockerTime(i.State?.StartedAt);
  if (started) d.startedAt = started;
  if (Number.isInteger(i.RestartCount) && (i.RestartCount ?? -1) >= 0) {
    d.restartCount = i.RestartCount as number;
  }
  const status = i.State?.Status;
  if ((status === 'exited' || status === 'dead') && Number.isInteger(i.State?.ExitCode)) {
    d.exitCode = i.State?.ExitCode as number;
  }
  const h = i.State?.Health?.Status;
  if (h && HEALTH.has(h)) d.health = h as ContainerHealth;
  if (i.HostConfig) {
    const nano = i.HostConfig.NanoCpus;
    d.cpuLimit =
      typeof nano === 'number' && Number.isFinite(nano) && nano > 0
        ? Math.round(nano / 1e7) / 100
        : null;
  }
  return d;
}

export interface UsageSample {
  cpu?: number;
  memBytes?: number;
}

export function mapContainer(
  c: Docker.ContainerInfo,
  details: ContainerDetails = {},
  usage: UsageSample = {},
): ContainerInfo | null {
  const labels = c.Labels ?? {};
  const name = (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, '');
  const exit = /^Exited \((-?\d+)\)/.exec(c.Status ?? '');
  const ports: PortMapping[] = [];
  const seen = new Set<string>();
  for (const p of c.Ports ?? []) {
    if (!Number.isInteger(p.PrivatePort) || p.PrivatePort < 1) continue;
    const proto = p.Type === 'udp' || p.Type === 'sctp' ? p.Type : 'tcp';
    const entry: PortMapping = { privatePort: p.PrivatePort, proto };
    if (p.PublicPort) entry.publicPort = p.PublicPort;
    if (p.IP) entry.ip = p.IP.slice(0, 64);
    // Docker lists 0.0.0.0 and :: separately; keep both but no exact duplicates.
    const key = `${entry.privatePort}/${proto}/${entry.publicPort ?? ''}/${entry.ip ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ports.push(entry);
  }
  const state = (STATES.has(c.State) ? c.State : 'dead') as ContainerInfo['state'];
  const info: ContainerInfo = {
    dockerId: c.Id,
    name: name.slice(0, 128),
    image: (c.Image ?? '').slice(0, 256),
    state,
    health: details.health ?? healthFromStatus(c.Status ?? ''),
    statusText: (c.Status ?? '').slice(0, 128),
    ports: ports.slice(0, 64),
  };
  if (c.ImageID) info.imageId = c.ImageID.slice(0, 128);
  const project = labels['com.docker.compose.project'];
  const service = labels['com.docker.compose.service'];
  const dir = labels['com.docker.compose.project.working_dir'];
  if (project) info.composeProject = project.slice(0, 128);
  if (service) info.composeService = service.slice(0, 128);
  if (dir) info.composeDir = dir.slice(0, 512);
  if (state === 'exited' || state === 'dead') {
    if (details.exitCode !== undefined) info.exitCode = details.exitCode;
    else if (exit?.[1]) info.exitCode = Number(exit[1]);
  }
  if (details.startedAt && (state === 'running' || state === 'paused' || state === 'restarting')) {
    info.startedAt = details.startedAt;
  }
  if (details.restartCount !== undefined) info.restartCount = details.restartCount;
  const role = labels['hz.role'];
  if (role === 'core' || role === 'agent' || role === 'updater') info.role = role;
  const game = labels['homelab.game'];
  if (game !== undefined && gameFolderNameSchema.safeParse(game).success) info.game = game;
  if (details.cpuLimit !== undefined) info.cpuLimit = details.cpuLimit;
  if (state === 'running') {
    if (usage.cpu !== undefined) info.cpu = Math.min(100, Math.max(0, usage.cpu));
    if (usage.memBytes !== undefined) info.memBytes = Math.max(0, usage.memBytes);
  }
  const parsed = containerInfoSchema.safeParse(info);
  return parsed.success ? parsed.data : null;
}

// Stats ---------------------------------------------------------------------

/** Subset of the Docker stats JSON. */
export interface StatsLike {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: {
    usage?: number;
    stats?: Record<string, number | undefined>;
  };
}

export interface CpuSample {
  total: number;
  system: number;
}

export function cpuSample(s: StatsLike): CpuSample | null {
  const total = s.cpu_stats?.cpu_usage?.total_usage;
  const system = s.cpu_stats?.system_cpu_usage;
  if (typeof total !== 'number' || typeof system !== 'number') return null;
  if (!Number.isFinite(total) || !Number.isFinite(system) || system <= 0) return null;
  return { total, system };
}

/**
 * CPU share of the whole host in percent (0-100) between two samples.
 * system_cpu_usage sums all cores, so this is comparable to the server's CPU value.
 */
export function cpuPercent(prev: CpuSample, cur: CpuSample): number | undefined {
  const dTotal = cur.total - prev.total;
  const dSystem = cur.system - prev.system;
  if (dSystem <= 0 || dTotal < 0) return undefined;
  return Math.min(100, Math.max(0, (dTotal / dSystem) * 100));
}

/** Memory like `docker stats`: usage minus inactive file cache (cgroup v2 and v1). */
export function memoryUsage(s: StatsLike): number | undefined {
  const usage = s.memory_stats?.usage;
  if (typeof usage !== 'number' || !Number.isFinite(usage)) return undefined;
  const st = s.memory_stats?.stats ?? {};
  const cache = st.inactive_file ?? st.total_inactive_file ?? 0;
  const v = cache > 0 && cache < usage ? usage - cache : usage;
  return Math.max(0, v);
}

/** Runs fn over items with at most `limit` in parallel. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error('failed'));
      },
    );
  });
}

export interface CollectorOptions {
  /** Stats at most this often. Default 55 s (a 60 s inventory gets fresh values). */
  statsIntervalMs?: number;
  /** Inspect cache max age. Default 10 min. */
  detailsMaxAgeMs?: number;
  statsConcurrency?: number;
  now?: () => number;
  /** Containers to leave out (e.g. the old container while it is being updated). */
  hide?: (dockerId: string) => boolean;
}

/** The parts of dockerode the collector uses. */
export type DockerReader = Pick<Docker, 'listContainers' | 'getContainer'>;

/**
 * Builds the container list for `inventory`. Keeps caches between calls; Docker
 * events call `invalidate(id)`.
 */
export class ContainerCollector {
  private readonly details = new Map<string, { at: number; d: ContainerDetails }>();
  private readonly cpuPrev = new Map<string, CpuSample>();
  private readonly usage = new Map<string, UsageSample>();
  private statsAt = Number.NEGATIVE_INFINITY;
  private statsRun: Promise<void> | null = null;
  private readonly statsIntervalMs: number;
  private readonly detailsMaxAgeMs: number;
  private readonly statsConcurrency: number;
  private readonly now: () => number;
  private readonly hide: (dockerId: string) => boolean;

  constructor(
    private readonly docker: DockerReader | null,
    opts: CollectorOptions = {},
  ) {
    this.statsIntervalMs = opts.statsIntervalMs ?? 55_000;
    this.detailsMaxAgeMs = opts.detailsMaxAgeMs ?? 600_000;
    this.statsConcurrency = opts.statsConcurrency ?? 4;
    this.now = opts.now ?? Date.now;
    this.hide = opts.hide ?? (() => false);
  }

  /** Forget cached inspect data of one container (or all). */
  invalidate(dockerId?: string): void {
    if (dockerId === undefined) {
      this.details.clear();
      return;
    }
    for (const id of this.details.keys()) {
      if (id === dockerId || id.startsWith(dockerId)) this.details.delete(id);
    }
  }

  private async detailsFor(docker: DockerReader, id: string): Promise<ContainerDetails> {
    const cached = this.details.get(id);
    if (cached && this.now() - cached.at < this.detailsMaxAgeMs) return cached.d;
    try {
      const i = (await withTimeout(
        docker.getContainer(id).inspect(),
        10_000,
      )) as unknown as InspectLike;
      const d = detailsFromInspect(i);
      this.details.set(id, { at: this.now(), d });
      return d;
    } catch {
      return cached?.d ?? {};
    }
  }

  private async refreshStats(docker: DockerReader, running: readonly string[]): Promise<void> {
    const keep = new Set(running);
    for (const id of [...this.usage.keys()]) if (!keep.has(id)) this.usage.delete(id);
    for (const id of [...this.cpuPrev.keys()]) if (!keep.has(id)) this.cpuPrev.delete(id);
    await mapLimit(running, this.statsConcurrency, async (id) => {
      try {
        const s = (await withTimeout(
          docker.getContainer(id).stats({ stream: false, 'one-shot': true }),
          5_000,
        )) as unknown as StatsLike;
        const u: UsageSample = {};
        const mem = memoryUsage(s);
        if (mem !== undefined) u.memBytes = mem;
        const cur = cpuSample(s);
        const prev = this.cpuPrev.get(id);
        if (cur) {
          if (prev) {
            const pct = cpuPercent(prev, cur);
            if (pct !== undefined) u.cpu = pct;
          }
          this.cpuPrev.set(id, cur);
        }
        this.usage.set(id, u);
      } catch {
        // keep the last value
      }
    });
  }

  /** Starts a stats round when due; resolves when the current round is done. */
  private statsWhenDue(docker: DockerReader, running: readonly string[]): Promise<void> {
    if (this.statsRun) return this.statsRun;
    if (this.now() - this.statsAt < this.statsIntervalMs) return Promise.resolve();
    this.statsAt = this.now();
    this.statsRun = this.refreshStats(docker, running).finally(() => {
      this.statsRun = null;
    });
    return this.statsRun;
  }

  async list(): Promise<ContainerInfo[]> {
    const docker = this.docker;
    if (!docker) return [];
    let list: Docker.ContainerInfo[];
    try {
      list = await docker.listContainers({ all: true });
    } catch {
      return [];
    }
    list = list.filter((c) => !this.hide(c.Id)).slice(0, 500);
    const ids = new Set(list.map((c) => c.Id));
    for (const id of [...this.details.keys()]) if (!ids.has(id)) this.details.delete(id);

    const running = list.filter((c) => c.State === 'running').map((c) => c.Id);
    const [details] = await Promise.all([
      mapLimit(list, 8, (c) => this.detailsFor(docker, c.Id)),
      this.statsWhenDue(docker, running).catch(() => undefined),
    ]);
    const out: ContainerInfo[] = [];
    list.forEach((c, i) => {
      const m = mapContainer(c, details[i] ?? {}, this.usage.get(c.Id) ?? {});
      if (m) out.push(m);
    });
    return out;
  }
}

export async function dockerVersion(
  docker: Pick<Docker, 'version'> | null,
): Promise<string | undefined> {
  if (!docker) return undefined;
  try {
    const v = await docker.version();
    return v.Version;
  } catch {
    return undefined;
  }
}
