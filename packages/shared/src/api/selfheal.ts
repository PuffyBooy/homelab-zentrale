import { z } from 'zod';
import { containerRefSchema } from '../agent-protocol.js';
import { checkIdSchema } from './checks.js';
import { serverIdSchema } from './servers.js';

/**
 * M20 "Selbstheilung" (ROADMAP M20, SPEC 18.2). Module `selfheal` (off by default).
 *
 * The core restarts hanging containers: Docker health `unhealthy` for longer than
 * `unhealthyGraceSeconds`, a container that exited without being stopped by the
 * admin (mode unhealthy_or_exited), or a linked website check that is DOWN for
 * `checkDownMinutes`. Works with M10 (priorities):
 * - never containers with the label hz.role (core, agent),
 * - never containers the admin stopped (container.stop from the UI, a task or the
 *   API) or that M10 stopped/throttles (`darf gestoppt werden`); a stopped
 *   container is only healed again after it was started,
 * - an *exited* `wichtig` container is left to M10 (it already restarts those);
 *   selfheal only handles its `unhealthy` / check_down cases,
 * - no restart while a deploy, app update or game migration runs for that container.
 *
 * Loop guard: at most `maxRestarts` restarts per container in `windowMinutes`, at
 * least `minGapSeconds` between two restarts of the same container. When the limit
 * is hit the container goes to `gave_up`: crit alert `selfheal:<serverId>:<name>`,
 * no further restarts until it was healthy/running for 10 minutes (resolves the
 * alert with an OK message) or the admin presses "Zurücksetzen".
 * Every restart: info alert in the feed (no push), audit log entry.
 *
 * Routes (admin session):
 * GET    /api/selfheal                                  -> SelfhealResponse
 * PUT    /api/selfheal/settings       SelfhealSettings  -> SelfhealSettings
 * PUT    /api/selfheal/rules/:serverId/:container  SelfhealRuleRequest -> SelfhealRule
 * DELETE /api/selfheal/rules/:serverId/:container      -> 204 (back to `default`)
 * POST   /api/selfheal/reset/:serverId/:container      -> 204 (gave_up -> watching)
 */

export const selfhealModeSchema = z.enum(['off', 'unhealthy', 'unhealthy_or_exited']);
export type SelfhealMode = z.infer<typeof selfhealModeSchema>;

export const SELFHEAL_MODE_LABELS: Record<SelfhealMode | 'default', string> = {
  default: 'Standard',
  off: 'Aus',
  unhealthy: 'Bei „unhealthy“',
  unhealthy_or_exited: 'Bei „unhealthy“ oder Absturz',
};

export const selfhealSettingsSchema = z.strictObject({
  /**
   * Mode of containers without an own rule. `unhealthy` = every container with a
   * Docker healthcheck. Containers without healthcheck are never `unhealthy`.
   */
  defaultMode: selfhealModeSchema,
  maxRestarts: z.number().int().min(1).max(10),
  windowMinutes: z.number().int().min(10).max(1440),
  minGapSeconds: z.number().int().min(30).max(3600),
  unhealthyGraceSeconds: z.number().int().min(30).max(1800),
  checkDownMinutes: z.number().int().min(1).max(60),
});
export type SelfhealSettings = z.infer<typeof selfhealSettingsSchema>;

export const defaultSelfhealSettings: SelfhealSettings = {
  defaultMode: 'unhealthy',
  maxRestarts: 3,
  windowMinutes: 30,
  minGapSeconds: 120,
  unhealthyGraceSeconds: 120,
  checkDownMinutes: 3,
};

export const selfhealRuleRequestSchema = z.strictObject({
  mode: selfhealModeSchema,
  /** Restart this container when this website check is DOWN (any mode but off). */
  checkId: checkIdSchema.nullable().default(null),
});
export type SelfhealRuleRequest = z.input<typeof selfhealRuleRequestSchema>;

export const selfhealRuleParamsSchema = z.strictObject({
  serverId: serverIdSchema,
  container: containerRefSchema,
});

export const selfhealRuleSchema = z.strictObject({
  serverId: serverIdSchema,
  /** Container name (rules follow the name across recreation). */
  container: containerRefSchema,
  mode: selfhealModeSchema,
  checkId: checkIdSchema.nullable(),
  updatedAt: z.number().int(),
});
export type SelfhealRule = z.infer<typeof selfhealRuleSchema>;

export const selfhealPhaseSchema = z.enum(['watching', 'restarting', 'gave_up']);
export type SelfhealPhase = z.infer<typeof selfhealPhaseSchema>;

export const selfhealReasonSchema = z.enum(['unhealthy', 'exited', 'check_down']);
export type SelfhealReason = z.infer<typeof selfhealReasonSchema>;

/** Containers that currently have a problem or restarts in the window. */
export const selfhealStateSchema = z.strictObject({
  serverId: serverIdSchema,
  serverName: z.string().max(64),
  container: containerRefSchema,
  phase: selfhealPhaseSchema,
  /** Restarts in the current window. */
  attempts: z.number().int().nonnegative(),
  lastReason: selfhealReasonSchema.nullable(),
  lastRestartAt: z.number().int().nullable(),
});
export type SelfhealState = z.infer<typeof selfhealStateSchema>;

export const selfhealEventSchema = z.strictObject({
  id: z.number().int(),
  at: z.number().int(),
  serverId: serverIdSchema,
  serverName: z.string().max(64),
  container: containerRefSchema,
  reason: selfhealReasonSchema,
  action: z.enum(['restart', 'restart_failed', 'gave_up', 'recovered', 'reset']),
  attempt: z.number().int().nonnegative(),
});
export type SelfhealEvent = z.infer<typeof selfhealEventSchema>;

export const SELFHEAL_EVENTS_KEEP_DAYS = 30;
export const SELFHEAL_EVENTS_LIST = 100;

export const selfhealResponseSchema = z.strictObject({
  settings: selfhealSettingsSchema,
  rules: z.array(selfhealRuleSchema),
  state: z.array(selfhealStateSchema),
  events: z.array(selfhealEventSchema),
});
export type SelfhealResponse = z.infer<typeof selfhealResponseSchema>;

export const selfhealAlertKey = (serverId: string, container: string) =>
  `selfheal:${serverId}:${container}`;
