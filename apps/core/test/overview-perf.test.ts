import { afterEach, describe, expect, it } from 'vitest';
import { authHeaders, completeSetup, makeApp, type TestApp } from './helpers.js';

/**
 * M9 performance: the endpoints the overview page loads must stay fast with a
 * realistic amount of data (48 h raw metrics of 6 servers, 7 days of check results,
 * 90 days of alerts, a big audit log). Every SQL statement they run is captured and
 * its query plan checked: no full scan of a big table.
 */

let t: TestApp | undefined;

afterEach(async () => {
  await t?.app.close();
  t = undefined;
});

const OVERVIEW = [
  '/api/servers',
  '/api/alerts?state=active&limit=200',
  '/api/containers',
  '/api/checks',
  '/api/games',
  '/api/github/repos',
  '/api/github/settings',
  '/api/ha/state',
  '/api/wall/state',
];

const BIG_TABLES = [
  'metrics_raw',
  'metrics_5m',
  'metrics_1h',
  'check_results',
  'alerts',
  'audit_log',
  'deploys',
  'share_audit',
  'console_sessions',
];

const HOUR = 3_600_000;

function seed(t: TestApp, now: number): void {
  const db = t.db.sqlite;
  const servers = Array.from({ length: 6 }, (_, i) => `srv${String(i).padStart(19, '0')}`);
  const insServer = db.prepare(
    `INSERT INTO servers (id, name, location, created_at, thresholds_json) VALUES (?, ?, 'Zuhause', ?, '{}')`,
  );
  const insRaw = db.prepare(
    `INSERT INTO metrics_raw (server_id, ts, cpu, ram, swap, disk_max, disk_json, temp, net_in, net_out)
     VALUES (?, ?, 10, 40, 0, 50, '[]', 45, 100, 100)`,
  );
  const insAlert = db.prepare(
    `INSERT INTO alerts (id, key, level, title, body, server_id, source, state, opened_at, resolved_at)
     VALUES (?, ?, ?, 'Titel', 'Text', ?, 'server', ?, ?, ?)`,
  );
  const insAudit = db.prepare(
    `INSERT INTO audit_log (ts, actor, action, target) VALUES (?, 'admin', 'x', 'y')`,
  );
  db.transaction(() => {
    servers.forEach((id, i) => insServer.run(id, `server-${i}`, now - 30 * 24 * HOUR));
    for (const id of servers) {
      for (let ts = now - 48 * HOUR; ts < now; ts += 10_000) insRaw.run(id, ts);
    }
    for (let i = 0; i < 20_000; i++) {
      const open = i < 30;
      insAlert.run(
        `alert${i}`,
        `k${i}`,
        i % 3 === 0 ? 'crit' : 'warn',
        servers[i % servers.length],
        open ? 'open' : 'resolved',
        now - i * 60_000,
        open ? null : now - i * 60_000 + 1,
      );
    }
    for (let i = 0; i < 50_000; i++) insAudit.run(now - i * 1000);
  })();
}

/** Records every statement prepared through better-sqlite3 (Drizzle prepares per query). */
function captureSql(t: TestApp): { sqls: Set<string>; stop: () => void } {
  const db = t.db.sqlite;
  const original = db.prepare.bind(db);
  const sqls = new Set<string>();
  db.prepare = ((source: string) => {
    sqls.add(source);
    return original(source);
  }) as typeof db.prepare;
  return { sqls, stop: () => (db.prepare = original) };
}

function fullScans(t: TestApp, sql: string): string[] {
  if (!/^\s*select/i.test(sql)) return [];
  const params = (sql.match(/\?/g) ?? []).map(() => null);
  const plan = t.db.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as {
    detail: string;
  }[];
  return (
    plan
      .map((p) => p.detail)
      // Also `SCAN x USING INDEX` (an ordered walk over the whole table) counts.
      .filter((d) => BIG_TABLES.some((tb) => new RegExp(`^SCAN ${tb}\\b`).test(d)))
  );
}

describe('overview performance', () => {
  it('no full scans of big tables, every endpoint well under the budget', async () => {
    const app = await makeApp();
    t = app;
    const { cookie } = await completeSetup(app);
    seed(t, t.clock.t);
    const checkIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/checks',
        headers: authHeaders(cookie),
        payload: { kind: 'http', name: `site-${i}`, url: `https://example${i}.invalid/` },
      });
      expect(res.statusCode).toBe(200);
      checkIds.push(res.json<{ check: { id: string } }>().check.id);
    }
    const insResult = t.db.sqlite.prepare(
      'INSERT INTO check_results (check_id, ts, ok, code, ms) VALUES (?, ?, 1, 200, 120)',
    );
    t.db.sqlite.transaction(() => {
      for (const id of checkIds) {
        for (let ts = app.clock.t - 7 * 24 * HOUR; ts < app.clock.t; ts += 60_000)
          insResult.run(id, ts);
      }
    })();
    t.db.sqlite.exec('ANALYZE');
    const cap = captureSql(t);
    const times: Record<string, number> = {};
    for (const url of OVERVIEW) {
      // Second request is the steady state (prepared statements, caches).
      await t.app.inject({ method: 'GET', url, headers: authHeaders(cookie) });
      const start = performance.now();
      const res = await t.app.inject({ method: 'GET', url, headers: authHeaders(cookie) });
      times[url] = performance.now() - start;
      expect(res.statusCode, url).toBe(200);
    }
    cap.stop();
    const scans = [...cap.sqls].flatMap((sql) => fullScans(app, sql).map((d) => `${d} :: ${sql}`));
    expect(scans).toEqual([]);
    const total = Object.values(times).reduce((a, b) => a + b, 0);
    // Target: overview < 1 s in the tailnet; the core's share must be a fraction of it.
    expect(total, JSON.stringify(times)).toBeLessThan(500);
  });
});
