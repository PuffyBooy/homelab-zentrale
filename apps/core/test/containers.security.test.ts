import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_API_ROUTES } from '../src/auth/guard.js';
import { updatePlan } from '../src/containers/routes.js';
import { auditLog } from '../src/db/schema.js';
import { WsClient } from './agent-helpers.js';
import { containerByName, info, withAgent } from './container-helpers.js';
import { authHeaders, HOST, makeApp, type TestApp } from './helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

const ROUTES = [
  ['GET', '/api/containers'],
  ['POST', '/api/containers/:id/:action'],
] as const;

describe('container routes: auth', () => {
  it('are registered and not public', async () => {
    t = await makeApp();
    const routes = t.app.hzRoutes.map((r) => `${r.method} ${r.url}`);
    for (const [method, url] of ROUTES) {
      expect(routes).toContain(`${method} ${url}`);
      expect(PUBLIC_API_ROUTES).not.toContain(url);
    }
  });

  it('401 without a session or with a forged cookie, and nothing reaches the agent', async () => {
    const s = await withAgent(clients);
    t = s.t;
    const ha = containerByName(s.t, 'homeassistant');
    if (!ha) throw new Error('missing');
    for (const cookie of [undefined, `hz_session=${'A'.repeat(43)}`]) {
      const headers = { host: HOST, origin: `https://${HOST}`, ...(cookie ? { cookie } : {}) };
      const list = await s.t.app.inject({ url: '/api/containers', headers });
      expect(list.statusCode).toBe(401);
      for (const action of ['start', 'stop', 'restart', 'update']) {
        const res = await s.t.app.inject({
          method: 'POST',
          url: `/api/containers/${ha.id}/${action}`,
          headers,
        });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ ok: false, error: 'unauthorized' });
      }
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(s.rpcs).toEqual([]);
  });

  it('403 bad_origin for actions from a foreign or missing Origin', async () => {
    const s = await withAgent(clients);
    t = s.t;
    const ha = containerByName(s.t, 'homeassistant');
    if (!ha) throw new Error('missing');
    const cookie = `hz_session=${s.cookie}`;
    for (const headers of [
      { host: HOST, cookie, origin: 'https://evil.example' },
      { host: HOST, cookie, origin: 'null' },
      { host: HOST, cookie },
    ]) {
      const res = await s.t.app.inject({
        method: 'POST',
        url: `/api/containers/${ha.id}/stop`,
        headers,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ ok: false, error: 'bad_origin' });
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(s.rpcs).toEqual([]);
    expect(s.t.app.hzCore.containers.row(ha.id)?.intent).toBeNull();
  });
});

describe('image update: path choice', () => {
  it.each([
    ['/srv/app', 'container'],
    ['/opt/homelab/../etc', 'container'],
    ['/opt/homelab/apps/../../etc', 'container'],
    ['/opt/homelabx/app', 'container'],
    ['/opt/homelab/', 'container'],
    ['/opt/homelab//app', 'container'],
    ['/opt/homelab/./app', 'container'],
    ['opt/homelab/app', 'container'],
    ['/opt/homelab/app\0', 'container'],
    ['', 'container'],
    [null, 'container'],
    ['/opt/homelab/apps/web', 'compose'],
  ] as const)('composeDir %j -> %s', (composeDir, kind) => {
    expect(updatePlan({ composeDir, dockerId: 'abc123abc123' }).kind).toBe(kind);
  });

  it('compose dir below /opt/homelab/: compose.pull then compose.up on that dir', async () => {
    const s = await withAgent(clients, {
      containers: [
        info('web', {
          composeProject: 'web',
          composeService: 'web',
          composeDir: '/opt/homelab/apps/web',
        }),
      ],
    });
    t = s.t;
    const web = containerByName(s.t, 'web');
    if (!web) throw new Error('missing');
    const res = await s.t.app.inject({
      method: 'POST',
      url: `/api/containers/${web.id}/update`,
      headers: authHeaders(s.cookie),
    });
    expect(res.statusCode).toBe(200);
    expect(s.rpcs.map((r) => [r.action, r.params])).toEqual([
      ['compose.pull', { dir: '/opt/homelab/apps/web' }],
      ['compose.up', { dir: '/opt/homelab/apps/web' }],
    ]);
    const audit = s.t.db.db
      .select()
      .from(auditLog)
      .all()
      .find((a) => a.action === 'container.update');
    expect(JSON.parse(audit?.detailsJson ?? '{}')).toMatchObject({ method: 'compose' });
  });

  it('a compose update marks every container of the project as intended (no false alerts)', async () => {
    const dir = '/opt/homelab/apps/web';
    const s = await withAgent(clients, {
      containers: [
        info('web', { composeProject: 'web', composeService: 'web', composeDir: dir }),
        info('db', { composeProject: 'web', composeService: 'db', composeDir: dir }),
        info('other', {
          composeProject: 'other',
          composeService: 'x',
          composeDir: '/opt/homelab/o',
        }),
      ],
    });
    t = s.t;
    const [web, db, other] = ['web', 'db', 'other'].map((n) => containerByName(s.t, n));
    if (!web || !db || !other) throw new Error('missing');
    const res = await s.t.app.inject({
      method: 'POST',
      url: `/api/containers/${web.id}/update`,
      headers: authHeaders(s.cookie),
    });
    expect(res.statusCode).toBe(200);
    const svc = s.t.app.hzCore.containers;
    expect(svc.row(web.id)?.intent).toBe('restart');
    expect(svc.row(db.id)?.intent).toBe('restart');
    expect(svc.row(other.id)?.intent).toBeNull();
  });

  it('compose dir outside /opt/homelab/ or not normalized: container.update, never compose.*', async () => {
    const dirs = ['/srv/web', '/opt/homelab/../etc', '/opt/homelabx/web', '/opt/homelab/a/./b'];
    const s = await withAgent(clients, {
      containers: dirs.map((composeDir, i) =>
        info(`c${i}`, { composeProject: `p${i}`, composeService: 'svc', composeDir }),
      ),
    });
    t = s.t;
    for (let i = 0; i < dirs.length; i++) {
      const c = containerByName(s.t, `c${i}`);
      if (!c) throw new Error('missing');
      expect(c.composeManaged).toBe(false);
      const res = await s.t.app.inject({
        method: 'POST',
        url: `/api/containers/${c.id}/update`,
        headers: authHeaders(s.cookie),
      });
      expect(res.statusCode).toBe(200);
    }
    expect(s.rpcs.map((r) => r.action)).toEqual(dirs.map(() => 'container.update'));
    expect(s.rpcs.some((r) => String(r.action).startsWith('compose.'))).toBe(false);
    expect(s.rpcs.map((r) => r.params)).toEqual(
      dirs.map((_, i) => ({ id: containerByName(s.t, `c${i}`)?.dockerId })),
    );
  });

  it('a failing compose.pull stops before compose.up', async () => {
    const s = await withAgent(clients, {
      containers: [info('web', { composeProject: 'web', composeDir: '/opt/homelab/apps/web' })],
      reply: (rpc) =>
        rpc.action === 'compose.pull'
          ? {
              type: 'rpc.result',
              id: rpc.id,
              ok: false,
              error: { code: 'failed', message: 'pull' },
            }
          : null,
    });
    t = s.t;
    const web = containerByName(s.t, 'web');
    if (!web) throw new Error('missing');
    const res = await s.t.app.inject({
      method: 'POST',
      url: `/api/containers/${web.id}/update`,
      headers: authHeaders(s.cookie),
    });
    expect(res.statusCode).toBe(502);
    expect(s.rpcs.map((r) => r.action)).toEqual(['compose.pull']);
  });
});

describe('container logs topic: auth', () => {
  it('the /live upgrade needs a session, so logs are never streamed to anonymous clients', async () => {
    const s = await withAgent(clients);
    t = s.t;
    const origin = s.url.replace('ws://', 'http://');
    expect(await WsClient.status(`${s.url}/live`, { origin })).toBe(401);
    await new Promise((r) => setTimeout(r, 30));
    expect(s.rpcs).toEqual([]);
  });
});
