import { and, desc, eq, like, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  updateApplyDataSchema,
  updateCheckDataSchema,
  updateComponentStateSchema,
  updatePolicySchema,
  systemUpgradeDataSchema,
  defaultUpdatePolicy,
  type ImageVersion,
  type SystemUpgradeData,
  type UpdateComponentState,
  type UpdatePolicy,
  type UpdateRun,
  type UpdateRunStatus,
  type UpdateRunTarget,
  type UpdateServerState,
  type UpdatesResponse,
  type UpdateTarget,
} from '@hz/shared';
import type { FastifyBaseLogger } from 'fastify';
import { RpcError, type AgentHub } from '../agents/hub.js';
import type { AlertService } from '../alerts/service.js';
import type { Clock } from '../clock.js';
import { randomToken } from '../crypto.js';
import type { Db } from '../db/index.js';
import { containers, servers, serverState, settings, updateRuns } from '../db/schema.js';
import type { UpdateRunRow } from '../db/schema.js';
import { readSetting, writeSetting } from '../db/settings.js';
import { HttpError } from '../http/errors.js';
import type { UpdateResultEvent } from '../servers/service.js';
import { updateAlert } from './texts.js';
import { nextWindowAfter, openWindowAt } from './window.js';

/** update.check pulls the image tag (can take minutes on a Raspberry Pi). */
export const CHECK_TIMEOUT_MS = 5 * 60_000;
/** update.apply answers at once ({ accepted: true }); the outcome comes as event. */
export const APPLY_TIMEOUT_MS = 60_000;
/** apt-get update + upgrade. */
export const UPGRADE_TIMEOUT_MS = 45 * 60_000;
export const REBOOT_TIMEOUT_MS = 30_000;
/** A run without a result after this long ends with status timeout. */
export const RUN_TIMEOUT_MS = 15 * 60_000;
/** os runs end by their RPC timeout; the sweep only catches runs left by a core restart. */
export const OS_RUN_TIMEOUT_MS = UPGRADE_TIMEOUT_MS + 5 * 60_000;
export const RUNS_KEPT = 200;
export const RUNS_SHOWN = 50;

export const updatePolicyKey = (serverId: string): string => `updates.policy.${serverId}`;
export const updateStateKey = (serverId: string): string => `updates.state.${serverId}`;

const emptyComponent: UpdateComponentState = {
  current: null,
  available: null,
  upToDate: null,
  checkedAt: null,
};

const storedStateSchema = z.object({
  agent: updateComponentStateSchema.catch(emptyComponent),
  core: updateComponentStateSchema.nullable().catch(null),
  /** Window occurrence whose scheduled sequence was started. */
  windowKey: z.string().max(64).nullable().catch(null),
  /**
   * Progress of the scheduled sequence in `windowKey`: steps done or skipped,
   * the runs of started steps, and the reboot need reported by the os step. A
   * restarted core (e.g. after updating itself) continues from here.
   */
  progress: z
    .object({
      key: z.string().max(64),
      done: z.array(z.enum(['check', 'os', 'agent', 'core', 'reboot'])).max(5),
      runs: z.record(z.string(), z.string().max(64)),
      rebootRequired: z.boolean().nullable(),
    })
    .nullable()
    .catch(null)
    .default(null),
  /** Day (window start time, every day) of the last automatic check. */
  checkKey: z.string().max(64).nullable().catch(null),
});
type StoredState = z.infer<typeof storedStateSchema>;
const emptyState = (): StoredState => ({
  agent: emptyComponent,
  core: null,
  windowKey: null,
  checkKey: null,
  progress: null,
});

/** Steps of the scheduled sequence per server, in this order (ROADMAP M17). */
const SEQUENCE_STEPS = ['check', 'os', 'agent', 'core', 'reboot'] as const;
type SequenceStep = (typeof SEQUENCE_STEPS)[number];
type Progress = NonNullable<StoredState['progress']>;

/** Short text of an image version: version label, else short revision, else short image id. */
export function versionText(v: ImageVersion | null | undefined): string | null {
  if (!v) return null;
  if (v.version) return v.version;
  if (v.revision) return v.revision.slice(0, 7);
  return v.imageId.slice('sha256:'.length, 'sha256:'.length + 12);
}

/** Agent text without control characters, bounded. */
function cleanText(s: string, max: number): string {
  return [...s]
    .map((c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? ' ' : c))
    .join('')
    .trim()
    .slice(0, max);
}

function rpcFailText(err: unknown): string {
  if (!(err instanceof RpcError)) return 'Interner Fehler';
  switch (err.code) {
    case 'offline':
    case 'disconnected':
      return 'Agent nicht verbunden';
    case 'timeout':
      return 'Agent hat nicht geantwortet';
    default: {
      const detail = cleanText(err.detail, 200);
      return detail ? `Agent: ${err.code}: ${detail}` : `Agent: ${err.code}`;
    }
  }
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

export function toUpdateRun(r: UpdateRunRow): UpdateRun {
  return {
    id: r.id,
    serverId: r.serverId,
    serverName: r.serverName,
    target: r.target as UpdateRunTarget,
    trigger: r.trigger as UpdateRun['trigger'],
    status: r.status as UpdateRunStatus,
    startedAt: new Date(r.startedAt).toISOString(),
    finishedAt: iso(r.finishedAt),
    from: r.fromText,
    to: r.toText,
    message: r.message,
  };
}

interface RunDone {
  status: UpdateRunStatus;
  /** os runs: the agent's answer. */
  upgrade?: SystemUpgradeData;
}

export interface UpdateServiceDeps {
  db: Db;
  now: Clock;
  hub: AgentHub;
  alerts: AlertService;
  /** Display name and connection state (demo servers count as connected). */
  isConnected: (serverId: string) => boolean;
  log: FastifyBaseLogger;
}

/**
 * M17 Auto-Update (contract: @hz/shared api/updates.ts). Policy and component
 * state per server in settings, run history in update_runs. One run at a time
 * (globally). agent/core runs end with the agent event update_result, which is
 * accepted only for a known running run of the same server and target (also
 * after a core restart: the run is looked up in the database).
 */
export class UpdateService {
  private readonly listeners = new Set<() => void>();
  private readonly waiters = new Map<string, (d: RunDone) => void>();
  private readonly upgrades = new Map<string, SystemUpgradeData>();
  private readonly background = new Set<Promise<unknown>>();
  private readonly checking = new Set<string>();
  private sequence: Promise<void> | null = null;
  private demoCoreHost: string | null = null;
  private closed = false;

  constructor(private readonly deps: UpdateServiceDeps) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Core shutdown: no new runs or checks; waiting sequences end (runs stay `running`). */
  close(): void {
    this.closed = true;
    for (const [, w] of this.waiters) w({ status: 'running' });
    this.waiters.clear();
  }

  /** Resolves when background work (runs, checks, the scheduled sequence) is done (tests). */
  async idle(): Promise<void> {
    while (this.background.size > 0 || this.sequence) {
      await Promise.allSettled([...this.background, ...(this.sequence ? [this.sequence] : [])]);
    }
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.background.add(p);
    void p.finally(() => this.background.delete(p)).catch(() => undefined);
    return p;
  }

  // ---- policy and state ---------------------------------------------------------

  policy(serverId: string): UpdatePolicy {
    const p = updatePolicySchema.safeParse(readSetting(this.deps.db, updatePolicyKey(serverId)));
    return p.success ? p.data : defaultUpdatePolicy;
  }

  setPolicy(serverId: string, policy: UpdatePolicy): void {
    writeSetting(this.deps.db, updatePolicyKey(serverId), policy, this.deps.now());
    this.emit();
  }

  private stored(serverId: string): StoredState {
    const raw = readSetting(this.deps.db, updateStateKey(serverId));
    if (raw === undefined) return emptyState();
    const p = storedStateSchema.safeParse(raw);
    return p.success ? p.data : emptyState();
  }

  private patchStored(serverId: string, patch: Partial<StoredState>): void {
    writeSetting(
      this.deps.db,
      updateStateKey(serverId),
      { ...this.stored(serverId), ...patch },
      this.deps.now(),
    );
  }

  /** HZ_DEMO=1 only: the demo home server shows the core component. */
  markDemoCoreHost(serverId: string): void {
    this.demoCoreHost = serverId;
  }

  /** Demo data (HZ_DEMO=1): stores a component state. */
  seedComponent(serverId: string, target: UpdateTarget, state: UpdateComponentState): void {
    this.patchStored(serverId, { [target]: state });
  }

  /** Servers whose latest inventory has the container with hz.role=core. */
  private coreHosts(): Set<string> {
    const rows = this.deps.db
      .select({ serverId: containers.serverId, infoJson: containers.infoJson })
      .from(containers)
      .where(like(containers.infoJson, '%"role":"core"%'))
      .all();
    const out = new Set<string>();
    for (const r of rows) {
      try {
        const info = JSON.parse(r.infoJson) as { role?: unknown };
        if (info.role === 'core') out.add(r.serverId);
      } catch {
        // ignore broken rows
      }
    }
    if (this.demoCoreHost !== null) out.add(this.demoCoreHost);
    return out;
  }

  hostsCore(serverId: string): boolean {
    return this.coreHosts().has(serverId);
  }

  private activeRun(): UpdateRunRow | undefined {
    return this.deps.db.select().from(updateRuns).where(eq(updateRuns.status, 'running')).get();
  }

  run(id: string): UpdateRun | null {
    const r = this.deps.db.select().from(updateRuns).where(eq(updateRuns.id, id)).get();
    return r ? toUpdateRun(r) : null;
  }

  private nextWindow(policy: UpdatePolicy, st: StoredState, now: number): string | null {
    const open = openWindowAt(policy.window, now);
    if (open && st.windowKey !== open.key) return iso(open.start);
    const next = nextWindowAfter(policy.window, now);
    return next ? iso(next.start) : null;
  }

  private buildServer(
    row: { id: string; name: string },
    coreHosts: Set<string>,
    running: UpdateRunRow | undefined,
  ): UpdateServerState {
    const now = this.deps.now();
    const policy = this.policy(row.id);
    const st = this.stored(row.id);
    const hostsCore = coreHosts.has(row.id);
    const state = this.deps.db
      .select({ updatesJson: serverState.updatesJson, rebootRequired: serverState.rebootRequired })
      .from(serverState)
      .where(eq(serverState.serverId, row.id))
      .get();
    let os: UpdateServerState['os'] = null;
    if (state?.updatesJson) {
      const p = z
        .object({ total: z.number().int(), security: z.number().int() })
        .safeParse(JSON.parse(state.updatesJson));
      if (p.success) os = { total: p.data.total, security: p.data.security };
    }
    return {
      serverId: row.id,
      name: row.name,
      connected: this.deps.isConnected(row.id),
      hostsCore,
      policy,
      agent: st.agent,
      core: hostsCore ? (st.core ?? emptyComponent) : null,
      os,
      rebootRequired: state?.rebootRequired ?? null,
      nextWindow: this.nextWindow(policy, st, now),
      running: running?.serverId === row.id ? (running.target as UpdateRunTarget) : null,
    };
  }

  serverState(serverId: string): UpdateServerState | null {
    const row = this.deps.db
      .select({ id: servers.id, name: servers.name })
      .from(servers)
      .where(eq(servers.id, serverId))
      .get();
    return row ? this.buildServer(row, this.coreHosts(), this.activeRun()) : null;
  }

  response(): UpdatesResponse {
    const coreHosts = this.coreHosts();
    const running = this.activeRun();
    const rows = this.deps.db
      .select({ id: servers.id, name: servers.name })
      .from(servers)
      .all()
      .sort((a, b) => a.name.localeCompare(b.name));
    const runs = this.deps.db
      .select()
      .from(updateRuns)
      .orderBy(desc(updateRuns.startedAt), desc(sql`rowid`))
      .limit(RUNS_SHOWN)
      .all()
      .map(toUpdateRun);
    return {
      servers: rows.map((r) => this.buildServer(r, coreHosts, running)),
      runs,
      coreHostKnown: coreHosts.size > 0,
    };
  }

  /** Server deleted: drop its settings (runs go with the foreign key). */
  forgetServer(serverId: string): void {
    this.deps.db
      .delete(settings)
      .where(eq(settings.key, updatePolicyKey(serverId)))
      .run();
    this.deps.db
      .delete(settings)
      .where(eq(settings.key, updateStateKey(serverId)))
      .run();
    this.emit();
  }

  // ---- check -------------------------------------------------------------------

  /**
   * update.check on the agent (pulls the tag the container already uses). Throws
   * HttpError (404, 400 core not on this host, 409 offline) or RpcError.
   */
  async check(serverId: string, target: UpdateTarget): Promise<UpdateComponentState> {
    const row = this.serverRow(serverId);
    if (target === 'core' && !this.hostsCore(row.id)) throw new HttpError(400, 'invalid_input');
    if (!this.deps.hub.isConnected(row.id)) throw new HttpError(409, 'agent_offline');
    const data = await this.deps.hub.call(
      row.id,
      'update.check',
      { target },
      { timeoutMs: CHECK_TIMEOUT_MS },
    );
    const parsed = updateCheckDataSchema.safeParse(data);
    if (!parsed.success || parsed.data.target !== target) {
      throw new RpcError('failed', 'invalid update.check answer');
    }
    const d = parsed.data;
    const state: UpdateComponentState = {
      current: d.current,
      available: d.available,
      upToDate: d.pulled ? d.available === null : null,
      checkedAt: new Date(this.deps.now()).toISOString(),
    };
    this.patchStored(row.id, { [target]: state });
    this.emit();
    return state;
  }

  /** check() without throwing (scheduled and after runs). */
  private async checkQuiet(serverId: string, target: UpdateTarget): Promise<void> {
    const key = `${serverId}:${target}`;
    if (this.checking.has(key)) return;
    this.checking.add(key);
    try {
      await this.check(serverId, target);
    } catch (err) {
      this.deps.log.info(
        {
          serverId,
          target,
          code: err instanceof RpcError || err instanceof HttpError ? err.code : 'error',
        },
        'update check failed',
      );
    } finally {
      this.checking.delete(key);
    }
  }

  /** Automatic checks pull only the images the policy may update. */
  private async checkAll(serverId: string): Promise<void> {
    const policy = this.policy(serverId);
    if (policy.agent) await this.checkQuiet(serverId, 'agent');
    if (policy.core && this.hostsCore(serverId)) await this.checkQuiet(serverId, 'core');
  }

  private serverRow(serverId: string): { id: string; name: string } {
    const row = this.deps.db
      .select({ id: servers.id, name: servers.name })
      .from(servers)
      .where(eq(servers.id, serverId))
      .get();
    if (!row) throw new HttpError(404, 'not_found');
    return row;
  }

  // ---- runs --------------------------------------------------------------------

  /**
   * Starts a run (also outside the window). Throws HttpError: 404, 400 (core
   * not on this host), 409 busy (another run is active), 409 agent_offline.
   * `done` resolves when the run has finished.
   */
  startRun(
    serverId: string,
    target: UpdateRunTarget,
    trigger: UpdateRun['trigger'],
  ): { runId: string; done: Promise<RunDone> } {
    const row = this.serverRow(serverId);
    if (target === 'core' && !this.hostsCore(row.id)) throw new HttpError(400, 'invalid_input');
    if (this.closed || this.activeRun()) throw new HttpError(409, 'busy');
    if (!this.deps.hub.isConnected(row.id)) throw new HttpError(409, 'agent_offline');
    const now = this.deps.now();
    const st = this.stored(row.id);
    const from =
      target === 'agent'
        ? versionText(st.agent.current)
        : target === 'core'
          ? versionText(st.core?.current)
          : null;
    const id = randomToken(12);
    this.deps.db
      .insert(updateRuns)
      .values({
        id,
        serverId: row.id,
        serverName: row.name,
        target,
        trigger,
        status: 'running',
        startedAt: now,
        finishedAt: null,
        fromText: from,
        toText: null,
        message: null,
      })
      .run();
    this.prune();
    const done = new Promise<RunDone>((resolve) => this.waiters.set(id, resolve));
    this.deps.log.info({ serverId: row.id, target, trigger, runId: id }, 'update run started');
    this.emit();
    this.track(this.execute(id, row, target));
    return { runId: id, done };
  }

  private prune(): void {
    const keep = this.deps.db
      .select({ id: updateRuns.id })
      .from(updateRuns)
      .orderBy(desc(updateRuns.startedAt), desc(sql`rowid`))
      .limit(RUNS_KEPT)
      .all()
      .map((r) => r.id);
    this.deps.db.delete(updateRuns).where(notInArray(updateRuns.id, keep)).run();
  }

  private async execute(
    runId: string,
    row: { id: string; name: string },
    target: UpdateRunTarget,
  ): Promise<void> {
    const hub = this.deps.hub;
    if (target === 'agent' || target === 'core') {
      // Only target and runId: the agent updates the image tag its container already uses.
      try {
        const data = await hub.call(
          row.id,
          'update.apply',
          { target, runId },
          { timeoutMs: APPLY_TIMEOUT_MS },
        );
        if (!updateApplyDataSchema.safeParse(data).success) {
          this.finish(runId, 'failed', { message: 'Ungültige Antwort des Agents' });
        }
      } catch (err) {
        this.finish(runId, 'failed', { message: rpcFailText(err) });
      }
      // Otherwise the run ends with the event update_result (or the timeout sweep).
      return;
    }
    if (target === 'os') {
      try {
        const data = await hub.call(
          row.id,
          'system.upgrade',
          {},
          { timeoutMs: UPGRADE_TIMEOUT_MS },
        );
        const p = systemUpgradeDataSchema.safeParse(data);
        if (!p.success) {
          this.finish(runId, 'failed', { message: 'Ungültige Antwort des Agents' });
          return;
        }
        const u = p.data;
        this.upgrades.set(runId, u);
        const n = u.upgraded;
        const kept = u.kept > 0 ? `, ${u.kept} zurückgehalten` : '';
        this.finish(runId, n === 0 ? 'up_to_date' : 'updated', {
          to: n === 1 ? '1 Paket' : `${n} Pakete`,
          message: `${n} ${n === 1 ? 'Paket' : 'Pakete'} aktualisiert${kept}`,
        });
      } catch (err) {
        // apt can restart tailscaled/docker (or run via systemd-run): a dropped
        // connection means "unknown outcome", not a failure.
        if (err instanceof RpcError && err.code === 'disconnected') {
          this.finish(runId, 'timeout', {
            message: 'Verbindung während der Paket-Updates getrennt',
          });
          return;
        }
        const timeout = err instanceof RpcError && err.code === 'timeout';
        this.finish(runId, timeout ? 'timeout' : 'failed', { message: rpcFailText(err) });
      }
      return;
    }
    // reboot: the agent answers before the host goes down; a dropped socket counts as done.
    try {
      await hub.call(
        row.id,
        'system.reboot',
        { confirmName: row.name },
        { timeoutMs: REBOOT_TIMEOUT_MS },
      );
      this.finish(runId, 'updated', { message: 'Neustart ausgelöst' });
    } catch (err) {
      if (err instanceof RpcError && err.code === 'disconnected') {
        this.finish(runId, 'updated', { message: 'Neustart ausgelöst' });
      } else {
        this.finish(runId, 'failed', { message: rpcFailText(err) });
      }
    }
  }

  /** Ends a running run (no-op if it is not running any more). */
  private finish(
    runId: string,
    status: Exclude<UpdateRunStatus, 'running'>,
    f: { from?: string | null; to?: string | null; message?: string | null },
  ): void {
    // After close() the database is about to go; a restarted core finishes the run.
    if (this.closed) return;
    const now = this.deps.now();
    const set: Partial<UpdateRunRow> = { status, finishedAt: now };
    if (f.from !== undefined) set.fromText = f.from === null ? null : f.from.slice(0, 80);
    if (f.to !== undefined) set.toText = f.to === null ? null : f.to.slice(0, 80);
    if (f.message !== undefined) set.message = f.message === null ? null : f.message.slice(0, 300);
    const res = this.deps.db
      .update(updateRuns)
      .set(set)
      .where(and(eq(updateRuns.id, runId), eq(updateRuns.status, 'running')))
      .run();
    if (res.changes === 0) return;
    const row = this.deps.db.select().from(updateRuns).where(eq(updateRuns.id, runId)).get();
    if (!row) return;
    this.deps.log.info(
      { serverId: row.serverId, target: row.target, runId, status },
      'update run finished',
    );
    const upgrade = this.upgrades.get(runId);
    this.upgrades.delete(runId);
    try {
      this.alert(row, upgrade);
    } catch (err) {
      this.deps.log.error(
        { err: err instanceof Error ? err.name : 'error' },
        'update alert failed',
      );
    }
    this.emit();
    const waiter = this.waiters.get(runId);
    this.waiters.delete(runId);
    waiter?.({ status, ...(upgrade ? { upgrade } : {}) });
    // Fresh versions after every image run.
    if (row.target === 'agent' || row.target === 'core') {
      const target: UpdateTarget = row.target;
      if (this.deps.hub.isConnected(row.serverId)) {
        this.track(this.checkQuiet(row.serverId, target));
      }
    }
  }

  private alert(row: UpdateRunRow, upgrade: SystemUpgradeData | undefined): void {
    const a = updateAlert(toUpdateRun(row), this.deps.now(), upgrade);
    if (!a) return;
    const alerts = this.deps.alerts;
    if (a.level === 'info' || a.level === 'ok') {
      // Success after an earlier problem: the open alert of this target is resolved.
      if (alerts.active(a.key)) alerts.resolve(a.key, { title: a.title, body: a.body });
      else if (a.level === 'info')
        alerts.log(a.key, 'info', a.title, a.body, row.serverId, 'server');
      return;
    }
    alerts.raise(a.key, a.level, a.title, a.body, row.serverId, 'server');
  }

  /**
   * Event update_result of an agent. Accepted only for a run that exists, is
   * running and belongs to this server and target; everything else is ignored.
   */
  onUpdateResult(serverId: string, e: UpdateResultEvent): void {
    if (this.closed) return;
    const row = this.deps.db.select().from(updateRuns).where(eq(updateRuns.id, e.runId)).get();
    if (!row || row.serverId !== serverId || row.target !== e.target) {
      this.deps.log.warn(
        { serverId, target: e.target, known: row !== undefined },
        'update result for an unknown run ignored',
      );
      return;
    }
    if (row.status !== 'running') {
      // The agent repeats its last result after a reconnect.
      this.deps.log.debug({ serverId, runId: row.id }, 'update result for a finished run ignored');
      return;
    }
    const status: Exclude<UpdateRunStatus, 'running'> = e.outcome;
    const from = versionText(e.from) ?? row.fromText;
    const to = versionText(e.to);
    if (e.outcome === 'updated' && e.to) {
      const component: UpdateComponentState = {
        current: e.to,
        available: null,
        upToDate: true,
        checkedAt: new Date(this.deps.now()).toISOString(),
      };
      this.patchStored(serverId, { [e.target]: component });
    }
    this.finish(row.id, status, {
      from,
      to: to ?? (e.outcome === 'up_to_date' ? from : null),
      message: e.message === undefined ? null : cleanText(e.message, 300),
    });
  }

  /** Runs without a result: agent/core/reboot after 15 min, os after its RPC timeout. */
  sweep(): void {
    const now = this.deps.now();
    const running = this.deps.db
      .select()
      .from(updateRuns)
      .where(eq(updateRuns.status, 'running'))
      .all();
    for (const r of running) {
      const limit = r.target === 'os' ? OS_RUN_TIMEOUT_MS : RUN_TIMEOUT_MS;
      if (now - r.startedAt < limit) continue;
      this.finish(r.id, 'timeout', { message: 'Keine Rückmeldung vom Agent' });
    }
  }

  // ---- schedule ----------------------------------------------------------------

  /**
   * Every minute: timeouts, then the scheduled sequence for every connected
   * server whose window is open and whose occurrence has steps left (one server
   * after the other, the core host last), then the daily checks. Never waits for
   * the sequence (the scheduler runs jobs one after another). The progress is
   * persisted, so a restarted core continues the same occurrence.
   */
  tick(): void {
    if (this.closed) return;
    this.sweep();
    const now = this.deps.now();
    const coreHosts = this.coreHosts();
    const rows = this.deps.db
      .select({ id: servers.id, name: servers.name })
      .from(servers)
      .all()
      .filter((r) => this.deps.hub.isConnected(r.id));
    if (!this.sequence) {
      const due: { id: string; name: string; key: string }[] = [];
      for (const r of rows) {
        const occ = openWindowAt(this.policy(r.id).window, now);
        if (!occ) continue;
        const st = this.stored(r.id);
        if (st.windowKey !== occ.key || st.progress?.key !== occ.key) {
          // A new occurrence: claim it before the first step.
          this.patchStored(r.id, {
            windowKey: occ.key,
            checkKey: occ.key,
            progress: { key: occ.key, done: [], runs: {}, rebootRequired: null },
          });
        } else if (SEQUENCE_STEPS.every((step) => st.progress?.done.includes(step))) {
          continue;
        }
        due.push({ id: r.id, name: r.name, key: occ.key });
      }
      due.sort(
        (a, b) =>
          Number(coreHosts.has(a.id)) - Number(coreHosts.has(b.id)) || a.name.localeCompare(b.name),
      );
      if (due.length > 0) {
        this.emit();
        this.sequence = this.runSequence(due).finally(() => {
          this.sequence = null;
        });
      }
    }
    // Daily check at the window start time, also on days without a window.
    for (const r of rows) {
      const w = this.policy(r.id).window;
      const occ = openWindowAt({ ...w, days: [1, 2, 3, 4, 5, 6, 7] }, now);
      if (!occ || this.stored(r.id).checkKey === occ.key) continue;
      this.patchStored(r.id, { checkKey: occ.key });
      this.track(this.checkAll(r.id));
    }
  }

  private async runSequence(due: { id: string; name: string; key: string }[]): Promise<void> {
    for (const d of due) {
      try {
        // A step that waits for its run (e.g. after a restart) blocks everything behind it.
        if ((await this.runServerWindow(d.id, d.key)) === 'blocked') return;
      } catch (err) {
        this.deps.log.error(
          { serverId: d.id, err: err instanceof Error ? err.name : 'error' },
          'scheduled update failed',
        );
      }
    }
  }

  private progressOf(serverId: string, key: string): Progress | null {
    const p = this.stored(serverId).progress;
    return p?.key === key ? p : null;
  }

  private patchProgress(serverId: string, key: string, patch: Partial<Progress>): void {
    const p = this.progressOf(serverId, key);
    if (p) this.patchStored(serverId, { progress: { ...p, ...patch } });
  }

  private markDone(serverId: string, key: string, step: SequenceStep): void {
    const p = this.progressOf(serverId, key);
    if (p && !p.done.includes(step)) this.patchProgress(serverId, key, { done: [...p.done, step] });
  }

  /** Whether a step applies now (checked right before it would start). */
  private stepWanted(serverId: string, step: SequenceStep, policy: UpdatePolicy, key: string) {
    const st = this.stored(serverId);
    switch (step) {
      case 'check':
        return true;
      case 'os':
        return policy.os;
      case 'agent':
        return policy.agent && st.agent.available !== null;
      case 'core':
        return policy.core && this.hostsCore(serverId) && (st.core?.available ?? null) !== null;
      case 'reboot': {
        if (!policy.reboot) return false;
        const fromOs = this.progressOf(serverId, key)?.rebootRequired ?? null;
        if (fromOs !== null) return fromOs;
        return (
          this.deps.db
            .select({ r: serverState.rebootRequired })
            .from(serverState)
            .where(eq(serverState.serverId, serverId))
            .get()?.r ?? false
        );
      }
    }
  }

  /**
   * Runs the remaining steps of one occurrence. Each step at most once: a
   * started step counts as done once its run finished; a still running run
   * blocks. Returns 'blocked' when a step has to wait for a later tick.
   */
  private async runServerWindow(serverId: string, key: string): Promise<'done' | 'blocked'> {
    for (const step of SEQUENCE_STEPS) {
      // Re-read before every step: the admin may change the policy (or window) meanwhile.
      const policy = this.policy(serverId);
      const open = (): boolean =>
        openWindowAt(policy.window, this.deps.now())?.key === key &&
        this.deps.hub.isConnected(serverId);
      const p = this.progressOf(serverId, key);
      if (!p) return 'done';
      if (p.done.includes(step)) continue;
      const started = p.runs[step];
      if (started !== undefined) {
        if (this.run(started)?.status === 'running') return 'blocked';
        this.markDone(serverId, key, step);
        continue;
      }
      // Never start a step after the window ended.
      if (!open()) return 'done';
      if (!this.stepWanted(serverId, step, policy, key)) {
        this.markDone(serverId, key, step);
        continue;
      }
      if (step === 'check') {
        await this.checkAll(serverId);
        this.markDone(serverId, key, step);
        continue;
      }
      let run: { runId: string; done: Promise<RunDone> };
      try {
        run = this.startRun(serverId, step, 'schedule');
      } catch (err) {
        const code = err instanceof HttpError ? err.code : 'error';
        this.deps.log.info({ serverId, target: step, code }, 'scheduled update step skipped');
        // Busy (a manual run) or offline: try again on a later tick in this window.
        if (code === 'busy' || code === 'agent_offline') return 'blocked';
        this.markDone(serverId, key, step);
        continue;
      }
      this.patchProgress(serverId, key, { runs: { ...p.runs, [step]: run.runId } });
      const result = await run.done;
      if (result.status === 'running') return 'blocked'; // core shutting down
      if (step === 'os' && result.upgrade) {
        this.patchProgress(serverId, key, { rebootRequired: result.upgrade.rebootRequired });
      }
      this.markDone(serverId, key, step);
    }
    return 'done';
  }
}
