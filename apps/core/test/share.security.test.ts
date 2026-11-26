import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  shareConsoleResponseSchema,
  shareErrorResponseSchema,
  shareStatusResponseSchema,
} from '@hz/shared';
import { PUBLIC_API_ROUTES } from '../src/auth/guard.js';
import { createSecretBox, randomToken } from '../src/crypto.js';
import { auditLog, gameServers, servers, shareAudit, shareLinks } from '../src/db/schema.js';
import { redactShareUrl } from '../src/share/redact.js';
import {
  maskTailnet,
  SHARE_CONSOLE_IP_LIMIT,
  SHARE_IP_LIMIT,
  SHARE_TOKEN_LIMIT,
} from '../src/share/service.js';
import type { WsClient } from './agent-helpers.js';
import { stepUp } from './agent-helpers.js';
import { gameRequest, readyGame, rpcsOf, withGames, type GameSetup } from './games-helpers.js';
import { HOST, KEY, type TestApp } from './helpers.js';
import { createShare, enableGateway, friend, gateway, keyPaths, nextIp } from './share-helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

async function setup(opts: Parameters<typeof withGames>[1] = {}): Promise<GameSetup> {
  const s = await withGames(clients, opts);
  t = s.t;
  return s;
}

const MIN = 60_000;
const randomShareToken = (): string => randomToken(32);

const ADMIN_ROUTES = [
  ['GET', '/api/games/:id/shares'],
  ['POST', '/api/games/:id/shares'],
  ['POST', '/api/shares/:id/revoke'],
  ['DELETE', '/api/shares/:id'],
  ['GET', '/api/games/:id/share-audit'],
  ['GET', '/api/settings/share-gateway'],
  ['PUT', '/api/settings/share-gateway'],
  ['POST', '/api/settings/share-gateway/token'],
] as const;

describe('share admin routes: auth', () => {
  it('are registered, not public, and 401 without a session', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const link = await createShare(s, g.id);
    const routes = s.t.app.hzRoutes.map((r) => `${r.method} ${r.url}`);
    for (const [method, url] of ADMIN_ROUTES) {
      expect(routes).toContain(`${method} ${url}`);
      expect(PUBLIC_API_ROUTES).not.toContain(url);
      const id = url.includes('/shares/') ? link.id : g.id;
      const res = await s.t.app.inject({
        method,
        url: url.replace(':id', id),
        headers: { host: HOST, origin: `https://${HOST}` },
        ...(method === 'GET' ? {} : { payload: {} }),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    // Nothing changed: the link still works.
    expect((await friend(s, 'GET', 'status', { token: link.token })).statusCode).toBe(200);
  });

  it('refuses admin changes from a foreign Origin', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const res = await s.t.app.inject({
      method: 'POST',
      url: `/api/games/${g.id}/shares`,
      headers: { ...s.headers, origin: 'https://evil.example' },
      payload: { person: 'Max', perms: ['power'], expires: '7d' },
    });
    expect(res.statusCode).toBe(403);
    expect(s.t.db.db.select().from(shareLinks).all()).toHaveLength(0);
  });

  it('gateway settings and token need step-up', async () => {
    const s = await setup();
    const put = await gameRequest(s, 'PUT', '/api/settings/share-gateway', {
      enabled: true,
      publicUrl: 'https://spiel.example.org',
    });
    expect(put.statusCode).toBe(403);
    expect(put.json()).toEqual({ ok: false, error: 'step_up_required' });
    const tok = await gameRequest(s, 'POST', '/api/settings/share-gateway/token');
    expect(tok.statusCode).toBe(403);
    expect(tok.json()).toEqual({ ok: false, error: 'step_up_required' });
    const get = await gameRequest(s, 'GET', '/api/settings/share-gateway');
    expect(get.json()).toEqual({
      enabled: false,
      publicUrl: null,
      tokenSet: false,
      lastSeenAt: null,
    });

    await stepUp(s.t, s.secret, s.cookie);
    const ok = await gameRequest(s, 'PUT', '/api/settings/share-gateway', {
      enabled: true,
      publicUrl: 'https://spiel.example.org/',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ enabled: true, publicUrl: 'https://spiel.example.org' });
    const created = await gameRequest(s, 'POST', '/api/settings/share-gateway/token');
    expect(created.statusCode).toBe(200);
    const { token } = created.json<{ token: string }>();
    // Shown once: never in GET, the settings row holds only a hash.
    const again = await gameRequest(s, 'GET', '/api/settings/share-gateway');
    expect(again.body).not.toContain(token);
    expect(again.json()).toMatchObject({ tokenSet: true });
    const rows = s.t.db.sqlite.prepare('SELECT value_json FROM settings').all() as {
      value_json: string;
    }[];
    expect(JSON.stringify(rows)).not.toContain(token);
    // Plain http and an enabled gateway without address are refused.
    for (const body of [
      { enabled: true, publicUrl: 'http://spiel.example.org' },
      { enabled: true, publicUrl: null },
      { enabled: true, publicUrl: 'https://x.example', extra: 1 },
    ]) {
      expect((await gameRequest(s, 'PUT', '/api/settings/share-gateway', body)).statusCode).toBe(
        400,
      );
    }
  });
});

describe('share permissions (acceptance)', () => {
  it('a link with only power can start, but the console is 403 and nothing reaches the agent', async () => {
    const s = await setup();
    const g = await readyGame(s);
    expect((await gameRequest(s, 'POST', `/api/games/${g.id}/stop`)).statusCode).toBe(200);
    const link = await createShare(s, g.id, { perms: ['power'] });

    const ups = rpcsOf(s, 'compose.up').length;
    const start = await friend(s, 'POST', 'action', {
      token: link.token,
      payload: { action: 'start' },
    });
    expect(start.statusCode).toBe(200);
    expect(shareStatusResponseSchema.parse(start.json()).perms).toEqual(['power']);
    expect(rpcsOf(s, 'compose.up')).toHaveLength(ups + 1);

    const before = s.rpcs.length;
    const read = await friend(s, 'GET', 'console', { token: link.token });
    expect(read.statusCode).toBe(403);
    expect(read.json()).toEqual({ ok: false, error: 'forbidden' });
    const write = await friend(s, 'POST', 'console', {
      token: link.token,
      payload: { command: 'op Max' },
    });
    expect(write.statusCode).toBe(403);
    const wl = await friend(s, 'POST', 'whitelist', {
      token: link.token,
      payload: { op: 'add', player: 'Max' },
    });
    expect(wl.statusCode).toBe(403);
    const restart = await friend(s, 'POST', 'action', {
      token: link.token,
      payload: { action: 'restart' },
    });
    expect(restart.statusCode).toBe(403);
    expect(s.rpcs.slice(before).filter((r) => r.action !== 'game.status')).toEqual([]);
    expect(rpcsOf(s, 'game.rcon')).toHaveLength(0);

    const denied = s.t.db.db
      .select()
      .from(shareAudit)
      .where(eq(shareAudit.action, 'denied'))
      .all()
      .map((r) => r.detail);
    expect(denied).toEqual(['console_read', 'console_write', 'whitelist_add', 'restart']);
    const actors = s.t.db.db.select().from(auditLog).all();
    expect(actors.find((a) => a.action === 'game.start')?.actor).toBe(`share:${link.id}`);
    expect(actors.filter((a) => a.action === 'share.denied')).toHaveLength(4);
  });

  it('a link with only restart cannot start a stopped server', async () => {
    const s = await setup();
    const g = await readyGame(s);
    expect((await gameRequest(s, 'POST', `/api/games/${g.id}/stop`)).statusCode).toBe(200);
    const link = await createShare(s, g.id, { perms: ['restart'] });
    const ups = rpcsOf(s, 'compose.up').length;
    const restarts = rpcsOf(s, 'container.restart').length;
    const r = await friend(s, 'POST', 'action', {
      token: link.token,
      payload: { action: 'restart' },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ ok: false, error: 'forbidden' });
    expect(rpcsOf(s, 'compose.up')).toHaveLength(ups);
    expect(rpcsOf(s, 'container.restart')).toHaveLength(restarts);
    const start = await friend(s, 'POST', 'action', {
      token: link.token,
      payload: { action: 'start' },
    });
    expect(start.statusCode).toBe(403);
  });

  it('console_read cannot write; a link of one game cannot touch another', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const other = await readyGame(s, { name: 'creative', ports: { game: 25570 } });
    const link = await createShare(s, g.id, { perms: ['console_read'] });
    expect((await friend(s, 'GET', 'console', { token: link.token })).statusCode).toBe(200);
    const w = await friend(s, 'POST', 'console', {
      token: link.token,
      payload: { command: 'stop' },
    });
    expect(w.statusCode).toBe(403);
    expect(rpcsOf(s, 'game.rcon')).toHaveLength(0);
    // The friend API has no game id at all: the link decides.
    const st = await friend(s, 'GET', 'status', { token: link.token });
    expect(st.json<{ game: { name: string } }>().game.name).toBe('survival');
    expect(st.body).not.toContain(other.id);
    expect(st.body).not.toContain('creative');
  });

  it('refuses a player name that would inject RCON commands', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const link = await createShare(s, g.id, { perms: ['whitelist'] });
    for (const player of [
      'Steve; op Max',
      'Steve\nop Max',
      'Steve op',
      '@a',
      'x'.repeat(17),
      'ab',
    ]) {
      const res = await friend(s, 'POST', 'whitelist', {
        token: link.token,
        payload: { op: 'add', player },
      });
      expect(res.statusCode, player).toBe(400);
      expect(res.json()).toEqual({ ok: false, error: 'invalid_input' });
    }
    expect(
      (
        await friend(s, 'POST', 'whitelist', {
          token: link.token,
          payload: { op: 'op', player: 'Steve' },
        })
      ).statusCode,
    ).toBe(400);
    expect(rpcsOf(s, 'game.rcon')).toHaveLength(0);
    const ok = await friend(s, 'POST', 'whitelist', {
      token: link.token,
      payload: { op: 'add', player: 'Steve_01' },
    });
    expect(ok.statusCode).toBe(200);
    expect(rpcsOf(s, 'game.rcon').map((r) => (r.params as { command: string }).command)).toEqual([
      'whitelist add Steve_01',
    ]);
  });

  it('console commands are single line and rate-limited like the admin RCON', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const link = await createShare(s, g.id, { perms: ['console_write'] });
    const bad = await friend(s, 'POST', 'console', {
      token: link.token,
      payload: { command: 'say hi\nstop' },
    });
    expect(bad.statusCode).toBe(400);
    expect(rpcsOf(s, 'game.rcon')).toHaveLength(0);
    // Admin RCON and the friend share the 10-per-10-s window of the game.
    for (let i = 0; i < 10; i++) await s.t.app.hzCore.games.rcon(g.id, `say ${i}`);
    const limited = await friend(s, 'POST', 'console', {
      token: link.token,
      payload: { command: 'list' },
    });
    expect(limited.statusCode).toBe(429);
    expect(shareErrorResponseSchema.parse(limited.json()).error).toBe('rate_limited');
    expect(rpcsOf(s, 'game.rcon')).toHaveLength(10);
  });
});

describe('share link states', () => {
  it('a revoked link gives 410 at once, also for the next status call', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const link = await createShare(s, g.id);
    expect((await friend(s, 'GET', 'status', { token: link.token })).statusCode).toBe(200);
    const rev = await gameRequest(s, 'POST', `/api/shares/${link.id}/revoke`);
    expect(rev.statusCode).toBe(200);
    expect(rev.json<{ share: { state: string } }>().share.state).toBe('revoked');
    const before = s.rpcs.length;
    for (const [method, path, payload] of [
      ['GET', 'status', undefined],
      ['POST', 'action', { action: 'stop' }],
      ['GET', 'console', undefined],
    ] as const) {
      const res = await friend(s, method, path, {
        token: link.token,
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode, path).toBe(410);
      expect(res.json()).toEqual({ ok: false, error: 'revoked' });
    }
    expect(s.rpcs.slice(before).filter((r) => r.action !== 'game.status')).toEqual([]);
  });

  it('an expired link gives 410 expired; unknown and malformed tokens the same 404', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const link = await createShare(s, g.id, { expires: '1d' });
    expect((await friend(s, 'GET', 'status', { token: link.token })).statusCode).toBe(200);
    s.t.clock.advance(24 * 60 * MIN + 1);
    const res = await friend(s, 'GET', 'status', { token: link.token });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toEqual({ ok: false, error: 'expired' });

    const answers = new Set<string>();
    for (const authorization of [
      `Share ${randomShareToken()}`,
      `Share ${link.token.slice(1)}`,
      `Share ${link.token}x`,
      'Share ../../etc',
      `Bearer ${link.token}`,
      '',
    ]) {
      const r = await friend(s, 'GET', 'status', { authorization });
      expect(r.statusCode, authorization).toBe(404);
      answers.add(r.body);
    }
    expect((await friend(s, 'GET', 'status')).statusCode).toBe(404);
    expect([...answers]).toEqual([JSON.stringify({ ok: false, error: 'not_found' })]);
  });

  it('5 wrong PINs lock the link for 15 minutes', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const pin = String(1000 + Math.floor(Math.random() * 8000));
    const wrong = String(((Number(pin) - 999) % 9000) + 1000);
    const link = await createShare(s, g.id, { pin });
    const ip = nextIp();

    const none = await friend(s, 'GET', 'status', { token: link.token, ip });
    expect(none.statusCode).toBe(401);
    expect(none.json()).toEqual({ ok: false, error: 'pin_required', triesLeft: 5 });
    for (let i = 4; i >= 1; i--) {
      const r = await friend(s, 'GET', 'status', { token: link.token, pin: wrong, ip });
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ ok: false, error: 'pin_wrong', triesLeft: i });
    }
    const locked = await friend(s, 'GET', 'status', { token: link.token, pin: wrong, ip });
    expect(locked.statusCode).toBe(423);
    expect(locked.json()).toEqual({ ok: false, error: 'locked', retryAfter: 900 });
    // The right PIN does not help while locked, also from another IP.
    const still = await friend(s, 'GET', 'status', { token: link.token, pin });
    expect(still.statusCode).toBe(423);
    expect(still.headers['retry-after']).toBeDefined();
    const list = await gameRequest(s, 'GET', `/api/games/${g.id}/shares`);
    expect(
      list.json<{ shares: { lockedUntil: string | null }[] }>().shares[0]?.lockedUntil,
    ).not.toBe(null);

    s.t.clock.advance(15 * MIN);
    const ok = await friend(s, 'GET', 'status', { token: link.token, pin });
    expect(ok.statusCode).toBe(200);
    const actions = s.t.db.db
      .select()
      .from(shareAudit)
      .all()
      .map((r) => r.action);
    expect(actions.filter((a) => a === 'pin_failed')).toHaveLength(4);
    expect(actions.filter((a) => a === 'pin_locked')).toHaveLength(1);
    // A malformed PIN counts as wrong and never reaches argon2 with odd input.
    const bad = await friend(s, 'GET', 'status', { token: link.token, pin: '12 4' });
    expect(bad.json()).toMatchObject({ error: 'pin_wrong', triesLeft: 4 });
  });
});

describe('share rate limits', () => {
  it(`allows ${SHARE_IP_LIMIT} requests per minute per IP and API`, async () => {
    const s = await setup();
    const g = await readyGame(s);
    const links = await Promise.all([createShare(s, g.id), createShare(s, g.id)]);
    const ip = nextIp();
    for (let i = 0; i < SHARE_IP_LIMIT; i++) {
      const token = links[i % 2]?.token ?? '';
      expect((await friend(s, 'GET', 'status', { token, ip })).statusCode).toBe(200);
    }
    const limited = await friend(s, 'GET', 'status', { token: links[0]?.token ?? '', ip });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ ok: false, error: 'rate_limited' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Unknown tokens count too (no free guessing).
    const guess = await friend(s, 'GET', 'status', { token: randomShareToken(), ip });
    expect(guess.statusCode).toBe(429);
    // Another IP is not affected; after a minute the IP may again.
    expect((await friend(s, 'GET', 'status', { token: links[0]?.token ?? '' })).statusCode).toBe(
      200,
    );
    s.t.clock.advance(MIN);
    expect(
      (await friend(s, 'GET', 'status', { token: links[0]?.token ?? '', ip })).statusCode,
    ).toBe(200);
  });

  it(`allows ${SHARE_TOKEN_LIMIT} requests per minute per token over all IPs`, async () => {
    const s = await setup();
    const g = await readyGame(s);
    const link = await createShare(s, g.id);
    for (let i = 0; i < SHARE_TOKEN_LIMIT; i++) {
      expect((await friend(s, 'GET', 'status', { token: link.token })).statusCode).toBe(200);
    }
    expect((await friend(s, 'GET', 'status', { token: link.token })).statusCode).toBe(429);
  });

  it(`console polls have their own budget of ${SHARE_CONSOLE_IP_LIMIT} per minute and IP`, async () => {
    const s = await setup();
    const g = await readyGame(s);
    const link = await createShare(s, g.id, { perms: ['console_read'] });
    const ip = nextIp();
    for (let i = 0; i < SHARE_CONSOLE_IP_LIMIT; i++) {
      expect((await friend(s, 'GET', 'console', { token: link.token, ip })).statusCode).toBe(200);
    }
    expect((await friend(s, 'GET', 'console', { token: link.token, ip })).statusCode).toBe(429);
    // The API budget of that IP is untouched.
    expect((await friend(s, 'GET', 'status', { token: link.token, ip })).statusCode).toBe(200);
  });

  it('limits the gateway per friend IP (X-Share-Client-Ip)', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const gw = await enableGateway(s);
    const link = await createShare(s, g.id);
    const clientIp = '203.0.113.7';
    for (let i = 0; i < SHARE_IP_LIMIT; i++) {
      const r = await gateway(s, 'GET', 'status', {
        gatewayToken: gw,
        token: link.token,
        clientIp,
      });
      expect(r.statusCode).toBe(200);
    }
    const r = await gateway(s, 'GET', 'status', { gatewayToken: gw, token: link.token, clientIp });
    expect(r.statusCode).toBe(429);
    const other = await gateway(s, 'GET', 'status', {
      gatewayToken: gw,
      token: link.token,
      clientIp: '2001:db8::1',
    });
    expect(other.statusCode).toBe(200);
  });
});

describe('share gateway API', () => {
  it('is refused without, with a wrong token and while disabled', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const link = await createShare(s, g.id);
    // No gateway token at all yet.
    for (const gatewayToken of [null, randomShareToken()]) {
      const r = await gateway(s, 'GET', 'status', { gatewayToken, token: link.token });
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ ok: false, error: 'unauthorized' });
    }
    const gw = await enableGateway(s);
    for (const gatewayToken of [null, randomShareToken(), `${gw}x`, gw.slice(1)]) {
      const r = await gateway(s, 'GET', 'status', { gatewayToken, token: link.token });
      expect(r.statusCode).toBe(401);
    }
    // An admin session does not open the gateway API.
    const withCookie = await s.t.app.inject({
      method: 'GET',
      url: '/api/share-gateway/status',
      headers: { ...s.headers, 'x-share-token': link.token, 'x-share-client-ip': '203.0.113.1' },
    });
    expect(withCookie.statusCode).toBe(401);
    // The share token in Authorization (tailnet style) is no gateway token.
    const swapped = await s.t.app.inject({
      method: 'GET',
      url: '/api/share-gateway/status',
      headers: { authorization: `Share ${link.token}`, 'x-share-client-ip': '203.0.113.1' },
    });
    expect(swapped.statusCode).toBe(401);

    const ok = await gateway(s, 'GET', 'status', { gatewayToken: gw, token: link.token });
    expect(ok.statusCode).toBe(200);
    // Missing or invalid client IP.
    for (const clientIp of [null, 'not-an-ip', '10.0.0.1, 10.0.0.2', '999.1.1.1']) {
      const r = await gateway(s, 'GET', 'status', {
        gatewayToken: gw,
        token: link.token,
        clientIp,
      });
      expect(r.statusCode, String(clientIp)).toBe(400);
    }
    // Nothing else is reachable with the gateway token.
    for (const path of ['servers', 'games', 'shares', '../games', 'status/x']) {
      const r = await gateway(s, 'GET', path, { gatewayToken: gw, token: link.token });
      expect([401, 404], path).toContain(r.statusCode);
      expect(r.body).not.toContain('survival');
    }

    // Disabled again: refused with the right token.
    await stepUp(s.t, s.secret, s.cookie);
    await gameRequest(s, 'PUT', '/api/settings/share-gateway', { enabled: false, publicUrl: null });
    const off = await gateway(s, 'GET', 'status', { gatewayToken: gw, token: link.token });
    expect(off.statusCode).toBe(503);
    expect(off.json()).toEqual({ ok: false, error: 'unavailable' });

    // A new token replaces the old one at once.
    await gameRequest(s, 'PUT', '/api/settings/share-gateway', {
      enabled: true,
      publicUrl: 'https://spiel.example.org',
    });
    const next = await gameRequest(s, 'POST', '/api/settings/share-gateway/token');
    const gw2 = next.json<{ token: string }>().token;
    expect(
      (await gateway(s, 'GET', 'status', { gatewayToken: gw2, token: link.token })).statusCode,
    ).toBe(200);
    expect(
      (await gateway(s, 'GET', 'status', { gatewayToken: gw, token: link.token })).statusCode,
    ).toBe(401);
  });

  it('slows down guessing of the gateway token', async () => {
    const s = await setup();
    await enableGateway(s);
    for (let i = 0; i < 5; i++) {
      expect(
        (await gateway(s, 'GET', 'status', { gatewayToken: randomShareToken() })).statusCode,
      ).toBe(401);
    }
    expect(
      (await gateway(s, 'GET', 'status', { gatewayToken: randomShareToken() })).statusCode,
    ).toBe(429);
  });

  it('answers only with the allowed fields and no internal data', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const tailscaleIp = '100.101.102.103';
    s.t.db.db.update(servers).set({ tailscaleIp }).where(eq(servers.id, s.serverId)).run();
    const gw = await enableGateway(s);
    const link = await createShare(s, g.id, {
      perms: ['power', 'restart', 'console_write', 'whitelist'],
    });
    expect(link.urls.public).toBe(`https://spiel.example.org/s/${link.token}`);
    await s.t.app.hzCore.games.rcon(g.id, 'list');

    const status = await gateway(s, 'GET', 'status', { gatewayToken: gw, token: link.token });
    expect(status.statusCode).toBe(200);
    const body: unknown = status.json();
    expect(shareStatusResponseSchema.safeParse(body).success).toBe(true);
    expect(new Set(keyPaths(body))).toEqual(
      new Set([
        'person',
        'perms',
        'expiresAt',
        'game',
        'game.name',
        'game.game',
        'game.version',
        'game.status',
        'game.statusText',
        'game.address',
        'game.players',
        'game.players.online',
        'game.players.max',
        'game.players.names',
        'game.whitelist',
      ]),
    );
    // Without an external address there is no address at all (never the Tailscale IP).
    expect(status.json<{ game: { address: unknown } }>().game.address).toBeNull();

    const consoleRes = await gateway(s, 'GET', 'console', { gatewayToken: gw, token: link.token });
    expect(consoleRes.statusCode).toBe(200);
    const lines = shareConsoleResponseSchema.parse(consoleRes.json()).lines;
    expect(lines.length).toBeGreaterThan(0);
    for (const p of keyPaths(consoleRes.json())) {
      expect(['lines', 'lines[].id', 'lines[].text', 'lines[].kind', 'lines[].ts']).toContain(p);
    }
    const action = await gateway(s, 'POST', 'action', {
      gatewayToken: gw,
      token: link.token,
      payload: { action: 'restart' },
    });
    expect(action.statusCode).toBe(200);
    const cmd = await gateway(s, 'POST', 'console', {
      gatewayToken: gw,
      token: link.token,
      payload: { command: 'list' },
    });
    expect(cmd.statusCode).toBe(200);
    expect(keyPaths(cmd.json())).toEqual(['output']);
    const err = await gateway(s, 'GET', 'console', {
      gatewayToken: gw,
      token: randomShareToken(),
    });
    expect(keyPaths(err.json()).sort()).toEqual(['error', 'ok']);

    const row = s.t.db.db.select().from(gameServers).where(eq(gameServers.id, g.id)).get();
    const containerIds = [...s.running.values()].map((c) => c.dockerId);
    const coreContainer = s.t.app.hzCore.games.containerIdOf(g.id);
    for (const res of [status, consoleRes, action, cmd, err]) {
      const text = res.body;
      expect(text).not.toMatch(/\b100\.\d+\.\d+\.\d+/);
      expect(text).not.toContain(tailscaleIp);
      expect(text).not.toContain('heimserver');
      expect(text).not.toContain(s.serverId);
      expect(text).not.toContain(g.id);
      expect(text).not.toContain(link.id);
      expect(text).not.toContain(link.token);
      expect(text).not.toContain('/opt/homelab');
      if (coreContainer) expect(text).not.toContain(coreContainer);
      for (const c of containerIds) expect(text).not.toContain(c);
      expect(text).not.toContain(String(row?.rconPort));
    }

    // With an external address only that address and the game port are shown.
    await gameRequest(s, 'PUT', `/api/games/${g.id}`, { externalAddress: 'mc.example.at' });
    const withAddr = await gateway(s, 'GET', 'status', { gatewayToken: gw, token: link.token });
    expect(withAddr.json<{ game: { address: string } }>().game.address).toBe(
      `mc.example.at:${g.ports[0]?.port}`,
    );
    // The gateway was seen.
    const settings = await gameRequest(s, 'GET', '/api/settings/share-gateway');
    expect(settings.json<{ lastSeenAt: string | null }>().lastSeenAt).not.toBeNull();
  });
});

describe('share answers never contain tailnet addresses', () => {
  it('hides an external address that is a Tailscale IP or ts.net name', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const link = await createShare(s, g.id);
    for (const externalAddress of ['100.64.0.9', 'heimserver.tail1234.ts.net']) {
      await gameRequest(s, 'PUT', `/api/games/${g.id}`, { externalAddress });
      const r = await friend(s, 'GET', 'status', { token: link.token });
      expect(r.json<{ game: { address: unknown } }>().game.address, externalAddress).toBeNull();
      expect(r.body).not.toContain(externalAddress);
    }
  });

  it('masks Tailscale addresses in console text', () => {
    expect(maskTailnet('from 100.101.2.3 and 100.63.0.1')).toBe('from [intern] and 100.63.0.1');
    expect(maskTailnet('to fd7a:115c:a1e0:ab12::1 ok')).toBe('to [intern] ok');
    expect(maskTailnet('host pi.tail-abc.ts.net up')).toBe('host [intern] up');
  });
});

describe('share console', () => {
  it('never shows the RCON password', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const row = s.t.db.db.select().from(gameServers).where(eq(gameServers.id, g.id)).get();
    const box = createSecretBox(Buffer.from(KEY, 'base64'));
    const password = box.decrypt(row?.rconSecretEnc ?? '', `game_servers.rcon:${g.id}`);
    s.behaviour.rconSuffix = ` pw=${password}`;
    const link = await createShare(s, g.id, { perms: ['console_write'] });
    const cmd = await friend(s, 'POST', 'console', {
      token: link.token,
      payload: { command: 'list' },
    });
    expect(cmd.statusCode).toBe(200);
    expect(cmd.body).not.toContain(password);
    const read = await friend(s, 'GET', 'console', { token: link.token });
    expect(read.statusCode).toBe(200);
    expect(read.body).toContain('ran list');
    expect(read.body).not.toContain(password);
  });

  it('refuses cross-origin POSTs on the tailnet API', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const link = await createShare(s, g.id);
    const before = s.rpcs.length;
    const res = await friend(s, 'POST', 'action', {
      token: link.token,
      payload: { action: 'stop' },
      origin: 'https://evil.example',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ ok: false, error: 'forbidden' });
    expect(s.rpcs.slice(before).filter((r) => r.action !== 'game.status')).toEqual([]);
  });
});

describe('share tokens stay secret', () => {
  it('are never in logs, the audit, the database or later responses', async () => {
    const s = await setup({ captureLogs: true });
    const g = await readyGame(s);
    const pin = String(1000 + Math.floor(Math.random() * 8000));
    const link = await createShare(s, g.id, { pin, perms: ['power', 'console_read'] });
    const gw = await enableGateway(s);
    await s.t.app.inject({ method: 'GET', url: `/s/${link.token}`, headers: { host: HOST } });
    await s.t.app.inject({
      method: 'GET',
      url: `/s/${encodeURIComponent(link.token)}?x=1`,
      headers: { host: HOST },
    });
    await friend(s, 'GET', 'status', { token: link.token, pin });
    await friend(s, 'GET', 'status', { token: link.token, pin: '0000' === pin ? '1111' : '0000' });
    await friend(s, 'GET', 'console', { token: link.token, pin });
    await friend(s, 'POST', 'action', { token: link.token, pin, payload: { action: 'stop' } });
    await gateway(s, 'GET', 'status', { gatewayToken: gw, token: link.token, pin });

    const logs = s.t.logs.join('');
    expect(logs).toContain('/s/[redacted]');
    expect(logs).toContain('/s/api/status');
    for (const secret of [link.token, gw, `Share ${link.token}`]) {
      expect(logs).not.toContain(secret);
    }
    expect(logs).not.toMatch(new RegExp(`"x-share-pin":"${pin}"`));
    const audit = JSON.stringify([
      s.t.db.db.select().from(auditLog).all(),
      s.t.db.db.select().from(shareAudit).all(),
    ]);
    expect(audit).not.toContain(link.token);
    expect(audit).not.toContain(gw);
    expect(audit).not.toContain(pin);
    const dump = JSON.stringify(s.t.db.db.select().from(shareLinks).all());
    expect(dump).not.toContain(link.token);
    expect(dump).not.toContain(`"${pin}"`);
    const list = await gameRequest(s, 'GET', `/api/games/${g.id}/shares`);
    expect(list.body).not.toContain(link.token);
    const auditRes = await gameRequest(s, 'GET', `/api/games/${g.id}/share-audit`);
    expect(auditRes.body).not.toContain(link.token);
  });

  it('redacts share paths and token-like runs in URLs', () => {
    const tok = randomShareToken();
    expect(redactShareUrl(`/s/${tok}`)).toBe('/s/[redacted]');
    expect(redactShareUrl(`//s//${tok}?a=1`)).toBe('/s/[redacted]');
    expect(redactShareUrl(`/%73/${tok}`)).toBe('/s/[redacted]');
    expect(redactShareUrl('/s/api/status')).toBe('/s/api/status');
    expect(redactShareUrl('/s/assets/app-1.js')).toBe('/s/assets/app-1.js');
    expect(redactShareUrl(`/api/x?t=${tok}`)).toBe('/api/x?t=[redacted]');
    expect(redactShareUrl('/api/games')).toBe('/api/games');
  });
});
