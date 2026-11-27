import { afterEach, describe, expect, it } from 'vitest';
import { gameRelayResponseSchema } from '@hz/shared';
import { eq } from 'drizzle-orm';
import { RpcError } from '../src/agents/hub.js';
import { dnsRecords, gameRelays, gameServers, servers } from '../src/db/schema.js';
import { moduleOfPath } from '../src/modules/service.js';
import { DNS_TEXT } from '../src/relay/service.js';
import { stepUp, withStepUp, type WsClient } from './agent-helpers.js';
import { CF_TOKEN, World } from './domains-helpers.js';
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

async function setup(
  opts: { relay?: boolean; enable?: boolean; world?: World; captureLogs?: boolean } = {},
): Promise<Setup> {
  const s = await withGames(clients, {
    ...(opts.world ? { modules: { domains: true }, features: { domains: opts.world.deps() } } : {}),
    ...(opts.captureLogs ? { captureLogs: true } : {}),
  });
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

  it('the old DNS settings route is gone: /api/settings/dns answers 404 (also with step-up)', async () => {
    const x = await setup();
    expect(moduleOfPath('/api/settings/dns')).toBeNull();
    await stepUp(x.s.t, x.s.secret, x.s.cookie);
    for (const method of ['GET', 'PUT'] as const) {
      const res = await gameRequest(x.s, method, '/api/settings/dns', {
        provider: 'duckdns',
        token: 'a'.repeat(26),
      });
      expect(res.statusCode, method).toBe(404);
    }
    expect(x.s.t.db.sqlite.prepare("SELECT * FROM settings WHERE key = 'relay.dns'").all()).toEqual(
      [],
    );
  });

  it('games module off: the ingress route answers 404 module_disabled', async () => {
    const x = await setup();
    x.s.t.app.hzCore.modules.set({ games: false });
    const res = await withStepUp(x.s.t, () => putIngress(x.s, x.ing.serverId));
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'module_disabled' });
  });

  it('step-up for ingress and relay changes; without it nothing changes or reaches an agent', async () => {
    const x = await setup({ enable: false });
    const before = x.ing.sets.length;
    for (const [url, payload] of [
      [
        `/api/servers/${x.ing.serverId}/ingress`,
        { enabled: true, publicIp: null, portFrom: 25565, portTo: 25600 },
      ],
      [
        `/api/games/${x.gameId}/relay`,
        { ingressServerId: x.ing.serverId, dnsName: 'mc.example.com' },
      ],
    ] as const) {
      const res = await gameRequest(x.s, 'PUT', url, payload);
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toMatchObject({ error: 'step_up_required' });
    }
    expect(x.ing.sets.length).toBe(before);
    expect(relayRows(x)).toEqual([]);
    expect(x.s.t.db.sqlite.prepare('SELECT * FROM server_ingress').all()).toEqual([]);
    expect(x.s.t.db.db.select().from(dnsRecords).all()).toEqual([]);
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
  });
});

describe('relay DNS through the domains module (M15/M20, security)', () => {
  async function withProvider(captureLogs = false) {
    const world = new World(() => Date.now());
    const x = await setup({ world, captureLogs });
    await stepUp(x.s.t, x.s.secret, x.s.cookie);
    const res = await gameRequest(x.s, 'POST', '/api/domains/providers', {
      kind: 'cloudflare',
      label: 'Cloudflare',
      token: CF_TOKEN,
    });
    expect(res.statusCode, res.body).toBe(201);
    return { x, world, providerId: res.json<{ id: string }>().id };
  }

  it('a relay record cannot be edited, synced away or deleted through the admin domains routes', async () => {
    const { x, world } = await withProvider();
    const res = await putRelay(x.s, x.gameId, {
      ingressServerId: x.ing.serverId,
      dnsName: 'mc.example.com',
    });
    expect(res.statusCode, res.body).toBe(200);
    const rec = x.s.t.db.db.select().from(dnsRecords).get();
    expect(rec).toMatchObject({ owner: 'relay', ownerRef: x.gameId });
    const id = rec?.id ?? '';
    const put = await gameRequest(x.s, 'PUT', `/api/domains/records/${id}`, {
      target: { kind: 'static', value: '198.51.100.99' },
    });
    expect(put.statusCode).toBe(403);
    const del = await gameRequest(x.s, 'DELETE', `/api/domains/records/${id}`);
    expect(del.statusCode).toBe(403);
    // The provider still uses it: it cannot be deleted either.
    const delProvider = await gameRequest(
      x.s,
      'DELETE',
      `/api/domains/providers/${rec?.providerId ?? ''}`,
    );
    expect(delProvider.statusCode).toBe(409);
    expect(x.s.t.db.db.select().from(dnsRecords).all()).toEqual([rec]);
    const cf = [...world.cf.records.values()].find((r) => r.name === 'mc.example.com');
    expect(cf?.content).not.toBe('198.51.100.99');
  });

  it('no DNS token in any relay response, log line or audit entry', async () => {
    const { x } = await withProvider(true);
    const bodies: string[] = [];
    for (const name of ['mc.example.com', 'play.example.com', 'nozone.example.net']) {
      const res = await putRelay(x.s, x.gameId, { ingressServerId: x.ing.serverId, dnsName: name });
      expect(res.statusCode, res.body).toBe(200);
      bodies.push(res.body);
      bodies.push((await gameRequest(x.s, 'GET', `/api/games/${x.gameId}/relay`)).body);
    }
    bodies.push((await gameRequest(x.s, 'GET', '/api/relay/ingresses')).body);
    bodies.push((await gameRequest(x.s, 'GET', `/api/games/${x.gameId}`)).body);
    bodies.push((await putRelay(x.s, x.gameId, { ingressServerId: null })).body);
    await relayIdle(x.s);
    const audit = JSON.stringify(x.s.t.db.sqlite.prepare('SELECT * FROM audit_log').all());
    for (const text of [...bodies, x.s.t.logs.join('\n'), audit]) {
      expect(text).not.toContain(CF_TOKEN);
      expect(text).not.toContain('tokenEnc');
    }
  });

  it('a name under a zone no provider owns: dnsOk false, no provider is contacted', async () => {
    const { x, world } = await withProvider();
    const before = world.calls.length;
    for (const name of ['mc.example.net', 'mc.example.com.evil.org', 'meinheim.duckdns.org']) {
      const res = await putRelay(x.s, x.gameId, { ingressServerId: x.ing.serverId, dnsName: name });
      expect(res.statusCode, res.body).toBe(200);
      expect(gameRelayResponseSchema.parse(res.json()).relay, name).toMatchObject({
        dnsName: name,
        dnsOk: false,
        dnsError: DNS_TEXT.noProvider,
      });
    }
    await relayIdle(x.s);
    expect(world.calls.length).toBe(before);
    expect(x.s.t.db.db.select().from(dnsRecords).all()).toEqual([]);
  });
});
