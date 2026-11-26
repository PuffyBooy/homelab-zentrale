import { afterEach, describe, expect, it } from 'vitest';
import { historyResponseSchema } from '@hz/shared';
import { openDatabase, type DbHandle } from '../src/db/index.js';
import { servers } from '../src/db/schema.js';
import { BUCKET_1H, BUCKET_5M, DAY, HOUR, MetricsStore, toRawRow } from '../src/metrics/store.js';
import { metricsMsg } from './agent-helpers.js';

let h: DbHandle | undefined;
afterEach(() => {
  h?.close();
  h = undefined;
});

// Aligned to an hour, so buckets are easy to reason about.
const START = Date.UTC(2026, 10, 25, 10, 0, 0);

function store() {
  h = openDatabase(':memory:');
  const clock = { t: START };
  h.db.insert(servers).values({ id: 'srv-aaaaaaaa', name: 'heimserver', createdAt: START }).run();
  const m = new MetricsStore(h.sqlite, () => clock.t);
  return { m, clock, sqlite: h.sqlite };
}

function insert(
  m: MetricsStore,
  ts: number,
  cpu: number,
  extra: { temp?: number | null } = {},
): void {
  m.insert(toRawRow('srv-aaaaaaaa', ts, { ...metricsMsg({ cpu, ramPct: cpu / 2, ...extra }) }));
}

describe('toRawRow', () => {
  it('converts bytes to percent and keeps the fullest disk', () => {
    const r = toRawRow('s', 1, {
      ...metricsMsg(),
      disks: [
        { mount: '/', usedBytes: 50, totalBytes: 100 },
        { mount: '/srv', usedBytes: 90, totalBytes: 100 },
        { mount: '/empty', usedBytes: 0, totalBytes: 0 },
      ],
      swap: { usedBytes: 0, totalBytes: 0 },
    });
    expect(r.diskMax).toBe(90);
    expect(r.disks).toEqual([
      { mount: '/', pct: 50 },
      { mount: '/srv', pct: 90 },
    ]);
    expect(r.swap).toBe(0);
    expect(r.ram).toBeCloseTo(40);
  });
});

describe('rollups', () => {
  it('averages complete 5-minute buckets and is idempotent', () => {
    const { m, clock, sqlite } = store();
    // 10 min of samples every 10 s: first 5 min cpu 10, next 5 min cpu 30, then 2 in the open bucket.
    for (let i = 0; i < 60; i++) insert(m, START + i * 10_000, i < 30 ? 10 : 30);
    insert(m, START + 10 * 60_000, 90);
    insert(m, START + 10 * 60_000 + 10_000, 90);
    clock.t = START + 10 * 60_000 + 20_000;
    m.rollup5m();
    m.rollup5m();
    const rows = sqlite.prepare('SELECT ts, cpu, ram, samples FROM metrics_5m ORDER BY ts').all();
    expect(rows).toEqual([
      { ts: START, cpu: 10, ram: 5, samples: 30 },
      { ts: START + BUCKET_5M, cpu: 30, ram: 15, samples: 30 },
    ]);
  });

  it('hourly means are weighted by samples', () => {
    const { m, clock, sqlite } = store();
    // 10 samples at cpu 10 in the first bucket, 30 samples at cpu 50 in the second.
    for (let i = 0; i < 10; i++) insert(m, START + i * 10_000, 10);
    for (let i = 0; i < 30; i++) insert(m, START + BUCKET_5M + i * 10_000, 50);
    clock.t = START + HOUR + 60_000;
    m.rollup5m();
    m.rollup1h();
    const row = sqlite.prepare('SELECT ts, cpu, samples FROM metrics_1h').get();
    expect(row).toEqual({ ts: START, cpu: 40, samples: 40 });
  });

  it('keeps temp null when unknown', () => {
    const { m, clock, sqlite } = store();
    insert(m, START, 10, { temp: null });
    clock.t = START + HOUR;
    m.rollup5m();
    m.rollup1h();
    expect(sqlite.prepare('SELECT temp FROM metrics_5m').get()).toEqual({ temp: null });
    expect(sqlite.prepare('SELECT temp FROM metrics_1h').get()).toEqual({ temp: null });
  });

  it('prunes raw after 48 h, 5-min after 30 d, hourly after 1 year', () => {
    const { m, clock, sqlite } = store();
    insert(m, START, 10);
    clock.t = START + HOUR;
    m.rollup5m();
    m.rollup1h();
    clock.t = START + 48 * HOUR;
    expect(m.prune()).toEqual({ raw: 0, m5: 0, h1: 0 });
    clock.t = START + 48 * HOUR + 1;
    expect(m.prune()).toEqual({ raw: 1, m5: 0, h1: 0 });
    clock.t = START + 30 * DAY + 1;
    expect(m.prune()).toEqual({ raw: 0, m5: 1, h1: 0 });
    clock.t = START + 365 * DAY + 1;
    expect(m.prune()).toEqual({ raw: 0, m5: 0, h1: 1 });
    expect(sqlite.prepare('SELECT COUNT(*) n FROM metrics_1h').get()).toEqual({ n: 0 });
  });
});

describe('history', () => {
  it('1h raw, 24h in 5-min buckets, 7d hourly from 5-min, 30d hourly', () => {
    const { m, clock } = store();
    for (let i = 0; i < 6 * 60 * 3; i++) insert(m, START + i * 10_000, 20); // 3 h
    clock.t = START + 3 * HOUR;
    m.rollup5m(DAY);
    m.rollup1h(DAY);
    expect(m.history('srv-aaaaaaaa', '1h').points).toHaveLength(360);
    expect(m.history('srv-aaaaaaaa', '24h').points).toHaveLength(36);
    expect(m.history('srv-aaaaaaaa', '7d').points).toHaveLength(3);
    const d30 = m.history('srv-aaaaaaaa', '30d');
    expect(d30.points).toHaveLength(3);
    expect(d30.points[0]).toEqual({
      ts: new Date(START).toISOString(),
      cpu: 20,
      ramPct: 10,
      netIn: 1000,
      netOut: 500,
      temp: 45,
      diskMax: 50,
    });
    expect(BUCKET_1H).toBe(HOUR);
  });

  it('M16: diskMax in every range (highest value of a bucket, null without disks)', () => {
    const { m, clock } = store();
    const GB = 1024 ** 3;
    const at = (ts: number, diskPct: number | null): void => {
      const msg = metricsMsg({ diskPct: diskPct ?? 0 });
      m.insert(
        toRawRow('srv-aaaaaaaa', ts, {
          ...msg,
          disks:
            diskPct === null
              ? []
              : msg.disks.map((d) => ({ ...d, totalBytes: 100 * GB, usedBytes: diskPct * GB })),
        }),
      );
    };
    // First 5 min: 40 %, then one spike to 70 %, then 60 %; later a stretch without disks.
    for (let i = 0; i < 30; i++) at(START + i * 10_000, 40);
    at(START + 5 * 60_000, 70);
    for (let i = 1; i < 30; i++) at(START + 5 * 60_000 + i * 10_000, 60);
    for (let i = 0; i < 30; i++) at(START + HOUR + i * 10_000, null);
    clock.t = START + 2 * HOUR;
    m.rollup5m(DAY);
    m.rollup1h(DAY);
    const h1 = m.history('srv-aaaaaaaa', '1h').points;
    expect(h1.every((p) => p.diskMax === null)).toBe(true);
    const h24 = m.history('srv-aaaaaaaa', '24h').points;
    expect(h24.map((p) => p.diskMax)).toEqual([40, 70, null]);
    for (const range of ['7d', '30d'] as const) {
      const pts = m.history('srv-aaaaaaaa', range).points;
      expect(pts).toHaveLength(2);
      expect(pts[0]?.diskMax).toBeGreaterThanOrEqual(40);
      expect(pts[0]?.diskMax).toBeLessThanOrEqual(70);
      expect(pts[1]?.diskMax).toBeNull();
    }
    for (const range of ['1h', '24h', '7d', '30d'] as const) {
      expect(historyResponseSchema.safeParse(m.history('srv-aaaaaaaa', range)).success).toBe(true);
    }
  });
});
