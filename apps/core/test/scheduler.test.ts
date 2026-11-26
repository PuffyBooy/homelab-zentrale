import { afterEach, describe, expect, it } from 'vitest';
import { Scheduler } from '../src/scheduler.js';
import { authHeaders, completeSetup, makeApp, type TestApp } from './helpers.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.app.close();
  t = undefined;
});

describe('Scheduler', () => {
  it('runs jobs when the injected clock says they are due', async () => {
    const clock = { t: 1_000 };
    const s = new Scheduler(() => clock.t);
    const runs: number[] = [];
    s.every('a', 5_000, () => void runs.push(clock.t));
    await s.tick();
    expect(runs).toEqual([]);
    clock.t = 5_999;
    await s.tick();
    expect(runs).toEqual([]);
    clock.t = 6_000;
    await s.tick();
    await s.tick();
    expect(runs).toEqual([6_000]);
    // Missed runs are not caught up.
    clock.t = 60_000;
    await s.tick();
    expect(runs).toEqual([6_000, 60_000]);
    expect(s.nextRunOf('a')).toBe(65_000);
  });

  it('aligns to interval boundaries and supports immediate jobs', async () => {
    const clock = { t: 7 * 60_000 + 12_000 };
    const s = new Scheduler(() => clock.t);
    s.every('five', 5 * 60_000, () => undefined, { align: true });
    expect(s.nextRunOf('five')).toBe(10 * 60_000);
    let ran = false;
    s.every('now', 60_000, () => void (ran = true), { immediate: true });
    await s.tick();
    expect(ran).toBe(true);
  });

  it('never overlaps a job with itself and reports errors', async () => {
    const clock = { t: 0 };
    const errors: string[] = [];
    const s = new Scheduler(() => clock.t, { onError: (job) => errors.push(job) });
    let running = 0;
    let max = 0;
    s.every('slow', 1, async () => {
      running++;
      max = Math.max(max, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
    });
    s.every('bad', 1, () => {
      throw new Error('boom');
    });
    clock.t = 10;
    await Promise.all([s.tick(), s.tick(), s.tick()]);
    expect(max).toBe(1);
    expect(errors).toEqual(['bad']);
  });

  it('rejects duplicate names and bad intervals; cancel removes a job', () => {
    const s = new Scheduler(() => 0);
    const cancel = s.every('a', 10, () => undefined);
    expect(() => s.every('a', 10, () => undefined)).toThrow();
    expect(() => s.every('b', 0, () => undefined)).toThrow();
    cancel();
    expect(s.has('a')).toBe(false);
  });

  it('the app registers its jobs', async () => {
    t = await makeApp();
    for (const job of [
      'servers.status',
      'live.sessions',
      'agents.heartbeat',
      'metrics.rollup5m',
      'metrics.rollup1h',
      'metrics.prune',
    ]) {
      expect(t.app.hzCore.scheduler.has(job), job).toBe(true);
    }
    expect(t.app.hzCore.scheduler.has('demo.metrics')).toBe(false);
  });
});

describe('HZ_DEMO', () => {
  it('without the flag there are no servers', async () => {
    t = await makeApp();
    expect(t.app.hzCore.servers.list()).toEqual([]);
  });

  it('with HZ_DEMO=1 there are the three preview servers with history', async () => {
    t = await makeApp({ env: { HZ_DEMO: '1' } });
    const { cookie } = await completeSetup(t);
    const list = t.app.hzCore.servers.list();
    expect(list.map((s) => [s.name, s.location, s.status, s.connected])).toEqual([
      ['oracle-a1', 'Frankfurt', 'warn', true],
      ['heimserver', 'Wien', 'ok', true],
      ['soundos-pi', 'Studio', 'ok', true],
    ]);
    const id = list[1]?.id ?? '';
    const hist = await t.app.inject({
      method: 'GET',
      url: `/api/servers/${id}/history?range=24h`,
      headers: authHeaders(cookie),
    });
    expect(hist.json().points.length).toBeGreaterThan(200);
    // Simulated metrics keep coming.
    t.clock.advance(10_000);
    await t.app.hzCore.scheduler.tick();
    expect(t.app.hzCore.servers.summary(id)?.lastSeen).toBe(new Date(t.clock.t).toISOString());
    // RPC to a demo server: no agent.
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/servers/${id}/cleanup-preview`,
      headers: authHeaders(cookie),
    });
    expect(res.statusCode).toBe(409);
  });
});
