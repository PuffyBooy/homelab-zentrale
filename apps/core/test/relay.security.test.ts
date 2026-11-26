import { afterEach, describe, expect, it } from 'vitest';
import { gameRelayResponseSchema } from '@hz/shared';
import { eq } from 'drizzle-orm';
import { RpcError } from '../src/agents/hub.js';
import { gameRelays, gameServers, servers } from '../src/db/schema.js';
import { moduleOfPath } from '../src/modules/service.js';
import { DNS_HOSTS, DnsError, setARecord } from '../src/relay/dns.js';
import { stepUp, withStepUp, type WsClient } from './agent-helpers.js';
import { gameRequest, readyGame, withGames, type GameSetup } from './games-helpers.js';
import { SAME_ORIGIN, type TestApp } from './helpers.js';
import { addIngress, putIngress, putRelay, relayIdle, type FakeIngress } from './relay-helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

interface Setup {
  s: GameSetup;
  ing: FakeIngress;
  gameId: string;
}

async function setup(opts: { relay?: boolean; enable?: boolean } = {}): Promise<Setup> {
  const s = await withGames(clients);
  t = s.t;
  const game = await readyGame(s);
  const ing = await addIngress(s, clients, { relay: opts.relay ?? true });
  if (opts.enable !== false) {
    const res = await withStepUp(s.t, () => putIngress(s, ing.serverId));
    expect(res.statusCode, res.body).toBe(200);
  }
  return { s, ing, gameId: game.id };
}

function copyGame(x: Setup, serverId: string, name: string, port: number): string {
  const row = x.s.t.app.hzCore.games.row(x.gameId);
  if (!row) throw new Error('no game');
  const id = `copy${name}xxxxxxxxxx`.slice(0, 16);
  x.s.t.db.db
    .insert(gameServers)
    .values({
      ...row,
      id,
      serverId,
      name,
      phase: 'stopped',
      portsJson: JSON.stringify([{ name: 'game', port, protocol: 'tcp', count: 1 }]),
      rconPort: null,
    })
    .run();
  return id;
}

const relayRows = (x: Setup) => x.s.t.db.db.select().from(gameRelays).all();

const ROUTES = [
  ['GET', '/api/relay/ingresses'],
  ['PUT', '/api/servers/AAAAAAAAAAAAAAAA/ingress'],
  ['GET', '/api/games/AAAAAAAAAAAAAAAA/relay'],
  ['PUT', '/api/games/AAAAAAAAAAAAAAAA/relay'],
  ['GET', '/api/settings/dns'],
  ['PUT', '/api/settings/dns'],
] as const;

describe('relay security (M15)', () => {
  it('every relay route needs a session (401) and belongs to the games module', async () => {
    const x = await setup();
    for (const [method, url] of ROUTES) {
      const res = await x.s.t.app.inject({ method, url, headers: SAME_ORIGIN, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(moduleOfPath(url), url).toBe('games');
    }
    expect(moduleOfPath('/api/servers/:id/ingress')).toBe('games');
    expect(moduleOfPath('/api/servers/:id')).toBeNull();
  });

  it('games module off: the ingress route answers 404 module_disabled', async () => {
    const x = await setup();
    x.s.t.app.hzCore.modules.set({ games: false });
    const res = await withStepUp(x.s.t, () => putIngress(x.s, x.ing.serverId));
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'module_disabled' });
  });

  it('step-up for ingress, relay and DNS changes; without it nothing changes or reaches an agent', async () => {
    const x = await setup({ enable: false });
    const before = x.ing.sets.length;
    for (const [url, payload] of [
      [
        `/api/servers/${x.ing.serverId}/ingress`,
        { enabled: true, publicIp: null, portFrom: 25565, portTo: 25600 },
      ],
      [`/api/games/${x.gameId}/relay`, { ingressServerId: x.ing.serverId }],
      ['/api/settings/dns', { provider: 'duckdns', token: 'a'.repeat(26) }],
    ] as const) {
      const res = await gameRequest(x.s, 'PUT', url, payload);
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toMatchObject({ error: 'step_up_required' });
    }
    expect(x.ing.sets.length).toBe(before);
    expect(relayRows(x)).toEqual([]);
    expect(x.s.t.db.sqlite.prepare('SELECT * FROM server_ingress').all()).toEqual([]);
    expect(x.s.t.db.sqlite.prepare("SELECT * FROM settings WHERE key = 'relay.dns'").all()).toEqual(
      [],
    );
  });

  it('targets only in the tailnet: a host without Tailscale address gets no route', async () => {
    const x = await setup();
    x.s.t.db.db
      .update(servers)
      .set({ tailscaleIp: '192.168.1.20' })
      .where(eq(servers.id, x.s.serverId))
      .run();
    await stepUp(x.s.t, x.s.secret, x.s.cookie);
    const res = await putRelay(x.s, x.gameId, { ingressServerId: x.ing.serverId });
    expect(res.statusCode, res.body).toBe(200);
    await relayIdle(x.s);
    expect(gameRelayResponseSchema.parse(res.json()).relay).toMatchObject({
      state: 'error',
      error: 'Server hat keine Tailscale-Adresse',
    });
    for (const set of x.ing.sets) {
      for (const r of set)
        expect(r.target.host).toMatch(/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./);
    }
    // The hub refuses a non-tailnet target before anything is sent (protocol schema).
    const n = x.ing.rpcs.length;
    await expect(
      x.s.t.app.hzCore.hub.call(x.ing.serverId, 'relay.set', {
        routes: [
          {
            id: 'x:game:tcp',
            protocol: 'tcp',
            listenPort: 25566,
            count: 1,
            target: { host: '8.8.8.8', port: 25566 },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(RpcError);
    expect(x.ing.rpcs.length).toBe(n);
  });

  it('ports outside the ingress range are refused (409), nothing stored', async () => {
    const x = await setup();
    await stepUp(x.s.t, x.s.secret, x.s.cookie);
    await putIngress(x.s, x.ing.serverId, { portFrom: 30000, portTo: 30010 });
    const res = await putRelay(x.s, x.gameId, { ingressServerId: x.ing.serverId });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ message?: string }>().message).toContain('nicht im Bereich');
    expect(relayRows(x)).toEqual([]);
    // Ranges below 1024 cannot even be configured.
    const low = await putIngress(x.s, x.ing.serverId, { portFrom: 80, portTo: 2000 });
    expect(low.statusCode).toBe(400);
  });

  it('no overlaps: same port of another relayed game, or a game on the ingress itself', async () => {
    const x = await setup();
    await stepUp(x.s.t, x.s.secret, x.s.cookie);
    const port = x.s.t.app.hzCore.games.summary(x.gameId)?.ports[0]?.port ?? 0;
    expect((await putRelay(x.s, x.gameId, { ingressServerId: x.ing.serverId })).statusCode).toBe(
      200,
    );
    // Another game with the same port (another host would be fine, the ingress port is not).
    const twin = copyGame(x, x.s.serverId, 'twin', port);
    const dup = await putRelay(x.s, twin, { ingressServerId: x.ing.serverId });
    expect(dup.statusCode).toBe(409);
    expect(dup.json<{ message?: string }>().message).toContain('schon belegt');
    // A game running on the ingress with port 25590 blocks relaying 25590 there.
    copyGame(x, x.ing.serverId, 'local', 25590);
    const third = copyGame(x, x.s.serverId, 'third', 25590);
    const blocked = await putRelay(x.s, third, { ingressServerId: x.ing.serverId });
    expect(blocked.statusCode).toBe(409);
    // A game on the ingress itself needs no relay.
    const onIngress = copyGame(x, x.ing.serverId, 'onedge', 25595);
    const self = await putRelay(x.s, onIngress, { ingressServerId: x.ing.serverId });
    expect(self.statusCode).toBe(400);
    expect(relayRows(x).map((r) => r.gameId)).toEqual([x.gameId]);
    // Every route on the ingress has a distinct listen port.
    const last = x.ing.sets.at(-1) ?? [];
    expect(new Set(last.map((r) => `${r.protocol}:${r.listenPort}`)).size).toBe(last.length);
  });

  it('conflicts are checked against the stored listen ports, not the current host ports', async () => {
    const x = await setup();
    await stepUp(x.s.t, x.s.secret, x.s.cookie);
    const port = x.s.t.app.hzCore.games.summary(x.gameId)?.ports[0]?.port ?? 0;
    expect((await putRelay(x.s, x.gameId, { ingressServerId: x.ing.serverId })).statusCode).toBe(
      200,
    );
    // The host port moves away; the ingress keeps listening on the old one.
    const moved = await gameRequest(x.s, 'PATCH', `/api/games/${x.gameId}/ports`, {
      ports: { game: 27000 },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    const twin = copyGame(x, x.s.serverId, 'twin', port);
    const dup = await putRelay(x.s, twin, { ingressServerId: x.ing.serverId });
    expect(dup.statusCode).toBe(409);
    expect(dup.json<{ message?: string }>().message).toContain('schon belegt');
    // The freed host port number 27000 is not taken on the ingress.
    const other = copyGame(x, x.s.serverId, 'other', 25599);
    expect((await putRelay(x.s, other, { ingressServerId: x.ing.serverId })).statusCode).toBe(200);
  });

  it('relay only with HZ_AGENT_ALLOW_RELAY: not capable -> 409; agent refusal -> state error', async () => {
    const x = await setup({ relay: false });
    await stepUp(x.s.t, x.s.secret, x.s.cookie);
    const res = await putRelay(x.s, x.gameId, { ingressServerId: x.ing.serverId });
    expect(res.statusCode).toBe(409);
    expect(x.ing.sets).toEqual([]);

    const y = await (async () => {
      for (const c of clients.splice(0)) c.ws.terminate();
      await t?.app.close();
      return setup();
    })();
    await stepUp(y.s.t, y.s.secret, y.s.cookie);
    y.ing.behaviour.refuse = { code: 'not_allowed', message: 'relay disabled' };
    const r2 = await putRelay(y.s, y.gameId, { ingressServerId: y.ing.serverId });
    expect(r2.statusCode).toBe(200);
    expect(gameRelayResponseSchema.parse(r2.json()).relay).toMatchObject({
      state: 'error',
      error: 'Relay am Eingang nicht erlaubt (HZ_AGENT_ALLOW_RELAY=1 fehlt)',
    });
  });

  it('invalid input on the relay routes: 400, and unknown game / ingress 404', async () => {
    const x = await setup();
    await stepUp(x.s.t, x.s.secret, x.s.cookie);
    for (const p of [
      {},
      { ingressServerId: 'x' },
      { ingressServerId: x.ing.serverId, dnsName: '*.example.org' },
      { ingressServerId: x.ing.serverId, dnsName: 'nodot' },
      { ingressServerId: x.ing.serverId, extra: 1 },
    ]) {
      expect((await putRelay(x.s, x.gameId, p)).statusCode, JSON.stringify(p)).toBe(400);
    }
    expect(
      (await putRelay(x.s, 'AAAAAAAAAAAAAAAA', { ingressServerId: x.ing.serverId })).statusCode,
    ).toBe(404);
    expect(
      (await putRelay(x.s, x.gameId, { ingressServerId: 'BBBBBBBBBBBBBBBB' })).statusCode,
    ).toBe(404);
    for (const p of [
      { provider: 'aws' },
      { provider: 'duckdns', token: 'short' },
      { provider: 'duckdns', token: 'abc def ghi jkl mno pqr' },
    ]) {
      expect((await gameRequest(x.s, 'PUT', '/api/settings/dns', p)).statusCode).toBe(400);
    }
  });
});

describe('DNS client (M15, security)', () => {
  const TOKEN = 'tok' + 'Q'.repeat(20);

  it('contacts only the fixed provider hosts, never follows redirects, has a timeout', async () => {
    const urls: string[] = [];
    const inits: RequestInit[] = [];
    const fetchImpl = (url: string, init: RequestInit) => {
      urls.push(url);
      inits.push(init);
      return Promise.resolve(new Response('OK'));
    };
    await setARecord(
      fetchImpl,
      { provider: 'duckdns', token: TOKEN, zoneId: null },
      'abc.duckdns.org',
      '203.0.113.5',
    );
    expect(urls.map((u) => new URL(u).host)).toEqual(['www.duckdns.org']);
    expect(inits[0]?.redirect).toBe('error');
    expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
    expect([...DNS_HOSTS].sort()).toEqual(['api.cloudflare.com', 'www.duckdns.org']);

    // Names outside duckdns.org (also look-alikes) are refused before any request.
    for (const name of ['abc.duckdns.org.evil.com', 'a.b.duckdns.org', 'evil.com']) {
      await expect(
        setARecord(
          fetchImpl,
          { provider: 'duckdns', token: TOKEN, zoneId: null },
          name,
          '203.0.113.5',
        ),
      ).rejects.toBeInstanceOf(DnsError);
    }
    // A bad zone id never becomes part of a URL.
    await expect(
      setARecord(
        fetchImpl,
        { provider: 'cloudflare', token: TOKEN, zoneId: '../../x' },
        'mc.example.org',
        '203.0.113.5',
      ),
    ).rejects.toBeInstanceOf(DnsError);
    expect(urls).toHaveLength(1);
  });

  it('errors never contain the token or the URL (even if fetch reports it)', async () => {
    const failing = (url: string) => Promise.reject(new Error(`connect failed ${url}`));
    const err = await setARecord(
      failing,
      { provider: 'duckdns', token: TOKEN, zoneId: null },
      'abc.duckdns.org',
      '203.0.113.5',
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DnsError);
    const e = err as DnsError;
    expect(`${e.message} ${e.text} ${String(e.stack)}`).not.toContain(TOKEN);
    expect(e.text).toBe('DNS-Anbieter nicht erreichbar');

    const rejecting = () =>
      Promise.resolve(
        new Response(JSON.stringify({ success: false, token: TOKEN }), { status: 403 }),
      );
    const e2 = (await setARecord(
      rejecting,
      { provider: 'cloudflare', token: TOKEN, zoneId: 'b'.repeat(32) },
      'mc.example.org',
      '203.0.113.5',
    ).catch((x: unknown) => x)) as DnsError;
    expect(e2.text).toBe('DNS-Anbieter lehnt das Token ab');
    expect(e2.text).not.toContain(TOKEN);

    // Oversized answers are refused: by Content-Length and while streaming.
    const big = () =>
      Promise.resolve(
        new Response('x', { headers: { 'content-length': String(10 * 1024 * 1024) } }),
      );
    const huge = () => Promise.resolve(new Response('K'.repeat(300 * 1024)));
    for (const f of [big, huge]) {
      const e3 = (await setARecord(
        f,
        { provider: 'duckdns', token: TOKEN, zoneId: null },
        'abc.duckdns.org',
        '203.0.113.5',
      ).catch((x: unknown) => x)) as DnsError;
      expect(e3).toBeInstanceOf(DnsError);
      expect(e3.text).toBe('Ungültige Antwort des DNS-Anbieters');
    }

    // Malformed answers (zod) are refused.
    const junk = () => Promise.resolve(new Response('{"success":true,"result":[{"id":"../x"}]}'));
    await expect(
      setARecord(
        junk,
        { provider: 'cloudflare', token: TOKEN, zoneId: 'b'.repeat(32) },
        'mc.example.org',
        '203.0.113.5',
      ),
    ).rejects.toBeInstanceOf(DnsError);
  });
});
