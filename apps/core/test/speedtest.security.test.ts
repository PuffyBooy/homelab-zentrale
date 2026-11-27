import { afterEach, describe, expect, it } from 'vitest';
import { errorResponseSchema } from '@hz/shared';
import type { WsClient } from './agent-helpers.js';
import { SAME_ORIGIN, type TestApp } from './helpers.js';
import { api, withAutomation, type AutoSetup } from './tasks-helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

async function setup(opts: Parameters<typeof withAutomation>[1] = {}): Promise<AutoSetup> {
  const s = await withAutomation(clients, opts);
  t = s.t;
  return s;
}

const ROUTES: { method: 'GET' | 'POST' | 'PUT'; url: string }[] = [
  { method: 'GET', url: '/api/speedtest' },
  { method: 'PUT', url: '/api/speedtest/settings' },
  { method: 'POST', url: '/api/speedtest/run' },
];

describe('speedtest security', () => {
  it('every route answers 401 without a session', async () => {
    const s = await setup();
    for (const r of ROUTES) {
      const res = await s.t.app.inject({
        method: r.method,
        url: r.url,
        headers: SAME_ORIGIN,
        payload: {},
      });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
    }
  });

  it('every route answers 404 module_disabled when the module is off', async () => {
    const s = await setup({ modules: { speedtest: false } });
    for (const r of ROUTES) {
      const res = await api(s, r.method, r.url, r.method === 'GET' ? undefined : {});
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(404);
      expect(errorResponseSchema.parse(res.json()).error).toBe('module_disabled');
    }
  });

  it('a state-changing request from another origin is refused', async () => {
    const s = await setup();
    const res = await s.t.app.inject({
      method: 'POST',
      url: '/api/speedtest/run',
      headers: {
        host: 'hz.test',
        origin: 'https://evil.example',
        cookie: `hz_session=${s.cookie}`,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects invalid settings and queries with 400, unknown servers with 404', async () => {
    const s = await setup();
    for (const bad of [
      {},
      { intervalHours: 5 },
      { intervalHours: 0 },
      { maxMb: 9 },
      { maxMb: 501 },
      { maxMb: 10.5 },
      { maxSeconds: 2 },
      { maxSeconds: 21 },
      { minDownMbps: 0 },
      { minUpMbps: -1 },
      { minDownMbps: 100_001 },
      { serverId: 'bad!' },
      { url: 'https://evil.example' },
      { host: 'evil.example' },
    ]) {
      const res = await api(s, 'PUT', '/api/speedtest/settings', bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    for (const q of ['days=8', 'days=abc', 'days=7&x=1']) {
      expect((await api(s, 'GET', `/api/speedtest?${q}`)).statusCode, q).toBe(400);
    }
    const unknown = await api(s, 'PUT', '/api/speedtest/settings', {
      serverId: 'unknownserver123',
    });
    expect(unknown.statusCode).toBe(404);
    // Nothing was stored by the refused requests.
    const row = s.t.db.sqlite
      .prepare("SELECT value_json FROM settings WHERE key = 'speedtest'")
      .get();
    expect(row).toBeUndefined();
  });
});
