import dgram from 'node:dgram';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { status as javaStatus, statusBedrock } from 'minecraft-server-util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { gameWakeArmDataSchema, type AgentEvent, type RpcEnvelope } from '@hz/shared';
import { Dispatcher } from '../src/actions/index.js';
import {
  JavaConnection,
  RAKNET_MAGIC,
  WAKE_DISCONNECT_TEXT,
  WAKE_MAX_CONNECTIONS,
  WakeManager,
  bedrockVerdict,
  gameWakeArm,
  gameWakeDisarm,
  parsePortEntry,
  publishedPorts,
  rawUdpVerdict,
  readVarInt,
  writeVarInt,
  type GameWakeEvent,
} from '../src/actions/game-wake.js';
import { ActionError } from '../src/actions/types.js';
import type { HostContext } from '../src/host.js';
import { closedPort, makeCtx } from './game-helpers.js';

let base: string;
let root: string;
let games: string;
let outside: string;
const HOST = '127.0.0.1';

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hz-wake-')));
  root = path.join(base, 'homelab');
  games = path.join(root, 'games');
  outside = path.join(base, 'outside');
  await mkdir(games, { recursive: true });
  await mkdir(outside, { recursive: true });
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const managers: WakeManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.closeAll()));
});

let gameNo = 0;
async function makeGame(ports: string[]): Promise<string> {
  const id = `wake-${++gameNo}`;
  const dir = path.join(games, id);
  await mkdir(dir, { recursive: true });
  const lines = ports.map((p) => `      - '${p}'`).join('\n');
  await writeFile(
    path.join(dir, 'compose.yml'),
    `services:\n  server:\n    image: x:1\n    ports:\n${lines}\n    volumes:\n      - ./data:/data\n`,
  );
  return id;
}

function setup(opts: { docker?: HostContext['docker']; timeoutMs?: number } = {}) {
  const events: GameWakeEvent[] = [];
  const { ctx, rec } = makeCtx(root);
  const wake = new WakeManager({
    emit: (e) => events.push(e),
    log: ctx.log,
    host: HOST,
    ...(opts.timeoutMs ? { connectionTimeoutMs: opts.timeoutMs } : {}),
  });
  managers.push(wake);
  ctx.wake = wake;
  if (opts.docker !== undefined) ctx.host = { ...ctx.host, docker: opts.docker };
  return { ctx, rec, wake, events };
}

const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when nothing listens on the TCP port any more (we can bind it). */
async function tcpFree(port: number): Promise<boolean> {
  const s = net.createServer();
  return new Promise((resolve) => {
    s.once('error', () => resolve(false));
    s.listen(port, HOST, () => s.close(() => resolve(true)));
  });
}
async function udpFree(port: number): Promise<boolean> {
  const s = dgram.createSocket('udp4');
  return new Promise((resolve) => {
    s.once('error', () => {
      s.close();
      resolve(false);
    });
    s.bind(port, HOST, () => s.close(() => resolve(true)));
  });
}

function sendUdp(port: number, data: Buffer, waitMs = 300): Promise<Buffer[]> {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    const got: Buffer[] = [];
    s.on('message', (m) => got.push(m));
    s.send(data, port, HOST);
    setTimeout(() => s.close(() => resolve(got)), waitMs);
  });
}

function mcFrame(id: number, payload: Buffer): Buffer {
  const body = Buffer.concat([writeVarInt(id), payload]);
  return Buffer.concat([writeVarInt(body.length), body]);
}
function handshake(nextState: number, protocol = 767): Buffer {
  const host = Buffer.from('localhost');
  const port = Buffer.alloc(2);
  port.writeUInt16BE(25565);
  return mcFrame(
    0,
    Buffer.concat([
      writeVarInt(protocol),
      writeVarInt(host.length),
      host,
      port,
      writeVarInt(nextState),
    ]),
  );
}

/** Connects, writes `data`, collects everything until the server closes (or ms). */
function tcpExchange(
  port: number,
  data: Buffer,
  ms = 2000,
): Promise<{ got: Buffer; closed: boolean }> {
  return new Promise((resolve) => {
    const s = net.connect(port, HOST);
    const chunks: Buffer[] = [];
    let closed = false;
    const done = () => resolve({ got: Buffer.concat(chunks), closed });
    s.on('connect', () => s.write(data));
    s.on('data', (c) => chunks.push(c));
    s.on('error', () => undefined);
    s.on('close', () => {
      closed = true;
      clearTimeout(t);
      done();
    });
    const t = setTimeout(() => {
      s.destroy();
    }, ms);
  });
}

function rejectsWith(p: Promise<unknown>, code: string) {
  return expect(p).rejects.toSatisfy((e: unknown) => e instanceof ActionError && e.code === code);
}

describe('compose.yml port parsing', () => {
  it('accepts host ports on all interfaces only', () => {
    expect(parsePortEntry('25565:25565/tcp')).toEqual({ from: 25565, to: 25565, protocol: 'tcp' });
    expect(parsePortEntry('25565:25565')).toEqual({ from: 25565, to: 25565, protocol: 'tcp' });
    expect(parsePortEntry('0.0.0.0:19132:19132/udp')).toEqual({
      from: 19132,
      to: 19132,
      protocol: 'udp',
    });
    expect(parsePortEntry('2456-2458:2456-2458/udp')).toEqual({
      from: 2456,
      to: 2458,
      protocol: 'udp',
    });
    expect(parsePortEntry('[::]:7777:7777/udp')).toEqual({ from: 7777, to: 7777, protocol: 'udp' });
    // loopback-only (RCON, APIs), container-only and odd entries never count
    expect(parsePortEntry('127.0.0.1:25575:25575/tcp')).toBeNull();
    expect(parsePortEntry('[::1]:25575:25575/tcp')).toBeNull();
    expect(parsePortEntry('25565')).toBeNull();
    expect(parsePortEntry('25565:25565/sctp')).toBeNull();
    expect(parsePortEntry('99999:1/tcp')).toBeNull();
    expect(parsePortEntry('${PORT_GAME}:25565/tcp')).toBeNull();
  });

  it('reads only list items under ports:', () => {
    const text = [
      'services:',
      '  server:',
      '    environment:',
      "      - '1111:1111/tcp'",
      '    ports:',
      "      - '25565:25565/tcp' # game",
      '      - "127.0.0.1:25575:25575/tcp"',
      '      - 19132:19132/udp',
      '    volumes:',
      "      - '2222:2222/tcp'",
    ].join('\n');
    expect(publishedPorts(text)).toEqual([
      { from: 25565, to: 25565, protocol: 'tcp' },
      { from: 19132, to: 19132, protocol: 'udp' },
    ]);
  });
});

describe('protocol units', () => {
  it('varints are bounded', () => {
    expect(readVarInt(writeVarInt(300), 0)).toEqual([300, 2]);
    expect(readVarInt(Buffer.from([0x80]), 0)).toBeNull();
    expect(() => readVarInt(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x01]), 0)).toThrow();
  });

  it('a status ping never wakes, a login does', () => {
    const c = new JavaConnection('Schläft');
    const steps = c.push(Buffer.concat([handshake(1), mcFrame(0, Buffer.alloc(0))]));
    expect(steps.some((s) => s.kind === 'wake')).toBe(false);
    expect(new JavaConnection('x').push(handshake(2)).some((s) => s.kind === 'wake')).toBe(true);
    expect(new JavaConnection('x').push(handshake(3)).some((s) => s.kind === 'wake')).toBe(true);
    // legacy ping, unknown next state, oversized frame: close without wake
    expect(new JavaConnection('x').push(Buffer.from([0xfe, 0x01]))).toEqual([{ kind: 'close' }]);
    expect(new JavaConnection('x').push(handshake(7))).toEqual([{ kind: 'close' }]);
    expect(
      new JavaConnection('x').push(Buffer.concat([writeVarInt(2000), Buffer.alloc(10)])),
    ).toEqual([{ kind: 'close' }]);
  });

  it('raw UDP: A2S and Satisfactory queries do not wake', () => {
    const a2s = (c: number) => Buffer.from([0xff, 0xff, 0xff, 0xff, c, 0x53, 0x6f]);
    for (const c of [0x54, 0x55, 0x56, 0x57]) expect(rawUdpVerdict(a2s(c)).kind).toBe('ignore');
    expect(rawUdpVerdict(Buffer.from([0xd5, 0xf6, 0x00, 0x01, 1, 2, 3])).kind).toBe('ignore');
    expect(rawUdpVerdict(Buffer.alloc(0)).kind).toBe('ignore');
    expect(rawUdpVerdict(Buffer.alloc(1501, 1)).kind).toBe('ignore');
    expect(rawUdpVerdict(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41])).kind).toBe('wake');
    expect(rawUdpVerdict(Buffer.from('hello')).kind).toBe('wake');
  });

  it('bedrock: only a valid open connection request wakes', () => {
    const ocr = Buffer.concat([
      Buffer.from([0x05]),
      RAKNET_MAGIC,
      Buffer.from([11]),
      Buffer.alloc(20),
    ]);
    expect(bedrockVerdict(ocr, 'm', 1n, 19132).kind).toBe('wake');
    const bad = Buffer.from(ocr);
    bad[3] = 0;
    expect(bedrockVerdict(bad, 'm', 1n, 19132).kind).toBe('ignore');
    expect(bedrockVerdict(Buffer.from('hello'), 'm', 1n, 19132).kind).toBe('ignore');
  });
});

describe('game.wake.arm checks', () => {
  it('refuses ports the game does not publish (other port, loopback, other protocol)', async () => {
    const p = await closedPort();
    const id = await makeGame([`${p}:25565/tcp`, `127.0.0.1:${p + 1}:25575/tcp`]);
    const { ctx, wake } = setup();
    const arm = (port: number, protocol: 'tcp' | 'udp') =>
      gameWakeArm({ gameId: id, mode: 'raw', ports: [{ port, protocol }], motd: 'x' }, ctx);
    await rejectsWith(arm(p + 2, 'tcp'), 'not_allowed');
    await rejectsWith(arm(p + 1, 'tcp'), 'not_allowed');
    await rejectsWith(arm(p, 'udp'), 'not_allowed');
    expect(wake.armed(id)).toEqual([]);
    expect(await tcpFree(p)).toBe(true);
  });

  it('refuses a game without compose.yml, a symlinked compose.yml or game folder', async () => {
    const p = await closedPort();
    const { ctx } = setup();
    const params = (gameId: string) => ({
      gameId,
      mode: 'raw' as const,
      ports: [{ port: p, protocol: 'tcp' as const }],
      motd: 'x',
    });
    await mkdir(path.join(games, 'no-compose'), { recursive: true });
    await rejectsWith(gameWakeArm(params('no-compose'), ctx), 'not_allowed');

    await writeFile(
      path.join(outside, 'compose.yml'),
      `services:\n  s:\n    ports:\n      - '${p}:1/tcp'\n`,
    );
    await mkdir(path.join(games, 'link-compose'), { recursive: true });
    await symlink(
      path.join(outside, 'compose.yml'),
      path.join(games, 'link-compose', 'compose.yml'),
    );
    await rejectsWith(gameWakeArm(params('link-compose'), ctx), 'bad_path');

    await symlink(outside, path.join(games, 'link-game'));
    await rejectsWith(gameWakeArm(params('link-game'), ctx), 'bad_path');
    await rejectsWith(gameWakeArm(params('missing-game'), ctx), 'not_found');
    expect(await tcpFree(p)).toBe(true);
  });

  it('is busy while the container runs', async () => {
    const p = await closedPort();
    const id = await makeGame([`${p}:25565/tcp`]);
    let running = true;
    const docker = {
      getContainer: (name: string) => ({
        inspect: async () => {
          expect(name).toBe(`game-${id}`);
          return { State: { Running: running } };
        },
      }),
    } as unknown as HostContext['docker'];
    const { ctx } = setup({ docker });
    const params = {
      gameId: id,
      mode: 'raw' as const,
      ports: [{ port: p, protocol: 'tcp' as const }],
      motd: 'x',
    };
    await rejectsWith(gameWakeArm(params, ctx), 'busy');
    expect(await tcpFree(p)).toBe(true);
    running = false;
    const r = await gameWakeArm(params, ctx);
    expect(gameWakeArmDataSchema.parse(r)).toEqual({ listening: [{ port: p, protocol: 'tcp' }] });
  });

  it('is busy when the port is taken', async () => {
    const p = await closedPort();
    const id = await makeGame([`${p}:25565/tcp`]);
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(p, HOST, r));
    try {
      const { ctx, wake } = setup();
      await rejectsWith(
        gameWakeArm(
          { gameId: id, mode: 'raw', ports: [{ port: p, protocol: 'tcp' }], motd: 'x' },
          ctx,
        ),
        'busy',
      );
      expect(wake.armed(id)).toEqual([]);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it('the dispatcher audits a foreign port as denied', async () => {
    const p = await closedPort();
    const id = await makeGame([`${p}:25565/tcp`]);
    const { ctx } = setup();
    const events: AgentEvent[] = [];
    const d = new Dispatcher(ctx, (e) => events.push(e));
    const env: RpcEnvelope = {
      type: 'rpc',
      id: 'wake-rpc-0001',
      action: 'game.wake.arm',
      params: { gameId: id, mode: 'raw', ports: [{ port: p + 3, protocol: 'tcp' }], motd: 'x' },
    };
    const res = await d.handle(env);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('not_allowed');
    expect(events.some((e) => e.event.kind === 'denied')).toBe(true);
  });
});

describe('minecraft wake listener', () => {
  it('answers the server list with "Schläft" and does not wake; a login wakes', async () => {
    const p = await closedPort();
    const id = await makeGame([`${p}:25565/tcp`]);
    const { ctx, wake, events } = setup();
    await gameWakeArm(
      {
        gameId: id,
        mode: 'minecraft',
        ports: [{ port: p, protocol: 'tcp' }],
        motd: 'Schläft, zum Aufwecken verbinden',
      },
      ctx,
    );

    const st = await javaStatus(HOST, p, { timeout: 3000, enableSRV: false });
    expect(st.version.name).toBe('Schläft');
    expect(st.players.online).toBe(0);
    expect(st.players.max).toBe(0);
    expect(st.motd.clean).toBe('Schläft, zum Aufwecken verbinden');
    expect(st.roundTripLatency).toBeGreaterThanOrEqual(0);
    await sleep(100);
    expect(events).toEqual([]);
    expect(wake.armed(id)).toEqual([{ port: p, protocol: 'tcp' }]);

    // protocol of the request is echoed (clients then show no "outdated" warning)
    const raw = await tcpExchange(
      p,
      Buffer.concat([handshake(1, 999), mcFrame(0, Buffer.alloc(0))]),
      500,
    );
    expect(raw.got.toString('utf8')).toContain('"protocol":999');
    expect(events).toEqual([]);

    const login = await tcpExchange(p, handshake(2));
    expect(login.closed).toBe(true);
    const len = readVarInt(login.got, 0);
    expect(len).not.toBeNull();
    const text = login.got.toString('utf8');
    expect(text).toContain(JSON.stringify({ text: WAKE_DISCONNECT_TEXT }).slice(1, -1));
    await until(() => events.length > 0);
    expect(events).toEqual([{ kind: 'game_wake', gameId: id, port: p, protocol: 'tcp' }]);
    expect(wake.armed(id)).toEqual([]);
    // the port is free for the game before the core starts it
    expect(await tcpFree(p)).toBe(true);
  });

  it('parses inner VarInts without throwing', () => {
    const c = new JavaConnection('x');
    expect(() => c.push(Buffer.from([0x06, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]))).not.toThrow();
  });

  it('closes on oversized frames and garbage, without waking', async () => {
    const p = await closedPort();
    const id = await makeGame([`${p}:25565/tcp`]);
    const { ctx, events } = setup();
    await gameWakeArm(
      { gameId: id, mode: 'minecraft', ports: [{ port: p, protocol: 'tcp' }], motd: 'x' },
      ctx,
    );
    const big = await tcpExchange(p, Buffer.concat([writeVarInt(1025), Buffer.alloc(1025, 0)]));
    expect(big.closed).toBe(true);
    expect(big.got.length).toBe(0);
    const garbage = await tcpExchange(p, Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
    expect(garbage.closed).toBe(true);
    // A frame whose inner VarInt is longer than 5 bytes must not crash the agent.
    const badInner = await tcpExchange(p, Buffer.from([0x06, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]));
    expect(badInner.closed).toBe(true);
    const badProto = await tcpExchange(
      p,
      Buffer.from([0x07, 0x00, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]),
    );
    expect(badProto.closed).toBe(true);
    const legacy = await tcpExchange(p, Buffer.from([0xfe, 0x01, 0xfa]));
    expect(legacy.closed).toBe(true);
    await sleep(100);
    expect(events).toEqual([]);
  });

  it('caps concurrent connections and times idle ones out', async () => {
    const p = await closedPort();
    const id = await makeGame([`${p}:25565/tcp`]);
    const { ctx, events } = setup({ timeoutMs: 600 });
    await gameWakeArm(
      { gameId: id, mode: 'minecraft', ports: [{ port: p, protocol: 'tcp' }], motd: 'x' },
      ctx,
    );
    const open: net.Socket[] = [];
    const closedAt: number[] = [];
    const t0 = Date.now();
    for (let i = 0; i < WAKE_MAX_CONNECTIONS; i++) {
      const s = net.connect(p, HOST);
      s.on('error', () => undefined);
      s.on('close', () => closedAt.push(Date.now() - t0));
      await new Promise((r) => s.once('connect', r));
      open.push(s);
    }
    await sleep(100);
    const extra = await tcpExchange(p, Buffer.alloc(0), 1000);
    expect(extra.closed).toBe(true);
    expect(closedAt.length).toBe(0);
    // idle connections are cut after the timeout
    await until(() => closedAt.length === WAKE_MAX_CONNECTIONS, 3000);
    for (const s of open) s.destroy();
    expect(events).toEqual([]);
  });
});

describe('raw and bedrock wake listeners', () => {
  it('raw TCP: the first byte wakes, nothing is answered', async () => {
    const p = await closedPort();
    const id = await makeGame([`${p}:7777/tcp`]);
    const { ctx, events } = setup();
    await gameWakeArm(
      { gameId: id, mode: 'raw', ports: [{ port: p, protocol: 'tcp' }], motd: 'x' },
      ctx,
    );
    // a bare connect (port scan) does not wake
    const scan = net.connect(p, HOST);
    await new Promise((r) => scan.once('connect', r));
    scan.destroy();
    await sleep(100);
    expect(events).toEqual([]);
    const r = await tcpExchange(p, Buffer.from([0x16, 0x03, 0x01]));
    expect(r.got.length).toBe(0);
    await until(() => events.length > 0);
    expect(events).toEqual([{ kind: 'game_wake', gameId: id, port: p, protocol: 'tcp' }]);
    expect(await tcpFree(p)).toBe(true);
  });

  it('raw UDP: A2S queries do not wake, any other datagram does; all listeners close', async () => {
    const p = await closedPort();
    const id = await makeGame([`${p}-${p + 1}:2456-2457/udp`]);
    const { ctx, wake, events } = setup();
    await gameWakeArm(
      {
        gameId: id,
        mode: 'raw',
        ports: [
          { port: p, protocol: 'udp' },
          { port: p + 1, protocol: 'udp' },
        ],
        motd: 'x',
      },
      ctx,
    );
    const a2s = Buffer.concat([
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]),
      Buffer.from('Source Engine Query\0'),
    ]);
    expect(await sendUdp(p + 1, a2s)).toEqual([]);
    expect(
      await sendUdp(p + 1, Buffer.from([0xff, 0xff, 0xff, 0xff, 0x55, 0xff, 0xff, 0xff, 0xff])),
    ).toEqual([]);
    expect(events).toEqual([]);
    expect(wake.armed(id)).toHaveLength(2);
    expect(await sendUdp(p, Buffer.from([0x01, 0x02, 0x03]))).toEqual([]);
    await until(() => events.length > 0);
    expect(events).toEqual([{ kind: 'game_wake', gameId: id, port: p, protocol: 'udp' }]);
    expect(wake.armed(id)).toEqual([]);
    expect(await udpFree(p)).toBe(true);
    expect(await udpFree(p + 1)).toBe(true);
  });

  it('bedrock: the server list ping gets a pong with the MOTD, the join request wakes', async () => {
    const p = await closedPort();
    const id = await makeGame([`${p}:19132/udp`]);
    const { ctx, events } = setup();
    await gameWakeArm(
      {
        gameId: id,
        mode: 'minecraft-bedrock',
        ports: [{ port: p, protocol: 'udp' }],
        motd: 'Schläft',
      },
      ctx,
    );
    const st = await statusBedrock(HOST, p, { timeout: 3000, enableSRV: false });
    expect(st.motd.clean).toContain('Schläft');
    expect(st.players.online).toBe(0);
    await sleep(100);
    expect(events).toEqual([]);
    const ocr1 = Buffer.concat([
      Buffer.from([0x05]),
      RAKNET_MAGIC,
      Buffer.from([11]),
      Buffer.alloc(1400),
    ]);
    expect(await sendUdp(p, ocr1)).toEqual([]);
    await until(() => events.length > 0);
    expect(events).toEqual([{ kind: 'game_wake', gameId: id, port: p, protocol: 'udp' }]);
    expect(await udpFree(p)).toBe(true);
  });

  it('re-arming replaces listeners, disarm and closeAll free the ports', async () => {
    const p = await closedPort();
    const id = await makeGame([`${p}:25565/tcp`, `${p}:25565/udp`]);
    const { ctx, wake, events } = setup();
    const params = {
      gameId: id,
      mode: 'raw' as const,
      ports: [
        { port: p, protocol: 'tcp' as const },
        { port: p, protocol: 'udp' as const },
      ],
      motd: 'x',
    };
    await gameWakeArm(params, ctx);
    await gameWakeArm(params, ctx);
    expect(wake.armed(id)).toHaveLength(2);
    await expect(gameWakeDisarm({ gameId: id }, ctx)).resolves.toEqual({ disarmed: true });
    expect(await tcpFree(p)).toBe(true);
    expect(await udpFree(p)).toBe(true);
    await expect(gameWakeDisarm({ gameId: id }, ctx)).resolves.toEqual({ disarmed: true });
    await gameWakeArm(params, ctx);
    await wake.closeAll();
    expect(await tcpFree(p)).toBe(true);
    expect(events).toEqual([]);
  });

  it('without a wake manager the action fails cleanly', async () => {
    const p = await closedPort();
    const id = await makeGame([`${p}:25565/tcp`]);
    const { ctx } = makeCtx(root);
    await rejectsWith(
      gameWakeArm(
        { gameId: id, mode: 'raw', ports: [{ port: p, protocol: 'tcp' }], motd: 'x' },
        ctx,
      ),
      'failed',
    );
  });
});
