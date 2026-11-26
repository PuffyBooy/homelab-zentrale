import { afterEach, describe, expect, it } from 'vitest';
import { MAX_ALLOWED_PORTS } from '@hz/shared';
import { enrollAgent, listen, type WsClient } from './agent-helpers.js';
import { authHeaders, completeSetup, makeApp, SAME_ORIGIN, type TestApp } from './helpers.js';

let t: TestApp | undefined;
let agent: WsClient | undefined;
afterEach(async () => {
  agent?.close();
  agent = undefined;
  await t?.app.close();
  t = undefined;
});

async function setup(): Promise<{ app: TestApp; cookie: string; serverId: string }> {
  const app = await makeApp();
  t = app;
  const { cookie } = await completeSetup(app);
  const e = await enrollAgent(app, await listen(app), cookie);
  agent = e.agent;
  return { app, cookie, serverId: e.serverId };
}

describe('port audit routes', () => {
  it('401 without a session, nothing changes', async () => {
    const { app, serverId } = await setup();
    for (const [method, url, payload] of [
      ['GET', `/api/servers/${serverId}/ports/allowed`, undefined],
      ['PUT', `/api/servers/${serverId}/ports/allowed`, { ports: [] }],
      ['POST', `/api/servers/${serverId}/ports/allow`, { port: 80, proto: 'tcp' }],
    ] as const) {
      const res = await app.app.inject({
        method,
        url,
        headers: SAME_ORIGIN,
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    expect(app.db.sqlite.prepare('SELECT COUNT(*) n FROM server_port_audit').get()).toEqual({
      n: 0,
    });
  });

  it('403 bad_origin for changes from another origin', async () => {
    const { app, cookie, serverId } = await setup();
    const res = await app.app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/ports/allow`,
      headers: { ...authHeaders(cookie), origin: 'https://evil.example' },
      payload: { port: 80, proto: 'tcp' },
    });
    expect(res.statusCode).toBe(403);
    expect(app.db.sqlite.prepare('SELECT COUNT(*) n FROM server_allowed_ports').get()).toEqual({
      n: 0,
    });
  });

  it('400 for invalid input', async () => {
    const { app, cookie, serverId } = await setup();
    const bad: [string, string, unknown][] = [
      ['POST', 'allow', { port: 0, proto: 'tcp' }],
      ['POST', 'allow', { port: 70000, proto: 'tcp' }],
      ['POST', 'allow', { port: 80, proto: 'icmp' }],
      ['POST', 'allow', { port: 80, proto: 'tcp', note: 'x'.repeat(81) }],
      ['POST', 'allow', { port: 80, proto: 'tcp', extra: true }],
      [
        'PUT',
        'allowed',
        {
          ports: [
            { port: 80, proto: 'tcp' },
            { port: 80, proto: 'tcp' },
          ],
        },
      ],
      [
        'PUT',
        'allowed',
        {
          ports: Array.from({ length: MAX_ALLOWED_PORTS + 1 }, (_, i) => ({
            port: i + 1,
            proto: 'tcp',
          })),
        },
      ],
      ['PUT', 'allowed', {}],
    ];
    for (const [method, path, payload] of bad) {
      const res = await app.app.inject({
        method: method as 'POST',
        url: `/api/servers/${serverId}/ports/${path}`,
        headers: authHeaders(cookie),
        payload: payload as object,
      });
      expect(res.statusCode, JSON.stringify(payload).slice(0, 60)).toBe(400);
      expect(res.json()).toEqual({ ok: false, error: 'invalid_input' });
    }
  });

  it('404 for an unknown server, 400 for a malformed id', async () => {
    const { app, cookie } = await setup();
    const missing = await app.app.inject({
      method: 'GET',
      url: '/api/servers/AAAAAAAAAAAAAAAAAAAAAA/ports/allowed',
      headers: authHeaders(cookie),
    });
    expect(missing.statusCode).toBe(404);
    const bad = await app.app.inject({
      method: 'GET',
      url: '/api/servers/x/ports/allowed',
      headers: authHeaders(cookie),
    });
    expect(bad.statusCode).toBe(400);
  });
});
