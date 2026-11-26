import { z } from 'zod';
import {
  agentNameSchema,
  agentTokenSchema,
  cleanupPreviewDataSchema,
  diskSchema,
  listeningPortSchema,
  systemInfoSchema,
} from '../agent-protocol.js';

/** UI status of a server (design/README.md). */
export const serverStatusSchema = z.enum(['ok', 'warn', 'crit', 'off']);
export type ServerStatus = z.infer<typeof serverStatusSchema>;

const thresholdFields = {
  cpuWarn: z.number().min(1).max(100),
  /** Minutes CPU must stay above cpuWarn. */
  cpuWarnMinutes: z.number().int().min(1).max(120),
  ramWarn: z.number().min(1).max(100),
  ramCrit: z.number().min(1).max(100),
  ramCritMinutes: z.number().int().min(1).max(120),
  diskWarn: z.number().min(1).max(100),
  diskCrit: z.number().min(1).max(100),
  tempWarn: z.number().min(20).max(120),
  /** Seconds without a report until the server is DOWN. */
  offlineAfterS: z.number().int().min(30).max(600),
};

/** Per-server thresholds (SPEC 5.1). All values in percent or °C. */
export const thresholdsSchema = z.strictObject({
  cpuWarn: thresholdFields.cpuWarn.default(85),
  cpuWarnMinutes: thresholdFields.cpuWarnMinutes.default(10),
  ramWarn: thresholdFields.ramWarn.default(90),
  ramCrit: thresholdFields.ramCrit.default(95),
  ramCritMinutes: thresholdFields.ramCritMinutes.default(5),
  diskWarn: thresholdFields.diskWarn.default(85),
  diskCrit: thresholdFields.diskCrit.default(95),
  tempWarn: thresholdFields.tempWarn.default(75),
  offlineAfterS: thresholdFields.offlineAfterS.default(90),
});
/**
 * Partial thresholds without defaults (PATCH). Note: `thresholdsSchema.partial()`
 * would fill in the defaults in zod 4 and reset values that were not sent.
 */
export const thresholdsPatchSchema = z.strictObject(thresholdFields).partial();
export type ThresholdsPatch = z.infer<typeof thresholdsPatchSchema>;
export type Thresholds = z.infer<typeof thresholdsSchema>;
export const defaultThresholds: Thresholds = thresholdsSchema.parse({});

/** Why a server is not ok. `code` is stable, `text` is the German UI text. */
export const statusReasonSchema = z.strictObject({
  level: z.enum(['warn', 'crit']),
  code: z.enum([
    'offline',
    'never_seen',
    'disk_crit',
    'disk_warn',
    'ram_crit',
    'ram_warn',
    'cpu_warn',
    'temp_warn',
    'security_updates',
    'reboot_required',
  ]),
  text: z.string(),
});
export type StatusReason = z.infer<typeof statusReasonSchema>;

export const serverIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export const serverIdParamsSchema = z.strictObject({ id: serverIdSchema });

export const serverNetworkSchema = z.enum(['home', 'cloud', 'vps', 'other']);
export type ServerNetwork = z.infer<typeof serverNetworkSchema>;

export const serverSummarySchema = z.strictObject({
  id: serverIdSchema,
  name: agentNameSchema,
  location: z.string(),
  arch: z.string().nullable(),
  os: z.string().nullable(),
  tailscaleIp: z.string().nullable(),
  publicIp: z.string().nullable(),
  status: serverStatusSchema,
  reasons: z.array(statusReasonSchema),
  /** WebSocket of the agent is connected right now. */
  connected: z.boolean(),
  lastSeen: z.iso.datetime().nullable(),
  agentVersion: z.string().nullable(),
  /** Latest values, null while unknown. */
  cpu: z.number().nullable(),
  ramPct: z.number().nullable(),
  /** Highest usage of all disks. */
  diskPct: z.number().nullable(),
  temp: z.number().nullable(),
  uptimeS: z.number().nullable(),
  allowTerminal: z.boolean(),
  /**
   * M12: where the server sits, for the port forwarding hint of game servers:
   * home = behind a home router, cloud = cloud VM with a provider firewall
   * (e.g. Oracle Security List + iptables), vps = VPS with provider firewall,
   * other / null = generic hint.
   */
  network: serverNetworkSchema.nullable(),
  containersRunning: z.number().int().nonnegative(),
  containersTotal: z.number().int().nonnegative(),
});
export type ServerSummary = z.infer<typeof serverSummarySchema>;

export const serverDetailSchema = z.strictObject({
  server: serverSummarySchema,
  thresholds: thresholdsSchema,
  system: systemInfoSchema.nullable(),
  ram: z.strictObject({ usedBytes: z.number(), totalBytes: z.number() }).nullable(),
  swap: z.strictObject({ usedBytes: z.number(), totalBytes: z.number() }).nullable(),
  disks: z.array(diskSchema),
  net: z.strictObject({ rxBps: z.number(), txBps: z.number() }).nullable(),
  updates: z.strictObject({ total: z.number().int(), security: z.number().int() }).nullable(),
  rebootRequired: z.boolean().nullable(),
  sshFailed24h: z.number().int().nullable(),
  fail2banBanned: z.number().int().nullable(),
  listeningPorts: z.array(listeningPortSchema),
});
export type ServerDetail = z.infer<typeof serverDetailSchema>;

export const serverListResponseSchema = z.strictObject({ servers: z.array(serverSummarySchema) });
export type ServerListResponse = z.infer<typeof serverListResponseSchema>;

// GET /api/servers/:id/history?range=24h|7d|30d
export const historyRangeSchema = z.enum(['1h', '24h', '7d', '30d']);
export const historyQuerySchema = z.strictObject({ range: historyRangeSchema.default('24h') });
export const historyPointSchema = z.strictObject({
  ts: z.iso.datetime(),
  cpu: z.number(),
  ramPct: z.number(),
  netIn: z.number(),
  netOut: z.number(),
  temp: z.number().nullable(),
});
export const historyResponseSchema = z.strictObject({
  range: historyRangeSchema,
  points: z.array(historyPointSchema),
});
export type HistoryResponse = z.infer<typeof historyResponseSchema>;

// POST /api/servers/enroll
export const enrollRequestSchema = z.strictObject({
  name: agentNameSchema,
  location: z.string().trim().max(60).default(''),
});
export type EnrollRequest = z.infer<typeof enrollRequestSchema>;
export const enrollResponseSchema = z.strictObject({
  /** One-time token, valid 15 min. Shown once. */
  token: agentTokenSchema,
  expiresAt: z.iso.datetime(),
  /** Ready-to-copy one-liner and compose snippet. */
  dockerRun: z.string(),
  compose: z.string(),
});
export type EnrollResponse = z.infer<typeof enrollResponseSchema>;

// PATCH /api/servers/:id
export const serverUpdateRequestSchema = z.strictObject({
  location: z.string().trim().max(60).optional(),
  /** Only the sent keys change. warn must stay <= crit (checked by the core). */
  thresholds: thresholdsPatchSchema.optional(),
  /** Changing this needs step-up. */
  allowTerminal: z.boolean().optional(),
  /** M12: null clears it. */
  network: serverNetworkSchema.nullable().optional(),
});
export type ServerUpdateRequest = z.infer<typeof serverUpdateRequestSchema>;

// PATCH /api/servers/:id -> the updated detail
export const serverUpdateResponseSchema = serverDetailSchema;

// POST /api/servers/:id/cleanup-preview -> cleanupPreviewDataSchema
export const cleanupPreviewResponseSchema = cleanupPreviewDataSchema;
// POST /api/servers/:id/cleanup
export const cleanupResponseSchema = z.strictObject({ freedBytes: z.number().nonnegative() });
// POST /api/servers/:id/reboot (step-up; confirmName must equal the server name)
export const rebootRequestSchema = z.strictObject({ confirmName: agentNameSchema });
// -> okResponseSchema ({ ok: true }) once the agent accepted the reboot.
// POST /api/servers/:id/revoke-agent (step-up): revokes the agent token, disconnects at once
// -> okResponseSchema
// DELETE /api/servers/:id (step-up) -> okResponseSchema
