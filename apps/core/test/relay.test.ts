import { afterEach, describe, expect, it } from 'vitest';
import {
  dnsSettingsSchema,
  gameRelayResponseSchema,
  gameResponseSchema,
  ingressListResponseSchema,
  ingressResponseSchema,
  migrationSuggestResponseSchema,
  shareStatusResponseSchema,
  TRANSFER_CHUNK_BYTES,
} from '@hz/shared';
import { eq } from 'drizzle-orm';
import type { FetchLike } from '../src/checks/rdap.js';
import { auditLog, gameRelays, gameServers, servers } from '../src/db/schema.js';
import { stepUp, type WsClient } from './agent-helpers.js';
import { gameRequest, type GameSetup } from './games-helpers.js';
import { makeApp, authHeaders, completeSetup, type TestApp } from './helpers.js';
import {
  archive,
  installExport,
  settled,
  startMigration,
  withTwoServers,
  type MigrateSetup,
} from './migrate-helpers.js';
import {
  addIngress,
  fakeDns,
  INGRESS_PUBLIC_IP,
  putIngress,
  putRelay,
  reconnectIngress,
  relayIdle,
  type FakeIngress,
} from './relay-helpers.js';
import { createShare, friend } from './share-helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

const SOURCE_TS = '100.64.0.5';
const TARGET_TS = '100.64.0.6';

interface RelaySetup {
  m: MigrateSetup;
  s: GameSetup;
  ing: FakeIngress;
  gameId: string;
}

async function setup(
  opts: { dnsFetch?: FetchLike; captureLogs?: boolean; targetListening?: number[] } = {},
): Promise<RelaySetup> {
  const m = await withTwoServers(
    clients,
    {},
    {
      targetListening: opts.targetListening ?? [],
      targetTailscaleIp: TARGET_TS,
      ...(opts.dnsFetch ? { dnsFetch: opts.dnsFetch } : {}),
      ...(opts.captureLogs ? { captureLogs: true } : {}),
    },
  );
  t = m.s.t;
  const ing = await addIngress(m.s, clients);
  await stepUp(m.s.t, m.s.secret, m.s.cookie);
  return { m, s: m.s, ing, gameId: m.gameId };
}

async function enableAndAssign(r: RelaySetup, dnsName?: string) {
  const ingRes = await putIngress(r.s, r.ing.serverId);
  expect(ingRes.statusCode, ingRes.body).toBe(200);
  const res = await putRelay(r.s, r.gameId, {
    ingressServerId: r.ing.serverId,
    ...(dnsName ? { dnsName } : {}),
  });
  expect(res.statusCode, res.body).toBe(200);
  await relayIdle(r.s);
  return gameRelayResponseSchema.parse(res.json()).relay;
}

const audits = (tt: TestApp, action: string) =>
  tt.db.db
    .select()
    .from(auditLog)
    .all()
    .filter((a) => a.action === action);

/** A copy of the ready game as another game row (stopped) on `serverId`. */
function copyGame(r: RelaySetup, serverId: string, name: string, port: number): string {
  const row = r.s.t.app.hzCore.games.row(r.gameId);
  if (!row) throw new Error('no game');
  const id = `copy${name}xxxxxxxx`.slice(0, 16);
  r.s.t.db.db
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

describe('ingress (M15)', () => {
  it('lists every server; enabling stores range and takes the public IP from the inventory', async () => {
    const r = await setup();
    const list = await gameRequest(r.s, 'GET', '/api/relay/ingresses');
    expect(list.statusCode).toBe(200);
    expect(list.headers['content-type']).toContain('application/json');
    const ingresses = ingressListResponseSchema.parse(list.json()).ingresses;
    expect(ingresses.map((i) => i.serverName)).toEqual(['cloud', 'edge', 'heimserver']);
    const edge = ingresses.find((i) => i.serverId === r.ing.serverId);
    expect(edge).toMatchObject({ enabled: false, capable: true, connected: true, games: [] });
    expect(ingresses.find((i) => i.serverName === 'cloud')?.capable).toBe(false);

    const res = await putIngress(r.s, r.ing.serverId, { portFrom: 25565, portTo: 25570 });
    expect(res.statusCode).toBe(200);
    expect(ingressResponseSchema.parse(res.json()).ingress).toMatchObject({
      enabled: true,
      publicIp: INGRESS_PUBLIC_IP,
      portFrom: 25565,
      portTo: 25570,
      firewallHint: 'Firewall des Anbieters: 25565–25570 TCP und UDP öffnen',
    });
    // An explicit public IPv4 wins over the inventory.
    const own = await putIngress(r.s, r.ing.serverId, { publicIp: '203.0.113.20' });
    expect(ingressResponseSchema.parse(own.json()).ingress.publicIp).toBe('203.0.113.20');
    expect(audits(r.s.t, 'server.ingress_updated')).toHaveLength(2);
  });

  it('invalid input: private IP, tiny or reversed ranges, more than 5000 ports, unknown server', async () => {
    const r = await setup();
    for (const p of [
      { publicIp: '192.168.1.5' },
      { publicIp: '100.64.0.9' },
      { portFrom: 80, portTo: 25600 },
      { portFrom: 26000, portTo: 25000 },
      { portFrom: 20000, portTo: 26000 },
      { extra: true },
    ]) {
      const res = await putIngress(r.s, r.ing.serverId, p);
      expect(res.statusCode, JSON.stringify(p)).toBe(400);
    }
    const missing = await putIngress(r.s, 'AAAAAAAAAAAAAAAA');
    expect(missing.statusCode).toBe(404);
  });

  it('disabling an ingress that still relays a game: 409; range must keep its games', async () => {
    const r = await setup();
    await enableAndAssign(r);
    const off = await putIngress(r.s, r.ing.serverId, { enabled: false });
    expect(off.statusCode).toBe(409);
    expect(off.json()).toMatchObject({ error: 'conflict' });
    const shrink = await putIngress(r.s, r.ing.serverId, { portFrom: 26000, portTo: 26100 });
    expect(shrink.statusCode).toBe(409);
    expect(audits(r.s.t, 'server.ingress_refused')).toHaveLength(2);
    await putRelay(r.s, r.gameId, { ingressServerId: null });
    expect((await putIngress(r.s, r.ing.serverId, { enabled: false })).statusCode).toBe(200);
  });
});

describe('game relay (M15)', () => {
  it('assigning sends relay.set to the ingress with the host Tailscale IP; address uses the ingress', async () => {
    const r = await setup();
    const relay = await enableAndAssign(r);
    expect(relay).toMatchObject({
      ingressServerId: r.ing.serverId,
      ingressName: 'edge',
      address: `${INGRESS_PUBLIC_IP}:25566`,
      state: 'ok',
      error: null,
      dnsOk: null,
    });
    expect(r.ing.sets.at(-1)).toEqual([
      {
        id: `${r.gameId}:game:tcp`,
        protocol: 'tcp',
        listenPort: 25566,
        count: 1,
        target: { host: SOURCE_TS, port: 25566 },
      },
    ]);
    // Nothing went to the other agents.
    expect(r.s.rpcs.some((x) => x.action === 'relay.set')).toBe(false);
    expect(r.m.target.rpcs.some((x) => x.action === 'relay.set')).toBe(false);

    const game = gameResponseSchema.parse(
      (await gameRequest(r.s, 'GET', `/api/games/${r.gameId}`)).json(),
    ).game;
    expect(game.address).toBe(`${INGRESS_PUBLIC_IP}:25566`);
    expect(game.relay?.state).toBe('ok');
    const get = await gameRequest(r.s, 'GET', `/api/games/${r.gameId}/relay`);
    expect(gameRelayResponseSchema.parse(get.json()).relay?.address).toBe(
      `${INGRESS_PUBLIC_IP}:25566`,
    );
    const ingress = ingressListResponseSchema
      .parse((await gameRequest(r.s, 'GET', '/api/relay/ingresses')).json())
      .ingresses.find((i) => i.serverId === r.ing.serverId);
    expect(ingress?.games).toEqual([{ id: r.gameId, name: 'survival' }]);
    expect(audits(r.s.t, 'game.relay_set')).toHaveLength(1);
  });

  it('share page shows the relay address (never the Tailscale IP)', async () => {
    const r = await setup();
    await enableAndAssign(r);
    const link = await createShare(r.s, r.gameId, { perms: ['power'] });
    const res = await friend(r.s, 'GET', 'status', { token: link.token });
    expect(res.statusCode).toBe(200);
    const status = shareStatusResponseSchema.parse(res.json());
    expect(status.game.address).toBe(`${INGRESS_PUBLIC_IP}:25566`);
    expect(res.body).not.toContain(SOURCE_TS);
  });

  it('removing the relay sends an empty list; deleting a relayed game too', async () => {
    const r = await setup();
    await enableAndAssign(r);
    const off = await putRelay(r.s, r.gameId, { ingressServerId: null });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ relay: null });
    expect(r.ing.sets.at(-1)).toEqual([]);
    expect(audits(r.s.t, 'game.relay_removed')).toHaveLength(1);

    await putRelay(r.s, r.gameId, { ingressServerId: r.ing.serverId });
    await relayIdle(r.s);
    expect(r.ing.sets.at(-1)).toHaveLength(1);
    const del = await gameRequest(r.s, 'DELETE', `/api/games/${r.gameId}`, {
      confirmName: 'survival',
    });
    expect(del.statusCode, del.body).toBe(200);
    await relayIdle(r.s);
    expect(r.ing.sets.at(-1)).toEqual([]);
  });

  it('a host port change only moves the target; friends keep address and port', async () => {
    const r = await setup();
    const before = await enableAndAssign(r);
    const res = await gameRequest(r.s, 'PATCH', `/api/games/${r.gameId}/ports`, {
      ports: { game: 25570 },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ forwardingHint: string }>().forwardingHint).toBe(
      `Adresse bleibt ${INGRESS_PUBLIC_IP}:25566 (Eingang edge). Kein Router-Portforwarding nötig, Ports am Eingang edge in der Firewall des Anbieters: game 25566 (TCP)`,
    );
    await relayIdle(r.s);
    expect(r.ing.sets.at(-1)?.[0]).toMatchObject({
      listenPort: 25566,
      target: { host: SOURCE_TS, port: 25570 },
    });
    // Host ports outside the ingress range are fine: the ingress keeps listening on 25566.
    const far = await gameRequest(r.s, 'PATCH', `/api/games/${r.gameId}/ports`, {
      ports: { game: 27000 },
    });
    expect(far.statusCode, far.body).toBe(200);
    await relayIdle(r.s);
    expect(r.ing.sets.at(-1)?.[0]).toMatchObject({
      listenPort: 25566,
      target: { host: SOURCE_TS, port: 27000 },
    });
    expect(r.s.t.app.hzCore.games.summary(r.gameId)?.address).toBe(before?.address);
    // Assigning the same ingress again keeps the stored listen port.
    const again = await putRelay(r.s, r.gameId, { ingressServerId: r.ing.serverId });
    expect(gameRelayResponseSchema.parse(again.json()).relay?.address).toBe(before?.address);
  });

  it('a move (M11) re-targets the relay to the new host; the address stays', async () => {
    const r = await setup();
    const before = await enableAndAssign(r);
    const sug = await gameRequest(
      r.s,
      'GET',
      `/api/games/${r.gameId}/migration/suggest?targetServerId=${r.m.target.serverId}`,
    );
    expect(migrationSuggestResponseSchema.parse(sug.json()).forwardingHint).toBe(
      `Adresse bleibt ${INGRESS_PUBLIC_IP}:25566 (Eingang edge). Kein Router-Portforwarding nötig, Ports am Eingang edge in der Firewall des Anbieters: game 25566 (TCP)`,
    );
    installExport(r.s, { data: archive(2 * TRANSFER_CHUNK_BYTES + 10) });
    const res = await startMigration(r.s, r.gameId, { targetServerId: r.m.target.serverId });
    expect(res.statusCode, res.body).toBe(202);
    const mig = await settled(r.s, r.gameId);
    expect(mig.phase).toBe('done');
    await relayIdle(r.s);
    expect(r.ing.sets.at(-1)).toEqual([
      {
        id: `${r.gameId}:game:tcp`,
        protocol: 'tcp',
        listenPort: 25566,
        count: 1,
        target: { host: TARGET_TS, port: 25566 },
      },
    ]);
    const after = r.s.t.app.hzCore.games.summary(r.gameId);
    expect(after?.serverId).toBe(r.m.target.serverId);
    expect(after?.address).toBe(before?.address);
    expect(after?.relay?.state).toBe('ok');
  });

  it('a move with another port on the target: same address, listenPort unchanged, target port new', async () => {
    // 25566 is taken on the target: the game gets 25567 there.
    const r = await setup({ targetListening: [25566] });
    const before = await enableAndAssign(r);
    const sug = migrationSuggestResponseSchema.parse(
      (
        await gameRequest(
          r.s,
          'GET',
          `/api/games/${r.gameId}/migration/suggest?targetServerId=${r.m.target.serverId}`,
        )
      ).json(),
    );
    expect(sug.ports).toEqual({ game: 25567 });
    expect(sug.forwardingHint).toBe(
      `Adresse bleibt ${INGRESS_PUBLIC_IP}:25566 (Eingang edge). Kein Router-Portforwarding nötig, Ports am Eingang edge in der Firewall des Anbieters: game 25566 (TCP)`,
    );
    installExport(r.s, { data: archive(TRANSFER_CHUNK_BYTES + 10) });
    const res = await startMigration(r.s, r.gameId, { targetServerId: r.m.target.serverId });
    expect(res.statusCode, res.body).toBe(202);
    expect((await settled(r.s, r.gameId)).phase).toBe('done');
    await relayIdle(r.s);
    expect(r.ing.sets.at(-1)).toEqual([
      {
        id: `${r.gameId}:game:tcp`,
        protocol: 'tcp',
        listenPort: 25566,
        count: 1,
        target: { host: TARGET_TS, port: 25567 },
      },
    ]);
    const after = r.s.t.app.hzCore.games.summary(r.gameId);
    expect(after?.ports[0]?.port).toBe(25567);
    expect(after?.address).toBe(before?.address);
    expect(after?.address).toBe(`${INGRESS_PUBLIC_IP}:25566`);
  });

  it('a failed move keeps the relay on the old host', async () => {
    const r = await setup();
    await enableAndAssign(r);
    const sent = r.ing.sets.length;
    installExport(r.s, { data: archive(1000), failWith: 'failed' });
    await startMigration(r.s, r.gameId, { targetServerId: r.m.target.serverId });
    const mig = await settled(r.s, r.gameId);
    expect(mig.phase).toBe('failed');
    await relayIdle(r.s);
    const last = r.ing.sets.at(-1);
    expect(last?.[0]?.target.host).toBe(SOURCE_TS);
    // Nothing changed for the relay: no resend with another target.
    expect(r.ing.sets.slice(sent).every((x) => x[0]?.target.host === SOURCE_TS)).toBe(true);
  });

  it('moving onto its own ingress is refused (remove the relay first)', async () => {
    const r = await setup();
    await enableAndAssign(r);
    const res = await startMigration(r.s, r.gameId, { targetServerId: r.ing.serverId });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ message?: string }>().message).toContain('Relay entfernen');
  });

  it('the ingress agent reconnecting gets the routes again (hello)', async () => {
    const r = await setup();
    await enableAndAssign(r);
    const n = r.ing.sets.length;
    const again = await reconnectIngress(r.s, clients, r.ing);
    await relayIdle(r.s);
    expect(again.sets.length).toBe(n + 1);
    expect(again.sets.at(-1)?.[0]?.target.host).toBe(SOURCE_TS);
  });

  it('ingress offline: pending; a new Tailscale IP of the host re-targets the relay', async () => {
    const r = await setup();
    await enableAndAssign(r);
    // New tailnet address of the host (inventory).
    r.s.t.db.db
      .update(servers)
      .set({ tailscaleIp: '100.64.0.77' })
      .where(eq(servers.id, r.s.serverId))
      .run();
    r.s.t.app.hzCore.relay.queueAll();
    await relayIdle(r.s);
    expect(r.ing.sets.at(-1)?.[0]?.target.host).toBe('100.64.0.77');

    r.ing.ws.ws.terminate();
    await relayIdle(r.s);
    await new Promise((res) => setTimeout(res, 50));
    r.s.t.app.hzCore.relay.queueAll();
    await relayIdle(r.s);
    expect(r.s.t.app.hzCore.games.summary(r.gameId)?.relay?.state).toBe('pending');
  });

  it('a route the ingress could not open: state error with the agent reason', async () => {
    const r = await setup();
    r.ing.behaviour.failRoutes.set(`${r.gameId}:game:tcp`, 'Port 25565 ist belegt');
    const relay = await enableAndAssign(r);
    expect(relay).toMatchObject({ state: 'error', error: 'Port 25565 ist belegt' });
  });

  it('udp ranges: one route per protocol, counts above 10 split', async () => {
    const r = await setup();
    await putIngress(r.s, r.ing.serverId, { portFrom: 2000, portTo: 2100 });
    const row = r.s.t.app.hzCore.games.row(r.gameId);
    r.s.t.db.db
      .update(gameServers)
      .set({
        portsJson: JSON.stringify([
          { name: 'game', port: 2010, protocol: 'tcp+udp', count: 12 },
          { name: 'rcon', port: 2050, protocol: 'tcp', count: 1, local: true },
        ]),
      })
      .where(eq(gameServers.id, row?.id ?? ''))
      .run();
    const res = await putRelay(r.s, r.gameId, { ingressServerId: r.ing.serverId });
    expect(res.statusCode, res.body).toBe(200);
    // Sorted by listen port, then protocol.
    expect(r.ing.sets.at(-1)?.map((x) => [x.protocol, x.listenPort, x.count])).toEqual([
      ['tcp', 2010, 10],
      ['udp', 2010, 10],
      ['tcp', 2020, 2],
      ['udp', 2020, 2],
    ]);
  });

  it('a second game on the same ingress with other ports gets its own routes', async () => {
    const r = await setup();
    await enableAndAssign(r);
    const other = copyGame(r, r.s.serverId, 'creative', 25580);
    const res = await putRelay(r.s, other, { ingressServerId: r.ing.serverId });
    expect(res.statusCode, res.body).toBe(200);
    expect(r.ing.sets.at(-1)?.map((x) => x.listenPort)).toEqual([25566, 25580]);
  });
});

describe('DNS (M15)', () => {
  it('Cloudflare: A record is created, then moved with the ingress; the token never shows', async () => {
    const dns = fakeDns();
    const r = await setup({ dnsFetch: dns.fetch, captureLogs: true });
    const token = 'cf_' + 'x'.repeat(10) + Math.random().toString(36).slice(2, 12);
    const zoneId = 'a'.repeat(32);
    const put = await gameRequest(r.s, 'PUT', '/api/settings/dns', {
      provider: 'cloudflare',
      token,
      zoneId,
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(dnsSettingsSchema.parse(put.json())).toMatchObject({
      provider: 'cloudflare',
      tokenSet: true,
      zoneId,
    });
    const relay = await enableAndAssign(r, 'MC.Example.org');
    expect(relay).toMatchObject({ dnsName: 'mc.example.org', dnsOk: true });
    expect(relay?.address).toBe('mc.example.org:25566');
    expect(dns.records.get('mc.example.org')?.content).toBe(INGRESS_PUBLIC_IP);
    const create = dns.calls.find((c) => c.method === 'POST');
    expect(create?.url).toBe(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`);
    expect(JSON.parse(create?.body ?? '{}')).toEqual({
      type: 'A',
      name: 'mc.example.org',
      content: INGRESS_PUBLIC_IP,
      ttl: 60,
      proxied: false,
    });
    expect(create?.headers.authorization).toBe(`Bearer ${token}`);
    expect(dns.calls.every((c) => c.redirect === 'error')).toBe(true);

    // A second ingress: the record follows.
    const ing2 = await addIngress(r.s, clients, { name: 'edge2', publicIp: '203.0.113.55' });
    await stepUp(r.s.t, r.s.secret, r.s.cookie);
    expect((await putIngress(r.s, ing2.serverId)).statusCode).toBe(200);
    const moved = await putRelay(r.s, r.gameId, { ingressServerId: ing2.serverId });
    expect(moved.statusCode, moved.body).toBe(200);
    await relayIdle(r.s);
    expect(dns.records.get('mc.example.org')?.content).toBe('203.0.113.55');
    expect(dns.calls.some((c) => c.method === 'PUT')).toBe(true);
    expect(gameRelayResponseSchema.parse(moved.json()).relay).toMatchObject({
      ingressName: 'edge2',
      dnsName: 'mc.example.org',
      dnsOk: true,
    });
    // The old ingress drops the route, the new one takes it.
    expect(r.ing.sets.at(-1)).toEqual([]);
    expect(ing2.sets.at(-1)?.[0]?.target.host).toBe(SOURCE_TS);

    // Only the fixed provider host was contacted.
    expect(dns.calls.every((c) => new URL(c.url).host === 'api.cloudflare.com')).toBe(true);
    // The token is in no answer, no log line, no audit entry and not in the settings row clear.
    const get = await gameRequest(r.s, 'GET', '/api/settings/dns');
    expect(get.body).not.toContain(token);
    expect(put.body).not.toContain(token);
    expect(r.s.t.logs.join('\n')).not.toContain(token);
    const auditText = JSON.stringify(r.s.t.db.db.select().from(auditLog).all());
    expect(auditText).not.toContain(token);
    const settingsRow = r.s.t.db.sqlite
      .prepare("SELECT value_json v FROM settings WHERE key = 'relay.dns'")
      .get() as { v: string };
    expect(settingsRow.v).not.toContain(token);
    expect(audits(r.s.t, 'relay.dns_updated').length).toBeGreaterThanOrEqual(2);
  });

  it('DuckDNS: only <sub>.duckdns.org names; a refusal is reported without the token', async () => {
    const dns = fakeDns({ duck: 'KO' });
    const r = await setup({ dnsFetch: dns.fetch, captureLogs: true });
    const token = 'duck' + Math.random().toString(36).slice(2, 12) + 'abcdefghij';
    expect(
      (await gameRequest(r.s, 'PUT', '/api/settings/dns', { provider: 'duckdns', token }))
        .statusCode,
    ).toBe(200);
    expect((await putIngress(r.s, r.ing.serverId)).statusCode).toBe(200);
    const bad = await putRelay(r.s, r.gameId, {
      ingressServerId: r.ing.serverId,
      dnsName: 'mc.example.org',
    });
    expect(bad.statusCode).toBe(400);
    const ok = await putRelay(r.s, r.gameId, {
      ingressServerId: r.ing.serverId,
      dnsName: 'meinspiel.duckdns.org',
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(gameRelayResponseSchema.parse(ok.json()).relay?.dnsOk).toBe(false);
    const call = dns.calls.at(-1);
    const u = new URL(call?.url ?? '');
    expect(u.origin + u.pathname).toBe('https://www.duckdns.org/update');
    expect(u.searchParams.get('domains')).toBe('meinspiel');
    expect(u.searchParams.get('ip')).toBe(INGRESS_PUBLIC_IP);
    const settings = dnsSettingsSchema.parse(
      (await gameRequest(r.s, 'GET', '/api/settings/dns')).json(),
    );
    expect(settings.lastError).toBe('DuckDNS hat die Änderung abgelehnt');
    for (const text of [
      JSON.stringify(settings),
      r.s.t.logs.join('\n'),
      JSON.stringify(r.s.t.db.db.select().from(auditLog).all()),
    ]) {
      expect(text).not.toContain(token);
    }
  });

  it('one DNS name per game (409); a changed or removed name deletes the old record', async () => {
    const dns = fakeDns();
    const r = await setup({ dnsFetch: dns.fetch });
    await gameRequest(r.s, 'PUT', '/api/settings/dns', {
      provider: 'cloudflare',
      token: 'abcdefghijklmnopqrstuvwxyz',
      zoneId: 'c'.repeat(32),
    });
    await enableAndAssign(r, 'mc.example.org');
    expect(dns.records.get('mc.example.org')?.content).toBe(INGRESS_PUBLIC_IP);
    const other = copyGame(r, r.s.serverId, 'creative', 25580);
    const dup = await putRelay(r.s, other, {
      ingressServerId: r.ing.serverId,
      dnsName: 'mc.example.org',
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json<{ message?: string }>().message).toBe(
      'DNS-Name wird schon von survival genutzt',
    );
    // Rename: the old record goes, the new one points to the ingress.
    const renamed = await putRelay(r.s, r.gameId, {
      ingressServerId: r.ing.serverId,
      dnsName: 'play.example.org',
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(dns.records.has('mc.example.org')).toBe(false);
    expect(dns.records.get('play.example.org')?.content).toBe(INGRESS_PUBLIC_IP);
    expect(dns.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    expect(audits(r.s.t, 'relay.dns_deleted')).toHaveLength(1);
    // The freed name can be used by another game now.
    expect(
      (await putRelay(r.s, other, { ingressServerId: r.ing.serverId, dnsName: 'mc.example.org' }))
        .statusCode,
    ).toBe(200);
    // Removing the relay deletes its record too.
    await putRelay(r.s, r.gameId, { ingressServerId: null });
    expect(dns.records.has('play.example.org')).toBe(false);
    expect(dns.records.get('mc.example.org')?.content).toBe(INGRESS_PUBLIC_IP);
  });

  it('switching the provider needs a new token (a token never goes to another provider)', async () => {
    const dns = fakeDns();
    const r = await setup({ dnsFetch: dns.fetch });
    const cfToken = 'cloudflare' + 'Z'.repeat(20);
    await gameRequest(r.s, 'PUT', '/api/settings/dns', {
      provider: 'cloudflare',
      token: cfToken,
      zoneId: 'd'.repeat(32),
    });
    await enableAndAssign(r, 'spiel.duckdns.org');
    const sw = await gameRequest(r.s, 'PUT', '/api/settings/dns', { provider: 'duckdns' });
    expect(sw.statusCode).toBe(400);
    expect(
      dnsSettingsSchema.parse((await gameRequest(r.s, 'GET', '/api/settings/dns')).json()).provider,
    ).toBe('cloudflare');
    const ok = await gameRequest(r.s, 'PUT', '/api/settings/dns', {
      provider: 'duckdns',
      token: 'duck' + 'Y'.repeat(20),
    });
    expect(ok.statusCode).toBe(200);
    for (const c of dns.calls.filter((x) => new URL(x.url).host === 'www.duckdns.org')) {
      expect(c.url).not.toContain(cfToken);
      expect(JSON.stringify(c.headers)).not.toContain(cfToken);
    }
    // Same provider without a token keeps it (zone change only).
    const keep = await gameRequest(r.s, 'PUT', '/api/settings/dns', { provider: 'duckdns' });
    expect(keep.statusCode).toBe(200);
    expect(dnsSettingsSchema.parse(keep.json()).tokenSet).toBe(true);
  });

  it('provider none deletes the token; cloudflare without zone is refused', async () => {
    const r = await setup();
    const noZone = await gameRequest(r.s, 'PUT', '/api/settings/dns', {
      provider: 'cloudflare',
      token: 'abcdefghijklmnopqrstuvwxyz',
    });
    expect(noZone.statusCode).toBe(400);
    const badZone = await gameRequest(r.s, 'PUT', '/api/settings/dns', {
      provider: 'cloudflare',
      token: 'abcdefghijklmnopqrstuvwxyz',
      zoneId: '../../evil',
    });
    expect(badZone.statusCode).toBe(400);
    await gameRequest(r.s, 'PUT', '/api/settings/dns', {
      provider: 'duckdns',
      token: 'abcdefghijklmnopqrstuvwxyz',
    });
    const none = await gameRequest(r.s, 'PUT', '/api/settings/dns', { provider: 'none' });
    expect(dnsSettingsSchema.parse(none.json())).toMatchObject({
      provider: 'none',
      tokenSet: false,
    });
    expect(audits(r.s.t, 'settings.dns_updated')).toHaveLength(2);
  });
});

describe('demo data (M15, HZ_DEMO=1)', () => {
  it('a demo ingress with a relayed demo game', async () => {
    t = await makeApp({ env: { HZ_DEMO: '1' } });
    const { cookie } = await completeSetup(t);
    const list = ingressListResponseSchema.parse(
      (
        await t.app.inject({
          method: 'GET',
          url: '/api/relay/ingresses',
          headers: authHeaders(cookie),
        })
      ).json(),
    ).ingresses;
    const demo = list.find((i) => i.enabled);
    expect(demo).toMatchObject({ serverName: 'oracle-a1', capable: true });
    expect(demo?.games).toHaveLength(1);
    const game = t.app.hzCore.games.list().find((g) => g.relay !== null);
    expect(game?.relay).toMatchObject({ ingressName: 'oracle-a1', state: 'ok' });
    expect(game?.address).toBe('mc.example.org:25565');
    expect(t.db.db.select().from(gameRelays).all()).toHaveLength(1);
  });
});
