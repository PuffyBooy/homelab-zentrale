import { and, asc, eq, gte, isNull, lt, or, sql } from 'drizzle-orm';
import type { GameStats, GameStatusData } from '@hz/shared';
import { localTime } from '../calendar.js';
import type { Clock } from '../clock.js';
import type { Db } from '../db/index.js';
import { gamePlayerHours, gamePlayerSessions, type GameServerRow } from '../db/schema.js';
import type { GameService } from './service.js';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** Sessions and hour buckets are kept this long. */
export const STATS_RETENTION_MS = 90 * DAY_MS;
export const PLAYER_NAME_MAX = 40;
/** At most this many names per status answer are tracked. */
const MAX_NAMES = 100;
const MAX_PLAYERS_OUT = 200;
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}]/gu;

/** Player name as stored: control and format characters removed, max 40 characters. */
export function cleanPlayerName(name: string): string {
  return [...name.replace(CONTROL, '').trim()].slice(0, PLAYER_NAME_MAX).join('');
}

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Player statistics (SPEC 6.5) from the status polls: one session per player
 * name and stretch of being online, and per UTC hour the sum of players over
 * the polls and the peak. Hours of day are shown in HZ_TIMEZONE.
 */
export class GameStatsService {
  constructor(private readonly deps: { db: Db; now: Clock; games: GameService }) {
    deps.games.onStatus((row, st) => this.record(row, st));
  }

  /** One status poll of a game (`st` null: offline or stopped, open sessions end). */
  record(row: GameServerRow, st: GameStatusData | null): void {
    const db = this.deps.db;
    const now = this.deps.now();
    const open = db
      .select()
      .from(gamePlayerSessions)
      .where(and(eq(gamePlayerSessions.gameId, row.id), isNull(gamePlayerSessions.endedAt)))
      .all();
    const players = st?.online ? st.players : null;
    const names = new Set(
      (players?.names ?? [])
        .slice(0, MAX_NAMES)
        .map(cleanPlayerName)
        .filter((n) => n !== ''),
    );
    db.transaction((tx) => {
      for (const s of open) {
        if (names.has(s.player)) {
          tx.update(gamePlayerSessions)
            .set({ lastSeen: now })
            .where(eq(gamePlayerSessions.id, s.id))
            .run();
          names.delete(s.player);
        } else {
          tx.update(gamePlayerSessions)
            .set({ endedAt: now })
            .where(eq(gamePlayerSessions.id, s.id))
            .run();
        }
      }
      for (const player of names) {
        tx.insert(gamePlayerSessions)
          .values({ gameId: row.id, player, startedAt: now, lastSeen: now, endedAt: null })
          .run();
      }
      if (players) {
        const online = Math.max(0, players.online);
        const hourTs = Math.floor(now / HOUR_MS) * HOUR_MS;
        const h = gamePlayerHours;
        tx.insert(h)
          .values({
            gameId: row.id,
            hourTs,
            samples: 1,
            playersSum: online,
            peak: online,
            peakAt: now,
          })
          .onConflictDoUpdate({
            target: [h.gameId, h.hourTs],
            set: {
              samples: sql`${h.samples} + 1`,
              playersSum: sql`${h.playersSum} + ${online}`,
              peakAt: sql`CASE WHEN ${online} > ${h.peak} THEN ${now} ELSE ${h.peakAt} END`,
              peak: sql`MAX(${h.peak}, ${online})`,
            },
          })
          .run();
      }
    });
  }

  stats(gameId: string, days: 7 | 30): GameStats {
    const db = this.deps.db;
    const now = this.deps.now();
    const from = now - days * DAY_MS;
    const sessions = db
      .select()
      .from(gamePlayerSessions)
      .where(
        and(
          eq(gamePlayerSessions.gameId, gameId),
          or(isNull(gamePlayerSessions.endedAt), gte(gamePlayerSessions.endedAt, from)),
        ),
      )
      .all();
    const per = new Map<string, { seconds: number; sessions: number; lastSeen: number }>();
    for (const s of sessions) {
      const end = s.endedAt ?? now;
      const start = Math.max(s.startedAt, from);
      const p = per.get(s.player) ?? { seconds: 0, sessions: 0, lastSeen: 0 };
      p.seconds += Math.max(0, Math.round((end - start) / 1000));
      p.sessions += 1;
      p.lastSeen = Math.max(p.lastSeen, s.endedAt ?? s.lastSeen);
      per.set(s.player, p);
    }
    const players = [...per]
      .map(([name, p]) => ({ name, ...p, lastSeen: iso(p.lastSeen) }))
      .sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name))
      .slice(0, MAX_PLAYERS_OUT);

    const buckets = db
      .select()
      .from(gamePlayerHours)
      .where(and(eq(gamePlayerHours.gameId, gameId), gte(gamePlayerHours.hourTs, from - HOUR_MS)))
      .orderBy(asc(gamePlayerHours.hourTs))
      .all();
    const sum = new Array<number>(24).fill(0);
    let peak: { online: number; at: number } | null = null;
    let anyPlayers = false;
    for (const b of buckets) {
      const h = localTime(b.hourTs).hour;
      if (b.samples > 0) sum[h] = (sum[h] ?? 0) + b.playersSum / b.samples;
      if (b.peak > 0) anyPlayers = true;
      if (peak === null || b.peak > peak.online) peak = { online: b.peak, at: b.peakAt };
    }
    // Hours without a bucket (game off) count as 0 players.
    const hours = sum.map((v) => Math.round((v / days) * 100) / 100);
    return {
      days,
      players,
      hours,
      peak: peak === null ? null : { online: peak.online, at: iso(peak.at) },
      names: players.length > 0 || !anyPlayers,
    };
  }

  /** Daily: drops sessions and hour buckets older than 90 days. */
  prune(): number {
    const cut = this.deps.now() - STATS_RETENTION_MS;
    const a = this.deps.db
      .delete(gamePlayerSessions)
      .where(and(lt(gamePlayerSessions.lastSeen, cut), lt(gamePlayerSessions.startedAt, cut)))
      .run().changes;
    const b = this.deps.db
      .delete(gamePlayerHours)
      .where(lt(gamePlayerHours.hourTs, cut))
      .run().changes;
    return a + b;
  }
}
