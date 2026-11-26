import { z } from 'zod';
import {
  banIpSchema,
  fail2banJailSchema,
  imageScanDataSchema,
  jailNameSchema,
  LOG_MATCH_MAX_CHARS,
  LOG_SEARCH_MAX_MATCHES,
  LOG_SEARCH_MAX_MINUTES,
  logQuerySchema,
} from '../agent-ops.js';
import { serverIdSchema } from './servers.js';

/**
 * Optional operations modules (thread "Log-Suche, Scans, Discord-Bot und Echo
 * Show", 2026-11-26). Every module is off by default and switched under
 * Einstellungen → Module; a disabled module answers 404 module_disabled.
 *
 * - logsearch:  search the container logs of all servers at once
 * - vulnscan:   nightly Trivy scan of the images of running containers
 * - fail2ban:   jails and banned IPs per server, unban
 * - discordbot: Discord bot for friends with the rights of their share links
 * - voice:      Echo Show / Alexa through Home Assistant (helpers in HA)
 *
 * All routes need the admin session.
 */

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const isoTs = z.iso.datetime();
const count = z.number().int().nonnegative();

// ---- logsearch ------------------------------------------------------------------

// POST /api/logsearch -> LogSearchResponse (rate limit 10/min per session)
export const logSearchRequestSchema = z.strictObject({
  query: logQuerySchema,
  caseSensitive: z.boolean().default(false),
  sinceMinutes: z.number().int().min(5).max(LOG_SEARCH_MAX_MINUTES).default(60),
  /** Empty or missing: all connected servers. */
  serverIds: z.array(serverIdSchema).max(50).optional(),
  /** Substring of the container name (e.g. "nginx"); missing: all containers. */
  container: z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9_.-]*$/)
    .optional(),
  maxMatches: z.number().int().min(1).max(LOG_SEARCH_MAX_MATCHES).default(200),
});
export type LogSearchRequest = z.infer<typeof logSearchRequestSchema>;

export const logSearchHitSchema = z.strictObject({
  serverId: serverIdSchema,
  serverName: z.string().max(64),
  containerId: z.string().max(128),
  containerName: z.string().max(128),
  ts: isoTs.nullable(),
  stream: z.enum(['stdout', 'stderr']),
  text: z.string().max(LOG_MATCH_MAX_CHARS),
});
export type LogSearchHit = z.infer<typeof logSearchHitSchema>;

export const logSearchServerStateSchema = z.enum([
  'ok',
  /** Agent not connected. */
  'offline',
  /** Agent too old for logs.search (not_allowed). */
  'unsupported',
  'failed',
  /** No container matched the name filter. */
  'no_containers',
]);
export const logSearchResponseSchema = z.strictObject({
  /** Newest first over all servers. */
  hits: z.array(logSearchHitSchema).max(LOG_SEARCH_MAX_MATCHES),
  servers: z.array(
    z.strictObject({
      serverId: serverIdSchema,
      name: z.string().max(64),
      state: logSearchServerStateSchema,
      scannedContainers: count,
      truncated: z.boolean(),
    }),
  ),
  tookMs: count,
});
export type LogSearchResponse = z.infer<typeof logSearchResponseSchema>;

// ---- vulnscan -------------------------------------------------------------------

export const vulnAlertLevelSchema = z.enum(['critical', 'high']);
export const vulnScanSettingsSchema = z.strictObject({
  /** Local time (HZ_TIMEZONE) of the nightly scan, "HH:MM". */
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  /** Raise a warn alert from this severity on ("critical" = only critical). */
  alertFrom: vulnAlertLevelSchema,
});
export type VulnScanSettings = z.infer<typeof vulnScanSettingsSchema>;
export const VULNSCAN_DEFAULTS: VulnScanSettings = { time: '03:30', alertFrom: 'critical' };

export const vulnScanResultSchema = z.strictObject({
  serverId: serverIdSchema,
  serverName: z.string().max(64),
  containerName: z.string().max(128),
  scan: imageScanDataSchema,
});
export type VulnScanResult = z.infer<typeof vulnScanResultSchema>;

// GET /api/vulnscan -> VulnScanState
export const vulnScanStateSchema = z.strictObject({
  settings: vulnScanSettingsSchema,
  running: z.boolean(),
  /** Containers done / total of the running scan. */
  progress: z.strictObject({ done: count, total: count }).nullable(),
  lastRunAt: isoTs.nullable(),
  nextRunAt: isoTs.nullable(),
  /** Servers whose agent cannot scan (offline, too old) at the last run. */
  skippedServers: z.array(z.strictObject({ serverId: serverIdSchema, name: z.string().max(64) })),
  /** Sorted: most critical first. */
  results: z.array(vulnScanResultSchema),
});
export type VulnScanState = z.infer<typeof vulnScanStateSchema>;
// PUT /api/vulnscan/settings VulnScanSettings -> VulnScanState
// POST /api/vulnscan/run -> 202 VulnScanState (409 busy, 429 rate_limited: 1 per 10 min)

// ---- fail2ban -------------------------------------------------------------------

export const fail2banServerStateSchema = z.enum([
  'ok',
  'not_installed',
  'offline',
  'unsupported',
  'failed',
]);
export const fail2banServerSchema = z.strictObject({
  serverId: serverIdSchema,
  name: z.string().max(64),
  state: fail2banServerStateSchema,
  jails: z.array(fail2banJailSchema),
  fetchedAt: isoTs,
});
export type Fail2banServer = z.infer<typeof fail2banServerSchema>;
// GET /api/fail2ban -> { servers } (live from the agents, cached 30 s)
export const fail2banResponseSchema = z.strictObject({ servers: z.array(fail2banServerSchema) });
export type Fail2banResponse = z.infer<typeof fail2banResponseSchema>;
// POST /api/fail2ban/unban -> Fail2banServer (audit fail2ban.unban)
export const fail2banUnbanRequestSchema = z.strictObject({
  serverId: serverIdSchema,
  jail: jailNameSchema,
  ip: banIpSchema,
});

// ---- discordbot -----------------------------------------------------------------

/** Discord ids (user, guild, application) are snowflakes. */
export const snowflakeSchema = z.string().regex(/^\d{17,20}$/);
/** Bot token from the Developer Portal. Write only, stored encrypted. */
export const discordBotTokenSchema = z.string().regex(/^[A-Za-z0-9._-]{50,120}$/);

export const discordBotStatusSchema = z.enum([
  'off',
  'unconfigured',
  'connecting',
  'online',
  'error',
]);
export const discordBindingSchema = z.strictObject({
  shareId: idSchema,
  gameId: idSchema,
  gameName: z.string().max(64),
  person: z.string().max(40),
  /** Friend's Discord user id, null = not bound. */
  discordUserId: snowflakeSchema.nullable(),
  shareState: z.enum(['active', 'expired', 'revoked']),
});
export type DiscordBinding = z.infer<typeof discordBindingSchema>;

// GET /api/discord-bot -> DiscordBotState
export const discordBotStateSchema = z.strictObject({
  tokenSet: z.boolean(),
  applicationId: snowflakeSchema.nullable(),
  /** Commands are registered in this guild only (instant, no global commands). */
  guildId: snowflakeSchema.nullable(),
  status: discordBotStatusSchema,
  /** Fixed German text ("Verbunden als Zentrale#1234", "Token ungültig"). */
  statusText: z.string().max(200),
  /** All share links with power/restart permission, bound or not. */
  bindings: z.array(discordBindingSchema),
});
export type DiscordBotState = z.infer<typeof discordBotStateSchema>;

// PUT /api/discord-bot (step-up) -> DiscordBotState. token missing: keep; null: delete.
export const discordBotSettingsRequestSchema = z.strictObject({
  token: discordBotTokenSchema.nullable().optional(),
  applicationId: snowflakeSchema.nullable(),
  guildId: snowflakeSchema.nullable(),
});
// PUT /api/discord-bot/bindings/:id (share id) { discordUserId } -> DiscordBotState
export const discordBindingRequestSchema = z.strictObject({
  discordUserId: snowflakeSchema.nullable(),
});
export const shareParamsSchema = z.strictObject({ id: idSchema });

/** Slash commands the bot registers (guild scope). */
export const DISCORD_COMMANDS = ['status', 'start', 'stop', 'restart'] as const;

// ---- voice (Echo Show / Alexa via Home Assistant) --------------------------------

/**
 * The hub never gets a public endpoint for Alexa. It watches helper entities
 * in Home Assistant over its existing outgoing HA connection:
 * - `input_boolean.*` (switch): on -> start the game, off -> stop it (only if
 *   allowStop). Alexa sees the helper as a switch (Nabu Casa or emulated_hue).
 * - `input_text.*` (status, optional): the hub writes a short German status
 *   ("Läuft, 3 Spieler") for an Echo Show dashboard or an Alexa routine.
 * The hub mirrors the game state into the switch, so it never drifts.
 * Needs the module homeassistant. Starts honour the RAM reserve (M10).
 */
export const voiceSwitchEntitySchema = z.string().regex(/^input_boolean\.[a-z0-9_]{1,64}$/);
export const voiceStatusEntitySchema = z.string().regex(/^input_text\.[a-z0-9_]{1,64}$/);

export const voiceGameSchema = z.strictObject({
  gameId: idSchema,
  gameName: z.string().max(64),
  switchEntity: voiceSwitchEntitySchema.nullable(),
  statusEntity: voiceStatusEntitySchema.nullable(),
  allowStop: z.boolean(),
  /** Last voice/HA trigger, for the admin. */
  lastTriggerAt: isoTs.nullable(),
});
export type VoiceGame = z.infer<typeof voiceGameSchema>;

// GET /api/voice -> VoiceState
export const voiceStateSchema = z.strictObject({
  /** Home Assistant module on and connected. */
  haReady: z.boolean(),
  games: z.array(voiceGameSchema),
});
export type VoiceState = z.infer<typeof voiceStateSchema>;
// PUT /api/voice/games/:id (step-up when switchEntity changes) -> VoiceState
export const voiceGameRequestSchema = z.strictObject({
  switchEntity: voiceSwitchEntitySchema.nullable(),
  statusEntity: voiceStatusEntitySchema.nullable(),
  allowStop: z.boolean(),
});
export const voiceGameParamsSchema = z.strictObject({ id: idSchema });
/** A switch toggle starts/stops at most once per this window per game. */
export const VOICE_COOLDOWN_MS = 60_000;
