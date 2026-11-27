import { z } from 'zod';
import { SPEEDTEST_MAX_BYTES, SPEEDTEST_MAX_SECONDS } from '../agent-automation.js';
import { serverIdSchema } from './servers.js';

/**
 * M20 "Speedtest-Verlauf" (ROADMAP M20, SPEC 18.3). Module `speedtest` (off by default).
 *
 * One chosen server (usually the home server) runs `speedtest.run` against
 * speed.cloudflare.com every `intervalHours` and on "Jetzt messen". Results are kept
 * SPEEDTEST_KEEP_DAYS days. A test costs up to 2 × maxMb of traffic (shown in the UI).
 * When `minDownMbps`/`minUpMbps` is set and SPEEDTEST_SLOW_STREAK results in a row
 * are below, warn alert `speedtest:slow` ("Internet langsam: 12,3 Mbit/s statt 50");
 * the next good result resolves it. A failed test is stored with ok=false and error.
 *
 * Routes (admin session):
 * GET  /api/speedtest?days=7|30|90         -> SpeedtestResponse
 * PUT  /api/speedtest/settings             SpeedtestSettingsRequest -> SpeedtestSettings
 * POST /api/speedtest/run                  -> 202 { startedAt }; 409 busy while running,
 *                                             429 within SPEEDTEST_MANUAL_GAP_MS of the last start,
 *                                             409 no_server when no server is chosen/online
 */

export const SPEEDTEST_INTERVALS = [1, 2, 3, 4, 6, 12, 24] as const;
export const SPEEDTEST_KEEP_DAYS = 90;
export const SPEEDTEST_SLOW_STREAK = 3;
export const SPEEDTEST_MANUAL_GAP_MS = 5 * 60_000;

export const speedtestSettingsSchema = z.strictObject({
  serverId: serverIdSchema.nullable(),
  intervalHours: z.union(SPEEDTEST_INTERVALS.map((h) => z.literal(h))),
  /** Data cap per direction and test, MB (also caps the traffic per test). */
  maxMb: z
    .number()
    .int()
    .min(10)
    .max(SPEEDTEST_MAX_BYTES / (1024 * 1024)),
  maxSeconds: z.number().int().min(3).max(SPEEDTEST_MAX_SECONDS),
  minDownMbps: z.number().positive().max(100_000).nullable(),
  minUpMbps: z.number().positive().max(100_000).nullable(),
});
export type SpeedtestSettings = z.infer<typeof speedtestSettingsSchema>;

export const defaultSpeedtestSettings: SpeedtestSettings = {
  serverId: null,
  intervalHours: 6,
  maxMb: 100,
  maxSeconds: 10,
  minDownMbps: null,
  minUpMbps: null,
};

export const speedtestSettingsRequestSchema = speedtestSettingsSchema
  .partial()
  .refine((v) => Object.keys(v).length >= 1, { message: 'nothing to update' });

export const speedtestResultSchema = z.strictObject({
  id: z.number().int(),
  at: z.number().int(),
  serverId: serverIdSchema,
  trigger: z.enum(['schedule', 'manual']),
  ok: z.boolean(),
  downloadMbps: z.number().nullable(),
  uploadMbps: z.number().nullable(),
  latencyMs: z.number().nullable(),
  jitterMs: z.number().nullable(),
  /** Traffic of the test (down + up). */
  bytes: z.number().int().nonnegative(),
  colo: z.string().max(8).nullable(),
  /** German short error when ok=false ("Server offline", "Zeitüberschreitung"). */
  error: z.string().max(200).nullable(),
});
export type SpeedtestResult = z.infer<typeof speedtestResultSchema>;

export const speedtestQuerySchema = z.strictObject({
  days: z.coerce
    .number()
    .int()
    .refine((d) => d === 7 || d === 30 || d === 90, { message: '7, 30 or 90' })
    .default(7),
});

export const speedtestSummarySchema = z.strictObject({
  count: z.number().int().nonnegative(),
  avgDownMbps: z.number().nullable(),
  avgUpMbps: z.number().nullable(),
  avgLatencyMs: z.number().nullable(),
  minDownMbps: z.number().nullable(),
  maxDownMbps: z.number().nullable(),
  /** Share of ok results below minDownMbps/minUpMbps (0..1), null without limits. */
  slowShare: z.number().min(0).max(1).nullable(),
});

export const speedtestResponseSchema = z.strictObject({
  settings: speedtestSettingsSchema,
  /** Oldest first, only the requested days. */
  results: z.array(speedtestResultSchema),
  summary: speedtestSummarySchema,
  running: z.boolean(),
  nextRunAt: z.number().int().nullable(),
});
export type SpeedtestResponse = z.infer<typeof speedtestResponseSchema>;

export const SPEEDTEST_SLOW_ALERT_KEY = 'speedtest:slow';
