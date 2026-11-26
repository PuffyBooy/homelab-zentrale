import dgram from 'node:dgram';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { relaySetDataSchema, type AgentEvent, type RelayRoute, type RpcEnvelope } from '@hz/shared';
import { Dispatcher } from '../src/actions/index.js';
import {
  RELAY_MAX_CONNECTIONS,
  RELAY_MAX_PER_IP,
  RELAY_TCP_IDLE_MS,
  RELAY_UDP_IDLE_MS,
  RelayManager,
  canonicalIp,
  isTailnetTarget,
  relaySet,
  type RelayManagerOptions,
} from '../src/actions/relay.js';
import { ActionError } from '../src/actions/types.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { makeCtx } from './game-helpers.js';

const HOST = '127.0.0.1';
const loopbackOnly = (h: string): boolean => h === HOST;

// ---------------------------------------------------------------------------
// helpers

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function manager(over: Partial<RelayManagerOptions> = {}): {
  m: RelayManager;
  logs: string[];
} {
  const logs: string[] = [];
  const m = new RelayManager({
    log: createLogger('debug', (l) => logs.push(l)),
    host: HOST,
    allowTarget: loopbackOnly,
    ...over,
  });
  cleanups.push(() => m.closeAll());
  return { m, logs };
}

async function canBind(port: number): Promise<boolean> {
  const tcp = await new Promise<boolean>((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen({ port, host: HOST, exclusive: true }, () => s.close(() => resolve(true)));
  });
  if (!tcp) return false;
  return new Promise<boolean>((resolve) => {
    const u = dgram.createSocket('udp4');
    u.once('error', () => {
      u.close();
      resolve(false);
    });
    u.bind({ port, address: HOST, exclusive: true }, () => u.close(() => resolve(true)));
  });
}

/** n consecutive ports free for TCP and UDP. */
async function freePorts(n = 1): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = 20000 + Math.floor(Math.random() * 40000);
    let ok = true;
    for (let i = 0; i < n && ok; i++) ok = await canBind(base + i);
    if (ok) return base;
  }
  throw new Error('no free ports');
}

/** TCP echo server that prefixes replies with its tag; `ends` on half-close. */
async function tcpEcho(tag: string, port = 0): Promise<{ port: number; conns: () => number }> {
  let conns = 0;
  const open = new Set<net.Socket>();
  const srv = net.createServer({ allowHalfOpen: true }, (s) => {
    conns += 1;
    open.add(s);
    s.on('close', () => open.delete(s));
    s.on('error', () => undefined);
    s.on('data', (d: Buffer) => s.write(Buffer.concat([Buffer.from(tag), d])));
    s.on('end', () => s.end(`${tag}:bye`));
  });
  await new Promise<void>((r) => srv.listen({ port, host: HOST }, r));
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        srv.close(() => r());
        for (const s of open) s.destroy();
      }),
  );
  return { port: (srv.address() as AddressInfo).port, conns: () => conns };
}

/** TCP sink that answers with the total byte count on end (backpressure test). */
async function tcpCounter(): Promise<number> {
  const srv = net.createServer({ allowHalfOpen: true }, (s) => {
    let n = 0;
    s.on('data', (d: Buffer) => {
      n += d.length;
    });
    s.on('end', () => s.end(String(n)));
  });
  await new Promise<void>((r) => srv.listen({ port: 0, host: HOST }, r));
  cleanups.push(() => new Promise<void>((r) => srv.close(() => r())));
  return (srv.address() as AddressInfo).port;
}

async function udpEcho(tag: string): Promise<number> {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    sock.send(Buffer.concat([Buffer.from(tag), msg]), rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => sock.bind(0, HOST, r));
  cleanups.push(() => new Promise<void>((r) => sock.close(() => r())));
  return sock.address().port;
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ port, host: HOST, allowHalfOpen: true }, () => resolve(s));
    s.once('error', reject);
    cleanups.push(() => {
      s.destroy();
    });
  });
}

function nextData(s: net.Socket, ms = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no data')), ms);
    s.once('data', (d: Buffer) => {
      clearTimeout(t);
      resolve(d.toString());
    });
  });
}

function readAll(s: net.Socket, ms = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    const t = setTimeout(() => reject(new Error('no end')), ms);
    s.on('data', (d: Buffer) => parts.push(d));
    s.once('end', () => {
      clearTimeout(t);
      resolve(Buffer.concat(parts).toString());
    });
  });
}

/** True when the relay ended or reset the connection (FIN or close). */
function closed(s: net.Socket, ms = 3000): Promise<boolean> {
  if (s.destroyed || s.readableEnded) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    const done = (): void => {
      clearTimeout(t);
      resolve(true);
    };
    s.once('end', done);
    s.once('close', done);
    s.on('error', () => undefined);
    s.resume();
  });
}

async function udpClient(): Promise<dgram.Socket> {
  const c = dgram.createSocket('udp4');
  await new Promise<void>((r) => c.bind(0, HOST, r));
  cleanups.push(() => new Promise<void>((r) => c.close(() => r())));
  return c;
}

function udpAsk(c: dgram.Socket, port: number, text: string, ms = 1000): Promise<string | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      c.removeListener('message', on);
      resolve(null);
    }, ms);
    const on = (msg: Buffer): void => {
      clearTimeout(t);
      c.removeListener('message', on);
      resolve(msg.toString());
    };
    c.on('message', on);
    c.send(text, port, HOST);
  });
}

function route(
  id: string,
  protocol: 'tcp' | 'udp',
  listenPort: number,
  targetPort: number,
  count = 1,
  host = HOST,
): RelayRoute {
  return { id, protocol, listenPort, count, target: { host, port: targetPort } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function eventually(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await sleep(20);
  }
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ActionError);
  expect((err as ActionError).code).toBe(code);
}

// ---------------------------------------------------------------------------

describe('relay: config and capability', () => {
  const base = { HZ_CORE_URL: 'wss://heimserver.tail1234.ts.net/agent', HZ_AGENT_NAME: 'oracle' };

  it('HZ_AGENT_ALLOW_RELAY is off unless 1/true', () => {
    expect(loadConfig(base).allowRelay).toBe(false);
    expect(loadConfig({ ...base, HZ_AGENT_ALLOW_RELAY: '0' }).allowRelay).toBe(false);
    expect(loadConfig({ ...base, HZ_AGENT_ALLOW_RELAY: '1' }).allowRelay).toBe(true);
    expect(() => loadConfig({ ...base, HZ_AGENT_ALLOW_RELAY: 'yes' })).toThrow();
  });

  it('defaults: 256 per route, 10 min TCP idle, 2 min UDP idle', () => {
    expect(RELAY_MAX_CONNECTIONS).toBe(256);
    expect(RELAY_MAX_PER_IP).toBe(16);
    expect(RELAY_TCP_IDLE_MS).toBe(600_000);
    expect(RELAY_UDP_IDLE_MS).toBe(120_000);
  });
});

describe('relay: dispatcher', () => {
  const env = (params: unknown): RpcEnvelope => ({
    type: 'rpc',
    id: 'r1',
    action: 'relay.set',
    params,
  });

  it('without HZ_AGENT_ALLOW_RELAY relay.set is not_allowed and audited', async () => {
    const { ctx } = makeCtx('/nonexistent');
    const events: AgentEvent[] = [];
    const d = new Dispatcher(ctx, (e) => events.push(e));
    const res = await d.handle(env({ routes: [] }));
    expect(res).toMatchObject({ ok: false, error: { code: 'not_allowed' } });
    expect(events.some((e) => e.event.kind === 'denied')).toBe(true);
    await expectCode(relaySet({ routes: [] }, ctx), 'not_allowed');
  });

  it('rejects targets outside the tailnet and ports below 1024 before any bind', async () => {
    const { m } = manager({ allowTarget: undefined });
    const { ctx } = makeCtx('/nonexistent', { relay: m });
    const d = new Dispatcher(ctx, () => undefined);
    const bad = [
      route('g1:game', 'tcp', 30000, 30000, 1, '127.0.0.1'),
      route('g1:game', 'tcp', 30000, 30000, 1, '192.168.1.10'),
      route('g1:game', 'tcp', 30000, 30000, 1, '8.8.8.8'),
      route('g1:game', 'tcp', 30000, 30000, 1, 'heimserver'),
      route('g1:game', 'tcp', 80, 30000, 1, '100.64.0.1'),
      route('g1:game', 'tcp', 30000, 22, 1, '100.64.0.1'),
    ];
    for (const r of bad) {
      const res = await d.handle(env({ routes: [r] }));
      expect(res, JSON.stringify(r)).toMatchObject({
        ok: false,
        error: { code: 'invalid_params' },
      });
    }
    expect(m.active()).toEqual([]);
  });

  it('a tailnet target is accepted through the dispatcher', async () => {
    const port = await freePorts();
    const { m } = manager({ allowTarget: undefined });
    const { ctx } = makeCtx('/nonexistent', { relay: m });
    const d = new Dispatcher(ctx, () => undefined);
    const res = await d.handle(
      env({ routes: [route('g1:game', 'udp', port, 25565, 1, '100.101.2.3')] }),
    );
    expect(res.ok).toBe(true);
    const data = relaySetDataSchema.parse(res.ok ? res.data : null);
    expect(data.routes).toEqual([{ id: 'g1:game', ok: true, error: null }]);
  });
});

describe('relay: target check (strict default)', () => {
  it('isTailnetTarget only accepts literal tailnet IPs', () => {
    for (const ok of [
      '100.64.0.1',
      '100.127.255.254',
      'fd7a:115c:a1e0::1',
      'fd7a:115c:a1e0:ab12::5',
    ])
      expect(isTailnetTarget(ok), ok).toBe(true);
    for (const bad of [
      '127.0.0.1',
      '100.63.255.255',
      '100.128.0.1',
      '10.0.0.1',
      '0.0.0.0',
      '::1',
      'fd7a:115c:a1e1::1',
      '::ffff:100.64.0.1',
      'localhost',
      'x.ts.net',
      '',
    ])
      expect(isTailnetTarget(bad), bad).toBe(false);
  });

  it('the manager itself refuses a loopback target without the test override', async () => {
    const { m } = manager({ allowTarget: undefined });
    const port = await freePorts();
    await expectCode(m.set([route('g1:game', 'tcp', port, port)]), 'invalid_params');
    expect(await canBind(port)).toBe(true);
  });

  it('the manager re-checks ports even if the schema was bypassed', async () => {
    const { m } = manager();
    await expectCode(m.set([route('g1:game', 'tcp', 1023, 30000)]), 'invalid_params');
    await expectCode(m.set([route('g1:game', 'tcp', 65535, 30000, 2)]), 'invalid_params');
    await expectCode(m.set([route('g1:game', 'tcp', 30000, 65535, 2)]), 'invalid_params');
  });
});

describe('relay: TCP', () => {
  it('forwards both ways, passes a half-close on, keeps the target port offset', async () => {
    const a = await tcpEcho('A');
    const b = await tcpEcho('B', a.port + 1).catch(() => null);
    const listen = await freePorts(2);
    const { m, logs } = manager();
    const count = b ? 2 : 1;
    const res = await m.set([route('g1:game', 'tcp', listen, a.port, count)]);
    expect(res.routes).toEqual([{ id: 'g1:game', ok: true, error: null }]);

    const c = await connect(listen);
    c.write('secret-payload');
    expect(await nextData(c)).toBe('Asecret-payload');
    const rest = readAll(c);
    c.end();
    expect(await rest).toBe('A:bye');

    if (b) {
      const c2 = await connect(listen + 1);
      c2.write('x');
      expect(await nextData(c2)).toBe('Bx');
    }
    const all = logs.join('\n');
    expect(all).not.toContain('secret-payload');
    expect(all).not.toContain(HOST);
  });

  it('streams large data with backpressure', async () => {
    const target = await tcpCounter();
    const listen = await freePorts();
    const { m } = manager();
    await m.set([route('g1:game', 'tcp', listen, target)]);
    const c = await connect(listen);
    const chunk = Buffer.alloc(64 * 1024, 7);
    const total = 8 * 1024 * 1024;
    const answer = readAll(c, 15_000);
    for (let sent = 0; sent < total; sent += chunk.length) {
      if (!c.write(chunk)) await new Promise((r) => c.once('drain', r));
    }
    c.end();
    expect(await answer).toBe(String(total));
  });

  it('closes a client when the target is unreachable', async () => {
    const dead = await freePorts();
    const listen = await freePorts();
    const { m } = manager();
    await m.set([route('g1:game', 'tcp', listen, dead)]);
    const c = await connect(listen);
    expect(await closed(c)).toBe(true);
    await eventually(() => m.liveCount('g1:game') === 0);
  });

  it('limits connections per route', async () => {
    const t = await tcpEcho('A');
    const listen = await freePorts();
    const { m } = manager({ maxConnections: 2 });
    await m.set([route('g1:game', 'tcp', listen, t.port)]);
    const c1 = await connect(listen);
    const c2 = await connect(listen);
    c1.write('1');
    c2.write('2');
    await nextData(c1);
    await nextData(c2);
    const c3 = await connect(listen);
    expect(await closed(c3)).toBe(true);
    expect(m.liveCount('g1:game')).toBe(2);
    c1.destroy();
    await eventually(() => m.liveCount('g1:game') === 1);
    const c4 = await connect(listen);
    c4.write('4');
    expect(await nextData(c4)).toBe('A4');
  });

  it('limits connections per client IP', async () => {
    const t = await tcpEcho('A');
    const listen = await freePorts();
    const { m } = manager({ maxPerIp: 2 });
    await m.set([route('g1:game', 'tcp', listen, t.port)]);
    const c1 = await connect(listen);
    const c2 = await connect(listen);
    c1.write('1');
    c2.write('2');
    await nextData(c1);
    await nextData(c2);
    const c3 = await connect(listen);
    expect(await closed(c3)).toBe(true);
    c2.destroy();
    await eventually(() => m.liveCount('g1:game') === 1);
    const c4 = await connect(listen);
    c4.write('4');
    expect(await nextData(c4)).toBe('A4');
  });

  it('closes idle connections', async () => {
    const t = await tcpEcho('A');
    const listen = await freePorts();
    const { m } = manager({ tcpIdleMs: 150 });
    await m.set([route('g1:game', 'tcp', listen, t.port)]);
    const c = await connect(listen);
    c.write('x');
    await nextData(c);
    expect(await closed(c, 2000)).toBe(true);
    await eventually(() => m.liveCount('g1:game') === 0);
  });
});

describe('relay: UDP', () => {
  it('forwards both ways with one session per client', async () => {
    const t = await udpEcho('U');
    const listen = await freePorts();
    const { m, logs } = manager();
    await m.set([route('g1:game', 'udp', listen, t)]);
    const c1 = await udpClient();
    const c2 = await udpClient();
    expect(await udpAsk(c1, listen, 'secret-one')).toBe('Usecret-one');
    expect(await udpAsk(c2, listen, 'two')).toBe('Utwo');
    expect(await udpAsk(c1, listen, 'again')).toBe('Uagain');
    expect(m.liveCount('g1:game')).toBe(2);
    const all = logs.join('\n');
    expect(all).not.toContain('secret-one');
    expect(all).not.toContain(HOST);
  });

  it('limits sessions per client IP and expires idle ones', async () => {
    const t = await udpEcho('U');
    const listen = await freePorts();
    const { m } = manager({ maxPerIp: 1, udpIdleMs: 200 });
    await m.set([route('g1:game', 'udp', listen, t)]);
    const c1 = await udpClient();
    const c2 = await udpClient();
    expect(await udpAsk(c1, listen, 'a')).toBe('Ua');
    // Same IP (127.0.0.1), other port: over the per-IP limit.
    expect(await udpAsk(c2, listen, 'b', 300)).toBeNull();
    await eventually(() => m.liveCount('g1:game') === 0);
    expect(await udpAsk(c2, listen, 'c')).toBe('Uc');
  });

  it('a full route evicts its oldest session for a new client', async () => {
    const t = await udpEcho('U');
    const listen = await freePorts();
    const { m } = manager({ maxConnections: 2 });
    await m.set([route('g1:game', 'udp', listen, t)]);
    const [c1, c2, c3] = [await udpClient(), await udpClient(), await udpClient()];
    expect(await udpAsk(c1, listen, '1')).toBe('U1');
    expect(await udpAsk(c2, listen, '2')).toBe('U2');
    expect(await udpAsk(c3, listen, '3')).toBe('U3');
    expect(m.liveCount('g1:game')).toBe(2);
    // c1's session was evicted; it gets a fresh one (evicting c2, now the oldest).
    expect(await udpAsk(c1, listen, '1b')).toBe('U1b');
    expect(m.liveCount('g1:game')).toBe(2);
  });

  it('drops datagrams from port 0 or a bad address instead of crashing', async () => {
    const t = await udpEcho('U');
    const listen = await freePorts();
    const created: dgram.Socket[] = [];
    const orig = dgram.createSocket.bind(dgram);
    vi.spyOn(dgram, 'createSocket').mockImplementation(((...args: Parameters<typeof orig>) => {
      const s = orig(...args);
      created.push(s);
      return s;
    }) as typeof dgram.createSocket);
    const { m } = manager();
    await m.set([route('g1:game', 'udp', listen, t)]);
    const listener = created[0];
    expect(listener).toBeDefined();
    const bad: dgram.RemoteInfo[] = [
      { address: HOST, port: 0, family: 'IPv4', size: 1 },
      { address: HOST, port: 70000, family: 'IPv4', size: 1 },
      { address: 'not-an-ip', port: 4000, family: 'IPv4', size: 1 },
    ];
    for (const rinfo of bad) {
      expect(() => listener?.emit('message', Buffer.from('x'), rinfo)).not.toThrow();
    }
    expect(m.liveCount('g1:game')).toBe(0);
    // The route still works.
    expect(await udpAsk(await udpClient(), listen, 'ok')).toBe('Uok');
  });

  it('TCP and UDP may share a port number', async () => {
    const tt = await tcpEcho('T');
    const tu = await udpEcho('U');
    const listen = await freePorts();
    const { m } = manager();
    const res = await m.set([
      route('g1:tcp', 'tcp', listen, tt.port),
      route('g1:udp', 'udp', listen, tu),
    ]);
    expect(res.routes.every((r) => r.ok)).toBe(true);
    const c = await connect(listen);
    c.write('t');
    expect(await nextData(c)).toBe('Tt');
    expect(await udpAsk(await udpClient(), listen, 'u')).toBe('Uu');
  });
});

describe('relay: route list', () => {
  it('rejects overlapping routes and duplicate ids, nothing is opened', async () => {
    const listen = await freePorts(4);
    const { m } = manager();
    await expectCode(
      m.set([route('a:x', 'tcp', listen, 30000, 3), route('b:x', 'tcp', listen + 2, 30000)]),
      'invalid_params',
    );
    await expectCode(
      m.set([route('a:x', 'udp', listen, 30000), route('a:x', 'tcp', listen + 3, 30000)]),
      'invalid_params',
    );
    expect(m.active()).toEqual([]);
    expect(await canBind(listen)).toBe(true);
  });

  it('keeps unchanged routes with their connections, closes removed ones', async () => {
    const t = await tcpEcho('A');
    const tu = await udpEcho('U');
    const p1 = await freePorts();
    const p2 = await freePorts();
    const p3 = await freePorts();
    const { m } = manager();
    await m.set([route('keep:x', 'tcp', p1, t.port), route('gone:x', 'tcp', p2, t.port)]);
    const kept = await connect(p1);
    const gone = await connect(p2);
    kept.write('1');
    gone.write('2');
    await nextData(kept);
    await nextData(gone);
    const conns = t.conns();

    const res = await m.set([route('keep:x', 'tcp', p1, t.port), route('new:x', 'udp', p3, tu)]);
    expect(res.routes.map((r) => r.ok)).toEqual([true, true]);
    expect(await closed(gone)).toBe(true);
    kept.write('3');
    expect(await nextData(kept)).toBe('A3');
    expect(t.conns()).toBe(conns);
    expect(m.active().sort()).toEqual(['keep:x', 'new:x']);
    expect(await canBind(p2)).toBe(true);

    await m.set([]);
    expect(m.active()).toEqual([]);
    expect(await closed(kept)).toBe(true);
    expect(await canBind(p1)).toBe(true);
  });

  it('a new target (game moved) keeps the port and drops old connections', async () => {
    const a = await tcpEcho('A');
    const b = await tcpEcho('B');
    const listen = await freePorts();
    const { m } = manager();
    await m.set([route('g:x', 'tcp', listen, a.port)]);
    const old = await connect(listen);
    old.write('1');
    expect(await nextData(old)).toBe('A1');
    await m.set([route('g:x', 'tcp', listen, b.port)]);
    expect(await closed(old)).toBe(true);
    const c = await connect(listen);
    c.write('2');
    expect(await nextData(c)).toBe('B2');
  });

  it('a busy port fails only that route, with a German reason', async () => {
    const t = await tcpEcho('A');
    const busy = await freePorts();
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen({ port: busy, host: HOST }, r));
    cleanups.push(() => new Promise<void>((r) => blocker.close(() => r())));
    const free = await freePorts();
    const { m } = manager();
    const res = await m.set([
      route('busy:x', 'tcp', busy, t.port),
      route('ok:x', 'tcp', free, t.port),
    ]);
    expect(res.routes).toEqual([
      { id: 'busy:x', ok: false, error: `Port ${busy}/tcp ist belegt` },
      { id: 'ok:x', ok: true, error: null },
    ]);
    expect(m.active()).toEqual(['ok:x']);
  });

  it('a range with one busy port frees the other ports again', async () => {
    const tu = await udpEcho('U');
    const listen = await freePorts(3);
    const blocker = dgram.createSocket('udp4');
    await new Promise<void>((r) => blocker.bind(listen + 2, HOST, r));
    cleanups.push(() => new Promise<void>((r) => blocker.close(() => r())));
    const { m } = manager();
    const res = await m.set([route('r:x', 'udp', listen, tu, 3)]);
    expect(res.routes[0]).toEqual({
      id: 'r:x',
      ok: false,
      error: `Port ${listen + 2}/udp ist belegt`,
    });
    expect(await canBind(listen)).toBe(true);
  });

  it('never takes a port of a wake listener', async () => {
    const listen = await freePorts();
    const { m } = manager({ wakeHolds: (port, proto) => port === listen && proto === 'udp' });
    const res = await m.set([route('w:x', 'udp', listen, 30000)]);
    expect(res.routes[0]).toMatchObject({ ok: false });
    expect(res.routes[0]?.error).toContain(`Port ${listen}/udp`);
    expect(m.active()).toEqual([]);
  });

  it('refuses a route that points back to one of its own relay ports (loop)', async () => {
    const p1 = await freePorts(2);
    const t = await tcpEcho('A');
    const { m } = manager({ localAddresses: () => ['127.0.0.1', 'fd7a:115c:a1e0::1'] });
    // Self loop and a loop through a second route.
    await expectCode(m.set([route('a:x', 'tcp', p1, p1)]), 'invalid_params');
    await expectCode(
      m.set([route('a:x', 'tcp', p1, p1 + 1), route('b:x', 'tcp', p1 + 1, t.port)]),
      'invalid_params',
    );
    expect(m.active()).toEqual([]);
    // Same port number but another protocol is no loop.
    const ok = await m.set([route('a:x', 'udp', p1, t.port), route('b:x', 'tcp', p1, t.port)]);
    expect(ok.routes.every((r) => r.ok)).toBe(true);
  });

  it('the loop check also matches a non-canonical tailnet IPv6', async () => {
    const { m } = manager({
      allowTarget: undefined,
      localAddresses: () => ['fd7a:115c:a1e0::1'],
    });
    await expectCode(
      m.set([route('a:x', 'udp', 40000, 40000, 1, 'FD7A:115C:A1E0:0:0::1')]),
      'invalid_params',
    );
    expect(canonicalIp('FD7A:115C:A1E0:0::1')).toBe('fd7a:115c:a1e0::1');
    expect(canonicalIp('100.64.0.1')).toBe('100.64.0.1');
    expect(canonicalIp('nope')).toBeNull();
  });

  it('holds() reports the ports of active routes (wake listeners must not take them)', async () => {
    const t = await udpEcho('U');
    const listen = await freePorts(2);
    const { m } = manager();
    await m.set([route('r:x', 'udp', listen, t, 2)]);
    expect(m.holds(listen, 'udp')).toBe(true);
    expect(m.holds(listen + 1, 'udp')).toBe(true);
    expect(m.holds(listen + 2, 'udp')).toBe(false);
    expect(m.holds(listen, 'tcp')).toBe(false);
  });

  it('closeAll closes listeners and connections; later sets fail', async () => {
    const t = await tcpEcho('A');
    const listen = await freePorts();
    const { m } = manager();
    await m.set([route('g:x', 'tcp', listen, t.port)]);
    const c = await connect(listen);
    c.write('1');
    await nextData(c);
    await m.closeAll();
    expect(await closed(c)).toBe(true);
    expect(await canBind(listen)).toBe(true);
    await expectCode(m.set([]), 'failed');
  });
});
