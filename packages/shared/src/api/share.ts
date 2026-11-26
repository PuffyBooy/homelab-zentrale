import { z } from 'zod';
import { gameNameSchema, gameStatusSchema } from './games.js';

/**
 * Share links (SPEC 6.4, SECURITY, NETWORK "Share-Gateway").
 *
 * A friend gets a link `/s/<token>` for exactly one game server. The token has
 * 256 bits (base64url, 43 chars); only its SHA-256 is stored. Optional 4-digit
 * PIN (argon2id hash). Permissions are checked by the core on every request.
 *
 * The share page (mini UI from apps/share) talks to a small API that never sees
 * the token in a URL path: the page reads it from `location.pathname` and sends
 * it in the header `Authorization: Share <token>` (PIN in `X-Share-Pin`).
 * - In the tailnet the core serves the page at `/s/<token>` and the API at
 *   `/s/api/*` (no admin session, own rate limits).
 * - The optional public gateway (apps/share on oracle-a1) serves the same page
 *   and forwards `/s/api/*` to the core's `/api/share-gateway/*`, authenticated
 *   with `Authorization: Bearer <HZ_SHARE_GATEWAY_TOKEN>`. The friend's share
 *   token goes in `X-Share-Token: <token>` (not in Authorization), the PIN in
 *   `X-Share-Pin` and the friend's IP in `X-Share-Client-Ip`. The core refuses
 *   that API while the gateway is off and accepts nothing else under it.
 *
 * Both share APIs answer with the same schemas below and never return internal
 * data: no Tailscale IPs, no server names or ids, no container ids, no other
 * games, no values, no RCON details.
 */

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export const shareIdParamsSchema = z.strictObject({ id: idSchema });

/** 32 random bytes, base64url without padding. */
export const shareTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const sharePinSchema = z.string().regex(/^\d{4}$/);

export const sharePermSchema = z.enum([
  /** Start and stop. */
  'power',
  'restart',
  'console_read',
  /** Send RCON commands; implies console_read. */
  'console_write',
  /** whitelist add/remove (Minecraft only, player name checked strictly). */
  'whitelist',
  /**
   * M12: ask to be put on the whitelist; the admin approves (push). For links
   * without `whitelist`. Minecraft only.
   */
  'whitelist_request',
  /** M12: download the world as tar.zst (as long as the link is valid, 1 per hour). */
  'world_download',
]);
export type SharePerm = z.infer<typeof sharePermSchema>;

export const shareExpirySchema = z.enum(['1d', '7d', '14d', '30d', 'never']);

/** "Max", "Lena K." — shown to the admin and on the friend's page. */
export const sharePersonSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[\p{L}\p{N} ._'-]+$/u, { message: "Nur Buchstaben, Ziffern, Leerzeichen und . _ ' -" });

/** Minecraft Java/Bedrock player name for whitelist edits. */
export const sharePlayerNameSchema = z.string().regex(/^[A-Za-z0-9_]{3,16}$/);

// ---- admin side (session) -------------------------------------------------------

export const shareStateSchema = z.enum(['active', 'expired', 'revoked']);

export const shareLinkSchema = z.strictObject({
  id: idSchema,
  gameId: idSchema,
  person: z.string(),
  perms: z.array(sharePermSchema),
  hasPin: z.boolean(),
  state: shareStateSchema,
  expiresAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  lastUsedAt: z.iso.datetime().nullable(),
  /** PIN locked after 5 wrong tries, until this time. */
  lockedUntil: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type ShareLink = z.infer<typeof shareLinkSchema>;

// GET /api/games/:id/shares
export const shareListResponseSchema = z.strictObject({ shares: z.array(shareLinkSchema) });

// POST /api/games/:id/shares -> 201
export const shareCreateRequestSchema = z.strictObject({
  person: sharePersonSchema,
  perms: z.array(sharePermSchema).min(1).max(7),
  expires: shareExpirySchema,
  pin: sharePinSchema.optional(),
});
export const shareCreateResponseSchema = z.strictObject({
  share: shareLinkSchema,
  /** Shown once. Tailnet link always; public link only when the gateway is on. */
  urls: z.strictObject({ tailnet: z.string(), public: z.string().nullable() }),
});

// POST /api/shares/:id/revoke -> { share } (immediately 410 for the friend)
// DELETE /api/shares/:id -> { ok } (only revoked or expired links; audit stays)
export const shareResponseSchema = z.strictObject({ share: shareLinkSchema });

export const shareAuditActionSchema = z.enum([
  'view',
  'start',
  'stop',
  'restart',
  'console_read',
  'console_write',
  'whitelist_add',
  'whitelist_remove',
  'whitelist_request',
  'world_download',
  'pin_failed',
  'pin_locked',
  'denied',
]);

// GET /api/games/:id/share-audit?limit= -> newest first
export const shareAuditQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const shareAuditEntrySchema = z.strictObject({
  id: idSchema,
  shareId: idSchema,
  person: z.string(),
  action: shareAuditActionSchema,
  /** Command or player name for console_write / whitelist_*; null otherwise. */
  detail: z.string().max(200).nullable(),
  ts: z.iso.datetime(),
  /** Client IP as seen by the core (tailnet) or reported by the gateway. */
  ip: z.string().max(64).nullable(),
  via: z.enum(['tailnet', 'gateway']),
});
export const shareAuditResponseSchema = z.strictObject({
  entries: z.array(shareAuditEntrySchema),
});

// GET /api/settings/share-gateway; PUT (step-up) { enabled, publicUrl }
export const shareGatewaySettingsSchema = z.strictObject({
  enabled: z.boolean(),
  /** e.g. "https://spiel.example.duckdns.org"; links become <publicUrl>/s/<token>. */
  publicUrl: z.url({ protocol: /^https$/ }).nullable(),
  tokenSet: z.boolean(),
  lastSeenAt: z.iso.datetime().nullable(),
});
export const shareGatewaySettingsRequestSchema = z.strictObject({
  enabled: z.boolean(),
  publicUrl: z
    .url({ protocol: /^https$/ })
    .max(200)
    .nullable(),
});
// POST /api/settings/share-gateway/token (step-up) -> new token, shown once; old one stops working.
export const shareGatewayTokenResponseSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

// ---- friend side (share API, tailnet /s/api/* and gateway /api/share-gateway/*) ----

/** Error codes of the share API (HTTP status in brackets). */
export const shareErrorCodeSchema = z.enum([
  /** Unknown token (404). Same answer for malformed tokens. */
  'not_found',
  /** Revoked (410). */
  'revoked',
  /** Expired (410): "Link abgelaufen". */
  'expired',
  /** PIN needed or wrong (401); `triesLeft` in the body. */
  'pin_required',
  'pin_wrong',
  /** 5 wrong PINs, locked for 15 min (423); retryAfter seconds. */
  'locked',
  /** Permission missing (403). */
  'forbidden',
  'rate_limited',
  'invalid_input',
  /** Another action is running (409). */
  'busy',
  /** Server cannot be reached right now (503). */
  'unavailable',
  /** Game start refused, not enough RAM free on the server (409). No details for friends. */
  'insufficient_ram',
]);
export const shareErrorResponseSchema = z.strictObject({
  ok: z.literal(false),
  error: shareErrorCodeSchema,
  retryAfter: z.number().int().optional(),
  triesLeft: z.number().int().min(0).max(5).optional(),
});

// GET /s/api/status
export const shareStatusResponseSchema = z.strictObject({
  person: z.string(),
  perms: z.array(sharePermSchema),
  expiresAt: z.iso.datetime().nullable(),
  game: z.strictObject({
    name: gameNameSchema,
    /** Template name, e.g. "Minecraft Java". */
    game: z.string(),
    version: z.string().nullable(),
    status: gameStatusSchema,
    /** German, same texts as the admin UI. */
    statusText: z.string(),
    /** Only the external address the admin entered ("mc.example.at:25565"); never a Tailscale IP. */
    address: z.string().nullable(),
    players: z
      .strictObject({ online: z.number().int(), max: z.number().int(), names: z.array(z.string()) })
      .nullable(),
    /** Whitelist editing makes sense only for Minecraft templates. */
    whitelist: z.boolean(),
    /** M12: asleep, a start (or connecting, if wake-on-connect is on) wakes it. */
    sleeping: z.boolean(),
  }),
  /** M12: the friend's own whitelist request, newest first (max 5). */
  whitelistRequests: z.array(
    z.strictObject({
      player: z.string(),
      state: z.enum(['pending', 'approved', 'rejected']),
      createdAt: z.iso.datetime(),
    }),
  ),
});
export type ShareStatus = z.infer<typeof shareStatusResponseSchema>;

// POST /s/api/action { action } -> status
export const shareActionRequestSchema = z.strictObject({
  action: z.enum(['start', 'stop', 'restart']),
});

// GET /s/api/console?after= -> console lines (needs console_read or console_write)
export const shareConsoleQuerySchema = z.strictObject({
  /** Line id from the last answer; only newer lines are returned. */
  after: z.string().max(64).optional(),
});
export const shareConsoleLineSchema = z.strictObject({
  id: z.string().max(64),
  text: z.string().max(4096),
  kind: z.enum(['out', 'cmd', 'err']),
  ts: z.iso.datetime(),
});
export const shareConsoleResponseSchema = z.strictObject({
  lines: z.array(shareConsoleLineSchema).max(500),
});

// POST /s/api/console { command } -> { output } (needs console_write)
export const shareCommandRequestSchema = z.strictObject({
  command: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((c) => !/[\r\n\0]/.test(c), { message: 'single line only' }),
});
export const shareCommandResponseSchema = z.strictObject({ output: z.string().max(16 * 1024) });

// POST /s/api/whitelist { op, player } -> { output } (needs whitelist)
export const shareWhitelistRequestSchema = z.strictObject({
  op: z.enum(['add', 'remove']),
  player: sharePlayerNameSchema,
});

// POST /s/api/whitelist-request { player } -> status (needs whitelist_request)
// Max 3 pending requests per link, 5 per hour; same player twice -> 409 busy.
export const shareWhitelistAskSchema = z.strictObject({ player: sharePlayerNameSchema });

// GET /s/api/world (needs world_download) -> application/zstd stream,
// Content-Disposition attachment "<name>-welt.tar.zst". 1 per link per hour
// (429 rate_limited), size limit WORLD_DOWNLOAD_MAX_BYTES (503 unavailable).
export const WORLD_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024 * 1024;
