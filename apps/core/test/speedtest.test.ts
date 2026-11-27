import { afterEach, describe, expect, it } from 'vitest';
import {
  speedtestResponseSchema,
  speedtestSettingsSchema,
  SPEEDTEST_KEEP_DAYS,
  SPEEDTEST_SLOW_ALERT_KEY,
  type SpeedtestResponse,
} from '@hz/shared';
import { until, type Received, type WsClient } from './agent-helpers.js';
import type { TestApp } from './helpers.js';
import {
  api,
  MIN,
  ok,
  rpcFail,
  rpcsOf,
  settle,
  withAutomation,
  type AutoSetup,
  type Reply,
} from './tasks-helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

const HOUR = 60 * MIN;
const MIB = 1024 * 1024;

const data = (down: number, up: number, over: Record<string, unknown> = {}) => ({
  downloadMbps: down,
  uploadMbps: up,
  latencyMs: 12.345,
  jitterMs: 1.5,
  downloadBytes: 40 * MIB,
  uploadBytes: 10 * MIB,
  durationMs: 21_000,
  colo: 'VIE',
  ...over,
});

/** Sim agent: answers speedtest.run with `next()`. */
async function setup(
  next: (m: Received) => Record<string, unknown> | 'silent' = (m) => ok(m, data(250.456, 40)),
  opts: Parameters<typeof withAutomation>[1] = {},
): Promise<AutoSetup> {
  const reply: Reply = (m) => (m.action === 'speedtest.run' ? next(m) : null);
  const s = await withAutomation(clients, { reply, ...opts });
  t = s.t;
  return s;
}

async function choose(s: AutoSetup, over: Record<string, unknown> = {}): Promise<void> {
  const res = await api(s, 'PUT', '/api/speedtest/settings', { serverId: s.serverId, ...over });
  expect(res.statusCode, res.body).toBe(200);
}

async function view(s: AutoSetup, days = 7): Promise<SpeedtestResponse> {
  const res = await api(s, 'GET', `/api/speedtest?days=${days}`);
  expect(res.statusCode, res.body).toBe(200);
  return speedtestResponseSchema.parse(res.json());
}

async function runNow(s: AutoSetup): Promise<number> {
  const res = await api(s, 'POST', '/api/speedtest/run');
  return res.statusCode;
}

describe('M20 acceptance: speed test', () => {
  it('a manual test lands in the history', async () => {
    const s = await setup();
    await choose(s);
    const res = await api(s, 'POST', '/api/speedtest/run');
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toEqual({ startedAt: s.t.clock.t });
    await settle(s);
    const run = rpcsOf(s, 'speedtest.run');
    expect(run).toHaveLength(1);
    // No URL or host goes over the wire: the agent only knows speed.cloudflare.com.
    expect(run[0]?.params).toEqual({ maxSeconds: 10, maxBytes: 100 * MIB });
    const v = await view(s);
    expect(v.results).toEqual([
      {
        id: expect.any(Number) as unknown as number,
        at: s.t.clock.t,
        serverId: s.serverId,
        trigger: 'manual',
        ok: true,
        downloadMbps: 250.46,
        uploadMbps: 40,
        latencyMs: 12.35,
        jitterMs: 1.5,
        bytes: 50 * MIB,
        colo: 'VIE',
        error: null,
      },
    ]);
    expect(v.summary).toMatchObject({ count: 1, avgDownMbps: 250.46, slowShare: null });
    expect(v.running).toBe(false);
    expect(v.nextRunAt).toBe(s.t.clock.t + 6 * HOUR);
  });
});

describe('speedtest: schedule and limits', () => {
  it('runs every intervalHours with the configured caps', async () => {
    const s = await setup();
    await choose(s, { intervalHours: 1, maxMb: 50, maxSeconds: 5 });
    const tick = async (ms: number) => {
      s.t.clock.advance(ms);
      await s.t.app.hzCore.scheduler.tick();
      await settle(s);
    };
    await tick(59 * MIN);
    expect(rpcsOf(s, 'speedtest.run')).toHaveLength(0);
    await tick(MIN);
    expect(rpcsOf(s, 'speedtest.run')).toHaveLength(1);
    expect(rpcsOf(s, 'speedtest.run')[0]?.params).toEqual({ maxSeconds: 5, maxBytes: 50 * MIB });
    await tick(30 * MIN);
    expect(rpcsOf(s, 'speedtest.run')).toHaveLength(1);
    await tick(30 * MIN);
    expect(rpcsOf(s, 'speedtest.run')).toHaveLength(2);
    expect((await view(s)).results.map((r) => r.trigger)).toEqual(['schedule', 'schedule']);
  });

  it('409 busy while running, 429 within 5 min of the last start, 409 without server', async () => {
    const held: Received[] = [];
    const s = await setup((m) => {
      held.push(m);
      return 'silent';
    });
    expect(await runNow(s)).toBe(409); // no server chosen
    await choose(s);
    expect(await runNow(s)).toBe(202);
    await until(() => held.length === 1);
    expect((await view(s)).running).toBe(true);
    expect(await runNow(s)).toBe(409);
    s.agent.send(ok(held[0] as Received, data(100, 20)));
    await settle(s);
    s.t.clock.advance(4 * MIN);
    const limited = await api(s, 'POST', '/api/speedtest/run');
    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ retryAfter: number }>().retryAfter).toBe(60);
    s.t.clock.advance(MIN);
    expect(await runNow(s)).toBe(202);
  });

  it('409 when the chosen server is offline; a scheduled test then stores "Server offline"', async () => {
    const s = await setup();
    await choose(s, { intervalHours: 1 });
    s.agent.ws.terminate();
    await until(() => !s.t.app.hzCore.hub.isConnected(s.serverId));
    expect(await runNow(s)).toBe(409);
    s.t.clock.advance(HOUR);
    await s.t.app.hzCore.scheduler.tick();
    await settle(s);
    expect((await view(s)).results).toMatchObject([
      { ok: false, error: 'Server offline', bytes: 0 },
    ]);
  });

  it('stores failed and invalid answers with ok=false', async () => {
    let n = 0;
    const s = await setup((m) => {
      n++;
      if (n === 1) return rpcFail(m, 'timeout');
      if (n === 2) return ok(m, data(10, 10, { url: 'https://evil.example' }));
      return ok(m, data(10, 10, { colo: 'evil' }));
    });
    await choose(s);
    for (let i = 0; i < 3; i++) {
      expect(await runNow(s)).toBe(202);
      await settle(s);
      s.t.clock.advance(6 * MIN);
    }
    expect((await view(s)).results.map((r) => [r.ok, r.error])).toEqual([
      [false, 'Zeitüberschreitung'],
      [false, 'Ungültige Antwort des Agents'],
      [false, 'Ungültige Antwort des Agents'],
    ]);
  });
});

describe('speedtest: slow alert, history', () => {
  it('warns after 3 slow results in a row, a good one resolves it', async () => {
    const speeds = [12.3, 20, 15, 30, 80];
    let i = 0;
    const s = await setup((m) => ok(m, data(speeds[i++] ?? 80, 40)));
    await choose(s, { minDownMbps: 50 });
    const measure = async () => {
      expect(await runNow(s)).toBe(202);
      await settle(s);
      s.t.clock.advance(6 * MIN);
    };
    await measure();
    await measure();
    expect(s.t.app.hzCore.alerts.active(SPEEDTEST_SLOW_ALERT_KEY)).toBeNull();
    await measure();
    const a = s.t.app.hzCore.alerts.active(SPEEDTEST_SLOW_ALERT_KEY);
    expect(a?.level).toBe('warn');
    expect(a?.title).toBe('Internet langsam: 15 Mbit/s statt 50');
    await measure(); // still slow: same alert
    expect(s.t.app.hzCore.alerts.active(SPEEDTEST_SLOW_ALERT_KEY)?.id).toBe(a?.id);
    await measure(); // 80: good
    expect(s.t.app.hzCore.alerts.active(SPEEDTEST_SLOW_ALERT_KEY)).toBeNull();
    const v = await view(s);
    expect(v.summary.count).toBe(5);
    expect(v.summary.slowShare).toBeCloseTo(4 / 5);
    expect(v.summary.minDownMbps).toBe(12.3);
    expect(v.summary.maxDownMbps).toBe(80);
  });

  it(`keeps ${SPEEDTEST_KEEP_DAYS} days and filters by days`, async () => {
    const s = await setup();
    await choose(s);
    const ins = s.t.db.sqlite.prepare(
      `INSERT INTO speedtest_results (at, server_id, trigger, ok, download_mbps, upload_mbps, latency_ms, jitter_ms, bytes)
       VALUES (?, ?, 'schedule', 1, 100, 20, 10, 1, 1000)`,
    );
    const day = 24 * HOUR;
    for (const ago of [1, 10, 40, 91]) ins.run(s.t.clock.t - ago * day, s.serverId);
    expect((await view(s, 7)).results).toHaveLength(1);
    expect((await view(s, 30)).results).toHaveLength(2);
    expect((await view(s, 90)).results).toHaveLength(3);
    s.t.app.hzCore.features.speedtest.service.prune();
    const n = s.t.db.sqlite.prepare('SELECT count(*) AS n FROM speedtest_results').get() as {
      n: number;
    };
    expect(n.n).toBe(3);
  });

  it('settings: partial update, read back; module off stops the job', async () => {
    const s = await setup();
    const res = await api(s, 'PUT', '/api/speedtest/settings', { minUpMbps: 10.5 });
    expect(speedtestSettingsSchema.parse(res.json())).toMatchObject({
      serverId: null,
      minUpMbps: 10.5,
      intervalHours: 6,
    });
    expect((await view(s)).nextRunAt).toBeNull();
    await choose(s, { intervalHours: 1 });
    s.t.app.hzCore.modules.set({ speedtest: false });
    expect(s.t.app.hzCore.scheduler.has('speedtest.tick')).toBe(false);
    s.t.clock.advance(2 * HOUR);
    await s.t.app.hzCore.scheduler.tick();
    await settle(s);
    expect(rpcsOf(s, 'speedtest.run')).toHaveLength(0);
  });
});
