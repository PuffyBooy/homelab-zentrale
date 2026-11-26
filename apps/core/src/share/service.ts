import { desc, eq, lt, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { shareConsoleLineSchema, shareExpirySchema } from '@hz/shared';
import {
  shareAuditEntrySchema,
  shareConsoleResponseSchema,
  shareGatewaySettingsSchema,
  shareLinkSchema,
  sharePermSchema,
  sharePinSchema,
  sharePlayerNameSchema,
  shareStatusResponseSchema,
  shareTokenSchema,
  type ShareLink,
  type SharePerm,
  type ShareStatus,
} from '@hz/shared';
import { RpcError } from '../agents/hub.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import type { Clock } from '../clock.js';
import { containerLogsTopic, type ContainerLogs } from '../containers/logs.js';
import { randomToken, sha256Hex, timingSafeEqual } from '../crypto.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { shareAudit, shareLinks, type ShareLinkRow } from '../db/schema.js';
import { readSetting, writeSetting } from '../db/settings.js';
import { HttpError } from '../http/errors.js';
import type { GameService } from '../games/service.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** Requests per minute per client IP and API (NETWORK.md "Share-Gateway"), same as the gateway. */
export const SHARE_IP_LIMIT = 10;
/** GET console polls per minute per client IP (own budget, same as the gateway). */
export const SHARE_CONSOLE_IP_LIMIT = 30;
/** Requests per minute per share token over all IPs (API calls / console polls). */
export const SHARE_TOKEN_LIMIT = 20;
export const SHARE_CONSOLE_TOKEN_LIMIT = 60;
export const SHARE_LIMIT_WINDOW_MS = MIN;
/** 5 wrong PINs lock the link for 15 minutes. */
export const PIN_MAX_FAILURES = 5;
export const PIN_LOCK_MS = 15 * MIN;
/** `view` and `console_read` are audited at most once per 10 minutes per link. */
export const READ_AUDIT_MS = 10 * MIN;
export const SHARE_AUDIT_RETENTION_MS = 90 * DAY;
/** The container log stream stays open this long after the last console poll. */
export const LOG_LEASE_MS = 2 * MIN;
/** lastSeenAt of the gateway and last_used_at of a link are written at most this often. */
const TOUCH_MS = MIN;
const CONSOLE_MAX_LINES = 500;
const CONSOLE_LINE_MAX = 4096;
const OUTPUT_MAX = 16 * 1024;
/** Templates whose RCON knows `whitelist add|remove <player>`. Bedrock has no RCON. */
const WHITELIST_TEMPLATES = new Set(['minecraft-java']);

const EXPIRY_MS: Record<ShareExpiry, number | null> = {
  '1d': DAY,
  '7d': 7 * DAY,
  '14d': 14 * DAY,
  '30d': 30 * DAY,
  never: null,
};

/** Domain-separated hashes (a share token never matches another table). */
export const shareTokenHash = (t: string): string => sha256Hex(`share:${t}`);
export const gatewayTokenHash = (t: string): string => sha256Hex(`gateway:${t}`);

export type ShareVia = 'tailnet' | 'gateway';
export type ShareErrorCode =
  | 'not_found'
  | 'revoked'
  | 'expired'
  | 'pin_required'
  | 'pin_wrong'
  | 'locked'
  | 'forbidden'
  | 'rate_limited'
  | 'invalid_input'
  | 'busy'
  | 'unavailable';
export type ShareAuditAction = z.infer<typeof shareAuditEntrySchema>['action'];
export type ShareLinkView = z.infer<typeof shareLinkSchema>;
type ConsoleLine = z.infer<typeof shareConsoleLineSchema>;
type ShareExpiry = z.infer<typeof shareExpirySchema>;

/** Expected failure of the share API; only these codes reach the friend. */
export class ShareError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ShareErrorCode,
    public readonly extra: { retryAfter?: number; triesLeft?: number } = {},
  ) {
    super(code);
    this.name = 'ShareError';
  }
}

/** A friend request that passed token, state and PIN checks. */
export interface ShareContext {
  link: ShareLinkRow;
  perms: SharePerm[];
  ip: string | null;
  via: ShareVia;
}

const storedGatewaySchema = z.object({
  enabled: z.boolean().default(false),
  publicUrl: z.string().nullable().default(null),
  tokenHash: z.string().nullable().default(null),
  lastSeenAt: z.number().nullable().default(null),
});
type StoredGateway = z.infer<typeof storedGatewaySchema>;
const GATEWAY_KEY = 'share.gateway';

const iso = (ms: number): string => new Date(ms).toISOString();

/** Tailscale addresses: 100.64.0.0/10, fd7a:115c:a1e0::/48 and MagicDNS names. */
const TS_IPV4 = /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g;
const TS_IPV6 = /fd7a:115c:a1e0:[0-9a-f:]*/gi;
const TS_NAME = /\b[A-Za-z0-9.-]*\.ts\.net\b/gi;

/** Whether `text` contains a Tailscale address or name. */
export function hasTailnetAddress(text: string): boolean {
  return [TS_IPV4, TS_IPV6, TS_NAME].some((re) => new RegExp(re.source, re.flags).test(text));
}

/** Masks Tailscale addresses in text shown to friends (console lines). */
export function maskTailnet(text: string): string {
  return text
    .replace(TS_IPV4, '[intern]')
    .replace(TS_IPV6, '[intern]')
    .replace(TS_NAME, '[intern]');
}
const PERM_ORDER = sharePermSchema.options;
const CURSOR_RE = /^(\d{1,15})\.(\d{1,15})(?:\.\d{1,6})?$/;

function parsePerms(json: string): SharePerm[] {
  try {
    const p = z.array(sharePermSchema).safeParse(JSON.parse(json));
    return p.success ? p.data : [];
  } catch {
    return [];
  }
}

function cut(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

export interface ShareServiceDeps {
  db: Db;
  now: Clock;
  games: GameService;
  logs: Pick<ContainerLogs, 'lease' | 'snapshot'>;
  log: FastifyBaseLogger;
}

/**
 * Share links (SPEC 6.4): admin side (create, list, revoke, delete, audit,
 * gateway settings) and the friend API (status, actions, console, whitelist).
 * Every friend request checks token, state, PIN and the permission again.
 */
export class ShareService {
  /** Last `view` / `console_read` audit per link (in memory). */
  private readonly readAudits = new Map<string, number>();

  constructor(private readonly deps: ShareServiceDeps) {}

  private get db(): Db {
    return this.deps.db;
  }

  // ---- admin -----------------------------------------------------------------------

  private stateOf(row: ShareLinkRow): ShareLink['state'] {
    if (row.revokedAt !== null) return 'revoked';
    if (row.expiresAt !== null && row.expiresAt <= this.deps.now()) return 'expired';
    return 'active';
  }

  toLink(row: ShareLinkRow): ShareLinkView {
    const now = this.deps.now();
    return shareLinkSchema.parse({
      id: row.id,
      gameId: row.gameId,
      person: row.person,
      perms: parsePerms(row.permsJson),
      hasPin: row.pinHash !== null,
      state: this.stateOf(row),
      expiresAt: row.expiresAt === null ? null : iso(row.expiresAt),
      revokedAt: row.revokedAt === null ? null : iso(row.revokedAt),
      lastUsedAt: row.lastUsedAt === null ? null : iso(row.lastUsedAt),
      lockedUntil: row.lockedUntil !== null && row.lockedUntil > now ? iso(row.lockedUntil) : null,
      createdAt: iso(row.createdAt),
    });
  }

  row(id: string): ShareLinkRow | undefined {
    return this.db.select().from(shareLinks).where(eq(shareLinks.id, id)).get();
  }

  /** Newest first. */
  list(gameId: string): ShareLinkView[] {
    return this.db
      .select()
      .from(shareLinks)
      .where(eq(shareLinks.gameId, gameId))
      .orderBy(desc(shareLinks.createdAt))
      .all()
      .map((r) => this.toLink(r));
  }

  /** Creates a link. The plain token is returned once and never stored. */
  async create(
    gameId: string,
    req: { person: string; perms: SharePerm[]; expires: ShareExpiry; pin?: string | undefined },
  ): Promise<{ share: ShareLinkView; token: string }> {
    if (!this.deps.games.row(gameId)) throw new HttpError(404, 'not_found');
    const now = this.deps.now();
    const token = randomToken(32);
    const id = randomToken(12);
    const perms = PERM_ORDER.filter((p) => req.perms.includes(p));
    const ttl = EXPIRY_MS[req.expires];
    const pinHash = req.pin === undefined ? null : await hashPassword(req.pin);
    this.db
      .insert(shareLinks)
      .values({
        id,
        gameId,
        person: req.person,
        tokenHash: shareTokenHash(token),
        pinHash,
        permsJson: JSON.stringify(perms),
        expiresAt: ttl === null ? null : now + ttl,
        createdAt: now,
      })
      .run();
    return { share: this.toLink(this.row(id) as ShareLinkRow), token };
  }

  /** Revokes at once (idempotent). */
  revoke(id: string): ShareLinkView | null {
    const row = this.row(id);
    if (!row) return null;
    if (row.revokedAt === null) {
      this.db
        .update(shareLinks)
        .set({ revokedAt: this.deps.now() })
        .where(eq(shareLinks.id, id))
        .run();
    }
    return this.toLink(this.row(id) as ShareLinkRow);
  }

  /** Deletes a revoked or expired link (the audit stays). */
  remove(id: string): 'ok' | 'not_found' | 'active' {
    const row = this.row(id);
    if (!row) return 'not_found';
    if (this.stateOf(row) === 'active') return 'active';
    this.db.delete(shareLinks).where(eq(shareLinks.id, id)).run();
    this.readAudits.delete(`${id}:view`);
    this.readAudits.delete(`${id}:console_read`);
    return 'ok';
  }

  /** Newest first. */
  auditEntries(gameId: string, limit: number): z.infer<typeof shareAuditEntrySchema>[] {
    return this.db
      .select()
      .from(shareAudit)
      .where(eq(shareAudit.gameId, gameId))
      .orderBy(desc(shareAudit.ts), desc(sql`rowid`))
      .limit(limit)
      .all()
      .map((r) =>
        shareAuditEntrySchema.parse({
          id: r.id,
          shareId: r.shareId,
          person: r.person,
          action: r.action,
          detail: r.detail,
          ts: iso(r.ts),
          ip: r.ip,
          via: r.via,
        }),
      );
  }

  /** Removes share audit entries older than 90 days. Returns the count. */
  prune(maxAgeMs = SHARE_AUDIT_RETENTION_MS): number {
    const now = this.deps.now();
    for (const [k, ts] of this.readAudits) if (now - ts >= READ_AUDIT_MS) this.readAudits.delete(k);
    return this.db
      .delete(shareAudit)
      .where(lt(shareAudit.ts, now - maxAgeMs))
      .run().changes;
  }

  // ---- gateway settings ----------------------------------------------------------------

  private gateway(): StoredGateway {
    const p = storedGatewaySchema.safeParse(readSetting(this.db, GATEWAY_KEY) ?? {});
    return p.success
      ? p.data
      : { enabled: false, publicUrl: null, tokenHash: null, lastSeenAt: null };
  }

  private writeGateway(g: StoredGateway): void {
    writeSetting(this.db, GATEWAY_KEY, g, this.deps.now());
  }

  gatewaySettings(): z.infer<typeof shareGatewaySettingsSchema> {
    const g = this.gateway();
    return shareGatewaySettingsSchema.parse({
      enabled: g.enabled,
      publicUrl: g.publicUrl,
      tokenSet: g.tokenHash !== null,
      lastSeenAt: g.lastSeenAt === null ? null : iso(g.lastSeenAt),
    });
  }

  setGateway(enabled: boolean, publicUrl: string | null): void {
    const url = publicUrl === null ? null : publicUrl.replace(/\/+$/, '');
    this.writeGateway({ ...this.gateway(), enabled, publicUrl: url });
  }

  /** New gateway token (shown once); the old one stops working at once. */
  newGatewayToken(): string {
    const token = randomToken(32);
    this.writeGateway({ ...this.gateway(), tokenHash: gatewayTokenHash(token) });
    return token;
  }

  /** Constant-time check of the gateway token against the stored hash. */
  gatewayTokenOk(token: string | undefined): boolean {
    const stored = this.gateway().tokenHash;
    const given = gatewayTokenHash(token ?? '');
    // Compare even without a stored hash, so timing does not tell whether one is set.
    const ok = timingSafeEqual(given, stored ?? sha256Hex('gateway-unset'));
    return ok && stored !== null && token !== undefined && token.length > 0;
  }

  gatewayEnabled(): boolean {
    return this.gateway().enabled;
  }

  /** Public link base, only while the gateway is on. */
  publicBase(): string | null {
    const g = this.gateway();
    return g.enabled && g.publicUrl ? g.publicUrl : null;
  }

  touchGateway(): void {
    const g = this.gateway();
    const now = this.deps.now();
    if (g.lastSeenAt === null || now - g.lastSeenAt >= TOUCH_MS) {
      this.writeGateway({ ...g, lastSeenAt: now });
    }
  }

  // ---- friend: authentication --------------------------------------------------------

  /** Records a friend action in share_audit and (optionally) audit_log. */
  private record(
    ctx: { link: ShareLinkRow; ip: string | null; via: ShareVia },
    action: ShareAuditAction,
    detail: string | null,
    auditLog: { action: string; details?: Record<string, unknown> } | null,
  ): void {
    const ts = this.deps.now();
    this.db
      .insert(shareAudit)
      .values({
        id: randomToken(12),
        shareId: ctx.link.id,
        gameId: ctx.link.gameId,
        person: ctx.link.person,
        action,
        detail: detail === null ? null : cut(detail, 200),
        ts,
        ip: ctx.ip === null ? null : cut(ctx.ip, 64),
        via: ctx.via,
      })
      .run();
    if (auditLog) {
      writeAudit(this.db, ts, {
        actor: `share:${ctx.link.id}`,
        action: auditLog.action,
        target: ctx.link.gameId,
        details: { person: ctx.link.person, via: ctx.via, ip: ctx.ip, ...auditLog.details },
      });
    }
  }

  /** At most once per 10 minutes per link and kind. */
  private recordRead(ctx: ShareContext, action: 'view' | 'console_read'): void {
    const key = `${ctx.link.id}:${action}`;
    const now = this.deps.now();
    const last = this.readAudits.get(key);
    if (last !== undefined && now - last < READ_AUDIT_MS) return;
    this.readAudits.set(key, now);
    this.record(ctx, action, null, { action: `share.${action}` });
  }

  /**
   * Token → link, then state (revoked/expired 410), lock (423) and PIN (401).
   * Unknown and malformed tokens give the same 404.
   */
  async authenticate(
    token: string | undefined,
    pin: string | undefined,
    ip: string | null,
    via: ShareVia,
  ): Promise<ShareContext> {
    if (token === undefined || !shareTokenSchema.safeParse(token).success) {
      throw new ShareError(404, 'not_found');
    }
    const hash = shareTokenHash(token);
    const link = this.db.select().from(shareLinks).where(eq(shareLinks.tokenHash, hash)).get();
    if (!link) throw new ShareError(404, 'not_found');
    this.checkState(link);
    const now = this.deps.now();
    if (link.lockedUntil !== null && link.lockedUntil > now) {
      throw new ShareError(423, 'locked', {
        retryAfter: Math.max(1, Math.ceil((link.lockedUntil - now) / 1000)),
      });
    }
    if (link.pinHash !== null) {
      if (pin === undefined || pin === '') {
        throw new ShareError(401, 'pin_required', {
          triesLeft: Math.max(0, PIN_MAX_FAILURES - link.pinFailures),
        });
      }
      const ok = sharePinSchema.safeParse(pin).success && (await verifyPassword(link.pinHash, pin));
      if (!ok) this.pinFailed(link, ip, via);
    }
    // Re-read: the link may have been revoked or locked while the PIN was checked.
    const fresh = this.row(link.id);
    if (!fresh) throw new ShareError(404, 'not_found');
    this.checkState(fresh);
    if (fresh.lockedUntil !== null && fresh.lockedUntil > this.deps.now()) {
      throw new ShareError(423, 'locked', {
        retryAfter: Math.max(1, Math.ceil((fresh.lockedUntil - this.deps.now()) / 1000)),
      });
    }
    const set: Partial<ShareLinkRow> = {};
    if (fresh.pinFailures !== 0) set.pinFailures = 0;
    if (fresh.lastUsedAt === null || this.deps.now() - fresh.lastUsedAt >= TOUCH_MS) {
      set.lastUsedAt = this.deps.now();
    }
    if (Object.keys(set).length > 0) {
      this.db.update(shareLinks).set(set).where(eq(shareLinks.id, fresh.id)).run();
    }
    return { link: { ...fresh, ...set }, perms: parsePerms(fresh.permsJson), ip, via };
  }

  private checkState(link: ShareLinkRow): void {
    if (link.revokedAt !== null) throw new ShareError(410, 'revoked');
    if (link.expiresAt !== null && link.expiresAt <= this.deps.now()) {
      throw new ShareError(410, 'expired');
    }
  }

  private pinFailed(link: ShareLinkRow, ip: string | null, via: ShareVia): never {
    this.db
      .update(shareLinks)
      .set({ pinFailures: sql`${shareLinks.pinFailures} + 1` })
      .where(eq(shareLinks.id, link.id))
      .run();
    const fresh = this.row(link.id) ?? link;
    const ctx = { link: fresh, ip, via };
    if (fresh.pinFailures >= PIN_MAX_FAILURES) {
      this.db
        .update(shareLinks)
        .set({ pinFailures: 0, lockedUntil: this.deps.now() + PIN_LOCK_MS })
        .where(eq(shareLinks.id, link.id))
        .run();
      this.record(ctx, 'pin_locked', null, { action: 'share.pin_locked' });
      throw new ShareError(423, 'locked', { retryAfter: PIN_LOCK_MS / 1000 });
    }
    this.record(ctx, 'pin_failed', null, { action: 'share.pin_failed' });
    throw new ShareError(401, 'pin_wrong', { triesLeft: PIN_MAX_FAILURES - fresh.pinFailures });
  }

  /** 403 and an audit entry unless the link has one of `perms`. Nothing else happens. */
  private require(ctx: ShareContext, perms: SharePerm[], what: string): void {
    if (perms.some((p) => ctx.perms.includes(p))) return;
    this.record(ctx, 'denied', what, { action: 'share.denied', details: { what } });
    throw new ShareError(403, 'forbidden');
  }

  // ---- friend: API -------------------------------------------------------------------

  private whitelistSupported(gameId: string): boolean {
    const row = this.deps.games.row(gameId);
    return !!row && WHITELIST_TEMPLATES.has(row.templateId) && this.deps.games.hasRcon(gameId);
  }

  private statusOf(ctx: ShareContext): ShareStatus {
    const games = this.deps.games;
    const row = games.row(ctx.link.gameId);
    const s = games.summary(ctx.link.gameId);
    if (!row || !s) throw new ShareError(404, 'not_found');
    const ext = row.externalAddress.trim();
    const port = s.ports[0]?.port;
    const status = {
      person: ctx.link.person,
      perms: ctx.perms,
      expiresAt: ctx.link.expiresAt === null ? null : iso(ctx.link.expiresAt),
      game: {
        name: s.name,
        game: s.game,
        version: s.version,
        status: s.status,
        statusText: maskTailnet(s.statusText),
        // Only what Alex entered for friends; never the Tailscale IP or server name.
        // An external address that is itself a tailnet address is not shown either.
        address:
          ext === '' || hasTailnetAddress(ext) ? null : port === undefined ? ext : `${ext}:${port}`,
        players: s.players && { ...s.players, names: s.players.names.map(maskTailnet) },
        whitelist: this.whitelistSupported(ctx.link.gameId),
      },
    };
    return strictOut(shareStatusResponseSchema, status);
  }

  status(ctx: ShareContext): ShareStatus {
    const out = this.statusOf(ctx);
    this.recordRead(ctx, 'view');
    return out;
  }

  async action(ctx: ShareContext, action: 'start' | 'stop' | 'restart'): Promise<ShareStatus> {
    this.require(ctx, [action === 'restart' ? 'restart' : 'power'], action);
    // A restart of a stopped or crashed server would start it (compose up), so
    // without "power" a restart is only allowed while the server runs.
    if (action === 'restart' && !ctx.perms.includes('power')) {
      const st = this.deps.games.summary(ctx.link.gameId)?.status;
      if (st !== 'ok' && st !== 'warn') {
        this.record(ctx, 'denied', 'restart_not_running', {
          action: 'share.denied',
          details: { what: 'restart_not_running' },
        });
        throw new ShareError(403, 'forbidden');
      }
    }
    try {
      await this.deps.games.action(ctx.link.gameId, action, `share:${ctx.link.id}`);
    } catch (err) {
      const e = shareErrorOf(err);
      writeAudit(this.db, this.deps.now(), {
        actor: `share:${ctx.link.id}`,
        action: `game.${action}_failed`,
        target: ctx.link.gameId,
        details: { person: ctx.link.person, via: ctx.via, error: e.code },
      });
      throw e;
    }
    // audit_log: GameService.action writes game.<action> with actor share:<id>.
    this.record(ctx, action, null, null);
    return this.statusOf(ctx);
  }

  /**
   * Console lines newer than `after`: the game's console/error events and the
   * container log lines. The id of a line is the cursor `<event>.<log>` after it.
   */
  console(ctx: ShareContext, after: string | undefined): { lines: ConsoleLine[] } {
    this.require(ctx, ['console_read', 'console_write'], 'console_read');
    let g = 0;
    let l = 0;
    if (after !== undefined) {
      const m = CURSOR_RE.exec(after);
      if (!m) throw new ShareError(400, 'invalid_input');
      g = Number(m[1]);
      l = Number(m[2]);
    }
    const games = this.deps.games;
    const id = ctx.link.gameId;
    const nowIso = iso(this.deps.now());
    const containerId = games.containerIdOf(id);
    let logLines: { seq: number; stream: 'stdout' | 'stderr'; text: string }[] = [];
    if (containerId !== null) {
      const topic = containerLogsTopic(containerId);
      this.deps.logs.lease(topic, LOG_LEASE_MS);
      logLines = this.deps.logs.snapshot(topic)?.lines ?? [];
    }
    // A restarted log stream starts its sequence at 0 again.
    const lastLog = logLines.at(-1);
    if (lastLog !== undefined && l > lastLog.seq + 1) l = 0;
    if (g > games.nextEventSeq(id)) g = 0;

    const out: ConsoleLine[] = [];
    for (const e of games.consoleEvents(id, g)) {
      g = Number(e.id) + 1;
      const kind = e.kind === 'error' ? 'err' : e.text.startsWith('> ') ? 'cmd' : 'out';
      const parts = maskTailnet(games.scrubFor(id, e.text)).replace(/\r/g, '').split('\n');
      if (parts.length > 1 && parts.at(-1) === '') parts.pop();
      parts.forEach((text, k) => {
        out.push({
          id: k === parts.length - 1 ? `${g}.${l}` : `${g}.${l}.${k}`,
          text: cut(text, CONSOLE_LINE_MAX),
          kind,
          ts: e.ts,
        });
      });
    }
    for (const line of logLines) {
      if (line.seq < l) continue;
      l = line.seq + 1;
      out.push({
        id: `${g}.${l}`,
        text: cut(maskTailnet(games.scrubFor(id, line.text)), CONSOLE_LINE_MAX),
        kind: line.stream === 'stderr' ? 'err' : 'out',
        ts: nowIso,
      });
    }
    const result = strictOut(shareConsoleResponseSchema, { lines: out.slice(-CONSOLE_MAX_LINES) });
    this.recordRead(ctx, 'console_read');
    return result;
  }

  async command(ctx: ShareContext, command: string): Promise<{ output: string }> {
    this.require(ctx, ['console_write'], 'console_write');
    const output = await this.rcon(ctx, command, 'game.rcon');
    this.record(ctx, 'console_write', command, { action: 'game.rcon', details: { command } });
    return { output };
  }

  async whitelist(
    ctx: ShareContext,
    op: 'add' | 'remove',
    player: string,
  ): Promise<{ output: string }> {
    this.require(ctx, ['whitelist'], `whitelist_${op}`);
    // Checked again here: the name goes into an RCON command line.
    if (!sharePlayerNameSchema.safeParse(player).success) {
      throw new ShareError(400, 'invalid_input');
    }
    if (!this.whitelistSupported(ctx.link.gameId)) throw new ShareError(403, 'forbidden');
    const command = `whitelist ${op} ${player}`;
    const output = await this.rcon(ctx, command, `game.whitelist_${op}`);
    this.record(ctx, `whitelist_${op}`, player, {
      action: `game.whitelist_${op}`,
      details: { player },
    });
    return { output };
  }

  private async rcon(ctx: ShareContext, command: string, auditAction: string): Promise<string> {
    if (!this.deps.games.hasRcon(ctx.link.gameId)) throw new ShareError(403, 'forbidden');
    try {
      const out = await this.deps.games.rcon(ctx.link.gameId, command);
      return cut(maskTailnet(out), OUTPUT_MAX);
    } catch (err) {
      const e = shareErrorOf(err);
      // Rate-limited attempts never reach the agent and are not audited.
      if (e.code !== 'rate_limited') {
        writeAudit(this.db, this.deps.now(), {
          actor: `share:${ctx.link.id}`,
          action: `${auditAction}_failed`,
          target: ctx.link.gameId,
          details: { person: ctx.link.person, via: ctx.via, error: e.code },
        });
      }
      throw e;
    }
  }

  /** For tests: forget the read-audit throttle. */
  resetReadAudits(): void {
    this.readAudits.clear();
  }
}

/** Game/agent errors → share error codes; internals never reach the friend. */
export function shareErrorOf(err: unknown): ShareError {
  if (err instanceof ShareError) return err;
  if (err instanceof HttpError) {
    switch (err.code) {
      case 'busy':
        return new ShareError(409, 'busy');
      case 'rate_limited':
        return new ShareError(
          429,
          'rate_limited',
          err.retryAfter === undefined ? {} : { retryAfter: err.retryAfter },
        );
      case 'not_found':
        return new ShareError(404, 'not_found');
      case 'conflict':
      case 'forbidden':
        return new ShareError(403, 'forbidden');
      case 'invalid_input':
        return new ShareError(400, 'invalid_input');
      default:
        return new ShareError(503, 'unavailable');
    }
  }
  if (err instanceof RpcError) return new ShareError(503, 'unavailable');
  return new ShareError(503, 'unavailable');
}

/** Thrown when a response does not fit its strict schema (a bug, never sent). */
export class ResponseShapeError extends Error {
  constructor() {
    super('share response does not match its schema');
    this.name = 'ResponseShapeError';
  }
}

/** Validates a friend response with its strict schema before it is sent. */
export function strictOut<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const p = schema.safeParse(data);
  if (!p.success) throw new ResponseShapeError();
  return p.data;
}
