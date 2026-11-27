import { describe, expect, it } from 'vitest';
import { SPEEDTEST_MAX_BYTES, SPEEDTEST_MAX_SECONDS } from '../agent-automation.js';
import {
  defaultSpeedtestSettings,
  speedtestQuerySchema,
  speedtestResponseSchema,
  speedtestResultSchema,
  speedtestSettingsRequestSchema,
  speedtestSettingsSchema,
  SPEEDTEST_INTERVALS,
} from './speedtest.js';

describe('speedtest schema: settings', () => {
  it('defaults are valid and within the agent caps', () => {
    const s = speedtestSettingsSchema.parse(defaultSpeedtestSettings);
    expect(s.maxMb * 1024 * 1024).toBeLessThanOrEqual(SPEEDTEST_MAX_BYTES);
    expect(s.maxSeconds).toBeLessThanOrEqual(SPEEDTEST_MAX_SECONDS);
  });

  it('only the fixed intervals', () => {
    for (const h of SPEEDTEST_INTERVALS) {
      expect(speedtestSettingsRequestSchema.safeParse({ intervalHours: h }).success).toBe(true);
    }
    for (const h of [0, 5, 48, 1.5, '6']) {
      expect(
        speedtestSettingsRequestSchema.safeParse({ intervalHours: h }).success,
        String(h),
      ).toBe(false);
    }
  });

  it.each([
    { maxMb: 9 },
    { maxMb: SPEEDTEST_MAX_BYTES / (1024 * 1024) + 1 },
    { maxMb: 10.5 },
    { maxSeconds: 2 },
    { maxSeconds: SPEEDTEST_MAX_SECONDS + 1 },
    { minDownMbps: 0 },
    { minDownMbps: -5 },
    { minUpMbps: 100_001 },
    { minUpMbps: Number.POSITIVE_INFINITY },
    { serverId: '../x' },
    { url: 'https://example.org' },
    { host: 'speed.example.org' },
    {},
  ])('rejects %o', (v) => {
    expect(speedtestSettingsRequestSchema.safeParse(v).success).toBe(false);
  });

  it('accepts null thresholds and a null server', () => {
    expect(
      speedtestSettingsRequestSchema.safeParse({
        serverId: null,
        minDownMbps: null,
        minUpMbps: null,
      }).success,
    ).toBe(true);
  });
});

describe('speedtest schema: query and responses', () => {
  it('days is 7, 30 or 90 (default 7)', () => {
    expect(speedtestQuerySchema.parse({})).toEqual({ days: 7 });
    expect(speedtestQuerySchema.parse({ days: '30' })).toEqual({ days: 30 });
    for (const d of ['8', '0', '-7', '7.5', 'abc', '365']) {
      expect(speedtestQuerySchema.safeParse({ days: d }).success, d).toBe(false);
    }
    expect(speedtestQuerySchema.safeParse({ days: '7', extra: '1' }).success).toBe(false);
  });

  it('results are strict', () => {
    const r = {
      id: 1,
      at: 1,
      serverId: 'abcdefgh12345678',
      trigger: 'schedule',
      ok: true,
      downloadMbps: 1,
      uploadMbps: 1,
      latencyMs: 1,
      jitterMs: 1,
      bytes: 1,
      colo: 'VIE',
      error: null,
    };
    expect(speedtestResultSchema.safeParse(r).success).toBe(true);
    expect(speedtestResultSchema.safeParse({ ...r, url: 'x' }).success).toBe(false);
    expect(speedtestResultSchema.safeParse({ ...r, trigger: 'cron' }).success).toBe(false);
    expect(speedtestResultSchema.safeParse({ ...r, error: 'x'.repeat(201) }).success).toBe(false);
    expect(
      speedtestResponseSchema.safeParse({
        settings: defaultSpeedtestSettings,
        results: [r],
        summary: {
          count: 1,
          avgDownMbps: 1,
          avgUpMbps: 1,
          avgLatencyMs: 1,
          minDownMbps: 1,
          maxDownMbps: 1,
          slowShare: 1.5,
        },
        running: false,
        nextRunAt: null,
      }).success,
    ).toBe(false);
  });
});
