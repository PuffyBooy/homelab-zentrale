import { asc, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { gameScheduleSchema, type GameSchedule } from '@hz/shared';
import { nextWallClock } from '../calendar.js';
import type { Clock } from '../clock.js';
import { randomToken } from '../crypto.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { gameSchedules, type GameScheduleRow } from '../db/schema.js';
import type { Scheduler } from '../scheduler.js';
import type { GameService } from './service.js';

const MIN = 60_000;
/** Restart warnings: minutes before the restart. */
export const RESTART_WARNINGS = [5, 1] as const;
export const SCHEDULE_TICK_MS = MIN;

const daysOf = (json: string): number[] => {
  try {
    const p = z.array(z.number().int().min(1).max(7)).safeParse(JSON.parse(json));
    return p.success ? p.data : [];
  } catch {
    return [];
  }
};

/** First run of the schedule strictly after `from` (ISO weekday 7 = Sunday = JS 0). */
export function nextRun(s: Pick<GameSchedule, 'days' | 'time'>, from: number): number | null {
  const [h, m] = s.time.split(':').map(Number);
  if (h === undefined || m === undefined || s.days.length === 0) return null;
  let best: number | null = null;
  for (const d of s.days) {
    const at = nextWallClock(from, { hour: h, minute: m, weekday: d % 7 });
    if (best === null || at < best) best = at;
  }
  return best;
}

const warnText = (min: number): string =>
  min === 1 ? 'Neustart in 1 Minute' : `Neustart in ${min} Minuten`;

/**
 * Schedules per game server (SPEC 6.5): restart or backup at weekdays and HH:MM
 * in HZ_TIMEZONE. Checked every minute. A restart warns players over RCON
 * (template sayCommand) 5 and 1 minute before; a game that does not run or
 * sleeps is not restarted (and never woken). A backup runs in any state.
 */
export class GameScheduleService {
  private lastCheck: number;

  constructor(
    private readonly deps: {
      db: Db;
      now: Clock;
      games: GameService;
      scheduler: Scheduler;
      log: FastifyBaseLogger;
    },
  ) {
    this.lastCheck = deps.now();
  }

  start(): void {
    this.lastCheck = this.deps.now();
    this.deps.scheduler.every('games.schedules', SCHEDULE_TICK_MS, () => this.tick(), {
      align: true,
    });
  }

  private rows(gameId?: string): GameScheduleRow[] {
    return this.deps.db
      .select()
      .from(gameSchedules)
      .where(gameId === undefined ? undefined : eq(gameSchedules.gameId, gameId))
      .orderBy(asc(gameSchedules.gameId), asc(gameSchedules.position))
      .all();
  }

  private toApi(r: GameScheduleRow): GameSchedule {
    return gameScheduleSchema.parse({
      kind: r.kind,
      days: daysOf(r.daysJson),
      time: r.time,
      enabled: r.enabled,
    });
  }

  list(gameId: string): { schedules: GameSchedule[]; next: (string | null)[] } {
    const now = this.deps.now();
    const schedules = this.rows(gameId).map((r) => this.toApi(r));
    return {
      schedules,
      next: schedules.map((s) => {
        const at = s.enabled ? nextRun(s, now) : null;
        return at === null ? null : new Date(at).toISOString();
      }),
    };
  }

  /** Replaces the whole list of a game. */
  replace(gameId: string, list: readonly GameSchedule[]): void {
    const now = this.deps.now();
    this.deps.db.transaction((tx) => {
      tx.delete(gameSchedules).where(eq(gameSchedules.gameId, gameId)).run();
      list.forEach((s, position) => {
        tx.insert(gameSchedules)
          .values({
            id: randomToken(12),
            gameId,
            position,
            kind: s.kind,
            daysJson: JSON.stringify([...s.days].sort((a, b) => a - b)),
            time: s.time,
            enabled: s.enabled,
            lastRunAt: null,
            createdAt: now,
          })
          .run();
      });
    });
  }

  /**
   * Every minute: everything due in (lastCheck, now]. Missed minutes (core was
   * down longer) are not caught up beyond the last tick window.
   */
  async tick(): Promise<void> {
    const now = this.deps.now();
    const from = Math.max(this.lastCheck, now - 2 * MIN);
    this.lastCheck = now;
    if (!this.deps.games.enabled) return;
    for (const r of this.rows()) {
      if (!r.enabled) continue;
      const s = this.toApi(r);
      try {
        if (s.kind === 'restart') {
          for (const min of RESTART_WARNINGS) {
            const at = nextRun(s, from + min * MIN);
            if (at !== null && at - min * MIN <= now) await this.warn(r, min);
          }
        }
        const at = nextRun(s, from);
        if (at !== null && at <= now) await this.run(r, s.kind);
      } catch (err) {
        this.deps.log.error(
          { gameId: r.gameId, err: err instanceof Error ? err.name : 'error' },
          'schedule failed',
        );
      }
    }
  }

  /** Whether a restart makes sense: the game runs (not stopped, not asleep). */
  private runs(gameId: string): boolean {
    const g = this.deps.games;
    const row = g.row(gameId);
    return !!row && row.phase === 'running' && !row.sleeping && g.isRunning(gameId);
  }

  private async warn(r: GameScheduleRow, min: number): Promise<void> {
    const g = this.deps.games;
    const row = g.row(r.gameId);
    const say = row ? g.templates.get(row.templateId)?.template.rcon.sayCommand : undefined;
    if (!row || !say || !g.hasRcon(r.gameId) || !this.runs(r.gameId)) return;
    try {
      await g.rcon(r.gameId, say.replace('{msg}', warnText(min)));
    } catch {
      // A missed warning never blocks the restart.
    }
  }

  private async run(r: GameScheduleRow, kind: GameSchedule['kind']): Promise<void> {
    const g = this.deps.games;
    const row = g.row(r.gameId);
    if (!row) return;
    const now = this.deps.now();
    this.deps.db
      .update(gameSchedules)
      .set({ lastRunAt: now })
      .where(eq(gameSchedules.id, r.id))
      .run();
    const audit = (action: string, details: Record<string, unknown> = {}): void =>
      writeAudit(this.deps.db, now, {
        actor: 'system',
        action,
        target: r.gameId,
        details: { name: row.name, kind, time: r.time, ...details },
      });
    if (kind === 'restart' && !this.runs(r.gameId)) {
      const reason = row.sleeping ? 'schläft' : 'läuft nicht';
      g.pushEvent(r.gameId, 'progress', `Geplanter Neustart übersprungen: ${reason}`);
      audit('game.schedule_skipped', { reason: row.sleeping ? 'sleeping' : 'not_running' });
      return;
    }
    g.pushEvent(
      r.gameId,
      'progress',
      kind === 'restart' ? 'Geplanter Neustart' : 'Geplantes Backup',
    );
    try {
      await g.action(r.gameId, kind, 'system');
      audit('game.schedule_run');
    } catch (err) {
      const code = err instanceof Error && 'code' in err ? String(err.code) : 'failed';
      g.pushEvent(
        r.gameId,
        'error',
        kind === 'restart'
          ? 'Geplanter Neustart fehlgeschlagen'
          : 'Geplantes Backup fehlgeschlagen',
      );
      audit('game.schedule_failed', { error: code.slice(0, 40) });
    }
  }
}
