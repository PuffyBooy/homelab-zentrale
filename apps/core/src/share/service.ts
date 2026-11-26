import { createHmac, randomBytes } from 'node:crypto';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
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
/** After a verified PIN, the same token+PIN skips argon2 this long (in memory). */
export const PIN_GRANT_MS = 10 * MIN;
/** Hard cap of remembered PIN grants (oldest are dropped first). */
export const PIN_GRANT_MAX = 2000;
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
/**
 * Fixed texts a friend may see as status (never free agent/phase text, which
 * can contain container ids, paths or LAN addresses).
 */
export const FRIEND_STATUS_TEXTS = [
  'Läuft',
  'Läuft, aber langsam',
  'Antwortet nicht',
  'Gestört',
  'Gestoppt',
  'Nicht erreichbar',
  'Startet',
  'Startet neu',
  'Wird gestoppt',
  'Backup läuft',
  'Wird eingerichtet',
  'Beschäftigt',
] as const;
export type FriendStatusText = (typeof FRIEND_STATUS_TEXTS)[number];

/** Maps the internal status (games/status.ts) to a fixed friend text. */
export function friendStatusText(
  status: ShareStatus['game']['status'],
  statusText: string,
  phase: string,
): FriendStatusText {
  switch (status) {
    case 'ok':
      return 'Läuft';
    case 'warn':
      return statusText.startsWith('TPS niedrig') ? 'Läuft, aber langsam' : 'Antwortet nicht';
    case 'crit':
      return 'Gestört';
    case 'off':
      return statusText === 'Server offline' ? 'Nicht erreichbar' : 'Gestoppt';
    case 'busy':
      if (phase === 'setup') return 'Wird eingerichtet';
      if (statusText === 'Startet') return 'Startet';
      if (statusText === 'Neustart') return 'Startet neu';
      if (statusText === 'Wird gestoppt') return 'Wird gestoppt';
      if (statusText.startsWith('Backup läuft')) return 'Backup läuft';
      return 'Beschäftigt';
  }
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
  /**
   * Verified PINs (S4): HMAC(processKey, tokenHash|pinHash|pin) → expiry, in LRU
   * order. The key never leaves memory, so the map holds no usable PIN material.
   */
  private readonly pinGrants = new Map<string, number>();
  private readonly grantKey = randomBytes(32);
  /** PIN verifies in flight per link (a saturated counter without one is stale). */
  private readonly pinInFlight = new Map<string, number>();

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
    for (const [k, until] of this.pinGrants) if (until <= now) this.pinGrants.delete(k);
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
   *
   * PIN tries are reserved atomically before the (async) argon2 verify, so
   * parallel requests can never run more than 5 verifies per lock period. While
   * locked (or while all 5 tries are in flight) every PIN, right or wrong, gets 423.
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
    this.checkLock(link);
    let verified = false;
    if (link.pinHash !== null) {
      if (pin === undefined || pin === '') {
        const lockOver = link.lockedUntil !== null && link.lockedUntil <= this.deps.now();
        throw new ShareError(401, 'pin_required', {
          triesLeft: lockOver ? PIN_MAX_FAILURES : Math.max(0, PIN_MAX_FAILURES - link.pinFailures),
        });
      }
      const grant = this.grantId(link, pin);
      if (!this.hasGrant(grant)) {
        await this.verifyPin(link, pin, ip, via);
        verified = true;
        this.addGrant(grant);
      }
    }
    // Re-read: the link may have been revoked or locked while the PIN was checked.
    const fresh = this.row(link.id);
    if (!fresh) throw new ShareError(404, 'not_found');
    this.checkState(fresh);
    this.checkLock(fresh);
    const set: Partial<ShareLinkRow> = {};
    if (verified && fresh.pinFailures !== 0) set.pinFailures = 0;
    if (verified && fresh.lockedUntil !== null) set.lockedUntil = null;
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

  private checkLock(link: ShareLinkRow): void {
    const now = this.deps.now();
    if (link.lockedUntil !== null && link.lockedUntil > now) {
      throw new ShareError(423, 'locked', {
        retryAfter: Math.max(1, Math.ceil((link.lockedUntil - now) / 1000)),
      });
    }
  }

  private grantId(link: ShareLinkRow, pin: string): string {
    return createHmac('sha256', this.grantKey)
      .update(`${link.tokenHash}|${link.pinHash ?? ''}|${pin}`, 'utf8')
      .digest('hex');
  }

  private hasGrant(id: string): boolean {
    const until = this.pinGrants.get(id);
    if (until === undefined) return false;
    if (until <= this.deps.now()) {
      this.pinGrants.delete(id);
      return false;
    }
    return true;
  }

  private addGrant(id: string): void {
    this.pinGrants.delete(id);
    while (this.pinGrants.size >= PIN_GRANT_MAX) {
      const oldest = this.pinGrants.keys().next();
      if (oldest.done) break;
      this.pinGrants.delete(oldest.value);
    }
    this.pinGrants.set(id, this.deps.now() + PIN_GRANT_MS);
  }

  /**
   * Reserves one try (atomic UPDATE … RETURNING), then verifies. Throws 423 when no
   * try is left, 401 pin_wrong for a wrong PIN, 423 for the 5th wrong PIN.
   */
  private async verifyPin(
    link: ShareLinkRow,
    pin: string,
    ip: string | null,
    via: ShareVia,
  ): Promise<void> {
    const now = this.deps.now();
    const c = shareLinks;
    const lockOver = sql`(${c.lockedUntil} IS NOT NULL AND ${c.lockedUntil} <= ${now})`;
    const reserved = this.db
      .update(c)
      .set({
        pinFailures: sql`CASE WHEN ${lockOver} THEN 1 ELSE ${c.pinFailures} + 1 END`,
        lockedUntil: sql`CASE WHEN ${lockOver} THEN NULL ELSE ${c.lockedUntil} END`,
      })
      .where(
        and(
          eq(c.id, link.id),
          sql`((${c.lockedUntil} IS NULL AND ${c.pinFailures} < ${PIN_MAX_FAILURES}) OR ${lockOver})`,
        ),
      )
      .returning({ pinFailures: c.pinFailures })
      .get();
    if (!reserved) {
      const cur = this.row(link.id);
      if (cur) this.checkLock(cur);
      // All tries are taken. Without a verify in flight the counter is stale
      // (e.g. a crash mid-verify): lock, on the safe side.
      if (cur && (this.pinInFlight.get(link.id) ?? 0) === 0) {
        this.lock(cur, ip, via);
      }
      throw new ShareError(423, 'locked', { retryAfter: PIN_LOCK_MS / 1000 });
    }
    const attempt = reserved.pinFailures;
    this.pinInFlight.set(link.id, (this.pinInFlight.get(link.id) ?? 0) + 1);
    let ok: boolean;
    try {
      ok = sharePinSchema.safeParse(pin).success && (await verifyPassword(link.pinHash ?? '', pin));
    } catch {
      ok = false;
    } finally {
      const n = (this.pinInFlight.get(link.id) ?? 1) - 1;
      if (n <= 0) this.pinInFlight.delete(link.id);
      else this.pinInFlight.set(link.id, n);
    }
    if (ok) return;
    const fresh = this.row(link.id) ?? link;
    if (attempt >= PIN_MAX_FAILURES) {
      this.lock(fresh, ip, via);
      throw new ShareError(423, 'locked', { retryAfter: PIN_LOCK_MS / 1000 });
    }
    this.record({ link: fresh, ip, via }, 'pin_failed', null, { action: 'share.pin_failed' });
    // Locked meanwhile by a parallel try: same 423 as everyone else.
    this.checkLock(fresh);
    throw new ShareError(401, 'pin_wrong', { triesLeft: PIN_MAX_FAILURES - attempt });
  }

  private lock(link: ShareLinkRow, ip: string | null, via: ShareVia): void {
    this.db
      .update(shareLinks)
      .set({ pinFailures: PIN_MAX_FAILURES, lockedUntil: this.deps.now() + PIN_LOCK_MS })
      .where(eq(shareLinks.id, link.id))
      .run();
    this.record({ link, ip, via }, 'pin_locked', null, { action: 'share.pin_locked' });
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
        // Fixed texts only: agent errors and phase texts never reach the friend.
        statusText: friendStatusText(s.status, s.statusText, row.phase),
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
