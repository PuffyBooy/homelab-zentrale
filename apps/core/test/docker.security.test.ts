import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_API_ROUTES } from '../src/auth/guard.js';
import { stepUp, until, type Received, type WsClient } from './agent-helpers.js';
import {
  containerByName,
  info,
  inventory,
  insertServer,
  withAgent,
  type AgentSetup,
} from './container-helpers.js';
import { authHeaders, HOST, makeApp, SAME_ORIGIN, type TestApp } from './helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

const HEX = 'e'.repeat(64);
const ROUTES = [
  'GET /api/containers/:id/details',
  'POST /api/containers/:id/remove',
  'GET /api/servers/:serverId/docker/images',
  'POST /api/servers/:serverId/docker/images/pull',
  'POST /api/servers/:serverId/docker/images/:imageId/remove',
  'GET /api/servers/:serverId/docker/volumes',
  'POST /api/servers/:serverId/docker/volumes/:name/remove',
  'GET /api/servers/:serverId/docker/networks',
  'POST /api/servers/:serverId/docker/networks/:networkId/remove',
  'POST /api/servers/:serverId/stacks/:project/:op',
];

const CONTAINERS = [
  info('old', { state: 'exited', exitCode: 0, composeProject: 'misc' }),
  info('hz-agent', { state: 'exited', exitCode: 0, role: 'agent', composeProject: 'hz' }),
  info('hz-core', { role: 'core', composeProject: 'hz' }),
  info('game-mc', { state: 'exited', exitCode: 0, game: 'mc', composeProject: 'mc' }),
  info('web', { composeProject: 'site' }),
  info('web-db', { composeProject: 'site' }),
];

async function setup(reply?: (m: Received) => Record<string, unknown> | null): Promise<AgentSetup> {
  const s = await withAgent(clients, { containers: CONTAINERS, ...(reply ? { reply } : {}) });
  t = s.t;
  return s;
}

const post = (s: AgentSetup, url: string, payload: object = {}) =>
  s.t.app.inject({ method: 'POST', url, headers: authHeaders(s.cookie), payload });
const settle = () => new Promise((r) => setTimeout(r, 40));
const idOf = (s: AgentSetup, name: string): string => {
  const c = containerByName(s.t, name);
  if (!c) throw new Error(`missing ${name}`);
  return c.id;
};
const changingRpcs = (s: AgentSetup) =>
  s.rpcs.filter((r) =>
    ['container.remove', 'image.remove', 'volume.remove', 'network.remove', 'stack.op'].includes(
      r.action as string,
    ),
  );

function concrete(route: string, serverId: string, containerId: string): [string, string] {
  const [method, path] = route.split(' ') as [string, string];
  return [
    method,
    path
      .replace(':serverId', serverId)
      .replace(':id', containerId)
      .replace(':imageId', HEX)
      .replace(':networkId', HEX)
      .replace(':name', 'vol1')
      .replace(':project', 'site')
      .replace(':op', 'stop'),
  ];
}

describe('docker routes: auth', () => {
  it('are registered and not public', async () => {
    t = await makeApp();
    const routes = t.app.hzRoutes.map((r) => `${r.method} ${r.url}`);
    expect(routes).toEqual(expect.arrayContaining(ROUTES));
    for (const r of ROUTES) expect(PUBLIC_API_ROUTES).not.toContain(r.split(' ')[1]);
  });

  it('401 without a session or with a forged cookie; nothing reaches the agent', async () => {
    const s = await setup();
    const cid = idOf(s, 'old');
    for (const cookie of [undefined, `hz_session=${'A'.repeat(43)}`]) {
      for (const r of ROUTES) {
        const [method, url] = concrete(r, s.serverId, cid);
        const res = await s.t.app.inject({
          method: method as 'GET',
          url,
          headers: { ...SAME_ORIGIN, ...(cookie ? { cookie } : {}) },
          ...(method === 'POST' ? { payload: { confirmName: 'old', ref: 'nginx' } } : {}),
        });
        expect(res.statusCode, r).toBe(401);
        expect(res.json()).toEqual({ ok: false, error: 'unauthorized' });
      }
    }
    await settle();
    expect(s.rpcs).toEqual([]);
  });

  it('403 bad_origin for changes from a foreign Origin', async () => {
    const s = await setup();
    await stepUp(s.t, s.secret, s.cookie);
    const cid = idOf(s, 'old');
    for (const r of ROUTES.filter((x) => x.startsWith('POST'))) {
      const [, url] = concrete(r, s.serverId, cid);
      const res = await s.t.app.inject({
        method: 'POST',
        url,
        headers: { host: HOST, origin: 'https://evil.example', cookie: `hz_session=${s.cookie}` },
        payload: {},
      });
      expect(res.statusCode, r).toBe(403);
      expect(res.json()).toEqual({ ok: false, error: 'bad_origin' });
    }
    await settle();
    expect(s.rpcs).toEqual([]);
  });
});

describe('docker routes: step-up and confirmation', () => {
  it('container and volume removal need a step-up', async () => {
    const s = await setup();
    const a = await post(s, `/api/containers/${idOf(s, 'old')}/remove`, { confirmName: 'old' });
    expect(a.statusCode).toBe(403);
    expect(a.json()).toEqual({ ok: false, error: 'step_up_required' });
    const b = await post(s, `/api/servers/${s.serverId}/docker/volumes/vol1/remove`, {
      confirmName: 'vol1',
    });
    expect(b.statusCode).toBe(403);
    expect(b.json()).toEqual({ ok: false, error: 'step_up_required' });
    // Expired step-up counts as none.
    await stepUp(s.t, s.secret, s.cookie);
    s.t.clock.advance(15 * 60_000);
    const c = await post(s, `/api/containers/${idOf(s, 'old')}/remove`, { confirmName: 'old' });
    expect(c.statusCode).toBe(403);
    await settle();
    expect(changingRpcs(s)).toEqual([]);
  });

  it('a wrong confirmName is 400 confirm_mismatch and nothing reaches the agent', async () => {
    const s = await setup();
    await stepUp(s.t, s.secret, s.cookie);
    for (const confirmName of ['OLD', 'old ', 'other']) {
      const res = await post(s, `/api/containers/${idOf(s, 'old')}/remove`, { confirmName });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ ok: false, error: 'confirm_mismatch' });
      const v = await post(s, `/api/servers/${s.serverId}/docker/volumes/vol1/remove`, {
        confirmName,
      });
      expect(v.statusCode).toBe(400);
      expect(v.json()).toEqual({ ok: false, error: 'confirm_mismatch' });
    }
    // Unknown fields are refused too.
    const x = await post(s, `/api/containers/${idOf(s, 'old')}/remove`, {
      confirmName: 'old',
      force: true,
    });
    expect(x.statusCode).toBe(400);
    expect(x.json()).toEqual({ ok: false, error: 'invalid_input' });
    await settle();
    expect(changingRpcs(s)).toEqual([]);
  });
});

describe('docker routes: protected and game containers', () => {
  it('a protected container (hz.role) is never removed: 403', async () => {
    const s = await setup();
    await stepUp(s.t, s.secret, s.cookie);
    const res = await post(s, `/api/containers/${idOf(s, 'hz-agent')}/remove`, {
      confirmName: 'hz-agent',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ ok: false, error: 'forbidden' });
    await settle();
    expect(changingRpcs(s)).toEqual([]);
  });

  it('a game container is refused with 409 and the Gameserver hint', async () => {
    const s = await setup();
    await stepUp(s.t, s.secret, s.cookie);
    const res = await post(s, `/api/containers/${idOf(s, 'game-mc')}/remove`, {
      confirmName: 'game-mc',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      ok: false,
      error: 'conflict',
      message: 'Gameserver über die Gameserver-Seite löschen',
    });
    await settle();
    expect(changingRpcs(s)).toEqual([]);
  });

  it('stack ops: a protected project 403, a game project 409, no intent set', async () => {
    const s = await setup();
    for (const op of ['start', 'stop', 'restart', 'update']) {
      const p = await post(s, `/api/servers/${s.serverId}/stacks/hz/${op}`);
      expect(p.statusCode).toBe(403);
      expect(p.json()).toEqual({ ok: false, error: 'forbidden' });
      const g = await post(s, `/api/servers/${s.serverId}/stacks/mc/${op}`);
      expect(g.statusCode).toBe(409);
      expect(g.json()).toMatchObject({ ok: false, error: 'conflict' });
    }
    expect(
      (await post(s, `/api/servers/${s.serverId}/stacks/hz/down`, { confirmName: 'hz' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await post(s, `/api/servers/${s.serverId}/stacks/mc/down`, { confirmName: 'mc' }))
        .statusCode,
    ).toBe(409);
    await settle();
    expect(changingRpcs(s)).toEqual([]);
    expect(s.t.app.hzCore.containers.row(idOf(s, 'hz-core'))?.intent).toBeNull();
  });

  it('a stack op only touches the project on that server', async () => {
    const s = await setup();
    const other = insertServer(s.t, 'pi');
    inventory(s.t, other, [info('remote-web', { composeProject: 'remote' })]);
    // The project exists only on the other server: 404 here.
    const res = await post(s, `/api/servers/${s.serverId}/stacks/remote/stop`);
    expect(res.statusCode).toBe(404);
    await settle();
    expect(changingRpcs(s)).toEqual([]);
  });
});

describe('docker routes: agent state', () => {
  it('offline agent: 409 agent_offline for every route', async () => {
    const s = await setup();
    await stepUp(s.t, s.secret, s.cookie);
    s.agent.ws.close();
    await until(() => !s.t.app.hzCore.hub.isConnected(s.serverId));
    const cid = idOf(s, 'old');
    for (const r of ROUTES) {
      const [method, url] = concrete(r, s.serverId, cid);
      const payload = r.includes('/pull')
        ? { ref: 'nginx' }
        : r.includes('volumes')
          ? { confirmName: 'vol1' }
          : { confirmName: 'old' };
      const res = await s.t.app.inject({
        method: method as 'GET',
        url,
        headers: authHeaders(s.cookie),
        ...(method === 'POST' ? { payload } : {}),
      });
      expect(res.statusCode, r).toBe(409);
      expect(res.json(), r).toEqual({ ok: false, error: 'agent_offline' });
    }
  });

  it('an agent without the M23 actions: 409 with "Agent zu alt"', async () => {
    const s = await setup((m) => ({
      type: 'rpc.result',
      id: m.id,
      ok: false,
      error: { code: 'not_allowed', message: 'action not allowed' },
    }));
    await stepUp(s.t, s.secret, s.cookie);
    const cid = idOf(s, 'old');
    for (const r of ROUTES) {
      const [method, url] = concrete(r, s.serverId, cid);
      const payload = r.includes('/pull')
        ? { ref: 'nginx' }
        : r.includes('volumes')
          ? { confirmName: 'vol1' }
          : { confirmName: 'old' };
      const res = await s.t.app.inject({
        method: method as 'GET',
        url,
        headers: authHeaders(s.cookie),
        ...(method === 'POST' ? { payload } : {}),
      });
      expect(res.statusCode, r).toBe(409);
      expect(res.json(), r).toEqual({
        ok: false,
        error: 'conflict',
        message: 'Agent zu alt, bitte aktualisieren',
      });
    }
  });

  it('other agent refusals (protected on the agent) stay 403, without the agent text', async () => {
    const s = await setup((m) => ({
      type: 'rpc.result',
      id: m.id,
      ok: false,
      error: { code: 'not_allowed', message: 'image used by a protected container' },
    }));
    const res = await post(s, `/api/servers/${s.serverId}/docker/images/${HEX}/remove`);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ ok: false, error: 'forbidden' });
    const audit = s.t.db.sqlite
      .prepare("SELECT action FROM audit_log WHERE action LIKE 'docker.image.remove%' ORDER BY id")
      .all();
    expect(audit).toEqual([
      { action: 'docker.image.remove' },
      { action: 'docker.image.remove_failed' },
    ]);
  });

  it('busy from the agent (volume in use) is 409 busy', async () => {
    const s = await setup((m) => ({
      type: 'rpc.result',
      id: m.id,
      ok: false,
      error: { code: 'busy', message: 'volume is in use' },
    }));
    await stepUp(s.t, s.secret, s.cookie);
    const res = await post(s, `/api/servers/${s.serverId}/docker/volumes/vol1/remove`, {
      confirmName: 'vol1',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ ok: false, error: 'busy' });
  });
});

describe('docker routes: no env values anywhere', () => {
  it('details pass only env keys; audit rows never contain values', async () => {
    const SECRET = 'geheim-wert-4711';
    const s = await setup((m) => {
      if (m.action !== 'container.inspect') return null;
      return {
        type: 'rpc.result',
        id: m.id,
        ok: true,
        // An agent that wrongly sends values is refused by the strict schema.
        data: { envKeys: ['DB_PASSWORD'], env: [`DB_PASSWORD=${SECRET}`] },
      };
    });
    await stepUp(s.t, s.secret, s.cookie);
    const res = await s.t.app.inject({
      url: `/api/containers/${idOf(s, 'web')}/details`,
      headers: authHeaders(s.cookie),
    });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain(SECRET);
    await post(s, `/api/containers/${idOf(s, 'old')}/remove`, { confirmName: 'old' });
    await post(s, `/api/servers/${s.serverId}/stacks/site/restart`);
    await post(s, `/api/servers/${s.serverId}/docker/images/pull`, { ref: 'nginx:1.27' });
    const rows = s.t.db.sqlite
      .prepare("SELECT action, details_json AS d FROM audit_log WHERE action LIKE 'docker.%'")
      .all() as { action: string; d: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows) {
      expect(r.d).not.toContain(SECRET);
      expect(Object.keys(JSON.parse(r.d) as object)).not.toContain('env');
    }
  });
});
