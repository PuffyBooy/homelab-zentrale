import { z } from 'zod';
import { alertSchema } from './alerts.js';

/**
 * Web console, wall mode, settings export (SPEC 11, 12, 13; SECURITY).
 */

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

// ---- web console (SPEC 11) -----------------------------------------------------------
//
// Browser ↔ core: wss://<core>/console?serverId=<id> (session cookie, Origin
// check, step-up session required at open. An open console may outlive the
// step-up, but closes after 15 min idle or 60 min in total).
// Core ↔ agent: rpc `pty.open` (stream), `pty.input`, `pty.resize`, `pty.close`;
// output arrives as stream.data (base64 not needed: utf-8 text chunks).
// The agent refuses pty.* unless HZ_AGENT_ALLOW_TERMINAL=1 (error terminal_disabled),
// the core refuses unless the server has allowTerminal (settings, step-up).
// Each session is logged (who, when, duration, bytes), never keystrokes or output.

export const consoleQuerySchema = z.strictObject({
  serverId: z.string().min(1).max(64),
  /** M23: core container id for a shell inside that container instead of the host. */
  container: idSchema.optional(),
});

const ptySize = {
  cols: z.number().int().min(10).max(500),
  rows: z.number().int().min(5).max(200),
};

/** Browser → core. */
export const consoleClientMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('open'), ...ptySize }),
  /** Keystrokes / paste, max 16 KiB per message. */
  z.strictObject({
    type: z.literal('input'),
    data: z
      .string()
      .min(1)
      .max(16 * 1024),
  }),
  z.strictObject({ type: z.literal('resize'), ...ptySize }),
  z.strictObject({ type: z.literal('close') }),
  z.strictObject({ type: z.literal('ping') }),
]);
export type ConsoleClientMessage = z.infer<typeof consoleClientMessageSchema>;

export const consoleCloseReasonSchema = z.enum([
  /** The shell exited. */
  'exit',
  'closed',
  'idle_timeout',
  'max_duration',
  'agent_offline',
  'terminal_disabled',
  'step_up_required',
  'not_allowed',
  /** Already CONSOLE_MAX_PER_SERVER consoles open on this server. */
  'busy',
  /** Input flood (more than the input rate cap). */
  'rate_limited',
  'error',
]);
export type ConsoleCloseReason = z.infer<typeof consoleCloseReasonSchema>;

/** Limits of the web console (enforced by the core). */
export const CONSOLE_MAX_PER_SERVER = 2;
export const CONSOLE_IDLE_MINUTES = 15;
export const CONSOLE_MAX_MINUTES = 60;
/** Input cap: messages and bytes per CONSOLE_INPUT_WINDOW_MS. */
export const CONSOLE_INPUT_WINDOW_MS = 10_000;
export const CONSOLE_INPUT_MAX_MESSAGES = 400;
export const CONSOLE_INPUT_MAX_BYTES = 512 * 1024;

/** Core → browser. */
export const consoleServerMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready'), sessionId: idSchema }),
  z.strictObject({ type: z.literal('output'), data: z.string().max(64 * 1024) }),
  z.strictObject({
    type: z.literal('closed'),
    reason: consoleCloseReasonSchema,
    exitCode: z.number().int().nullable(),
  }),
  z.strictObject({ type: z.literal('pong') }),
]);
export type ConsoleServerMessage = z.infer<typeof consoleServerMessageSchema>;

// GET /api/console/sessions?serverId=&limit= -> newest first
export const consoleSessionListQuerySchema = z.strictObject({
  serverId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const consoleSessionSchema = z.strictObject({
  id: idSchema,
  serverId: z.string(),
  serverName: z.string(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  durationSec: z.number().int().nonnegative().nullable(),
  reason: consoleCloseReasonSchema.nullable(),
  /** Client IP (tailnet). */
  ip: z.string().max(64).nullable(),
  bytesIn: z.number().int().nonnegative(),
  bytesOut: z.number().int().nonnegative(),
});
export const consoleSessionListResponseSchema = z.strictObject({
  sessions: z.array(consoleSessionSchema),
});

// ---- wall mode (SPEC 12) ------------------------------------------------------------
//
// The tablet opens /wall?t=<token>. The token is ONE-TIME (decision 2026-11-26):
// POST /api/wall/session swaps it once for an httpOnly cookie `hz_wall`
// (SameSite=Strict, Secure, path /api/wall). The token hash is then invalidated and
// the cookie carries a new random device session secret (only its SHA-256 hash is
// stored). A second exchange of the same token is 401 (rate limited), except when
// the request already carries a valid wall cookie of that device: then the repeated
// token is ignored and the answer is 200 (kiosk browsers reload the start URL).
// After cookie loss the device must be relinked:
// POST /api/settings/wall-devices/:id/link (step-up) issues a fresh one-time link
// and invalidates the old cookie. The device cookie is read-only: it can only read
// GET /api/wall/state. Deleting the device revokes everything at once.

export const wallTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** Name of the device cookie (path /api/wall, only GET /api/wall/state accepts it). */
export const WALL_COOKIE = 'hz_wall';

export const wallDeviceSchema = z.strictObject({
  id: idSchema,
  name: z.string(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime().nullable(),
  /** true once the one-time link was exchanged for a cookie (and not relinked since). */
  paired: z.boolean(),
});
// GET /api/settings/wall-devices
export const wallDeviceListResponseSchema = z.strictObject({
  devices: z.array(wallDeviceSchema),
});
// POST /api/settings/wall-devices (step-up) { name } -> { device, url } (url with token, shown once, also as QR)
export const wallDeviceCreateRequestSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[\p{L}\p{N} ._-]+$/u),
});
export const wallDeviceCreateResponseSchema = z.strictObject({
  device: wallDeviceSchema,
  url: z.string(),
});
// POST /api/settings/wall-devices/:id/link (step-up) -> { device, url } (fresh one-time
// link, shown once; the old link and the old cookie stop working)
export const wallDeviceLinkResponseSchema = wallDeviceCreateResponseSchema;
// DELETE /api/settings/wall-devices/:id -> { ok }
export const wallDeviceParamsSchema = z.strictObject({ id: idSchema });

// POST /api/wall/session { token } -> sets cookie, { ok }  (public, rate limited)
export const wallSessionRequestSchema = z.strictObject({ token: wallTokenSchema });

export const wallToneSchema = z.enum(['ok', 'warn', 'crit', 'off']);

/** One big tile (Metric size="wall"). A problem tile turns red as a whole. */
export const wallTileSchema = z.strictObject({
  id: z.enum(['servers', 'players', 'temperature', 'power', 'problems']),
  label: z.string(),
  /** Already formatted (Austrian format): "4/4", "3", "21,5", "420". */
  value: z.string(),
  unit: z.string().nullable(),
  hint: z.string().nullable(),
  tone: wallToneSchema,
});

// GET /api/wall/state (wall cookie or admin session) -> read only, no ids, no IPs
export const wallStateSchema = z.strictObject({
  tiles: z.array(wallTileSchema).max(8),
  /** Open crit/warn alerts, at most 5, titles only. */
  alerts: z.array(alertSchema.pick({ level: true, title: true, openedAt: true })).max(5),
  /** "Alles läuft." or "2 Probleme · 3 von 4 Servern laufen". */
  sentence: z.string(),
  /** 22–7 Uhr local time (HZ_TIMEZONE): dim to 40 %, crit stays bright. */
  night: z.boolean(),
  updatedAt: z.iso.datetime(),
});
export type WallState = z.infer<typeof wallStateSchema>;

// ---- settings: backup of the hub itself (SPEC 13) -------------------------------------
//
// POST /api/settings/export (step-up) -> application/octet-stream download of a
// consistent SQLite snapshot (VACUUM INTO a temp file), file name
// "homelab-zentrale-YYYYMMDD-HHmm.sqlite". Secrets inside stay AES-GCM encrypted;
// without HZ_SECRET_KEY the export cannot decrypt them. Audit `settings.export`.
