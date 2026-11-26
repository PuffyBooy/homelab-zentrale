import { and, desc, eq, lt } from 'drizzle-orm';
import {
  defaultSelfhealSettings,
  selfhealAlertKey,
  selfhealEventSchema,
  selfhealRuleSchema,
  selfhealSettingsSchema,
  selfhealStateSchema,
  SELFHEAL_EVENTS_KEEP_DAYS,
  SELFHEAL_EVENTS_LIST,
  type ContainerSummary,
  type SelfhealEvent,
  type SelfhealMode,
  type SelfhealReason,
  type SelfhealRule,
  type SelfhealSettings,
  type SelfhealState,
} from '@hz/shared';
import { INTENT_TTL_MS } from '../containers/status.js';
import { writeAudit } from '../db/audit.js';
import { readSetting, writeSetting } from '../db/settings.js';
import {
  checks,
  selfhealEvents,
  selfhealRules,
  servers,
  type SelfhealEventRow,
  type SelfhealRuleRow,
} from '../db/schema.js';
import type { FeatureContext } from '../features.js';
import { clockTime } from '../format.js';

export const SELFHEAL_SETTING = 'selfheal';
export const SELFHEAL_TICK_MS = 10_000;
/** Healthy/running this long ends `gave_up` (alert resolved with OK). */
export const SELFHEAL_RECOVER_MS = 10 * 60_000;

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const RESTART_TIMEOUT_MS = 60_000;
/** After a restart returned: grace for the last state changes (like the container routes). */
const SETTLE_MS = 60_000;
const PRUNE_EVERY_MS = 60 * MIN;

const REASON_TEXT: Record<SelfhealReason, string> = {
  unhealthy: '„unhealthy“',
  exited: 'abgestürzt',
  check_down: 'Website-Check DOWN',
};

type EventAction = SelfhealEvent['action'];

/** In-memory watch per container (serverId + name). */
interface Watch {
  unhealthySince: number | null;
  healthySince: number | null;
  /** Seen running since the core started: only then an exit counts as a crash. */
  sawRunning: boolean;
}

interface History {
  gaveUp: boolean;
  attempts: number;
  lastReason: SelfhealReason | null;
  lastRestartAt: number | null;
}

const keyOf = (serverId: string, name: string): string => `${serverId}\u0000${name}`;

/**
 * Self-healing (api/selfheal.ts). A scheduler job `selfheal.tick` looks at the
 * container state (inventory/events, health field), linked website checks and
 * the M10 state, and restarts hanging containers with container.restart.
 *
 * "Stopped by the admin" is the container's `stop` intent (containers/service.ts):
 * set by the container routes, by scheduled tasks and by M10's auto-stop, held
 * until the container runs again. Any active intent (stop or restart: deploys,
 * game actions, app updates set it too) means "hands off".
 *
 * The loop guard (attempts, gave_up) is derived from selfheal_events, so it
 * survives a core restart; the grace timers are in memory.
 */
export class SelfhealService {
  private readonly watches = new Map<string, Watch>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private removeJob: (() => void) | null = null;
  private lastPrune = 0;

  constructor(
    private readonly ctx: FeatureContext,
    private readonly opts: { tickMs: number },
  ) {}

  get enabled(): boolean {
    return this.ctx.modules.enabled('selfheal');
  }

  start(): void {
    if (this.removeJob) return;
    this.removeJob = this.ctx.scheduler.every('selfheal.tick', this.opts.tickMs, () => this.tick());
  }

  stop(): void {
    this.removeJob?.();
    this.removeJob = null;
  }

  /** Module off: no job, no open alerts, timers forgotten. */
  disable(): void {
    this.stop();
    this.watches.clear();
    this.ctx.alerts.resolveAllWithPrefix('selfheal:');
  }

  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight.values()]);
  }

  // ---- settings and rules -------------------------------------------------------------

  settings(): SelfhealSettings {
    const p = selfhealSettingsSchema.safeParse(readSetting(this.ctx.db, SELFHEAL_SETTING));
    return p.success ? p.data : { ...defaultSelfhealSettings };
  }

  saveSettings(s: SelfhealSettings): void {
    const now = this.ctx.now();
    writeSetting(this.ctx.db, SELFHEAL_SETTING, s, now);
    writeAudit(this.ctx.db, now, {
      actor: 'admin',
      action: 'selfheal.settings',
      details: { ...s },
    });
  }

  private toRule(r: SelfhealRuleRow): SelfhealRule {
    return selfhealRuleSchema.parse({
      serverId: r.serverId,
      container: r.container,
      mode: r.mode,
      checkId: r.checkId,
      updatedAt: r.updatedAt,
    });
  }

  rules(): SelfhealRule[] {
    return this.ctx.db
      .select()
      .from(selfhealRules)
      .all()
      .map((r) => this.toRule(r))
      .sort(
        (a, b) => a.serverId.localeCompare(b.serverId) || a.container.localeCompare(b.container),
      );
  }

  rule(serverId: string, container: string): SelfhealRule | null {
    const r = this.ctx.db
      .select()
      .from(selfhealRules)
      .where(and(eq(selfhealRules.serverId, serverId), eq(selfhealRules.container, container)))
      .get();
    return r ? this.toRule(r) : null;
  }

  checkExists(id: string): boolean {
    return (
      this.ctx.db.select({ id: checks.id }).from(checks).where(eq(checks.id, id)).get() !==
      undefined
    );
  }

  setRule(serverId: string, container: string, mode: SelfhealMode, checkId: string | null): void {
    const now = this.ctx.now();
    const values = { mode, checkId, updatedAt: now };
    this.ctx.db
      .insert(selfhealRules)
      .values({ serverId, container, ...values })
      .onConflictDoUpdate({
        target: [selfhealRules.serverId, selfhealRules.container],
        set: values,
      })
      .run();
    writeAudit(this.ctx.db, now, {
      actor: 'admin',
      action: 'selfheal.rule',
      target: serverId,
      details: { container, mode, checkId },
    });
  }

  deleteRule(serverId: string, container: string): void {
    const now = this.ctx.now();
    const res = this.ctx.db
      .delete(selfhealRules)
      .where(and(eq(selfhealRules.serverId, serverId), eq(selfhealRules.container, container)))
      .run();
    if (res.changes > 0) {
      writeAudit(this.ctx.db, now, {
        actor: 'admin',
        action: 'selfheal.rule_delete',
        target: serverId,
        details: { container },
      });
    }
  }

  // ---- history ------------------------------------------------------------------------

  private addEvent(
    serverId: string,
    container: string,
    reason: SelfhealReason,
    action: EventAction,
    attempt: number,
  ): void {
    this.ctx.db
      .insert(selfhealEvents)
      .values({ at: this.ctx.now(), serverId, container, reason, action, attempt })
      .run();
  }

  private eventsOf(serverId: string, container: string): SelfhealEventRow[] {
    return this.ctx.db
      .select()
      .from(selfhealEvents)
      .where(and(eq(selfhealEvents.serverId, serverId), eq(selfhealEvents.container, container)))
      .orderBy(desc(selfhealEvents.at), desc(selfhealEvents.id))
      .all();
  }

  /** Loop guard state from the events (newest first). */
  private history(serverId: string, container: string, s: SelfhealSettings): History {
    const now = this.ctx.now();
    const rows = this.eventsOf(serverId, container);
    const marker = rows.find(
      (r) => r.action === 'gave_up' || r.action === 'recovered' || r.action === 'reset',
    );
    const clean = rows.find((r) => r.action === 'recovered' || r.action === 'reset');
    const from = now - s.windowMinutes * MIN;
    const restarts = rows.filter((r) => r.action === 'restart' || r.action === 'restart_failed');
    const last = restarts[0];
    return {
      gaveUp: marker?.action === 'gave_up',
      // Restarts in the window that came after the last reset/recovery.
      attempts: restarts.filter((r) => r.at > from && (clean === undefined || r.id > clean.id))
        .length,
      lastReason: (rows[0]?.reason as SelfhealReason | undefined) ?? null,
      lastRestartAt: last?.at ?? null,
    };
  }

  private serverName(serverId: string): string {
    return (
      this.ctx.db.select({ name: servers.name }).from(servers).where(eq(servers.id, serverId)).get()
        ?.name ?? serverId
    );
  }

  /** Containers with a problem, restarts in the window or `gave_up`. */
  state(): SelfhealState[] {
    const s = this.settings();
    const out: SelfhealState[] = [];
    const seen = new Set<string>();
    const keys = this.ctx.db
      .selectDistinct({ serverId: selfhealEvents.serverId, container: selfhealEvents.container })
      .from(selfhealEvents)
      .all();
    for (const c of this.ctx.containers.list()) {
      const w = this.watches.get(keyOf(c.serverId, c.name));
      if (w?.unhealthySince != null) keys.push({ serverId: c.serverId, container: c.name });
    }
    for (const k of keys) {
      const key = keyOf(k.serverId, k.container);
      if (seen.has(key)) continue;
      seen.add(key);
      const h = this.history(k.serverId, k.container, s);
      const restarting = this.inFlight.has(key);
      const pending = this.watches.get(key)?.unhealthySince != null;
      if (!h.gaveUp && !restarting && h.attempts === 0 && !pending) continue;
      out.push(
        selfhealStateSchema.parse({
          serverId: k.serverId,
          serverName: this.serverName(k.serverId),
          container: k.container,
          phase: restarting ? 'restarting' : h.gaveUp ? 'gave_up' : 'watching',
          attempts: h.attempts,
          lastReason: h.lastReason ?? (pending ? 'unhealthy' : null),
          lastRestartAt: h.lastRestartAt,
        }),
      );
    }
    return out.sort(
      (a, b) => a.serverName.localeCompare(b.serverName) || a.container.localeCompare(b.container),
    );
  }

  events(): SelfhealEvent[] {
    return this.ctx.db
      .select({ e: selfhealEvents, serverName: servers.name })
      .from(selfhealEvents)
      .innerJoin(servers, eq(servers.id, selfhealEvents.serverId))
      .orderBy(desc(selfhealEvents.at), desc(selfhealEvents.id))
      .limit(SELFHEAL_EVENTS_LIST)
      .all()
      .map((r) =>
        selfhealEventSchema.parse({
          id: r.e.id,
          at: r.e.at,
          serverId: r.e.serverId,
          serverName: r.serverName,
          container: r.e.container,
          reason: r.e.reason,
          action: r.e.action,
          attempt: r.e.attempt,
        }),
      );
  }

  /** "Zurücksetzen": gave_up/attempts -> watching. Returns false if nothing was to reset. */
  reset(serverId: string, container: string): boolean {
    const s = this.settings();
    const h = this.history(serverId, container, s);
    this.watches.delete(keyOf(serverId, container));
    if (!h.gaveUp && h.attempts === 0) return false;
    this.addEvent(serverId, container, h.lastReason ?? 'unhealthy', 'reset', 0);
    const a = this.ctx.alerts.active(selfhealAlertKey(serverId, container));
    if (a) this.ctx.alerts.resolveById(a.id);
    writeAudit(this.ctx.db, this.ctx.now(), {
      actor: 'admin',
      action: 'selfheal.reset',
      target: serverId,
      details: { container },
    });
    return true;
  }

  prune(): void {
    const cutoff = this.ctx.now() - SELFHEAL_EVENTS_KEEP_DAYS * DAY;
    this.ctx.db.delete(selfhealEvents).where(lt(selfhealEvents.at, cutoff)).run();
  }

  // ---- rule set ---------------------------------------------------------------------------

  tick(): void {
    if (!this.enabled) return;
    const now = this.ctx.now();
    if (now - this.lastPrune >= PRUNE_EVERY_MS) {
      this.lastPrune = now;
      this.prune();
    }
    const s = this.settings();
    const rules = new Map(this.rules().map((r) => [keyOf(r.serverId, r.container), r] as const));
    const live = new Set<string>();
    for (const c of this.ctx.containers.list()) {
      const key = keyOf(c.serverId, c.name);
      live.add(key);
      try {
        this.evaluate(c, key, rules.get(key) ?? null, s, now);
      } catch (err) {
        this.ctx.log.error(
          {
            serverId: c.serverId,
            container: c.name,
            err: err instanceof Error ? err.name : 'error',
          },
          'selfheal evaluate failed',
        );
      }
    }
    for (const key of this.watches.keys()) if (!live.has(key)) this.watches.delete(key);
  }

  private watch(key: string): Watch {
    let w = this.watches.get(key);
    if (!w) {
      w = { unhealthySince: null, healthySince: null, sawRunning: false };
      this.watches.set(key, w);
    }
    return w;
  }

  /** The linked check is DOWN (crit) since at least checkDownMinutes (and since the last restart). */
  private checkDown(
    checkId: string | null,
    s: SelfhealSettings,
    lastRestartAt: number | null,
    now: number,
  ): boolean {
    const st = this.checkState(checkId);
    if (!st.down || st.since === null) return false;
    return now - Math.max(st.since, lastRestartAt ?? -Infinity) >= s.checkDownMinutes * MIN;
  }

  private checkState(checkId: string | null): { down: boolean; since: number | null } {
    if (checkId === null) return { down: false, since: null };
    const r = this.ctx.db
      .select({ status: checks.status, enabled: checks.enabled, downSince: checks.downSince })
      .from(checks)
      .where(eq(checks.id, checkId))
      .get();
    if (!r || !r.enabled || r.status !== 'crit') return { down: false, since: null };
    return { down: true, since: r.downSince };
  }

  private evaluate(
    c: ContainerSummary,
    key: string,
    rule: SelfhealRule | null,
    s: SelfhealSettings,
    now: number,
  ): void {
    // Never hz.role (core, agent).
    if (c.protected) {
      this.watches.delete(key);
      return;
    }
    const mode = rule?.mode ?? s.defaultMode;
    const w = this.watch(key);
    const running = c.state === 'running';
    if (running) w.sawRunning = true;
    if (mode === 'off' || this.inFlight.has(key)) return;
    if (!this.ctx.hub.isConnected(c.serverId)) return;

    const checkId = rule?.checkId ?? null;
    const h = this.history(c.serverId, c.name, s);

    if (h.gaveUp) {
      const healthy = running && c.health !== 'unhealthy' && !this.checkState(checkId).down;
      if (!healthy) {
        w.healthySince = null;
        return;
      }
      w.healthySince ??= now;
      if (now - w.healthySince >= SELFHEAL_RECOVER_MS) this.recovered(c, h, now);
      return;
    }

    const row = this.ctx.containers.row(c.id);
    if (!row) return;
    // Hands off: stopped by the admin, a task or M10 (stop intent), a restart/deploy
    // in progress (restart intent), throttled or auto-stopped by M10.
    if (this.ctx.containers.activeIntent(row) !== null || c.autoStopped || c.throttled !== null) {
      w.unhealthySince = null;
      return;
    }
    // A game container: not while the game is busy (migration, backup, action) or not running.
    if (c.gameId !== null && (this.ctx.games.isBusy(c.gameId) || !running)) {
      w.unhealthySince = null;
      return;
    }

    let reason: SelfhealReason | null = null;
    if (running && c.health === 'unhealthy') {
      w.unhealthySince ??= now;
      if (now - w.unhealthySince >= s.unhealthyGraceSeconds * 1000) reason = 'unhealthy';
    } else {
      w.unhealthySince = null;
    }
    if (
      reason === null &&
      mode === 'unhealthy_or_exited' &&
      (c.state === 'exited' || c.state === 'dead') &&
      w.sawRunning &&
      c.exitCode !== 0 &&
      // An exited `wichtig` container is restarted by M10.
      c.priority !== 'wichtig'
    ) {
      reason = 'exited';
    }
    if (reason === null && running && this.checkDown(checkId, s, h.lastRestartAt, now)) {
      reason = 'check_down';
    }
    if (reason === null) return;

    if (h.lastRestartAt !== null && now - h.lastRestartAt < s.minGapSeconds * 1000) return;
    if (h.attempts >= s.maxRestarts) {
      this.giveUp(c, reason, h, s, now);
      return;
    }
    this.restart(c, key, reason, h.attempts + 1);
  }

  private restart(c: ContainerSummary, key: string, reason: SelfhealReason, attempt: number): void {
    const containers = this.ctx.containers;
    const w = this.watch(key);
    containers.setIntent(c.id, 'restart', INTENT_TTL_MS);
    const audit = (action: string): void =>
      writeAudit(this.ctx.db, this.ctx.now(), {
        actor: 'system',
        action,
        target: c.id,
        details: { serverId: c.serverId, name: c.name, reason, attempt },
      });
    const p = this.ctx.hub
      .call(c.serverId, 'container.restart', { id: c.dockerId }, { timeoutMs: RESTART_TIMEOUT_MS })
      .then(
        () => {
          containers.setIntent(c.id, 'restart', SETTLE_MS);
          this.addEvent(c.serverId, c.name, reason, 'restart', attempt);
          audit('selfheal.restart');
          this.ctx.log.info(
            { serverId: c.serverId, container: c.name, reason, attempt },
            'selfheal restart',
          );
        },
        () => {
          containers.setIntent(c.id, null);
          this.addEvent(c.serverId, c.name, reason, 'restart_failed', attempt);
          audit('selfheal.restart_failed');
        },
      )
      .finally(() => {
        w.unhealthySince = null;
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, p);
  }

  private giveUp(
    c: ContainerSummary,
    reason: SelfhealReason,
    h: History,
    s: SelfhealSettings,
    now: number,
  ): void {
    this.addEvent(c.serverId, c.name, reason, 'gave_up', h.attempts);
    writeAudit(this.ctx.db, now, {
      actor: 'system',
      action: 'selfheal.gave_up',
      target: c.id,
      details: { serverId: c.serverId, name: c.name, reason, attempts: h.attempts },
    });
    this.ctx.alerts.raise(
      selfhealAlertKey(c.serverId, c.name),
      'crit',
      `${c.name} auf ${c.serverName}: Selbstheilung aufgegeben`,
      `${h.attempts} Neustarts in ${s.windowMinutes} Min halfen nicht (${REASON_TEXT[reason]}), seit ${clockTime(now)}. Container prüfen; unter Automatik zurücksetzen.`,
      c.serverId,
      'container',
    );
  }

  private recovered(c: ContainerSummary, h: History, now: number): void {
    this.addEvent(c.serverId, c.name, h.lastReason ?? 'unhealthy', 'recovered', 0);
    const w = this.watches.get(keyOf(c.serverId, c.name));
    if (w) w.healthySince = null;
    writeAudit(this.ctx.db, now, {
      actor: 'system',
      action: 'selfheal.recovered',
      target: c.id,
      details: { serverId: c.serverId, name: c.name },
    });
    this.ctx.alerts.resolve(selfhealAlertKey(c.serverId, c.name), {
      title: `${c.name} auf ${c.serverName} läuft wieder stabil`,
      body: `Seit 10 Min gesund (${clockTime(now)}). Selbstheilung ist wieder aktiv.`,
    });
  }
}
