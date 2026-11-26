import dgram from 'node:dgram';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { RelayRoute } from '@hz/shared';
import { eq } from 'drizzle-orm';
// The agent's real relay (packages are TypeScript sources; vitest and tsc resolve them).
import { RelayManager } from '../../agent/src/actions/relay.js';
import { gameServers } from '../src/db/schema.js';
import { stepUp, type WsClient } from './agent-helpers.js';
import type { TestApp } from './helpers.js';
import { withTwoServers } from './migrate-helpers.js';
import { addIngress, putIngress, putRelay, relayIdle } from './relay-helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

const SOURCE_TS = '100.64.0.5';
const TARGET_TS = '100.64.0.6';
const silent = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  addSecret: () => undefined,
};

/** A port free for TCP and UDP on 127.0.0.1. */
async function freePort(): Promise<number> {
  for (;;) {
    const srv = net.createServer();
    const port = await new Promise<number>((resolve) =>
      srv.listen(0, '127.0.0.1', () => resolve((srv.address() as net.AddressInfo).port)),
    );
    await new Promise((r) => srv.close(r));
    const sock = dgram.createSocket('udp4');
    const ok = await new Promise<boolean>((resolve) => {
      sock.once('error', () => resolve(false));
      sock.bind(port, '127.0.0.1', () => resolve(true));
    });
    await new Promise<void>((r) => sock.close(() => r()));
    if (ok && port >= 1024) return port;
  }
}

/** TCP and UDP echo on random ports, answering "<tag>:<data>" (one sim game server). */
async function echoServer(tag: string): Promise<{ tcp: number; udp: number }> {
  const tcp = net.createServer((s) => s.on('data', (d) => s.write(`${tag}:${d.toString()}`)));
  const tcpPort = await new Promise<number>((resolve) =>
    tcp.listen(0, '127.0.0.1', () => resolve((tcp.address() as net.AddressInfo).port)),
  );
  const udp = dgram.createSocket('udp4');
  udp.on('message', (msg, rinfo) =>
    udp.send(`${tag}:${msg.toString()}`, rinfo.port, rinfo.address),
  );
  const udpPort = await new Promise<number>((resolve) =>
    udp.bind(0, '127.0.0.1', () => resolve(udp.address().port)),
  );
  cleanups.push(() => new Promise<void>((r) => tcp.close(() => r())));
  cleanups.push(() => new Promise<void>((r) => udp.close(() => r())));
  return { tcp: tcpPort, udp: udpPort };
}

function tcpRoundTrip(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(text));
    s.once('data', (d) => {
      resolve(d.toString());
      s.destroy();
    });
    s.once('error', reject);
    setTimeout(() => reject(new Error('tcp timeout')), 3000).unref();
  });
}

function udpRoundTrip(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.once('message', (m) => {
      resolve(m.toString());
      s.close();
    });
    s.send(text, port, '127.0.0.1');
    setTimeout(() => {
      s.close();
      reject(new Error('udp timeout'));
    }, 3000).unref();
  });
}

describe('relay end to end: core routes in the agent RelayManager (M15 acceptance)', () => {
  it('TCP and UDP reach the game through the same ingress port before and after a move', async () => {
    const m = await withTwoServers(
      clients,
      {},
      { targetListening: [], targetTailscaleIp: TARGET_TS },
    );
    t = m.s.t;
    const s = m.s;
    const ing = await addIngress(s, clients);
    await stepUp(s.t, s.secret, s.cookie);

    // The game publishes one port for TCP and UDP on its host.
    const listen = await freePort();
    s.t.db.db
      .update(gameServers)
      .set({
        portsJson: JSON.stringify([{ name: 'game', port: listen, protocol: 'tcp+udp', count: 1 }]),
      })
      .where(eq(gameServers.id, m.gameId))
      .run();
    expect(
      (await putIngress(s, ing.serverId, { portFrom: listen, portTo: listen })).statusCode,
    ).toBe(200);
    const assigned = await putRelay(s, m.gameId, { ingressServerId: ing.serverId });
    expect(assigned.statusCode, assigned.body).toBe(200);
    await relayIdle(s);

    // Sim game servers: the tailnet address + host port of each host maps to a local echo.
    const onSource = await echoServer('A');
    const onTarget = await echoServer('B');
    const hostPortOnTarget = listen === 65535 ? listen - 1 : listen + 1;
    const local = new Map<string, number>([
      [`tcp ${SOURCE_TS}:${listen}`, onSource.tcp],
      [`udp ${SOURCE_TS}:${listen}`, onSource.udp],
      [`tcp ${TARGET_TS}:${hostPortOnTarget}`, onTarget.tcp],
      [`udp ${TARGET_TS}:${hostPortOnTarget}`, onTarget.udp],
    ]);
    const toLocal = (routes: RelayRoute[]): RelayRoute[] =>
      routes.map((r) => {
        const port = local.get(`${r.protocol} ${r.target.host}:${r.target.port}`);
        if (port === undefined) throw new Error(`unexpected target ${JSON.stringify(r.target)}`);
        return { ...r, target: { host: '127.0.0.1', port } };
      });

    const relay = new RelayManager({
      log: silent,
      host: '127.0.0.1',
      allowTarget: (h) => h === '127.0.0.1',
      localAddresses: () => [],
    });
    cleanups.push(() => relay.closeAll());

    const before = ing.sets.at(-1) ?? [];
    expect(before.map((r) => [r.protocol, r.listenPort, r.target.host, r.target.port])).toEqual([
      ['tcp', listen, SOURCE_TS, listen],
      ['udp', listen, SOURCE_TS, listen],
    ]);
    const first = await relay.set(toLocal(before));
    expect(first.routes.every((r) => r.ok)).toBe(true);
    expect(await tcpRoundTrip(listen, 'hallo')).toBe('A:hallo');
    expect(await udpRoundTrip(listen, 'ping')).toBe('A:ping');

    // The move switches the game record to the target (as migrate.ts does at the end),
    // with another host port there.
    const row = s.t.app.hzCore.games.row(m.gameId);
    s.t.app.hzCore.games.moveTo(
      m.gameId,
      m.target.serverId,
      [{ name: 'game', port: hostPortOnTarget, protocol: 'tcp+udp', count: 1 }],
      row?.rconPort ?? null,
    );
    await relayIdle(s);
    const after = ing.sets.at(-1) ?? [];
    expect(after.map((r) => [r.protocol, r.listenPort, r.target.host, r.target.port])).toEqual([
      ['tcp', listen, TARGET_TS, hostPortOnTarget],
      ['udp', listen, TARGET_TS, hostPortOnTarget],
    ]);
    const second = await relay.set(toLocal(after));
    expect(second.routes.every((r) => r.ok)).toBe(true);
    expect(await tcpRoundTrip(listen, 'hallo')).toBe('B:hallo');
    expect(await udpRoundTrip(listen, 'ping')).toBe('B:ping');
    // Friends' address is unchanged.
    expect(s.t.app.hzCore.games.summary(m.gameId)?.address).toBe(`198.51.100.7:${listen}`);
  });
});
