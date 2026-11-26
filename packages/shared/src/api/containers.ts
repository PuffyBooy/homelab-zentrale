import { z } from 'zod';
import {
  containerHealthSchema,
  containerStateSchema,
  portMappingSchema,
} from '../agent-protocol.js';
import { containerControlFields } from './throttle.js';

/** UI status of a container (design/README.md). */
export const containerStatusSchema = z.enum(['ok', 'warn', 'crit', 'off', 'busy']);
export type ContainerStatus = z.infer<typeof containerStatusSchema>;

export const containerIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export const containerIdParamsSchema = z.strictObject({ id: containerIdSchema });

export const containerSummarySchema = z.strictObject({
  /** Core id (stable per server + container name). */
  id: containerIdSchema,
  serverId: z.string(),
  serverName: z.string(),
  dockerId: z.string(),
  name: z.string(),
  image: z.string(),
  composeProject: z.string().nullable(),
  composeService: z.string().nullable(),
  /** True when the compose working dir is below /opt/homelab/, so compose.* actions work. */
  composeManaged: z.boolean(),
  state: containerStateSchema,
  health: containerHealthSchema,
  /**
   * ok = running (healthy/none), busy = health starting or removing,
   * warn = restarting or paused, crit = unhealthy, exited != 0 or dead,
   * off = exited 0, created, or stopped on purpose through the core.
   */
  status: containerStatusSchema,
  statusText: z.string(),
  exitCode: z.number().int().nullable(),
  startedAt: z.iso.datetime().nullable(),
  ports: z.array(portMappingSchema),
  cpu: z.number().nullable(),
  memBytes: z.number().nullable(),
  restartCount: z.number().int().nullable(),
  updatedAt: z.iso.datetime(),
  /** M10: priority, protection (hz.role) and throttle state (api/throttle.ts). */
  ...containerControlFields,
});
export type ContainerSummary = z.infer<typeof containerSummarySchema>;

// GET /api/containers?serverId=
export const containerListQuerySchema = z.strictObject({ serverId: z.string().max(64).optional() });
export const containerListResponseSchema = z.strictObject({
  containers: z.array(containerSummarySchema),
});
export type ContainerListResponse = z.infer<typeof containerListResponseSchema>;

// POST /api/containers/:id/{start,stop,restart,update} -> { container }
export const containerActionSchema = z.enum(['start', 'stop', 'restart', 'update']);
export type ContainerAction = z.infer<typeof containerActionSchema>;
export const containerActionParamsSchema = z.strictObject({
  id: containerIdSchema,
  action: containerActionSchema,
});
export const containerActionResponseSchema = z.strictObject({
  ok: z.literal(true),
  container: containerSummarySchema.nullable(),
});

/**
 * Live topic `container-logs:<id>`: snapshot data is a LogSnapshot with the lines
 * the core holds (the agent starts with the last 500, the core keeps a ring buffer
 * of up to 2000); each update upserts new LogLine items in order (by `seq`). When
 * the stream ends (container stopped, agent gone) or follows a recreated container
 * again, subscribers get a fresh snapshot with the new `ended` value. The stream
 * stops when the last subscriber leaves.
 */
export const logLineSchema = z.strictObject({
  /** Monotonic sequence per stream, used as id. */
  seq: z.number().int().nonnegative(),
  stream: z.enum(['stdout', 'stderr']),
  text: z.string().max(16 * 1024),
});
export type LogLine = z.infer<typeof logLineSchema>;
export const logSnapshotSchema = z.strictObject({
  lines: z.array(logLineSchema),
  ended: z.boolean(),
});
