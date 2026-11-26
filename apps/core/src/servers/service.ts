import { count, eq } from 'drizzle-orm';
import {
  defaultThresholds,
  serverNetworkSchema,
  thresholdsPatchSchema,
  thresholdsSchema,
  type AgentEvent,
  type ContainerInfo,
  type Disk,
  type Hello,
  type Inventory,
  type ListeningPort,
  type Metrics,
  type ServerDetail,
  type ServerNetwork,
  type ServerSummary,
  type SystemInfo,
  type Thresholds,
  type ThresholdsPatch,
} from '@hz/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { AlertService } from '../alerts/service.js';
import type { AgentSink } from '../agents/hub.js';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import {
  containers,
  servers,
  serverState,
  type ServerRow,
  type ServerStateRow,
} from '../db/schema.js';
import { toRawRow, type MetricsStore } from '../metrics/store.js';
import { syncServerAlerts } from './alert-texts.js';
import {
  evaluateStatus,
  publicReason,
  WINDOW_TOLERANCE_MS,
  type StatusInput,
  type StatusResult,
} from './status.js';

type StoredMetrics = Omit<Metrics, 'type'>;

export interface ConnectionInfo {
  isConnected(serverId: string): boolean;
  disconnectedAt(serverId: string): number | null;
}

/** Container bookkeeping (containers/service.ts), called by the server service. */
export interface ContainerSync {
  syncInventory(serverId: string, list: readonly ContainerInfo[]): void;
  /** Returns true if a container changed (the server counts are refreshed). */
  onEvent(serverId: string, event: AgentEvent['event']): boolean;
  removeServer(serverId: string): void;
}

/** Event game_wake of an agent (M12). */
export type GameWakeListener = (
  serverId: string,
  e: { gameId: string; port: number; protocol: 'tcp' | 'udp' },
) => void;

/** Stored network value, or null when unset or unknown. */
export function serverNetworkOf(v: string | null): ServerNetwork | null {
  const p = serverNetworkSchema.safeParse(v);
  return p.success ? p.data : null;
}

/** serverId and whether it was deleted. */
export type ServerListener = (serverId: string, deleted: boolean) => void;
/** Called after an inventory was stored. */
export type InventoryListener = (serverId: string, inv: Omit<Inventory, 'type'>) => void;

const parse = <T>(json: string | null): T | null =>
  json === null ? null : (JSON.parse(json) as T);
const round1 = (v: number): number => Math.round(v * 10) / 10;
const pct = (used: number, total: number): number => (total > 0 ? (used / total) * 100 : 0);

export function thresholdsOf(row: Pick<ServerRow, 'thresholdsJson'>): Thresholds {
  let partial: unknown;
  try {
    partial = JSON.parse(row.thresholdsJson);
  } catch {
    partial = {};
  }
  const p = thresholdsPatchSchema.safeParse(partial);
  return thresholdsSchema.parse({ ...defaultThresholds, ...(p.success ? p.data : {}) });
}

/** Applies a patch; keys that are absent or undefined keep their value. */
export function mergeThresholds(base: Thresholds, patch: ThresholdsPatch): Thresholds {
  const out: Thresholds = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === 'number') out[k as keyof Thresholds] = v;
  }
  return out;
}

/** Merged thresholds must keep warn <= crit. */
export function thresholdsConsistent(t: Thresholds): boolean {
  return t.ramWarn <= t.ramCrit && t.diskWarn <= t.diskCrit;
}

/**
 * Servers: state from agents, status rules, summaries for API and live channel.
 * Implements the AgentSink of the hub.
 */
export class ServerService implements AgentSink {
  private readonly lastSeen = new Map<string, number>();
  private readonly lastSummary = new Map<string, string>();
  private readonly listeners = new Set<ServerListener>();
  private readonly inventoryListeners = new Set<InventoryListener>();
  private readonly wakeListeners = new Set<GameWakeListener>();
  private readonly connectListeners = new Set<(serverId: string) => void>();
  /** Demo servers (HZ_DEMO=1) count as connected without a socket. */
  private readonly virtual = new Set<string>();
  private connections: ConnectionInfo = { isConnected: () => false, disconnectedAt: () => null };
  private containerSync: ContainerSync | null = null;
  private asleep: ((serverId: string) => boolean) | null = null;
  private readonly bootAt: number;

  constructor(
    private readonly deps: {
      db: Db;
      now: Clock;
      metrics: MetricsStore;
      alerts: AlertService;
      log: FastifyBaseLogger;
    },
  ) {
    this.bootAt = deps.now();
  }

  setConnections(c: ConnectionInfo): void {
    this.connections = c;
  }

  setContainers(c: ContainerSync): void {
    this.containerSync = c;
  }

  /**
   * M22: servers whose machine is switched off on purpose (a deallocated cloud VM).
   * While disconnected they are OFF without reasons, so no offline alert is raised.
   */
  setAsleep(fn: ((serverId: string) => boolean) | null): void {
    this.asleep = fn;
  }

  markVirtual(serverId: string): void {
    this.virtual.add(serverId);
  }

  onChange(fn: ServerListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** M12: a sleeping game got a connection (event game_wake of this server's agent). */
  onGameWake(fn: GameWakeListener): () => void {
    this.wakeListeners.add(fn);
    return () => this.wakeListeners.delete(fn);
  }

  /** After every hello of an agent (also a reconnect), once the server is stored. */
  onAgentConnected(fn: (serverId: string) => void): () => void {
    this.connectListeners.add(fn);
    return () => this.connectListeners.delete(fn);
  }

  onInventoryStored(fn: InventoryListener): () => void {
    this.inventoryListeners.add(fn);
    return () => this.inventoryListeners.delete(fn);
  }

  private emit(id: string, deleted: boolean): void {
    for (const fn of this.listeners) fn(id, deleted);
  }

  isConnected(id: string): boolean {
    return this.virtual.has(id) || this.connections.isConnected(id);
  }

  row(id: string): ServerRow | undefined {
    return this.deps.db.select().from(servers).where(eq(servers.id, id)).get();
  }

  private state(id: string): ServerStateRow | undefined {
    return this.deps.db.select().from(serverState).where(eq(serverState.serverId, id)).get();
  }

  private lastSeenOf(row: ServerRow): number | null {
    return this.lastSeen.get(row.id) ?? row.lastSeen;
  }

  // ---- AgentSink -------------------------------------------------------------

  onConnected(server: ServerRow, hello: Hello, enrolled: boolean): void {
    const now = this.deps.now();
    this.lastSeen.set(server.id, now);
    this.deps.db
      .update(servers)
      .set({
        arch: hello.arch,
        os: hello.os,
        agentVersion: hello.version,
        capabilitiesJson: JSON.stringify(hello.capabilities),
        lastSeen: now,
      })
      .where(eq(servers.id, server.id))
      .run();
    if (enrolled) {
      writeAudit(this.deps.db, now, {
        actor: 'system',
        action: 'server.enrolled',
        target: server.id,
        details: { name: server.name },
      });
    }
    this.refresh(server.id, true);
    for (const fn of this.connectListeners) {
      try {
        fn(server.id);
      } catch (err) {
        this.deps.log.error(
          { err: err instanceof Error ? err.name : 'error' },
          'connect hook failed',
        );
      }
    }
  }

  onDisconnected(serverId: string): void {
    this.refresh(serverId, true);
  }

  onSeen(serverId: string): void {
    this.lastSeen.set(serverId, this.deps.now());
  }

  onMetrics(serverId: string, m: Metrics): void {
    this.ingestMetrics(serverId, m);
  }

  onInventory(serverId: string, inv: Inventory): void {
    this.ingestInventory(serverId, inv);
  }

  onEvent(serverId: string, ev: AgentEvent): void {
    const e = ev.event;
    if (e.kind === 'denied') {
      this.deps.log.warn({ serverId, action: e.action }, 'agent denied an action');
      writeAudit(this.deps.db, this.deps.now(), {
        actor: 'system',
        action: 'agent.denied',
        target: serverId,
        details: { action: e.action, reason: e.reason },
      });
    } else if (e.kind === 'game_wake') {
      this.deps.log.info({ serverId, gameId: e.gameId, protocol: e.protocol }, 'game wake event');
      for (const fn of this.wakeListeners) fn(serverId, e);
    } else {
      this.deps.log.debug({ serverId, kind: e.kind }, 'agent event');
      if (this.containerSync?.onEvent(serverId, e)) this.refresh(serverId);
    }
  }

  terminalAllowed(serverId: string): boolean {
    return this.row(serverId)?.allowTerminal ?? false;
  }

  // ---- ingestion -------------------------------------------------------------

  /** Stores a metrics sample. The core's receive time is used, not the agent clock. */
  ingestMetrics(serverId: string, m: Metrics | StoredMetrics): void {
    const now = this.deps.now();
    const stored: StoredMetrics = {
      ts: m.ts,
      cpu: m.cpu,
      ...(m.load1 !== undefined ? { load1: m.load1 } : {}),
      ram: m.ram,
      swap: m.swap,
      disks: m.disks,
      temp: m.temp,
      net: m.net,
      uptimeS: m.uptimeS,
    };
    this.deps.metrics.insert(toRawRow(serverId, now, stored));
    const json = JSON.stringify(stored);
    this.deps.db
      .insert(serverState)
      .values({ serverId, metricsJson: json, metricsAt: now })
      .onConflictDoUpdate({
        target: serverState.serverId,
        set: { metricsJson: json, metricsAt: now },
      })
      .run();
    this.lastSeen.set(serverId, now);
    this.deps.db.update(servers).set({ lastSeen: now }).where(eq(servers.id, serverId)).run();
    this.refresh(serverId, true);
  }

  ingestInventory(serverId: string, inv: Omit<Inventory, 'type'>): void {
    const now = this.deps.now();
    const db = this.deps.db;
    db.transaction((tx) => {
      const values = {
        systemJson: JSON.stringify(inv.system),
        updatesJson: inv.updates === null ? null : JSON.stringify(inv.updates),
        rebootRequired: inv.rebootRequired,
        sshFailed24h: inv.sshFailed24h,
        fail2banBanned: inv.fail2banBanned,
        listeningPortsJson: JSON.stringify(inv.listeningPorts),
        inventoryAt: now,
      };
      tx.insert(serverState)
        .values({ serverId, ...values })
        .onConflictDoUpdate({ target: serverState.serverId, set: values })
        .run();
      tx.update(servers)
        .set({
          tailscaleIp: inv.system.tailscaleIp ?? null,
          publicIp: inv.system.publicIp ?? null,
          os: inv.system.os,
          arch: inv.system.arch,
          lastSeen: now,
        })
        .where(eq(servers.id, serverId))
        .run();
    });
    this.containerSync?.syncInventory(serverId, inv.containers);
    for (const fn of this.inventoryListeners) fn(serverId, inv);
    this.lastSeen.set(serverId, now);
    this.refresh(serverId, true);
  }

  // ---- status ----------------------------------------------------------------

  private statusInput(row: ServerRow, st: ServerStateRow | undefined, t: Thresholds): StatusInput {
    const now = this.deps.now();
    const m = parse<StoredMetrics>(st?.metricsJson ?? null);
    const windowMs = Math.max(t.cpuWarnMinutes, t.ramCritMinutes) * 60_000 + WINDOW_TOLERANCE_MS;
    const connected = this.isConnected(row.id);
    return {
      connected,
      disconnectedAt: connected ? null : this.connections.disconnectedAt(row.id),
      lastSeen: this.lastSeenOf(row),
      observedSince: this.bootAt,
      samples: m ? this.deps.metrics.samples(row.id, now - windowMs) : [],
      latest: m
        ? {
            cpu: m.cpu,
            ramPct: pct(m.ram.usedBytes, m.ram.totalBytes),
            disks: m.disks
              .filter((d) => d.totalBytes > 0)
              .map((d) => ({ mount: d.mount, pct: pct(d.usedBytes, d.totalBytes) })),
            temp: m.temp,
          }
        : null,
      updates: parse<{ total: number; security: number }>(st?.updatesJson ?? null),
      rebootRequired: st?.rebootRequired ?? null,
    };
  }

  private build(row: ServerRow): {
    summary: ServerSummary;
    result: StatusResult;
    thresholds: Thresholds;
    state: ServerStateRow | undefined;
  } {
    const st = this.state(row.id);
    const t = thresholdsOf(row);
    const input = this.statusInput(row, st, t);
    const result: StatusResult =
      !input.connected && this.asleep?.(row.id) === true
        ? { status: 'off', reasons: [] }
        : evaluateStatus(input, t, this.deps.now());
    const m = parse<StoredMetrics>(st?.metricsJson ?? null);
    const counts = this.deps.db
      .select({ state: containers.state, n: count() })
      .from(containers)
      .where(eq(containers.serverId, row.id))
      .groupBy(containers.state)
      .all();
    const lastSeen = this.lastSeenOf(row);
    const diskPct = input.latest?.disks.length
      ? Math.max(...input.latest.disks.map((d) => d.pct))
      : null;
    const summary: ServerSummary = {
      id: row.id,
      name: row.name,
      location: row.location,
      arch: row.arch,
      os: row.os,
      tailscaleIp: row.tailscaleIp,
      publicIp: row.publicIp,
      status: result.status,
      reasons: result.reasons.map(publicReason),
      connected: input.connected,
      lastSeen: lastSeen === null ? null : new Date(lastSeen).toISOString(),
      agentVersion: row.agentVersion,
      cpu: m ? round1(m.cpu) : null,
      ramPct: input.latest ? round1(input.latest.ramPct) : null,
      diskPct: diskPct === null ? null : round1(diskPct),
      temp: m?.temp ?? null,
      uptimeS: m?.uptimeS ?? null,
      allowTerminal: row.allowTerminal,
      network: serverNetworkOf(row.network),
      containersRunning: counts.find((c) => c.state === 'running')?.n ?? 0,
      containersTotal: counts.reduce((a, c) => a + c.n, 0),
    };
    return { summary, result, thresholds: t, state: st };
  }

  summary(id: string): ServerSummary | null {
    const row = this.row(id);
    return row ? this.build(row).summary : null;
  }

  /** Sorted: crit, warn, then by name (SPEC 5.1). */
  list(): ServerSummary[] {
    const order = { crit: 0, warn: 1, off: 2, ok: 3 } as const;
    return this.deps.db
      .select()
      .from(servers)
      .all()
      .map((r) => this.build(r).summary)
      .sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
  }

  detail(id: string): ServerDetail | null {
    const row = this.row(id);
    if (!row) return null;
    const { summary, thresholds, state: st } = this.build(row);
    const m = parse<StoredMetrics>(st?.metricsJson ?? null);
    return {
      server: summary,
      thresholds,
      system: parse<SystemInfo>(st?.systemJson ?? null),
      ram: m ? m.ram : null,
      swap: m ? m.swap : null,
      disks: m ? (m.disks as Disk[]) : [],
      net: m ? m.net : null,
      updates: parse<{ total: number; security: number }>(st?.updatesJson ?? null),
      rebootRequired: st?.rebootRequired ?? null,
      sshFailed24h: st?.sshFailed24h ?? null,
      fail2banBanned: st?.fail2banBanned ?? null,
      listeningPorts: parse<ListeningPort[]>(st?.listeningPortsJson ?? null) ?? [],
    };
  }

  /**
   * Re-evaluates one server, syncs its alerts and notifies listeners if the
   * summary changed (or always with `force`, e.g. after new metrics).
   */
  refresh(id: string, force = false): void {
    const row = this.row(id);
    if (!row) return;
    const { summary, result, thresholds } = this.build(row);
    syncServerAlerts(this.deps.alerts, result, {
      serverId: row.id,
      name: row.name,
      connected: summary.connected,
      now: this.deps.now(),
      thresholds,
      current: {
        cpu: summary.cpu,
        ramPct: summary.ramPct,
        diskPct: summary.diskPct,
        temp: summary.temp,
      },
    });
    const json = JSON.stringify(summary);
    const changed = this.lastSummary.get(id) !== json;
    this.lastSummary.set(id, json);
    if (changed || force) this.emit(id, false);
  }

  /** Every 5 s from the scheduler: offline detection without new messages. */
  refreshAll(): void {
    for (const r of this.deps.db.select({ id: servers.id }).from(servers).all()) this.refresh(r.id);
  }

  update(
    id: string,
    patch: {
      location?: string;
      thresholds?: ThresholdsPatch;
      allowTerminal?: boolean;
      network?: ServerNetwork | null;
    },
  ): boolean {
    const row = this.row(id);
    if (!row) return false;
    const set: Partial<ServerRow> = {};
    if (patch.location !== undefined) set.location = patch.location;
    if (patch.allowTerminal !== undefined) set.allowTerminal = patch.allowTerminal;
    if (patch.network !== undefined) set.network = patch.network;
    if (patch.thresholds !== undefined) {
      const current = thresholdsPatchSchema.safeParse(parse(row.thresholdsJson) ?? {});
      set.thresholdsJson = JSON.stringify({
        ...(current.success ? current.data : {}),
        ...patch.thresholds,
      });
    }
    if (Object.keys(set).length > 0) {
      this.deps.db.update(servers).set(set).where(eq(servers.id, id)).run();
    }
    this.refresh(id, true);
    return true;
  }

  delete(id: string): boolean {
    this.containerSync?.removeServer(id);
    const r = this.deps.db.delete(servers).where(eq(servers.id, id)).run();
    this.lastSeen.delete(id);
    this.lastSummary.delete(id);
    this.virtual.delete(id);
    if (r.changes > 0) this.emit(id, true);
    return r.changes > 0;
  }
}
