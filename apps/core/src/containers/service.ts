import { createHash } from 'node:crypto';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import {
  homelabPathSchema,
  type AgentEvent,
  type ContainerHealth,
  type ContainerInfo,
  type ContainerState,
  type ContainerStatus,
  type ContainerSummary,
  type PortMapping,
} from '@hz/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { AlertService } from '../alerts/service.js';
import type { Clock } from '../clock.js';
import type { Db } from '../db/index.js';
import { containers, servers, type ContainerRow } from '../db/schema.js';
import {
  alertClass,
  containerAlertKey,
  containerStatus,
  containerStatusText,
  downText,
  OOM_TTL_MS,
  stoppedText,
  upText,
  type AlertClass,
  type AlertInput,
  type ContainerIntent,
} from './status.js';

/** Container id in the core: stable per server + container name (survives a recreate). */
export function containerCoreId(serverId: string, name: string): string {
  return createHash('sha256')
    .update(`container:${serverId}:${name}`)
    .digest('base64url')
    .slice(0, 22);
}

/** Docker reports names with a leading slash in some APIs. */
const cleanName = (name: string): string => name.replace(/^\/+/, '');

/** The compose dir only counts if it is a normalized path below /opt/homelab/. */
export function managedComposeDir(dir: string | null | undefined): string | null {
  if (!dir) return null;
  return homelabPathSchema.safeParse(dir).success ? dir : null;
}

/** Docker reports 0001-01-01T00:00:00Z for containers that never started. */
function startedMs(iso: string | undefined): number | null {
  if (iso === undefined) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

export type ContainerListener = (id: string, deleted: boolean) => void;

const STATUS_ORDER: Record<ContainerStatus, number> = { crit: 0, warn: 1, busy: 2, off: 3, ok: 4 };

type Values = Omit<ContainerRow, 'id' | 'serverId' | 'name'>;

interface AlertAction {
  serverId: string;
  serverName: string;
  name: string;
  prev: AlertClass | null;
  next: AlertClass;
  input: AlertInput;
}

const parsePorts = (json: string): PortMapping[] => {
  try {
    return JSON.parse(json) as PortMapping[];
  } catch {
    return [];
  }
};

/** Only the fields the UI sees; a change here sends a live update. */
const signature = (v: Partial<Values>): string =>
  JSON.stringify([
    v.dockerId,
    v.image,
    v.composeProject,
    v.composeService,
    v.composeDir,
    v.state,
    v.health,
    v.statusText,
    v.exitCode,
    v.startedAt,
    v.restartCount,
    v.cpu,
    v.memBytes,
    v.portsJson,
    v.intent,
  ]);

/**
 * Containers of all servers: kept in sync with `inventory` and `event` from the
 * agents, mapped to a UI status, and turned into alerts on state transitions
 * (dedupe key container:<serverId>:<name>).
 */
export class ContainerService {
  private readonly listeners = new Set<ContainerListener>();

  constructor(
    private readonly deps: {
      db: Db;
      now: Clock;
      alerts: AlertService;
      log: FastifyBaseLogger;
    },
  ) {}

  onChange(fn: ContainerListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(id: string, deleted: boolean): void {
    for (const fn of this.listeners) fn(id, deleted);
  }

  // ---- reads -----------------------------------------------------------------

  row(id: string): ContainerRow | undefined {
    return this.deps.db.select().from(containers).where(eq(containers.id, id)).get();
  }

  /** Ids of all containers of the same compose project on the same server (incl. itself). */
  projectIds(row: Pick<ContainerRow, 'id' | 'serverId' | 'composeProject'>): string[] {
    if (!row.composeProject) return [row.id];
    return this.deps.db
      .select({ id: containers.id })
      .from(containers)
      .where(
        and(
          eq(containers.serverId, row.serverId),
          eq(containers.composeProject, row.composeProject),
        ),
      )
      .all()
      .map((r) => r.id);
  }

  private serverName(serverId: string): string {
    return (
      this.deps.db
        .select({ name: servers.name })
        .from(servers)
        .where(eq(servers.id, serverId))
        .get()?.name ?? serverId
    );
  }

  private activeIntent(row: Pick<ContainerRow, 'intent' | 'intentUntil'>): ContainerIntent | null {
    if (row.intent !== 'stop' && row.intent !== 'restart') return null;
    if (row.intentUntil !== null && row.intentUntil < this.deps.now()) return null;
    return row.intent;
  }

  toSummary(row: ContainerRow, serverName: string): ContainerSummary {
    const input = {
      state: row.state as ContainerState,
      health: row.health as ContainerHealth,
      exitCode: row.exitCode,
      intent: this.activeIntent(row),
    };
    return {
      id: row.id,
      serverId: row.serverId,
      serverName,
      dockerId: row.dockerId,
      name: row.name,
      image: row.image,
      composeProject: row.composeProject,
      composeService: row.composeService,
      composeManaged: managedComposeDir(row.composeDir) !== null,
      state: input.state,
      health: input.health,
      status: containerStatus(input),
      statusText: containerStatusText(input),
      exitCode: row.exitCode,
      startedAt: row.startedAt === null ? null : new Date(row.startedAt).toISOString(),
      ports: parsePorts(row.portsJson),
      cpu: row.cpu,
      memBytes: row.memBytes,
      restartCount: row.restartCount,
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }

  summary(id: string): ContainerSummary | null {
    const row = this.row(id);
    return row ? this.toSummary(row, this.serverName(row.serverId)) : null;
  }

  /** Problems first (crit, warn, busy, off, ok), then by server and name. */
  list(serverId?: string): ContainerSummary[] {
    const rows = this.deps.db
      .select({ c: containers, serverName: servers.name })
      .from(containers)
      .innerJoin(servers, eq(servers.id, containers.serverId))
      .where(serverId === undefined ? undefined : eq(containers.serverId, serverId))
      .all();
    return rows
      .map((r) => this.toSummary(r.c, r.serverName))
      .sort(
        (a, b) =>
          STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
          a.serverName.localeCompare(b.serverName) ||
          a.name.localeCompare(b.name),
      );
  }

  // ---- intents (actions through the core) -------------------------------------

  /**
   * Marks a container as taken down on purpose. `stop` holds until it runs
   * again, `restart` for `ttlMs`. `null` clears the intent.
   */
  setIntent(id: string, intent: ContainerIntent | null, ttlMs?: number): void {
    const now = this.deps.now();
    this.deps.db
      .update(containers)
      .set({
        intent,
        intentUntil: intent === null || ttlMs === undefined ? null : now + ttlMs,
      })
      .where(eq(containers.id, id))
      .run();
    this.emit(id, false);
  }

  // ---- inventory -------------------------------------------------------------

  /**
   * Reconciles the containers of one server with an inventory: upsert by name,
   * delete the ones that are gone. Then alerts and live updates.
   */
  syncInventory(serverId: string, list: readonly ContainerInfo[]): void {
    const now = this.deps.now();
    const db = this.deps.db;
    const serverName = this.serverName(serverId);
    const byName = new Map<string, ContainerInfo>();
    for (const c of list) byName.set(cleanName(c.name), c);

    const changed: string[] = [];
    const removed: ContainerRow[] = [];
    const actions: AlertAction[] = [];

    db.transaction((tx) => {
      const existing = new Map(
        tx
          .select()
          .from(containers)
          .where(eq(containers.serverId, serverId))
          .all()
          .map((r) => [r.name, r] as const),
      );
      const names = [...byName.keys()];
      const gone = [...existing.values()].filter((r) => !byName.has(r.name));
      if (gone.length > 0) {
        tx.delete(containers)
          .where(
            names.length > 0
              ? and(eq(containers.serverId, serverId), notInArray(containers.name, names))
              : eq(containers.serverId, serverId),
          )
          .run();
        removed.push(...gone);
      }
      for (const [name, c] of byName) {
        const old = existing.get(name);
        const base: Values = {
          dockerId: c.dockerId,
          image: c.image,
          composeProject: c.composeProject ?? null,
          composeService: c.composeService ?? null,
          composeDir: c.composeDir ?? null,
          state: c.state,
          health: c.health,
          statusText: '',
          exitCode: c.state === 'running' ? null : (c.exitCode ?? null),
          startedAt: startedMs(c.startedAt),
          restartCount: c.restartCount ?? null,
          cpu: c.cpu ?? null,
          memBytes: c.memBytes ?? null,
          portsJson: JSON.stringify(c.ports),
          infoJson: JSON.stringify(c),
          intent: old?.intent ?? null,
          intentUntil: old?.intentUntil ?? null,
          oomAt: old?.oomAt ?? null,
          alertClass: old?.alertClass ?? null,
          updatedAt: now,
        };
        const result = this.write(tx, serverId, serverName, name, old, base);
        if (result.changed) changed.push(result.id);
        if (result.action) actions.push(result.action);
      }
    });

    for (const r of removed) {
      // Gone from Docker (removed, not recreated): its alert has nothing left to watch.
      const active = this.deps.alerts.active(containerAlertKey(serverId, r.name));
      if (active) this.deps.alerts.resolveById(active.id);
      this.emit(r.id, true);
    }
    for (const a of actions) this.runAlert(a);
    for (const id of changed) this.emit(id, false);
  }

  // ---- events ----------------------------------------------------------------

  /** Docker events between inventories. Returns true if a container changed. */
  onEvent(serverId: string, event: AgentEvent['event']): boolean {
    if (event.kind === 'denied') return false;
    const db = this.deps.db;
    const now = this.deps.now();
    const name = cleanName(event.name);
    const old = db
      .select()
      .from(containers)
      .where(and(eq(containers.serverId, serverId), eq(containers.name, name)))
      .get();
    // Unknown containers wait for the next inventory (the agent sends one right away).
    if (!old) return false;

    const next: Values = { ...old, updatedAt: now };
    if (event.kind === 'oom') {
      next.oomAt = now;
    } else {
      switch (event.action) {
        case 'start':
        case 'restart':
          next.state = 'running';
          next.exitCode = null;
          next.startedAt = now;
          next.dockerId = event.dockerId;
          break;
        case 'unpause':
          next.state = 'running';
          break;
        case 'die':
          next.state = 'exited';
          next.exitCode = event.exitCode ?? null;
          next.cpu = null;
          next.memBytes = null;
          break;
        case 'pause':
          next.state = 'paused';
          break;
        case 'health_status':
          if (event.health) next.health = event.health;
          break;
        default:
          // stop/kill are followed by die; create/destroy by the next inventory.
          return false;
      }
      if (event.health && event.action !== 'health_status') next.health = event.health;
    }
    const serverName = this.serverName(serverId);
    let result: { id: string; changed: boolean; action: AlertAction | null } | undefined;
    db.transaction((tx) => {
      result = this.write(tx, serverId, serverName, name, old, next);
    });
    if (!result) return false;
    if (result.action) this.runAlert(result.action);
    if (result.changed) this.emit(result.id, false);
    return result.changed;
  }

  /** Before a server is deleted (its rows go with ON DELETE CASCADE). */
  removeServer(serverId: string): string[] {
    const ids = this.deps.db
      .select({ id: containers.id })
      .from(containers)
      .where(eq(containers.serverId, serverId))
      .all()
      .map((r) => r.id);
    if (ids.length > 0) this.deps.db.delete(containers).where(inArray(containers.id, ids)).run();
    for (const id of ids) this.emit(id, true);
    return ids;
  }

  // ---- internals -------------------------------------------------------------

  private write(
    tx: Db,
    serverId: string,
    serverName: string,
    name: string,
    old: ContainerRow | undefined,
    v: Values,
  ): { id: string; changed: boolean; action: AlertAction | null } {
    const now = this.deps.now();
    // A stop intent ends when the container runs again.
    if (v.intent === 'stop' && v.state === 'running' && old && old.state !== 'running') {
      v.intent = null;
      v.intentUntil = null;
    }
    if (v.intent !== null && this.activeIntent(v) === null) {
      v.intent = null;
      v.intentUntil = null;
    }
    const intent = this.activeIntent(v);
    const input: AlertInput = {
      state: v.state as ContainerState,
      health: v.health as ContainerHealth,
      exitCode: v.exitCode,
      intent,
      oom: v.oomAt !== null && now - v.oomAt <= OOM_TTL_MS,
    };
    v.statusText = containerStatusText(input);
    const prev = (old?.alertClass ?? null) as AlertClass | null;
    const next = alertClass(input);
    v.alertClass = next;
    // An OOM mark belongs to the next exit; it is cleared once the container ran again.
    if (next === 'up' && prev !== null && prev !== 'up') v.oomAt = null;

    const id = old?.id ?? containerCoreId(serverId, name);
    if (old) {
      tx.update(containers).set(v).where(eq(containers.id, id)).run();
    } else {
      tx.insert(containers)
        .values({ id, serverId, name, ...v })
        .onConflictDoUpdate({ target: [containers.serverId, containers.name], set: v })
        .run();
    }
    const changed = !old || signature(old) !== signature(v);
    const action =
      prev === next && old !== undefined
        ? null
        : { serverId, serverName, name, prev: old ? prev : null, next, input };
    return { id, changed, action };
  }

  private runAlert(a: AlertAction): void {
    const alerts = this.deps.alerts;
    const key = containerAlertKey(a.serverId, a.name);
    const now = this.deps.now();
    switch (a.next) {
      case 'down': {
        const t = downText(a.input, a.name, a.serverName, now);
        alerts.raise(key, 'crit', t.title, t.body, a.serverId, 'container');
        this.deps.log.info({ serverId: a.serverId, container: a.name }, 'container down');
        return;
      }
      case 'stopped': {
        // A container that is already stopped when we first see it is not news.
        if (a.prev === null) return;
        const t = stoppedText(a.input, a.name, a.serverName, now);
        alerts.raise(key, 'info', t.title, t.body, a.serverId, 'container');
        return;
      }
      case 'up': {
        const t = upText(a.name, a.serverName, now);
        alerts.resolve(key, t);
        return;
      }
      case 'none':
        return;
    }
  }
}
