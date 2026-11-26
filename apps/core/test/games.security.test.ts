import { afterEach, describe, expect, it } from 'vitest';
import { gameResponseSchema } from '@hz/shared';
import { PUBLIC_API_ROUTES } from '../src/auth/guard.js';
import { alerts, auditLog, gameServers } from '../src/db/schema.js';
import { stepUp, until, WsClient } from './agent-helpers.js';
import {
  createGame,
  fakeSecret,
  gameRequest,
  readyGame,
  rpcsOf,
  tick,
  withGames,
  type GameSetup,
} from './games-helpers.js';
import { HOST, type TestApp } from './helpers.js';

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

const ROUTES = [
  ['GET', '/api/games/templates'],
  ['GET', '/api/games/suggest'],
  ['GET', '/api/games'],
  ['POST', '/api/games'],
  ['GET', '/api/games/:id'],
  ['PUT', '/api/games/:id'],
  ['DELETE', '/api/games/:id'],
  ['POST', '/api/games/:id/rcon'],
  ['GET', '/api/games/:id/backups'],
  ['POST', '/api/games/:id/:action'],
] as const;
const MUTATING = new Set(['POST', 'PUT', 'DELETE']);

function urlFor(url: string, id: string): string {
  return url.replace(':id', id).replace(':action', 'stop');
}
function payloadFor(method: string, url: string, s: GameSetup): Record<string, unknown> {
  if (url === '/api/games') {
    return { templateId: 'minecraft-java', serverId: s.serverId, name: 'other', values: {} };
  }
  if (method === 'DELETE') return { confirmName: 'survival' };
  if (url.endsWith('/rcon')) return { command: 'list' };
  if (method === 'PUT') return { autoStopMinutes: 5 };
  return {};
}

describe('games routes: auth', () => {
  it('are registered and not public', async () => {
    const s = await setup();
    const routes = s.t.app.hzRoutes.map((r) => `${r.method} ${r.url}`);
    for (const [method, url] of ROUTES) {
      expect(routes).toContain(`${method} ${url}`);
      expect(PUBLIC_API_ROUTES).not.toContain(url);
    }
  });

  it('401 without a session or with a forged cookie; nothing reaches the agent', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const before = s.rpcs.length;
    for (const cookie of [undefined, `hz_session=${'A'.repeat(43)}`]) {
      const headers = { host: HOST, origin: `https://${HOST}`, ...(cookie ? { cookie } : {}) };
      for (const [method, url] of ROUTES) {
        const res = await s.t.app.inject({
          method,
          url: urlFor(url, g.id),
          headers,
          ...(MUTATING.has(method) ? { payload: payloadFor(method, url, s) } : {}),
        });
        expect(res.statusCode, `${method} ${url}`).toBe(401);
        expect(res.json()).toEqual({ ok: false, error: 'unauthorized' });
      }
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(s.rpcs.length).toBe(before);
    expect(s.t.app.hzCore.games.list()).toHaveLength(1);
  });

  it('403 bad_origin for every changing route from a foreign or missing Origin', async () => {
    const s = await setup();
    const g = await readyGame(s);
    await stepUp(s.t, s.secret, s.cookie);
    const before = s.rpcs.length;
    const cookie = `hz_session=${s.cookie}`;
    for (const [method, url] of ROUTES.filter(([m]) => MUTATING.has(m))) {
      for (const headers of [
        { host: HOST, cookie, origin: 'https://evil.example' },
        { host: HOST, cookie, origin: 'null' },
        { host: HOST, cookie },
      ]) {
        const res = await s.t.app.inject({
          method,
          url: urlFor(url, g.id),
          headers,
          payload: payloadFor(method, url, s),
        });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.json().error).toBe('bad_origin');
      }
    }
    expect(s.rpcs.length).toBe(before);
  });
});

describe('games: delete', () => {
  it('needs step-up, then the exact name; backs up first, then game.remove', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const url = `/api/games/${g.id}`;

    const noStep = await gameRequest(s, 'DELETE', url, { confirmName: 'survival' });
    expect(noStep.statusCode).toBe(403);
    expect(noStep.json().error).toBe('step_up_required');

    await stepUp(s.t, s.secret, s.cookie);
    expect((await gameRequest(s, 'DELETE', url, { confirmName: 'Survival' })).statusCode).toBe(400);
    for (const confirmName of ['survival2', 'surviva', 'creative']) {
      const res = await gameRequest(s, 'DELETE', url, { confirmName });
      expect(res.statusCode, confirmName).toBe(400);
      expect(res.json().error).toBe('confirm_mismatch');
    }
    for (const payload of [{}, { confirmName: '../survival' }, { confirmName: 'survival', x: 1 }]) {
      expect((await gameRequest(s, 'DELETE', url, payload)).statusCode).toBe(400);
    }
    expect(rpcsOf(s, 'game.backup')).toHaveLength(0);
    expect(rpcsOf(s, 'game.remove')).toHaveLength(0);
    expect(s.t.app.hzCore.games.row(g.id)).toBeDefined();

    // A failing backup refuses the delete: the world is never lost.
    s.behaviour.backup = { kind: 'fail', code: 2, error: 'failed' };
    const refused = await gameRequest(s, 'DELETE', url, { confirmName: 'survival' });
    expect(refused.statusCode).toBe(502);
    expect(rpcsOf(s, 'game.remove')).toHaveLength(0);
    expect(s.t.app.hzCore.games.row(g.id)).toBeDefined();

    s.behaviour.backup = { kind: 'ok', sizeBytes: 1 };
    const ok = await gameRequest(s, 'DELETE', url, { confirmName: 'survival' });
    expect(ok.statusCode).toBe(200);
    const order = s.rpcs
      .map((r) => r.action)
      .filter((a) => a === 'game.backup' || a === 'game.remove');
    expect(order).toEqual(['game.backup', 'game.backup', 'game.remove']);
    expect(rpcsOf(s, 'game.remove')[0]?.params).toEqual({ gameDir: '/opt/homelab/games/survival' });
    expect(s.t.app.hzCore.games.row(g.id)).toBeUndefined();
    expect((await gameRequest(s, 'GET', url)).statusCode).toBe(404);
    const actions = s.t.db.db
      .select()
      .from(auditLog)
      .all()
      .map((a) => a.action);
    expect(actions).toContain('game.delete_refused');
    expect(actions).toContain('game.deleted');
  });
});

describe('games: rendering injection is refused', () => {
  const BAD_TEXT = [
    'a\nb',
    'a\r\nports: ["1:1"]',
    '${RCON_PASSWORD}',
    '$HOME',
    'x"y',
    "x'y",
    'x\\y',
    'x`id`',
    'a b',
    'a‮b',
    'a\u0000b',
    'a\tb',
  ];

  it.each(BAD_TEXT)('text value %j', async (v) => {
    const s = await setup();
    const res = await createGame(s, { values: { MOTD: v } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ ok: false, error: 'invalid_input' });
    expect(res.body).not.toContain(v);
    expect(s.rpcs.filter((r) => String(r.action).startsWith('compose'))).toHaveLength(0);
    expect(s.t.app.hzCore.games.list()).toEqual([]);
  });

  it('huge values, wrong types, select and range violations, pattern', async () => {
    const s = await setup();
    for (const values of [
      { MOTD: 'x'.repeat(201) },
      { MOTD: 'x'.repeat(100_000) },
      { MAX_PLAYERS: '10' },
      { MAX_PLAYERS: 0 },
      { MAX_PLAYERS: 101 },
      { MAX_PLAYERS: 1e308 },
      { TYPE: 'SPIGOT' },
      { TYPE: 'PAPER\n' },
      { ENABLE_WHITELIST: 'true' },
      { VERSION: 'latest; rm -rf /' },
      { VERSION: '' },
      { LEVEL: 'my world' },
      { LEVEL: '-x' },
      { LEVEL: 'a:b' },
    ]) {
      const res = await createGame(s, { values });
      expect(res.statusCode, JSON.stringify(values).slice(0, 60)).toBe(400);
    }
    expect(s.t.app.hzCore.games.list()).toEqual([]);
  });

  it('YAML tricks in free text end up as one quoted string', async () => {
    const s = await setup();
    const motd = 'a: b # c &anchor *alias !!binary {x: 1} [y] | > %TAG @ ,';
    const res = await createGame(s, { values: { MOTD: motd, SEED: '-1234' } });
    expect(res.statusCode).toBe(202);
    await s.t.app.hzCore.games.idle();
    const compose = (rpcsOf(s, 'compose.write')[0]?.params as { files: Record<string, string> })
      .files['compose.yml'];
    const lines = (compose ?? '').split('\n');
    expect(lines).toContain(`      MOTD: "${motd}"`);
    expect(lines).toContain('      SEED: "-1234"');
    // Every line has the same structure as the template (no line was added).
    expect(lines.filter((l) => /^\s*MOTD:/.test(l))).toHaveLength(1);
  });

  it('unknown fields and unknown request keys are refused', async () => {
    const s = await setup();
    for (const payload of [
      { values: { NOPE: 'x' } },
      { values: { RCON_PASSWORD: 'mine' } },
      { values: { GAME_NAME: 'x' } },
      { values: { PORT_GAME: 1 } },
      { values: { lower: 'x' } },
      { ports: { rcon: 30000 } },
      { ports: { other: 30000 } },
      { ports: { game: 80 } },
      { rconPassword: 'mine' },
      { externalAddress: 'http://evil.example' },
      { externalAddress: 'a b' },
      { externalAddress: 'mc.example.at:25565' },
      { templateId: 'unknown' },
      { templateId: '../minecraft-java' },
      { serverId: 'nope-nope-nope' },
    ]) {
      const res = await createGame(s, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(s.rpcs.filter((r) => String(r.action).startsWith('compose'))).toHaveLength(0);
  });

  it('names and ids cannot traverse paths', async () => {
    const s = await setup();
    for (const name of [
      '../etc',
      '..',
      'a/b',
      'games/../../x',
      '.hidden',
      'UPPER',
      'a',
      'x'.repeat(33),
      '-x',
      'x-',
      'a b',
      'a\u0000b',
      '%2e%2e',
    ]) {
      const res = await createGame(s, { name });
      expect(res.statusCode, name).toBe(400);
    }
    for (const url of [
      '/api/games/..%2F..%2Fetc',
      '/api/games/a.b.c.d.e.f.g',
      '/api/games/short',
      '/api/games/AAAAAAAAAAAA/backups',
    ]) {
      const res = await gameRequest(s, 'GET', url);
      expect([400, 404], url).toContain(res.statusCode);
    }
    const bad = await gameRequest(s, 'POST', '/api/games/AAAAAAAAAAAA/delete');
    expect(bad.statusCode).toBe(400);
    expect(s.rpcs.filter((r) => String(r.action).startsWith('compose'))).toHaveLength(0);
  });
});

describe('games: secrets', () => {
  it('the RCON password is never in a response, log, audit entry, live message or compose.yml', async () => {
    const s = await setup({ captureLogs: true });
    const browser = await WsClient.connect(`${s.url}/live`, {
      cookie: `hz_session=${s.cookie}`,
      origin: s.url.replace('ws://', 'http://'),
    });
    clients.push(browser);
    browser.send({ type: 'subscribe', topics: ['games', 'alerts'] });
    const bodies: string[] = [];
    const res = await createGame(s);
    bodies.push(res.body);
    const { game } = gameResponseSchema.parse(res.json());
    browser.send({ type: 'subscribe', topics: [`game:${game.id}`] });
    await s.t.app.hzCore.games.idle();
    await tick(s, 5_000);
    const env = (rpcsOf(s, 'compose.write')[0]?.params as { files: Record<string, string> }).files;
    const pw = /^RCON_PASSWORD=(.+)$/m.exec(env['.env'] ?? '')?.[1] ?? '';
    expect(pw.length).toBeGreaterThanOrEqual(24);

    // The agent (or a game) echoes the password: the core scrubs it.
    s.behaviour.rconSuffix = ` password=${pw}`;
    for (const [method, url, payload] of [
      ['GET', '/api/games', undefined],
      ['GET', `/api/games/${game.id}`, undefined],
      ['GET', '/api/games/templates', undefined],
      ['GET', `/api/games/suggest?templateId=minecraft-java&serverId=${s.serverId}`, undefined],
      ['POST', `/api/games/${game.id}/rcon`, { command: 'list' }],
      ['PUT', `/api/games/${game.id}`, { values: { MAX_PLAYERS: 5 } }],
      ['POST', `/api/games/${game.id}/backup`, undefined],
      ['GET', `/api/games/${game.id}/backups`, undefined],
      ['GET', '/api/alerts', undefined],
    ] as const) {
      const r = await gameRequest(s, method, url, payload);
      expect(r.statusCode, url).toBeLessThan(300);
      bodies.push(r.body);
    }
    await s.t.app.hzCore.games.idle();
    s.t.app.hzCore.live.flushAll();
    await new Promise((r) => setTimeout(r, 50));
    expect(bodies.join('\n')).toContain('ran list password=***');
    for (const b of bodies) expect(b).not.toContain(pw);
    expect(JSON.stringify(browser.received)).not.toContain(pw);
    expect(browser.received.length).toBeGreaterThan(3);
    expect(s.t.logs.join('').length).toBeGreaterThan(0);
    expect(s.t.logs.join('')).not.toContain(pw);
    expect(JSON.stringify(s.t.db.db.select().from(auditLog).all())).not.toContain(pw);
    expect(JSON.stringify(s.t.db.db.select().from(alerts).all())).not.toContain(pw);
    expect(JSON.stringify(s.t.db.db.select().from(gameServers).all())).not.toContain(pw);
    for (const w of rpcsOf(s, 'compose.write')) {
      const files = (w.params as { files: Record<string, string> }).files;
      expect(files['compose.yml']).not.toContain(pw);
      expect(files['.env']).toContain(`RCON_PASSWORD=${pw}`);
    }
    // RCON goes to the agent without the password (it reads .env itself).
    expect(JSON.stringify(rpcsOf(s, 'game.rcon'))).not.toContain(pw);
    expect(JSON.stringify(rpcsOf(s, 'game.status'))).not.toContain(pw);
  });

  it('secret template fields stay out of compose.yml, the API and settings_json', async () => {
    const s = await setup();
    const pass = fakeSecret();
    const res = await createGame(s, {
      templateId: 'valheim',
      name: 'valheim',
      values: { SERVER_PASS: pass },
    });
    expect(res.statusCode).toBe(202);
    expect(res.body).not.toContain(pass);
    await s.t.app.hzCore.games.idle();
    const files = (rpcsOf(s, 'compose.write')[0]?.params as { files: Record<string, string> })
      .files;
    expect(files['compose.yml']).toContain('SERVER_PASS: ${SERVER_PASS}');
    expect(files['compose.yml']).not.toContain(pass);
    expect(files['.env']).toContain(`SERVER_PASS=${pass}`);
    const list = await gameRequest(s, 'GET', '/api/games');
    expect(list.body).not.toContain(pass);
    expect(list.json().games[0].values).toEqual({ SERVER_NAME: 'Homelab' });
    expect(JSON.stringify(s.t.db.db.select().from(gameServers).all())).not.toContain(pass);
    // A secret with a pattern violation or required but empty is refused.
    for (const v of ['kurz', '']) {
      const bad = await createGame(s, {
        templateId: 'valheim',
        name: 'valheim2',
        values: { SERVER_PASS: v },
      });
      expect(bad.statusCode).toBe(400);
    }
  });
});

describe('games: rcon', () => {
  it('rate limit: 10 commands per 10 s and game, then 429 with Retry-After', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const url = `/api/games/${g.id}/rcon`;
    for (let i = 0; i < 10; i += 1) {
      expect((await gameRequest(s, 'POST', url, { command: `say ${i}` })).statusCode).toBe(200);
    }
    const limited = await gameRequest(s, 'POST', url, { command: 'say 10' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe('rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(rpcsOf(s, 'game.rcon')).toHaveLength(10);
    s.t.clock.advance(10_000);
    expect((await gameRequest(s, 'POST', url, { command: 'say 11' })).statusCode).toBe(200);
    // Audit: the command, never the output; limited attempts are not audited.
    const entries = s.t.db.db
      .select()
      .from(auditLog)
      .all()
      .filter((a) => a.action === 'game.rcon');
    expect(entries).toHaveLength(11);
    expect(JSON.parse(entries[0]?.detailsJson ?? '{}')).toEqual({
      name: 'survival',
      command: 'say 0',
    });
    expect(entries.map((e) => e.detailsJson).join('')).not.toContain('ran ');
  });

  it('refuses multi-line commands and games without RCON', async () => {
    const s = await setup();
    const g = await readyGame(s);
    for (const command of [
      'list\nop evil',
      'a\rb',
      'a\u0000b',
      '',
      ' '.repeat(3),
      'x'.repeat(1001),
    ]) {
      const res = await gameRequest(s, 'POST', `/api/games/${g.id}/rcon`, { command });
      expect(res.statusCode, JSON.stringify(command)).toBe(400);
    }
    const v = await createGame(s, {
      templateId: 'valheim',
      name: 'valheim',
      values: { SERVER_PASS: fakeSecret() },
    });
    const vid = gameResponseSchema.parse(v.json()).game.id;
    await s.t.app.hzCore.games.idle();
    const res = await gameRequest(s, 'POST', `/api/games/${vid}/rcon`, { command: 'list' });
    expect(res.statusCode).toBe(409);
    expect(rpcsOf(s, 'game.rcon')).toHaveLength(0);
  });
});

describe('games: server deletion', () => {
  it('removes its games from the live list', async () => {
    const s = await setup();
    const g = await readyGame(s);
    await stepUp(s.t, s.secret, s.cookie);
    const del = await s.t.app.inject({
      method: 'DELETE',
      url: `/api/servers/${s.serverId}`,
      headers: s.headers,
      payload: { confirmName: 'heimserver' },
    });
    expect(del.statusCode).toBe(200);
    await until(() => s.t.app.hzCore.games.row(g.id) === undefined);
    expect(s.t.app.hzCore.games.list()).toEqual([]);
  });
});
