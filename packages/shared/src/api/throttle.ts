import { z } from 'zod';
import { cpusSchema } from '../agent-protocol.js';

/**
 * Priorities and automatic throttling (SPEC 6a, ROADMAP M10).
 *
 * Every container and every game server has a priority. The core watches the
 * metrics of each server and, when the server stays above its thresholds,
 * throttles `niedrig` containers with the agent action `container.limit`
 * (`docker update --cpus`), stops them if allowed, lifts the throttle again
 * and restarts stopped `wichtig` containers. RAM limits are never lowered.
 *
 * The core and the agent (docker label `hz.role` = core/agent) are always
 * `wichtig` and never a target: their priority cannot be changed (403
 * forbidden), they are never throttled or stopped, and the agent refuses
 * `container.limit` for them anyway.
 */

// ---------------------------------------------------------------------------
// Priority

/** German values as in SPEC 6a. Default for unknown containers: `normal`. */
export const prioritySchema = z.enum(['wichtig', 'normal', 'niedrig']);
export type Priority = z.infer<typeof prioritySchema>;
export const DEFAULT_PRIORITY: Priority = 'normal';

/** A stopped `wichtig` container is restarted at most this often in the window, then crit. */
export const WICHTIG_RESTART_MAX_ATTEMPTS = 3;
export const WICHTIG_RESTART_WINDOW_MINUTES = 10;

const allowStopNeedsNiedrig = {
  message: '"darf gestoppt werden" gibt es nur bei Priorität niedrig.',
  path: ['allowStop'],
};

/**
 * PUT /api/containers/:id/priority (admin) -> ContainerPriorityResponse
 *
 * Stored per server id + container name (the core container id is derived from
 * both, so it survives a recreate). `allowStop` is only allowed with `niedrig`
 * (400 invalid_input otherwise). Containers with `hz.role` -> 403 forbidden.
 * Containers that belong to a game server -> 409 conflict (use the game route).
 */
export const containerPriorityRequestSchema = z
  .strictObject({
    priority: prioritySchema,
    /** "darf gestoppt werden". */
    allowStop: z.boolean().default(false),
  })
  .refine((v) => !v.allowStop || v.priority === 'niedrig', allowStopNeedsNiedrig);
export type ContainerPriorityRequest = z.infer<typeof containerPriorityRequestSchema>;

// GET /api/containers/:id/priority (admin) -> ContainerPriorityResponse
export const containerPriorityResponseSchema = z.strictObject({
  containerId: z.string(),
  serverId: z.string(),
  containerName: z.string(),
  priority: prioritySchema,
  allowStop: z.boolean(),
  /** hz.role container (core/agent): always wichtig, cannot be changed. */
  protected: z.boolean(),
  /** Set when the container belongs to a game server; its priority lives on the game. */
  gameId: z.string().nullable(),
});
export type ContainerPriorityResponse = z.infer<typeof containerPriorityResponseSchema>;

/**
 * PUT /api/games/:id/priority (admin) -> GamePriorityResponse
 * `allowStopWithPlayers` needs `allowStop` (400 otherwise). A game is stopped
 * cleanly (RCON save if available, then compose stop).
 */
export const gamePriorityRequestSchema = z
  .strictObject({
    priority: prioritySchema,
    allowStop: z.boolean().default(false),
    /** Stop even while players are online. */
    allowStopWithPlayers: z.boolean().default(false),
  })
  .refine((v) => !v.allowStop || v.priority === 'niedrig', allowStopNeedsNiedrig)
  .refine((v) => !v.allowStopWithPlayers || v.allowStop, {
    message: '"auch mit Spielern" braucht "darf gestoppt werden".',
    path: ['allowStopWithPlayers'],
  });
export type GamePriorityRequest = z.infer<typeof gamePriorityRequestSchema>;

// GET /api/games/:id/priority (admin) -> GamePriorityResponse
export const gamePriorityResponseSchema = z.strictObject({
  gameId: z.string(),
  priority: prioritySchema,
  allowStop: z.boolean(),
  allowStopWithPlayers: z.boolean(),
});
export type GamePriorityResponse = z.infer<typeof gamePriorityResponseSchema>;

// ---------------------------------------------------------------------------
// Throttle state of a container (in ContainerSummary, GameSummary, top consumers)

export const throttleBySchema = z.enum([
  /** The rule set (lifted automatically after recovery). */
  'auto',
  /** The admin (POST /api/containers/:id/throttle); stays until unthrottled by the admin. */
  'admin',
  /** A schedule window with mode `cpus`; lifted when the window ends. */
  'schedule',
]);
export type ThrottleBy = z.infer<typeof throttleBySchema>;

export const throttledSchema = z.strictObject({
  /** Current --cpus limit. */
  cpus: z.number(),
  since: z.iso.datetime(),
  by: throttleBySchema,
  /** German, e.g. "heimserver CPU 96 % seit 2 Min". */
  reason: z.string().max(200),
});
export type Throttled = z.infer<typeof throttledSchema>;

/** Fields added to ContainerSummary (and the throttle part to GameSummary). */
export const containerControlFields = {
  priority: prioritySchema,
  allowStop: z.boolean(),
  /** hz.role container (core/agent): always wichtig, never a target. */
  protected: z.boolean(),
  /** Game server this container belongs to, null for plain containers. */
  gameId: z.string().nullable(),
  /** null when not throttled. */
  throttled: throttledSchema.nullable(),
  /**
   * Stopped by the rule set. Not restarted automatically; the alert offers
   * "Wieder starten". Cleared when the container runs again.
   */
  autoStopped: z.boolean(),
};

// POST /api/containers/:id/throttle (admin) { cpus } -> containerActionResponseSchema
// hz.role -> 403 forbidden; container not running -> 409 conflict.
export const containerThrottleRequestSchema = z.strictObject({ cpus: cpusSchema });
export type ContainerThrottleRequest = z.infer<typeof containerThrottleRequestSchema>;
// POST /api/containers/:id/unthrottle (admin) {} -> containerActionResponseSchema
// Removes any throttle (auto, admin, schedule until the window ends again).
export const containerUnthrottleRequestSchema = z.strictObject({});

// ---------------------------------------------------------------------------
// Per-server settings

const pct = z.number().int().min(50).max(99);
const minutes = z.number().int().min(1).max(120);

const throttleSettingsFields = {
  /** "Automatik" switch per server. Off: no automatic action at all on this server. */
  enabled: z.boolean(),
  /** Server CPU above this (percent) ... */
  cpuPct: pct,
  /** ... or RAM above this (percent) ... */
  ramPct: pct,
  /** ... for this many minutes: throttle (niedrig, highest CPU first). */
  forMinutes: minutes,
  /** Still above after this many further minutes: stop (only with allowStop). */
  stopAfterMinutes: minutes,
  /** Below threshold minus recoverMarginPct for this many minutes: lift the throttle. */
  recoverMinutes: minutes,
  recoverMarginPct: z.number().int().min(1).max(40),
  /** CPU share of a throttled container (docker --cpus). */
  throttleCpus: cpusSchema,
  /**
   * RAM kept free for `wichtig` containers (MiB). A game server starts (by hand,
   * through a share link or automatically) only if its RAM limit fits into
   * free RAM minus this reserve, else 409 insufficient_ram.
   * 0 = derive: the sum of the current memory usage of the `wichtig`
   * containers on this server (running ones with the latest value, stopped
   * ones with their last known value), so they can grow by as much again or
   * start again.
   */
  ramReserveMb: z.number().int().min(0).max(1_048_576),
};

export const throttleSettingsSchema = z.strictObject({
  enabled: throttleSettingsFields.enabled.default(true),
  cpuPct: throttleSettingsFields.cpuPct.default(90),
  ramPct: throttleSettingsFields.ramPct.default(90),
  forMinutes: throttleSettingsFields.forMinutes.default(2),
  stopAfterMinutes: throttleSettingsFields.stopAfterMinutes.default(5),
  recoverMinutes: throttleSettingsFields.recoverMinutes.default(10),
  recoverMarginPct: throttleSettingsFields.recoverMarginPct.default(10),
  throttleCpus: throttleSettingsFields.throttleCpus.default(1),
  ramReserveMb: throttleSettingsFields.ramReserveMb.default(0),
});
export type ThrottleSettings = z.infer<typeof throttleSettingsSchema>;
export const defaultThrottleSettings: ThrottleSettings = throttleSettingsSchema.parse({});
/** Partial without defaults (PUT only changes the sent keys), like thresholdsPatchSchema. */
export const throttleSettingsPatchSchema = z.strictObject(throttleSettingsFields).partial();
export type ThrottleSettingsPatch = z.infer<typeof throttleSettingsPatchSchema>;

// ---------------------------------------------------------------------------
// Schedules per tier (times in HZ_TIMEZONE)

export const weekdaySchema = z.enum(['mo', 'di', 'mi', 'do', 'fr', 'sa', 'so']);
export type Weekday = z.infer<typeof weekdaySchema>;
/** 24 h clock, "HH:MM". */
export const timeOfDaySchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const MAX_SCHEDULE_WINDOWS = 20;

/**
 * A window in which the tier is treated differently.
 * - `no_throttle`: containers of the tier are not throttled (or stopped) and an
 *   existing auto throttle is lifted when the window starts.
 * - `cpus`: while the window is active, every running container of the tier
 *   (never protected/hz.role, never `wichtig`) is limited to `cpus` (throttle
 *   `by: 'schedule'`), whatever the server load; lifted when the window ends.
 *   For `niedrig` this is e.g. a higher share in the evening than throttleCpus.
 *   `normal` containers are never stopped, also not inside such a window.
 *   If a `no_throttle` and a `cpus` window of the same tier overlap,
 *   `no_throttle` wins.
 * `to` < `from` runs over midnight; `days` are the days the window starts on.
 * `from` == `to` is rejected. Interpreted in HZ_TIMEZONE.
 */
export const scheduleWindowSchema = z
  .strictObject({
    tier: z.enum(['niedrig', 'normal']),
    days: z
      .array(weekdaySchema)
      .min(1)
      .max(7)
      .refine((d) => new Set(d).size === d.length, { message: 'duplicate day' }),
    from: timeOfDaySchema,
    to: timeOfDaySchema,
    mode: z.enum(['no_throttle', 'cpus']),
    cpus: cpusSchema.optional(),
  })
  .refine((w) => w.from !== w.to, { message: 'from and to must differ', path: ['to'] })
  .refine((w) => (w.mode === 'cpus') === (w.cpus !== undefined), {
    message: 'cpus is required for mode cpus and not allowed otherwise',
    path: ['cpus'],
  });
export type ScheduleWindow = z.infer<typeof scheduleWindowSchema>;
export const scheduleWindowsSchema = z.array(scheduleWindowSchema).max(MAX_SCHEDULE_WINDOWS);

// ---------------------------------------------------------------------------
// GET /api/servers/:id/throttle (admin) -> ServerThrottleResponse
// PUT /api/servers/:id/throttle (admin) ServerThrottleUpdateRequest -> ServerThrottleResponse

export const throttlePhaseSchema = z.enum([
  /** Below the thresholds. */
  'idle',
  /** Above, waiting for forMinutes. */
  'over',
  /** At least one container throttled, waiting for stopAfterMinutes or recovery. */
  'throttled',
  /** Below threshold minus margin, waiting for recoverMinutes. */
  'recovering',
  /** Automatik switched off. */
  'disabled',
]);
export type ThrottlePhase = z.infer<typeof throttlePhaseSchema>;

export const serverThrottleResponseSchema = z.strictObject({
  serverId: z.string(),
  settings: throttleSettingsSchema,
  schedules: scheduleWindowsSchema,
  status: z.strictObject({
    phase: throttlePhaseSchema,
    /** Start of the current phase, null for idle/disabled. */
    since: z.iso.datetime().nullable(),
    /** Effective reserve (explicit or derived), null while RAM is unknown. */
    ramReserveBytes: z.number().nonnegative().nullable(),
    /** Total minus used RAM from the latest metrics, null while unknown. */
    freeRamBytes: z.number().nonnegative().nullable(),
    /** Indices into `schedules` that are active right now. */
    activeWindows: z.array(z.number().int().nonnegative()),
  }),
});
export type ServerThrottleResponse = z.infer<typeof serverThrottleResponseSchema>;

export const serverThrottleUpdateRequestSchema = z.strictObject({
  /** Only the sent keys change. */
  settings: throttleSettingsPatchSchema.optional(),
  /** Replaces the whole list when sent. */
  schedules: scheduleWindowsSchema.optional(),
});
export type ServerThrottleUpdateRequest = z.infer<typeof serverThrottleUpdateRequestSchema>;

// ---------------------------------------------------------------------------
// GET /api/overview/top-consumers (admin) -> TopConsumersResponse
// "Wer frisst gerade?": top 3 running containers over all servers by CPU and by
// RAM. Actions: POST /api/containers/:id/stop (the web asks first),
// POST /api/containers/:id/throttle, POST /api/containers/:id/unthrottle.

export const TOP_CONSUMERS_LIMIT = 3;

export const topConsumerSchema = z.strictObject({
  /** Core container id (for the container action routes). */
  containerId: z.string(),
  containerName: z.string(),
  serverId: z.string(),
  serverName: z.string(),
  /** Percent of one server (as in ContainerSummary.cpu), null while unknown. */
  cpuPct: z.number().nullable(),
  memBytes: z.number().nullable(),
  priority: prioritySchema,
  protected: z.boolean(),
  throttled: throttledSchema.nullable(),
  isGame: z.boolean(),
  gameId: z.string().nullable(),
});
export type TopConsumer = z.infer<typeof topConsumerSchema>;

export const topConsumersResponseSchema = z.strictObject({
  byCpu: z.array(topConsumerSchema).max(TOP_CONSUMERS_LIMIT),
  byRam: z.array(topConsumerSchema).max(TOP_CONSUMERS_LIMIT),
  updatedAt: z.iso.datetime(),
});
export type TopConsumersResponse = z.infer<typeof topConsumersResponseSchema>;

// ---------------------------------------------------------------------------
// RAM reserve: 409 insufficient_ram on game start (admin, share link, auto)

/**
 * `details` of an ErrorResponse with error `insufficient_ram`. The web builds
 * "Zu wenig RAM, X GB frei" from it (X = max(0, freeBytes - reserveBytes)).
 * Share links get `insufficient_ram` without details.
 */
export const insufficientRamDetailsSchema = z.strictObject({
  freeBytes: z.number().nonnegative(),
  reserveBytes: z.number().nonnegative(),
  /** RAM limit of the game server. */
  neededBytes: z.number().nonnegative(),
});
export type InsufficientRamDetails = z.infer<typeof insufficientRamDetailsSchema>;

// ---------------------------------------------------------------------------
// Audit actions and alerts

/**
 * audit_log.action of the rule set (actor `system`, or `admin` for the manual
 * throttle routes; target = core container id). Each one is also an alert
 * (source `container` or `game`) with a German reason in the body:
 * - throttle.applied: warn, key `throttle:<serverId>:<containerName>`
 *   ("minecraft gedrosselt: heimserver CPU 96 % seit 2 Min")
 * - throttle.removed: resolves the throttle alert with an ok alert
 * - container.auto_stopped: warn, key `autostop:<serverId>:<containerName>`
 *   (offers "Wieder starten"; resolved when the container runs again)
 * - container.auto_restarted: warn, key `autorestart:<serverId>:<containerName>`
 * - container.restart_failed: crit, same key, after WICHTIG_RESTART_MAX_ATTEMPTS
 *   attempts in WICHTIG_RESTART_WINDOW_MINUTES
 * Plus `priority.changed` and `throttle.settings_changed` for admin changes.
 */
export const throttleAuditActionSchema = z.enum([
  'throttle.applied',
  'throttle.removed',
  'container.auto_stopped',
  'container.auto_restarted',
  'container.restart_failed',
  'priority.changed',
  'throttle.settings_changed',
]);
export type ThrottleAuditAction = z.infer<typeof throttleAuditActionSchema>;

export const throttleAlertKeyPrefix = {
  throttle: 'throttle',
  autoStop: 'autostop',
  autoRestart: 'autorestart',
} as const;
