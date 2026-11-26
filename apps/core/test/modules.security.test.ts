import { afterEach, describe, expect, it } from 'vitest';
import { MODULES, modulesSchema, wallStateSchema } from '@hz/shared';
import { moduleOfPath } from '../src/modules/service.js';
import { stepUp, until, WsClient } from './agent-helpers.js';
import { gameRequest, readyGame, rpcsOf, tick, withGames } from './games-helpers.js';
import { authHeaders, completeSetup, makeApp, SAME_ORIGIN, type TestApp } from './helpers.js';
import { createShare, friend, gateway } from './share-helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

const put = (app: TestApp, cookie: string, payload: unknown) =>
  app.app.inject({
    method: 'PUT',
    url: '/api/settings/modules',
    headers: authHeaders(cookie),
    payload: payload as object,
  });

const sample = (url: string) =>
  url
    .replace(/\*$/, 'x')
    .replace(/:entityId/g, 'light.flur')
    .replace(/:[A-Za-z]+/g, 'AAAAAAAAAAAAAAAAAAAAAA');

describe('optional modules', () => {
  it('fresh install: games on, github and homeassistant off; exposed in /api/auth/state', async () => {
    t = await makeApp({ modules: 'fresh' });
    const { cookie } = await completeSetup(t);
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/settings/modules',
      headers: authHeaders(cookie),
    });
    expect(res.statusCode).toBe(200);
    expect(modulesSchema.parse(res.json())).toEqual({
      github: false,
      homeassistant: false,
      games: true,
      proxmox: false,
      dnsfilter: false,
      fritzbox: false,
      uptimekuma: false,
      storage: true,
      logsearch: false,
      vulnscan: false,
      fail2ban: false,
      discordbot: false,
      voice: false,
      tasks: false,
      selfheal: false,
      speedtest: false,
      domains: false,
      apps: false,
    });
    const state = await t.app.inject({
      method: 'GET',
      url: '/api/auth/state',
      headers: authHeaders(cookie),
    });
    expect(state.json()).toMatchObject({
      modules: {
        github: false,
        homeassistant: false,
        games: true,
        proxmox: false,
        dnsfilter: false,
        fritzbox: false,
        uptimekuma: false,
      },
      timeZone: 'Europe/Vienna',
    });
    // Anonymous: no module flags, no time zone.
    const anon = await t.app.inject({
      method: 'GET',
      url: '/api/auth/state',
      headers: SAME_ORIGIN,
    });
    expect(anon.json()).not.toHaveProperty('modules');
    expect(anon.json()).not.toHaveProperty('timeZone');
  });

  it('routes of disabled modules are unreachable even with a valid session (404 module_disabled)', async () => {
    t = await makeApp({
      modules: Object.fromEntries(MODULES.map((m) => [m, false])),
    });
    const { cookie } = await completeSetup(t);
    const routes = t.app.hzRoutes.filter((r) => moduleOfPath(r.url) !== null);
    // Every module has routes; all of them are gated.
    for (const m of MODULES) {
      expect(
        routes.some((r) => moduleOfPath(r.url) === m),
        m,
      ).toBe(true);
    }
    expect(routes.length).toBeGreaterThan(40);
    for (const r of routes) {
      if (r.method === 'HEAD') continue;
      const res = await t.app.inject({
        method: r.method as 'GET',
        url: sample(r.url),
        headers: authHeaders(cookie),
        ...(r.method === 'GET' ? {} : { payload: {} }),
      });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(404);
      expect(res.json(), `${r.method} ${r.url}`).toEqual({ ok: false, error: 'module_disabled' });
    }
    // Encoded paths do not slip through.
    const enc = await t.app.inject({
      method: 'GET',
      url: '/api/%67ithub/repos',
      headers: authHeaders(cookie),
    });
    expect(enc.statusCode).toBe(404);
    // Without a session the guard answers first.
    const anon = await t.app.inject({
      method: 'GET',
      url: '/api/github/repos',
      headers: SAME_ORIGIN,
    });
    expect(anon.statusCode).toBe(401);
    // The modules route itself and other routes still work.
    for (const url of ['/api/settings/modules', '/api/servers', '/api/checks']) {
      const res = await t.app.inject({ method: 'GET', url, headers: authHeaders(cookie) });
      expect(res.statusCode, url).toBe(200);
    }
  });

  it('enabling github, homeassistant, tasks or domains needs step-up, games and switching off do not', async () => {
    t = await makeApp({ modules: 'fresh' });
    const { cookie, secret } = await completeSetup(t);
    t.clock.advance(16 * 60_000);
    for (const body of [
      { github: true },
      { homeassistant: true },
      { games: true, github: true },
      { tasks: true },
      { domains: true },
    ]) {
      const res = await put(t, cookie, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(403);
      expect(res.json()).toEqual({ ok: false, error: 'step_up_required' });
    }
    expect(t.app.hzCore.modules.get()).toEqual({
      github: false,
      homeassistant: false,
      games: true,
      proxmox: false,
      dnsfilter: false,
      fritzbox: false,
      uptimekuma: false,
      storage: true,
      logsearch: false,
      vulnscan: false,
      fail2ban: false,
      discordbot: false,
      voice: false,
      tasks: false,
      selfheal: false,
      speedtest: false,
      domains: false,
      apps: false,
    });
    // Off and games on: no step-up.
    expect((await put(t, cookie, { games: false })).statusCode).toBe(200);
    expect((await put(t, cookie, { games: true, github: false })).json()).toEqual({
      github: false,
      homeassistant: false,
      games: true,
      proxmox: false,
      dnsfilter: false,
      fritzbox: false,
      uptimekuma: false,
      storage: true,
      logsearch: false,
      vulnscan: false,
      fail2ban: false,
      discordbot: false,
      voice: false,
      tasks: false,
      selfheal: false,
      speedtest: false,
      domains: false,
      apps: false,
    });
    // Invalid input.
    for (const body of [{}, { shell: true }, { github: 'yes' }, []]) {
      expect((await put(t, cookie, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    // No session.
    const anon = await t.app.inject({
      method: 'PUT',
      url: '/api/settings/modules',
      headers: SAME_ORIGIN,
      payload: { github: true },
    });
    expect(anon.statusCode).toBe(401);

    await stepUp(t, secret, cookie);
    const on = await put(t, cookie, { github: true, homeassistant: true });
    expect(on.statusCode).toBe(200);
    // Enabled without restart: the routes answer again.
    const gh = await t.app.inject({
      method: 'GET',
      url: '/api/github/settings',
      headers: authHeaders(cookie),
    });
    expect(gh.statusCode).toBe(200);
    const audit = t.db.sqlite
      .prepare("SELECT details_json d FROM audit_log WHERE action = 'settings.modules'")
      .all() as { d: string }[];
    expect(audit.map((a) => JSON.parse(a.d))).toEqual([
      { games: false },
      { games: true },
      { github: true, homeassistant: true },
    ]);
  });

  it('games off: jobs stop, live topics send nothing, share links refused, no wall tile', async () => {
    const s = await withGames(clients);
    t = s.t;
    const g = await readyGame(s);
    const link = await createShare(s, g.id);
    expect((await friend(s, 'GET', 'status', { token: link.token })).statusCode).toBe(200);
    const browser = await WsClient.connect(`${s.url}/live`, {
      cookie: `hz_session=${s.cookie}`,
      origin: 'https://hz.test',
      host: 'hz.test',
    });
    clients.push(browser);

    s.t.app.hzCore.modules.set({ games: false });
    const before = rpcsOf(s, 'game.status').length;
    await tick(s, 60_000);
    expect(rpcsOf(s, 'game.status').length).toBe(before);

    browser.send({ type: 'subscribe', topics: ['games', `game:${g.id}`] });
    const err = await browser.next((m) => m.type === 'error');
    expect(err).toMatchObject({ code: 'unknown_topic' });
    expect(browser.received.some((m) => m.type === 'snapshot')).toBe(false);

    const fr = await friend(s, 'GET', 'status', { token: link.token });
    expect(fr.statusCode).toBe(404);
    expect(fr.json()).toEqual({ ok: false, error: 'module_disabled' });
    const gw = await gateway(s, 'GET', 'status', {
      gatewayToken: 'A'.repeat(43),
      token: link.token,
    });
    expect(gw.statusCode).toBe(404);
    const page = await s.t.app.inject({
      method: 'GET',
      url: `/s/${link.token}`,
      headers: { host: 'hz.test' },
    });
    expect(page.statusCode).toBe(404);

    const wall = wallStateSchema.parse((await gameRequest(s, 'GET', '/api/wall/state')).json());
    expect(wall.tiles.map((x) => x.id)).toEqual(['servers', 'temperature', 'power', 'problems']);

    // On again: jobs and links work without restart.
    s.t.app.hzCore.modules.set({ games: true });
    await tick(s, 30_000);
    expect(rpcsOf(s, 'game.status').length).toBeGreaterThan(before);
    expect((await friend(s, 'GET', 'status', { token: link.token })).statusCode).toBe(200);
  });

  it('the configured time zone is in the bootstrap response and drives the wall night', async () => {
    t = await makeApp({ env: { HZ_TIMEZONE: 'UTC' } });
    const { cookie } = await completeSetup(t);
    const state = await t.app.inject({
      method: 'GET',
      url: '/api/auth/state',
      headers: authHeaders(cookie),
    });
    expect(state.json()).toMatchObject({ timeZone: 'UTC' });
    // 06:30 UTC is still night in UTC, while it is 07:30 (day) in Vienna.
    t.clock.t = Date.UTC(2026, 10, 27, 6, 30);
    const wall = wallStateSchema.parse(
      (
        await t.app.inject({ method: 'GET', url: '/api/wall/state', headers: authHeaders(cookie) })
      ).json(),
    );
    expect(wall.night).toBe(true);
  });

  it('homeassistant off: no connection, no wall tiles for it', async () => {
    t = await makeApp({ modules: { homeassistant: false } });
    const { cookie } = await completeSetup(t);
    await until(() => t?.app.hzCore.ha.state().status === 'off');
    const wall = wallStateSchema.parse(
      (
        await t.app.inject({ method: 'GET', url: '/api/wall/state', headers: authHeaders(cookie) })
      ).json(),
    );
    expect(wall.tiles.map((x) => x.id)).toEqual(['servers', 'players', 'problems']);
  });
});
