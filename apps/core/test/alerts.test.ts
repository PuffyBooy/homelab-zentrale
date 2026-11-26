import { afterEach, describe, expect, it } from 'vitest';
import { alertListResponseSchema, alertResponseSchema } from '@hz/shared';
import { AlertService } from '../src/alerts/service.js';
import { openDatabase, type DbHandle } from '../src/db/index.js';
import { authHeaders, completeSetup, makeApp, type TestApp } from './helpers.js';

let h: DbHandle | undefined;
let t: TestApp | undefined;
afterEach(async () => {
  h?.close();
  h = undefined;
  await t?.app.close();
  t = undefined;
});

// 23:04 in Vienna.
const NOW = Date.UTC(2026, 10, 25, 22, 4, 0);

function service() {
  h = openDatabase(':memory:');
  const clock = { t: NOW };
  const svc = new AlertService(h.db, () => clock.t);
  const events: string[] = [];
  svc.onChange((a) => events.push(`${a.level}:${a.state}`));
  return { svc, clock, events };
}

describe('AlertService', () => {
  it('dedupes by key while open or acked', () => {
    const { svc } = service();
    const a = svc.raise(
      'check:1:down',
      'crit',
      'sc-ball.at ist offline',
      'Seit 23:04.',
      null,
      'check',
    );
    expect(a.created).toBe(true);
    const b = svc.raise('check:1:down', 'crit', 'anders', 'anders', null, 'check');
    expect(b).toMatchObject({ created: false, changed: false });
    expect(b.alert.id).toBe(a.alert.id);
    expect(b.alert.title).toBe('sc-ball.at ist offline');
    svc.ack(a.alert.id);
    expect(svc.raise('check:1:down', 'crit', 'x', 'y', null, 'check').created).toBe(false);
    expect(svc.list({ state: 'all', limit: 100 })).toHaveLength(1);
  });

  it('a level change updates the active alert (escalation)', () => {
    const { svc } = service();
    const a = svc.raise('k', 'warn', 'Disk bei 86 %', 'b', null, 'server');
    const b = svc.raise('k', 'crit', 'Disk bei 96 %', 'b2', null, 'server');
    expect(b).toMatchObject({ created: false, changed: true });
    expect(b.alert).toMatchObject({
      id: a.alert.id,
      level: 'crit',
      title: 'Disk bei 96 %',
      body: 'b2',
    });
  });

  it('resolve closes the alert and logs an OK alert; nothing happens without one', () => {
    const { svc, clock, events } = service();
    expect(svc.resolve('k')).toBeNull();
    svc.raise('k', 'crit', 'heimserver ist offline', 'b', null, 'server');
    clock.t += 6 * 60_000;
    const ok = svc.resolve('k', { title: 'heimserver ist wieder online', body: 'Seit 23:10.' });
    expect(ok).toMatchObject({
      level: 'ok',
      state: 'resolved',
      key: 'k',
      title: 'heimserver ist wieder online',
    });
    expect(svc.active('k')).toBeNull();
    expect(events).toEqual(['crit:open', 'crit:resolved', 'ok:resolved']);
    // Default OK text uses Vienna time.
    svc.raise('k', 'warn', 'T', 'b', null, 'server');
    expect(svc.resolve('k')).toMatchObject({ title: 'Erledigt: T', body: 'Seit 23:10 erledigt.' });
    // After resolve, the same key opens a new alert.
    expect(svc.raise('k', 'crit', 'again', 'b', null, 'server').created).toBe(true);
  });

  it('the partial unique index enforces one active alert per key', () => {
    const { svc } = service();
    svc.raise('k', 'crit', 't', 'b', null, 'server');
    expect(() =>
      h?.sqlite
        .prepare(
          "INSERT INTO alerts (id, key, level, title, body, source, state, opened_at) VALUES ('x','k','crit','t','b','server','open',0)",
        )
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it('filters the list', () => {
    const { svc, clock } = service();
    svc.raise('a', 'crit', 'a', 'b', null, 'server');
    clock.t += 1;
    svc.raise('b', 'warn', 'b', 'b', null, 'check');
    clock.t += 1;
    svc.raise('c', 'warn', 'c', 'b', null, 'check');
    svc.resolve('c');
    expect(svc.list({ state: 'active', limit: 100 }).map((a) => a.key)).toEqual(['b', 'a']);
    expect(
      svc.list({ state: 'all', limit: 100, source: 'check', level: 'warn' }).map((a) => a.key),
    ).toEqual(['c', 'b']);
    expect(svc.list({ state: 'resolved', limit: 1 })).toHaveLength(1);
  });
});

describe('alert routes', () => {
  async function withAlert() {
    t = await makeApp();
    const { cookie } = await completeSetup(t);
    const { alert } = t.app.hzCore.alerts.raise(
      'k',
      'crit',
      'heimserver ist offline',
      'b',
      null,
      'server',
    );
    return { t, cookie, id: alert.id };
  }

  it('GET /api/alerts lists active alerts by default and validates the query', async () => {
    const { t, cookie, id } = await withAlert();
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/alerts',
      headers: authHeaders(cookie),
    });
    expect(res.statusCode).toBe(200);
    expect(alertListResponseSchema.parse(res.json()).alerts.map((a) => a.id)).toEqual([id]);
    for (const q of ['state=nope', 'limit=0', 'limit=9999', 'level=fatal', 'x=1']) {
      const bad = await t.app.inject({
        method: 'GET',
        url: `/api/alerts?${q}`,
        headers: authHeaders(cookie),
      });
      expect(bad.statusCode, q).toBe(400);
    }
  });

  it('ack and resolve with audit; 409 on repeat, 404 unknown, 400 invalid id', async () => {
    const { t, cookie, id } = await withAlert();
    const post = (url: string) =>
      t.app.inject({ method: 'POST', url, headers: authHeaders(cookie) });
    const ack = await post(`/api/alerts/${id}/ack`);
    expect(ack.statusCode).toBe(200);
    expect(alertResponseSchema.parse(ack.json()).alert.state).toBe('acked');
    expect((await post(`/api/alerts/${id}/ack`)).statusCode).toBe(409);
    const res = await post(`/api/alerts/${id}/resolve`);
    expect(res.json().alert.state).toBe('resolved');
    expect((await post(`/api/alerts/${id}/resolve`)).statusCode).toBe(409);
    expect((await post('/api/alerts/AAAAAAAAAAAAAAAAAAAAAA/ack')).statusCode).toBe(404);
    expect((await post('/api/alerts/x/ack')).statusCode).toBe(400);
    const audit = t.db.sqlite
      .prepare("SELECT action FROM audit_log WHERE action LIKE 'alert.%'")
      .all();
    expect(audit).toEqual([{ action: 'alert.acked' }, { action: 'alert.resolved' }]);
  });

  it('401 without session', async () => {
    const { t, id } = await withAlert();
    for (const [method, url] of [
      ['GET', '/api/alerts'],
      ['POST', `/api/alerts/${id}/ack`],
      ['POST', `/api/alerts/${id}/resolve`],
    ] as const) {
      expect((await t.app.inject({ method, url })).statusCode).toBe(401);
    }
  });
});
