import { z } from 'zod';
import { agentNameSchema, imageVersionSchema, updateTargetSchema } from '../agent-protocol.js';
import { timeOfDaySchema } from './throttle.js';
import { serverIdSchema } from './servers.js';

/**
 * M17: Auto-Update (ROADMAP M17, SPEC 5.6).
 *
 * The core and every agent update themselves from their image tag (GHCR by
 * default), optionally the OS packages too, inside a maintenance window per
 * server (HZ_TIMEZONE). A failed health check rolls back to the old container.
 * Every run that changes something ends with an alert (info on success, warn on rollback
 * or timeout, crit on failure); up_to_date runs only resolve an open problem.
 *
 * GET  /api/updates                        -> UpdatesResponse
 * PUT  /api/servers/:id/update-policy      -> UpdateServerState (step-up when `reboot` turns on)
 * POST /api/servers/:id/update-check       { target } -> UpdateComponentState
 * POST /api/servers/:id/update             { target } -> { runId } (also outside the window)
 * Live topic `updates`: snapshot = UpdatesResponse, update = the full UpdatesResponse as the only upsert.
 */

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export const isoWeekdaySchema = z.number().int().min(1).max(7);

export const updateWindowSchema = z.strictObject({
  days: z
    .array(isoWeekdaySchema)
    .min(1)
    .max(7)
    .refine((a) => new Set(a).size === a.length, { message: 'duplicate day' }),
  /** Start in HZ_TIMEZONE, "HH:MM". */
  start: timeOfDaySchema,
  /** Length in minutes; a run only starts inside the window. */
  durationMin: z.number().int().min(30).max(480),
});
export type UpdateWindow = z.infer<typeof updateWindowSchema>;

export const defaultUpdateWindow: UpdateWindow = {
  days: [1, 2, 3, 4, 5, 6, 7],
  start: '03:00',
  durationMin: 120,
};

export const updatePolicySchema = z.strictObject({
  /** Update the agent of this server. */
  agent: z.boolean().default(true),
  /** Update the core, if it runs on this server. */
  core: z.boolean().default(true),
  /** apt-get upgrade (apt hosts only). Off by default. */
  os: z.boolean().default(false),
  /** Reboot in the window when the host needs it after updates (step-up to switch on). */
  reboot: z.boolean().default(false),
  window: updateWindowSchema.default(defaultUpdateWindow),
});
export type UpdatePolicy = z.infer<typeof updatePolicySchema>;
export const defaultUpdatePolicy: UpdatePolicy = updatePolicySchema.parse({});

/** What one run updates: an image (agent/core), the OS packages or a reboot after them. */
export const updateRunTargetSchema = z.enum(['agent', 'core', 'os', 'reboot']);
export type UpdateRunTarget = z.infer<typeof updateRunTargetSchema>;
export const updateRunStatusSchema = z.enum([
  'running',
  'updated',
  'up_to_date',
  'rolled_back',
  'failed',
  /** No result from the agent within 15 min. */
  'timeout',
]);
export type UpdateRunStatus = z.infer<typeof updateRunStatusSchema>;

export const updateRunSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  serverId: serverIdSchema,
  serverName: agentNameSchema,
  target: updateRunTargetSchema,
  trigger: z.enum(['schedule', 'manual']),
  status: updateRunStatusSchema,
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  /** Version text before/after (image version or short revision; os: "12 Pakete"). */
  from: z.string().max(80).nullable(),
  to: z.string().max(80).nullable(),
  message: z.string().max(300).nullable(),
});
export type UpdateRun = z.infer<typeof updateRunSchema>;

export const updateComponentStateSchema = z.strictObject({
  current: imageVersionSchema.nullable(),
  available: imageVersionSchema.nullable(),
  /** null until the first check. */
  upToDate: z.boolean().nullable(),
  checkedAt: z.iso.datetime().nullable(),
});
export type UpdateComponentState = z.infer<typeof updateComponentStateSchema>;

export const updateServerStateSchema = z.strictObject({
  serverId: serverIdSchema,
  name: agentNameSchema,
  connected: z.boolean(),
  /** The core container (hz.role=core) runs on this server. */
  hostsCore: z.boolean(),
  policy: updatePolicySchema,
  agent: updateComponentStateSchema,
  /** null unless hostsCore. */
  core: updateComponentStateSchema.nullable(),
  /** From the last inventory; null when the package state is unknown. */
  os: z.strictObject({ total: z.number().int(), security: z.number().int() }).nullable(),
  rebootRequired: z.boolean().nullable(),
  /** Next window start (ISO, UTC). */
  nextWindow: z.iso.datetime().nullable(),
  /** Target of the run in progress, if any. */
  running: updateRunTargetSchema.nullable(),
});
export type UpdateServerState = z.infer<typeof updateServerStateSchema>;

export const updatesResponseSchema = z.strictObject({
  servers: z.array(updateServerStateSchema),
  /** Newest first, at most 50. */
  runs: z.array(updateRunSchema).max(50),
  /** No server hosts the core container: the core updates with `install.sh update` only. */
  coreHostKnown: z.boolean(),
});
export type UpdatesResponse = z.infer<typeof updatesResponseSchema>;

export const updatePolicyRequestSchema = updatePolicySchema;
export const updateCheckRequestSchema = z.strictObject({ target: updateTargetSchema });
export type UpdateCheckRequest = z.infer<typeof updateCheckRequestSchema>;
export const updateNowRequestSchema = z.strictObject({
  target: z.enum(['agent', 'core', 'os']),
});
export type UpdateNowRequest = z.infer<typeof updateNowRequestSchema>;
export const updateNowResponseSchema = z.strictObject({ runId: updateRunSchema.shape.id });
export type UpdateNowResponse = z.infer<typeof updateNowResponseSchema>;
