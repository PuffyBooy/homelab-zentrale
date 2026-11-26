import { and, count, desc, eq, gte } from 'drizzle-orm';
import { sharePlayerNameSchema, whitelistRequestSchema, type WhitelistRequest } from '@hz/shared';
import type { AlertService } from '../alerts/service.js';
import type { Clock } from '../clock.js';
import { randomToken } from '../crypto.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { whitelistRequests, type WhitelistRequestRow } from '../db/schema.js';
import { HttpError } from '../http/errors.js';
import type { GameService } from './service.js';

const HOUR_MS = 60 * 60_000;
/** Open requests per link. */
export const WHITELIST_PENDING_MAX = 3;
/** New requests per link and hour. */
export const WHITELIST_PER_HOUR = 5;
const LIST_MAX = 50;
const OWN_MAX = 5;

export type WhitelistState = WhitelistRequest['state'];
export type AskResult =
  | { ok: true; request: WhitelistRequestRow }
  | { ok: false; reason: 'duplicate' | 'too_many' | 'rate_limited'; retryAfter?: number };

const iso = (ms: number): string => new Date(ms).toISOString();
const alertKey = (id: string): string => `whitelist:${id}`;

/**
 * Whitelist requests of friends (share link right `whitelist_request`, SPEC 6.5):
 * a friend enters a player name, the admin gets a push and approves (RCON
 * whitelistAddCommand of the template, the game must run) or rejects.
 */
export class WhitelistRequests {
  constructor(
    private readonly deps: { db: Db; now: Clock; games: GameService; alerts: AlertService },
  ) {}

  /** The template has a whitelist command and the game speaks RCON. */
  supported(gameId: string): boolean {
    const g = this.deps.games;
    const row = g.row(gameId);
    const t = row ? g.templates.get(row.templateId)?.template : undefined;
    return t?.rcon.whitelistAddCommand !== undefined && g.hasRcon(gameId);
  }

  toApi(r: WhitelistRequestRow): WhitelistRequest {
    return whitelistRequestSchema.parse({
      id: r.id,
      gameId: r.gameId,
      shareId: r.shareId,
      person: r.person,
      player: r.player,
      state: r.state,
      createdAt: iso(r.createdAt),
      decidedAt: r.decidedAt === null ? null : iso(r.decidedAt),
    });
  }

  row(id: string): WhitelistRequestRow | undefined {
    return this.deps.db.select().from(whitelistRequests).where(eq(whitelistRequests.id, id)).get();
  }

  list(gameId: string): WhitelistRequest[] {
    return this.deps.db
      .select()
      .from(whitelistRequests)
      .where(eq(whitelistRequests.gameId, gameId))
      .orderBy(desc(whitelistRequests.createdAt))
      .limit(LIST_MAX)
      .all()
      .map((r) => this.toApi(r));
  }

  /** The link's own requests, newest first (share status). */
  ofShare(shareId: string): { player: string; state: WhitelistState; createdAt: string }[] {
    return this.deps.db
      .select()
      .from(whitelistRequests)
      .where(eq(whitelistRequests.shareId, shareId))
      .orderBy(desc(whitelistRequests.createdAt))
      .limit(OWN_MAX)
      .all()
      .map((r) => ({
        player: r.player,
        state: r.state as WhitelistState,
        createdAt: iso(r.createdAt),
      }));
  }

  /** A friend asks. Limits per link: 3 open, 5 per hour; the same player twice is refused. */
  ask(link: { id: string; gameId: string; person: string }, player: string): AskResult {
    if (!sharePlayerNameSchema.safeParse(player).success) throw new HttpError(400, 'invalid_input');
    const db = this.deps.db;
    const now = this.deps.now();
    const w = whitelistRequests;
    const same = db
      .select({ id: w.id })
      .from(w)
      .where(and(eq(w.gameId, link.gameId), eq(w.player, player), eq(w.state, 'pending')))
      .get();
    if (same) return { ok: false, reason: 'duplicate' };
    const pending =
      db
        .select({ n: count() })
        .from(w)
        .where(and(eq(w.shareId, link.id), eq(w.state, 'pending')))
        .get()?.n ?? 0;
    if (pending >= WHITELIST_PENDING_MAX) return { ok: false, reason: 'too_many' };
    const recent = db
      .select({ createdAt: w.createdAt })
      .from(w)
      .where(and(eq(w.shareId, link.id), gte(w.createdAt, now - HOUR_MS)))
      .orderBy(w.createdAt)
      .all();
    if (recent.length >= WHITELIST_PER_HOUR) {
      const first = recent[0]?.createdAt ?? now;
      return {
        ok: false,
        reason: 'rate_limited',
        retryAfter: Math.max(1, Math.ceil((first + HOUR_MS - now) / 1000)),
      };
    }
    const row: WhitelistRequestRow = {
      id: randomToken(12),
      gameId: link.gameId,
      shareId: link.id,
      person: link.person,
      player,
      state: 'pending',
      createdAt: now,
      decidedAt: null,
    };
    db.insert(w).values(row).run();
    const game = this.deps.games.row(link.gameId);
    // Push to the admin (info alerts are pushed at once, outside quiet hours).
    this.deps.alerts.log(
      alertKey(row.id),
      'info',
      `${link.person} möchte auf die Whitelist von ${game?.name ?? 'Gameserver'}: ${player}`,
      'Im Gameserver bestätigen oder ablehnen.',
      game?.serverId ?? null,
      'game',
    );
    return { ok: true, request: row };
  }

  /** approve: whitelistAddCommand over RCON (409 when the game does not run). */
  async decide(id: string, decision: 'approve' | 'reject'): Promise<WhitelistRequest> {
    const r = this.row(id);
    if (!r) throw new HttpError(404, 'not_found');
    if (r.state !== 'pending') throw new HttpError(409, 'conflict');
    const g = this.deps.games;
    const game = g.row(r.gameId);
    if (!game) throw new HttpError(404, 'not_found');
    if (decision === 'approve') {
      const cmd = g.templates.get(game.templateId)?.template.rcon.whitelistAddCommand;
      // Checked again: the name goes into an RCON command line.
      if (!cmd || !sharePlayerNameSchema.safeParse(r.player).success || !g.hasRcon(game.id)) {
        throw new HttpError(409, 'conflict');
      }
      if (game.phase !== 'running' || !g.isRunning(game.id)) {
        throw new HttpError(409, 'conflict', undefined, 'Gameserver läuft nicht');
      }
      await g.rcon(game.id, cmd.replace('{player}', r.player));
    }
    const now = this.deps.now();
    const state = decision === 'approve' ? 'approved' : 'rejected';
    this.deps.db
      .update(whitelistRequests)
      .set({ state, decidedAt: now })
      .where(eq(whitelistRequests.id, id))
      .run();
    writeAudit(this.deps.db, now, {
      actor: 'admin',
      action: `game.whitelist_request_${state}`,
      target: game.id,
      details: { name: game.name, player: r.player, person: r.person, shareId: r.shareId },
    });
    return this.toApi(this.row(id) as WhitelistRequestRow);
  }
}
