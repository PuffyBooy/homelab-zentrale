import { z } from 'zod';
import { modFileNameSchema, modKindSchema } from '../agent-protocol.js';
import { gameNameSchema } from './games.js';
import { sharePlayerNameSchema } from './share.js';

/**
 * M12 "Gameserver komplett" (docs/ROADMAP.md, SPEC 6.5): schedules, Discord
 * notifications, player statistics, Modrinth mods/plugins, whitelist requests and
 * restoring a backup. All routes need an admin session; the ones marked step-up
 * also need a fresh TOTP.
 */

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

// ---- schedules -------------------------------------------------------------------

/** "HH:MM", 24 h, in HZ_TIMEZONE. */
export const clockTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

export const gameScheduleSchema = z.strictObject({
  /** restart: warn players (template sayCommand, 5 and 1 min before), save, restart. */
  kind: z.enum(['restart', 'backup']),
  /** ISO weekdays 1 = Monday .. 7 = Sunday, at least one, no duplicates. */
  days: z
    .array(z.number().int().min(1).max(7))
    .min(1)
    .max(7)
    .refine((d) => new Set(d).size === d.length, { message: 'duplicate day' }),
  time: clockTimeSchema,
  enabled: z.boolean(),
});
export type GameSchedule = z.infer<typeof gameScheduleSchema>;

// GET /api/games/:id/schedules; PUT replaces the whole list -> same shape
// A restart of a stopped or sleeping game is skipped (no wake-up); a backup runs anyway.
export const gameSchedulesSchema = z.strictObject({
  schedules: z.array(gameScheduleSchema).max(10),
});
export const gameSchedulesResponseSchema = z.strictObject({
  schedules: z.array(gameScheduleSchema),
  /** Next run per entry (same order), null when disabled. */
  next: z.array(z.iso.datetime().nullable()),
});

// ---- Discord -----------------------------------------------------------------------

/** Only Discord webhooks; the URL contains a secret and is stored encrypted. */
export const discordWebhookUrlSchema = z
  .string()
  .trim()
  .max(300)
  .regex(
    /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d{1,20}\/[A-Za-z0-9_-]{1,100}$/,
  );

export const gameNotifyEventSchema = z.enum(['online', 'offline', 'sleep', 'wake']);

// GET /api/games/:id/notify -> GameNotify (never the URL)
export const gameNotifySchema = z.strictObject({
  discordSet: z.boolean(),
  events: z.array(gameNotifyEventSchema),
  lastSentAt: z.iso.datetime().nullable(),
  /** German, last delivery error ("Discord antwortet 404"), null when fine. */
  lastError: z.string().nullable(),
});
// PUT /api/games/:id/notify (step-up when the URL changes)
// discordWebhookUrl: undefined keeps it, null removes it.
// Messages contain only game name, template name, the external address the admin
// entered (never a Tailscale IP) and player count; allowed_mentions is empty.
export const gameNotifyRequestSchema = z.strictObject({
  discordWebhookUrl: discordWebhookUrlSchema.nullable().optional(),
  events: z
    .array(gameNotifyEventSchema)
    .max(4)
    .refine((e) => new Set(e).size === e.length, { message: 'duplicate event' }),
});
// POST /api/games/:id/notify/test -> { ok } (sends "Testnachricht")
export const gameNotifyTestResponseSchema = z.strictObject({ ok: z.boolean() });

// ---- player statistics --------------------------------------------------------------

export const gameStatsQuerySchema = z.strictObject({
  days: z.coerce
    .number()
    .int()
    .pipe(z.union([z.literal(7), z.literal(30)]))
    .default(7),
});
// GET /api/games/:id/stats?days=7|30
// From the status polls (1/min): sessions per player name, hours in HZ_TIMEZONE.
// Sessions older than 90 days are deleted.
export const gameStatsResponseSchema = z.strictObject({
  days: z.number().int(),
  players: z
    .array(
      z.strictObject({
        name: z.string(),
        seconds: z.number().int().nonnegative(),
        sessions: z.number().int().nonnegative(),
        lastSeen: z.iso.datetime(),
      }),
    )
    .max(200),
  /** Average players online per hour of day (index 0 = 00:00–00:59), 24 entries. */
  hours: z.array(z.number().nonnegative()).length(24),
  peak: z.strictObject({ online: z.number().int(), at: z.iso.datetime() }).nullable(),
  /** False when the game reports no player names (e.g. some GameDig games). */
  names: z.boolean(),
});
export type GameStats = z.infer<typeof gameStatsResponseSchema>;

// ---- mods / plugins (Modrinth) -------------------------------------------------------

// GET /api/games/:id/mods -> installed jars (from game.mods.list) and the loader
export const gameModsResponseSchema = z.strictObject({
  kind: modKindSchema,
  /** "paper" or "fabric" (Modrinth loader), Minecraft version, e.g. "1.21.4". */
  loader: z.string(),
  gameVersion: z.string().nullable(),
  files: z.array(
    z.strictObject({
      fileName: modFileNameSchema,
      sizeBytes: z.number().int(),
      /** Known when installed through the zentrale, else null. */
      title: z.string().nullable(),
      projectId: z.string().nullable(),
    }),
  ),
  /** True when files changed since the last start: "Neustart nötig". */
  restartNeeded: z.boolean(),
});

const modrinthIdSchema = z.string().regex(/^[A-Za-z0-9]{8}$/);

// GET /api/games/:id/mods/search?q= -> Modrinth search, filtered by loader and version
export const gameModSearchQuerySchema = z.strictObject({
  q: z.string().trim().max(80).default(''),
});
export const gameModSearchResponseSchema = z.strictObject({
  hits: z
    .array(
      z.strictObject({
        projectId: modrinthIdSchema,
        slug: z.string().max(100),
        title: z.string().max(200),
        description: z.string().max(400),
        downloads: z.number().int().nonnegative(),
        /** A jar of this project is installed (installed through the zentrale). */
        installed: z.boolean(),
      }),
    )
    .max(20),
});

// POST /api/games/:id/mods { projectId } -> GameModsResponse
// The core picks the newest version for loader + game version (primary file, jar),
// passes only cdn.modrinth.com URLs with sha512 to the agent. 404 when none fits.
export const gameModInstallRequestSchema = z.strictObject({ projectId: modrinthIdSchema });
// DELETE /api/games/:id/mods/:fileName -> GameModsResponse
export const gameModFileParamsSchema = z.strictObject({
  id: idSchema,
  fileName: modFileNameSchema,
});

// ---- whitelist requests (admin side) -----------------------------------------------------

export const whitelistRequestSchema = z.strictObject({
  id: idSchema,
  gameId: idSchema,
  shareId: idSchema,
  person: z.string(),
  player: sharePlayerNameSchema,
  state: z.enum(['pending', 'approved', 'rejected']),
  createdAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
});
export type WhitelistRequest = z.infer<typeof whitelistRequestSchema>;
// GET /api/games/:id/whitelist-requests -> newest first, max 50
export const whitelistRequestListResponseSchema = z.strictObject({
  requests: z.array(whitelistRequestSchema),
});
// POST /api/whitelist-requests/:id/approve|reject -> { request }
// approve sends the template's whitelistAddCommand over RCON (game must run).
export const whitelistDecisionParamsSchema = z.strictObject({
  id: idSchema,
  decision: z.enum(['approve', 'reject']),
});
export const whitelistRequestResponseSchema = z.strictObject({ request: whitelistRequestSchema });

// ---- restore a backup -----------------------------------------------------------------------

// POST /api/games/:id/backups/:backupId/restore (step-up) { confirmName } -> 202 { game }
// Takes a fresh backup first, stops the game, restores (game.restore), starts it
// again if it ran before. Progress on topic game:<id>.
export const gameRestoreParamsSchema = z.strictObject({ id: idSchema, backupId: idSchema });
export const gameRestoreRequestSchema = z.strictObject({ confirmName: gameNameSchema });
