import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { AgentEvent, GameWakeArmData, RpcParams } from '@hz/shared';
import type { Logger } from '../log.js';
import { GAME_NAME, resolveGameDir } from './game-common.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * game.wake.arm / game.wake.disarm (M12 sleep mode).
 *
 * While a game sleeps (container stopped) the agent listens on the game's host
 * ports and wakes it on the first connection that wants to play:
 * - minecraft (TCP): status ping -> "Schläft" MOTD, 0/0 players, ping/pong, no wake;
 *   login (handshake with next state 2/3) -> disconnect message, wake.
 * - minecraft-bedrock (UDP): unconnected ping -> pong with the MOTD, no wake;
 *   open connection request 1/2 -> wake.
 * - raw: the first TCP data byte, or the first UDP datagram that is not a server
 *   list query (Steam A2S `FF FF FF FF` + T/U/V/W, Satisfactory lightweight query
 *   `D5 F6 00`), wakes.
 * In minecraft mode UDP ports and in minecraft-bedrock mode TCP ports behave raw.
 *
 * Safety:
 * - Only ports the game's compose.yml publishes on all interfaces (`HOST:CONTAINER`
 *   or `0.0.0.0:HOST:CONTAINER`, with the same protocol) may be armed; anything
 *   else is `not_allowed`. compose.yml is read without following symlinks.
 * - Refused with `busy` while the container game-<gameId> runs (or the port is taken).
 * - No byte is ever forwarded anywhere. Replies are fixed, small and built here.
 * - TCP: at most 16 connections per listener, 1 KiB per frame, 4 KiB per
 *   connection, 5 s per connection. UDP: datagrams above 1500 bytes are ignored,
 *   pongs are rate limited (no amplification with spoofed sources).
 * - On wake every listener of the game is closed and its ports are free before
 *   the `game_wake` event goes out. No client address is logged or sent.
 */

export const WAKE_MAX_CONNECTIONS = 16;
export const WAKE_MAX_FRAME = 1024;
export const WAKE_MAX_CONNECTION_BYTES = 4096;
export const WAKE_CONNECTION_TIMEOUT_MS = 5000;
export const WAKE_MAX_DATAGRAM = 1500;
/** Bedrock pongs per listener and second. */
export const WAKE_MAX_PONGS_PER_SECOND = 20;
export const WAKE_DISCONNECT_TEXT = 'Server startet, bitte in 1 Minute neu verbinden.';
export const WAKE_VERSION_NAME = 'Schläft';
const MAX_COMPOSE_BYTES = 64 * 1024;

export type WakeMode = RpcParams<'game.wake.arm'>['mode'];
export type WakeProtocol = 'tcp' | 'udp';
export interface WakePort {
  port: number;
  protocol: WakeProtocol;
}
export type GameWakeEvent = Extract<AgentEvent['event'], { kind: 'game_wake' }>;

// ---------------------------------------------------------------------------
// compose.yml: which host ports does the game publish?

export interface PublishedPort {
  from: number;
  to: number;
  protocol: WakeProtocol;
}

function parsePortNumber(s: string): number | null {
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : null;
}

function parseRange(s: string): [number, number] | null {
  const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(s);
  if (!m?.[1]) return null;
  const a = parsePortNumber(m[1]);
  const b = m[2] ? parsePortNumber(m[2]) : a;
  if (a === null || b === null || b < a) return null;
  return [a, b];
}

/**
 * One short-syntax port entry (`'25565:25565/tcp'`, `'0.0.0.0:2456-2458:2456-2458/udp'`).
 * Returns null for entries without a host port and for entries bound to a specific
 * address (127.0.0.1 RCON/API ports must never get a wake listener on 0.0.0.0).
 */
export function parsePortEntry(entry: string): PublishedPort | null {
  let e = entry.trim();
  let protocol: WakeProtocol = 'tcp';
  const slash = e.lastIndexOf('/');
  if (slash >= 0) {
    const p = e.slice(slash + 1);
    if (p !== 'tcp' && p !== 'udp') return null;
    protocol = p;
    e = e.slice(0, slash);
  }
  let ip: string | null = null;
  if (e.startsWith('[')) {
    const end = e.indexOf(']:');
    if (end < 0) return null;
    ip = e.slice(1, end);
    e = e.slice(end + 2);
  }
  const parts = e.split(':');
  if (parts.length === 3) {
    if (ip !== null) return null;
    ip = parts.shift() as string;
  }
  if (parts.length !== 2) return null;
  if (ip !== null && ip !== '0.0.0.0' && ip !== '::') return null;
  const host = parseRange(parts[0] as string);
  if (!host || !parseRange(parts[1] as string)) return null;
  return { from: host[0], to: host[1], protocol };
}

/** All published host ports in compose.yml text (short syntax under `ports:`). */
export function publishedPorts(compose: string): PublishedPort[] {
  const out: PublishedPort[] = [];
  let portsIndent = -1;
  for (const raw of compose.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^\s*(#.*)?$/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (/^\s*ports:\s*(#.*)?$/.test(line)) {
      portsIndent = indent;
      continue;
    }
    if (portsIndent < 0) continue;
    const item = /^\s*-\s+(?:'([^']*)'|"([^"]*)"|([^\s#'"]+))\s*(#.*)?$/.exec(line);
    if (item && indent >= portsIndent) {
      const p = parsePortEntry(item[1] ?? item[2] ?? item[3] ?? '');
      if (p) out.push(p);
      continue;
    }
    portsIndent = -1;
  }
  return out;
}

/** Reads <gameDir>/compose.yml (no symlink, regular file, at most 64 KiB). */
async function readCompose(dir: string): Promise<string> {
  let fh;
  try {
    fh = await open(
      path.join(dir, 'compose.yml'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new ActionError('bad_path', 'compose.yml must not be a symlink');
    }
    throw new ActionError('not_allowed', 'the game has no compose.yml');
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new ActionError('bad_path', 'compose.yml is not a regular file');
    if (st.size > MAX_COMPOSE_BYTES) throw new ActionError('failed', 'compose.yml is too large');
    const buf = Buffer.alloc(MAX_COMPOSE_BYTES + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead > MAX_COMPOSE_BYTES) throw new ActionError('failed', 'compose.yml is too large');
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

/** Throws not_allowed unless every port is published by the game's compose.yml. */
export async function assertPortsPublished(
  homelabRoot: string,
  gameId: string,
  ports: readonly WakePort[],
): Promise<void> {
  if (!GAME_NAME.test(gameId)) throw new ActionError('bad_path', 'invalid game name');
  const game = await resolveGameDir(path.join(homelabRoot, 'games', gameId), homelabRoot);
  const published = publishedPorts(await readCompose(game.dir));
  for (const p of ports) {
    const ok = published.some(
      (x) => x.protocol === p.protocol && p.port >= x.from && p.port <= x.to,
    );
    if (!ok) {
      throw new ActionError(
        'not_allowed',
        `port ${p.port}/${p.protocol} is not published by the game`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Minecraft Java (TCP)

/** VarInt at `off`: [value, bytes] or null if incomplete; throws on > 5 bytes. */
export function readVarInt(buf: Buffer, off: number): [number, number] | null {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (off + i >= buf.length) return null;
    const b = buf[off + i] as number;
    value |= (b & 0x7f) << (7 * i);
    if ((b & 0x80) === 0) return [value | 0, i + 1];
  }
  throw new Error('varint too long');
}

export function writeVarInt(n: number): Buffer {
  const out: number[] = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return Buffer.from(out);
}

function mcString(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([writeVarInt(b.length), b]);
}

function mcPacket(id: number, payload: Buffer): Buffer {
  const body = Buffer.concat([writeVarInt(id), payload]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

export function statusJson(motd: string, protocol: number): string {
  return JSON.stringify({
    version: { name: WAKE_VERSION_NAME, protocol },
    players: { max: 0, online: 0 },
    description: { text: motd },
  });
}

type JavaStep =
  | { kind: 'more' }
  | { kind: 'reply'; data: Buffer; close: boolean }
  | { kind: 'wake'; data: Buffer }
  | { kind: 'close' };

/**
 * Per-connection state of the Minecraft listener. `push` takes received bytes and
 * returns what to do. Never keeps more than one frame (<= 1 KiB) buffered.
 */
export class JavaConnection {
  private buf: Buffer = Buffer.alloc(0);
  private state: 'handshake' | 'status' | 'done' = 'handshake';
  private protocol = 0;
  private statusSent = false;
  private total = 0;

  constructor(private readonly motd: string) {}

  push(chunk: Buffer): JavaStep[] {
    const steps: JavaStep[] = [];
    if (this.state === 'done') return [{ kind: 'close' }];
    this.total += chunk.length;
    if (this.total > WAKE_MAX_CONNECTION_BYTES) return [{ kind: 'close' }];
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    // Legacy (pre-1.7) server list ping: no answer, no wake.
    if (this.state === 'handshake' && this.buf[0] === 0xfe) return [{ kind: 'close' }];
    for (;;) {
      let len: [number, number] | null;
      try {
        len = readVarInt(this.buf, 0);
      } catch {
        return [...steps, { kind: 'close' }];
      }
      if (!len) {
        if (this.buf.length > 5) return [...steps, { kind: 'close' }];
        break;
      }
      const [size, n] = len;
      if (size <= 0 || size > WAKE_MAX_FRAME) return [...steps, { kind: 'close' }];
      if (this.buf.length < n + size) break;
      const frame = this.buf.subarray(n, n + size);
      this.buf = this.buf.subarray(n + size);
      let step: JavaStep;
      try {
        step = this.frame(frame);
      } catch {
        // Malformed VarInt or string inside a frame: drop the connection, never throw.
        return [...steps, { kind: 'close' }];
      }
      steps.push(step);
      if (step.kind !== 'reply' || step.close) {
        this.state = 'done';
        return steps;
      }
    }
    if (this.buf.length > WAKE_MAX_FRAME + 5) return [...steps, { kind: 'close' }];
    return steps.length > 0 ? steps : [{ kind: 'more' }];
  }

  private frame(frame: Buffer): JavaStep {
    let off = 0;
    const id = readVarInt(frame, off);
    if (!id) return { kind: 'close' };
    off += id[1];
    if (this.state === 'handshake') {
      if (id[0] !== 0x00) return { kind: 'close' };
      const proto = readVarInt(frame, off);
      if (!proto) return { kind: 'close' };
      off += proto[1];
      const addrLen = readVarInt(frame, off);
      if (!addrLen || addrLen[0] < 0 || addrLen[0] > 255 * 4) return { kind: 'close' };
      off += addrLen[1] + addrLen[0] + 2;
      const next = readVarInt(frame, off);
      if (!next || off + next[1] !== frame.length) return { kind: 'close' };
      this.protocol = proto[0];
      if (next[0] === 1) {
        this.state = 'status';
        return { kind: 'reply', data: Buffer.alloc(0), close: false };
      }
      if (next[0] === 2 || next[0] === 3) {
        const text = JSON.stringify({ text: WAKE_DISCONNECT_TEXT });
        return { kind: 'wake', data: mcPacket(0x00, mcString(text)) };
      }
      return { kind: 'close' };
    }
    // status state
    if (id[0] === 0x00 && frame.length === off && !this.statusSent) {
      this.statusSent = true;
      const json = statusJson(this.motd, this.protocol);
      return { kind: 'reply', data: mcPacket(0x00, mcString(json)), close: false };
    }
    if (id[0] === 0x01 && frame.length === off + 8) {
      return { kind: 'reply', data: mcPacket(0x01, frame.subarray(off, off + 8)), close: true };
    }
    return { kind: 'close' };
  }
}

// ---------------------------------------------------------------------------
// Bedrock (RakNet, UDP) and raw UDP

export const RAKNET_MAGIC = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');

export type UdpVerdict = { kind: 'ignore' } | { kind: 'wake' } | { kind: 'reply'; data: Buffer };

/** Steam A2S (info, player, rules, legacy serverquery_getchallenge). */
export function isA2sQuery(d: Buffer): boolean {
  return (
    d.length >= 5 &&
    d.readUInt32BE(0) === 0xffffffff &&
    [0x54, 0x55, 0x56, 0x57].includes(d[4] as number)
  );
}

/** Satisfactory lightweight query (magic 0xF6D5 LE, type 0 = poll server state). */
export function isSatisfactoryQuery(d: Buffer): boolean {
  return d.length >= 3 && d[0] === 0xd5 && d[1] === 0xf6 && d[2] === 0x00;
}

export function rawUdpVerdict(d: Buffer): UdpVerdict {
  if (d.length === 0 || d.length > WAKE_MAX_DATAGRAM) return { kind: 'ignore' };
  if (isA2sQuery(d) || isSatisfactoryQuery(d)) return { kind: 'ignore' };
  return { kind: 'wake' };
}

function bedrockMotd(motd: string, guid: bigint, port: number): string {
  const name = motd.replace(/;/g, ' ');
  return `MCPE;${name};0;${WAKE_VERSION_NAME};0;0;${guid};${name};Survival;1;${port};${port};`;
}

export function bedrockVerdict(d: Buffer, motd: string, guid: bigint, port: number): UdpVerdict {
  if (d.length === 0 || d.length > WAKE_MAX_DATAGRAM) return { kind: 'ignore' };
  const id = d[0];
  // Unconnected ping (0x01) / ping open connections (0x02): time, magic, client guid.
  if ((id === 0x01 || id === 0x02) && d.length >= 25 && d.subarray(9, 25).equals(RAKNET_MAGIC)) {
    const text = Buffer.from(bedrockMotd(motd, guid, port), 'utf8');
    const out = Buffer.alloc(1 + 8 + 8 + 16 + 2 + text.length);
    out[0] = 0x1c;
    d.copy(out, 1, 1, 9);
    out.writeBigUInt64BE(guid, 9);
    RAKNET_MAGIC.copy(out, 17);
    out.writeUInt16BE(text.length, 33);
    text.copy(out, 35);
    return { kind: 'reply', data: out };
  }
  // Open connection request 1 (0x05) / 2 (0x07): the client wants to join.
  if ((id === 0x05 || id === 0x07) && d.length >= 17 && d.subarray(1, 17).equals(RAKNET_MAGIC)) {
    return { kind: 'wake' };
  }
  return { kind: 'ignore' };
}

// ---------------------------------------------------------------------------
// Manager

interface Listener {
  port: WakePort;
  close(): Promise<void>;
}

interface ArmedGame {
  listeners: Listener[];
  woken: boolean;
}

export interface WakeManagerOptions {
  emit: (event: GameWakeEvent) => void;
  log: Logger;
  /** Tests bind 127.0.0.1; production binds all interfaces. */
  host?: string;
  /** Per-connection timeout (tests shorten it). */
  connectionTimeoutMs?: number;
}

export class WakeManager {
  private readonly games = new Map<string, ArmedGame>();
  /** Serializes arm/disarm/wake per game. */
  private readonly queue = new Map<string, Promise<unknown>>();

  constructor(private readonly o: WakeManagerOptions) {}

  private serial<T>(gameId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queue.get(gameId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    const tail = next.catch(() => undefined);
    this.queue.set(gameId, tail);
    void tail.then(() => {
      if (this.queue.get(gameId) === tail) this.queue.delete(gameId);
    });
    return next;
  }

  /** Ports currently armed for a game (tests, diagnostics). */
  armed(gameId: string): WakePort[] {
    return this.games.get(gameId)?.listeners.map((l) => l.port) ?? [];
  }

  arm(
    gameId: string,
    mode: WakeMode,
    ports: readonly WakePort[],
    motd: string,
  ): Promise<GameWakeArmData> {
    return this.serial(gameId, async () => {
      await this.closeGame(gameId);
      const seen = new Set<string>();
      for (const p of ports) {
        const key = `${p.port}/${p.protocol}`;
        if (seen.has(key)) throw new ActionError('invalid_params', 'port listed twice');
        seen.add(key);
      }
      const game: ArmedGame = { listeners: [], woken: false };
      this.games.set(gameId, game);
      try {
        for (const p of ports) {
          const l =
            p.protocol === 'tcp'
              ? await this.listenTcp(gameId, game, mode, p, motd)
              : await this.listenUdp(gameId, game, mode, p, motd);
          game.listeners.push(l);
        }
      } catch (err) {
        await this.closeGame(gameId);
        throw err;
      }
      this.o.log.info('wake listeners armed', { game: gameId, ports: ports.length, mode });
      return { listening: game.listeners.map((l) => ({ ...l.port })) };
    });
  }

  disarm(gameId: string): Promise<void> {
    return this.serial(gameId, () => this.closeGame(gameId));
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.games.keys()].map((id) => this.disarm(id)));
  }

  private async closeGame(gameId: string): Promise<void> {
    const game = this.games.get(gameId);
    if (!game) return;
    this.games.delete(gameId);
    await Promise.all(game.listeners.map((l) => l.close().catch(() => undefined)));
  }

  /** First play attempt: close everything of this game, then report. */
  private wake(gameId: string, game: ArmedGame, port: WakePort): void {
    if (game.woken) return;
    game.woken = true;
    void this.serial(gameId, async () => {
      if (this.games.get(gameId) !== game) return;
      await this.closeGame(gameId);
      this.o.log.info('game wake requested', {
        game: gameId,
        port: port.port,
        protocol: port.protocol,
      });
      this.o.emit({ kind: 'game_wake', gameId, port: port.port, protocol: port.protocol });
    });
  }

  private bindError(err: unknown, p: WakePort): ActionError {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE')
      return new ActionError('busy', `port ${p.port}/${p.protocol} is in use`, false);
    if (code === 'EACCES')
      return new ActionError('failed', `port ${p.port}/${p.protocol}: permission denied`, false);
    return new ActionError('failed', `port ${p.port}/${p.protocol}: listen failed`, false);
  }

  private listenTcp(
    gameId: string,
    game: ArmedGame,
    mode: WakeMode,
    p: WakePort,
    motd: string,
  ): Promise<Listener> {
    const sockets = new Set<net.Socket>();
    const timeoutMs = this.o.connectionTimeoutMs ?? WAKE_CONNECTION_TIMEOUT_MS;
    const server = net.createServer({ pauseOnConnect: false, allowHalfOpen: false }, (s) => {
      if (game.woken || sockets.size >= WAKE_MAX_CONNECTIONS) {
        s.destroy();
        return;
      }
      sockets.add(s);
      s.on('error', () => undefined);
      s.on('close', () => {
        sockets.delete(s);
        clearTimeout(timer);
      });
      const timer = setTimeout(() => s.destroy(), timeoutMs);
      timer.unref();
      const java = mode === 'minecraft' ? new JavaConnection(motd) : null;
      s.on('data', (chunk: Buffer) => {
        if (s.destroyed) return;
        if (!java) {
          // raw: the first data byte wakes; nothing is read further or answered.
          s.destroy();
          this.wake(gameId, game, p);
          return;
        }
        let steps: ReturnType<JavaConnection['push']>;
        try {
          steps = java.push(chunk);
        } catch {
          // Defense in depth: a parser error closes this socket, never the agent.
          s.destroy();
          return;
        }
        for (const step of steps) {
          if (step.kind === 'reply') {
            if (step.data.length > 0) s.write(step.data);
            if (step.close) s.end();
          } else if (step.kind === 'wake') {
            s.end(step.data);
            setTimeout(() => s.destroy(), 1000).unref();
            this.wake(gameId, game, p);
          } else if (step.kind === 'close') {
            s.destroy();
          }
          if (step.kind !== 'reply' && step.kind !== 'more') return;
        }
      });
    });
    server.maxConnections = WAKE_MAX_CONNECTIONS;
    return new Promise((resolve, reject) => {
      server.once('error', (err) => reject(this.bindError(err, p)));
      server.listen({ port: p.port, host: this.o.host ?? '0.0.0.0', exclusive: true }, () => {
        server.removeAllListeners('error');
        server.on('error', () => undefined);
        resolve({
          port: p,
          close: () =>
            new Promise<void>((done) => {
              server.close(() => done());
              // Give a disconnect message a moment, then cut everything.
              for (const s of sockets) if (!s.writableEnded) s.destroy();
              setTimeout(() => {
                for (const s of sockets) s.destroy();
              }, 200).unref();
            }),
        });
      });
    });
  }

  private listenUdp(
    gameId: string,
    game: ArmedGame,
    mode: WakeMode,
    p: WakePort,
    motd: string,
  ): Promise<Listener> {
    const host = this.o.host ?? '0.0.0.0';
    const sock = dgram.createSocket({ type: net.isIPv6(host) ? 'udp6' : 'udp4', reuseAddr: false });
    const guid = randomBytes(8).readBigUInt64BE(0);
    let windowStart = 0;
    let pongs = 0;
    sock.on('message', (msg, rinfo) => {
      if (game.woken) return;
      let v: ReturnType<typeof rawUdpVerdict>;
      try {
        v =
          mode === 'minecraft-bedrock'
            ? bedrockVerdict(msg, motd, guid, p.port)
            : rawUdpVerdict(msg);
      } catch {
        return;
      }
      if (v.kind === 'wake') {
        this.wake(gameId, game, p);
      } else if (v.kind === 'reply') {
        const now = Date.now();
        if (now - windowStart >= 1000) {
          windowStart = now;
          pongs = 0;
        }
        if (pongs >= WAKE_MAX_PONGS_PER_SECOND) return;
        pongs += 1;
        sock.send(v.data, rinfo.port, rinfo.address, () => undefined);
      }
    });
    return new Promise((resolve, reject) => {
      sock.once('error', (err) => {
        sock.close();
        reject(this.bindError(err, p));
      });
      sock.bind({ port: p.port, address: host, exclusive: true }, () => {
        sock.removeAllListeners('error');
        sock.on('error', () => undefined);
        resolve({
          port: p,
          close: () =>
            new Promise<void>((done) => {
              try {
                sock.close(() => done());
              } catch {
                done();
              }
            }),
        });
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Actions

interface InspectState {
  State?: { Running?: boolean; Restarting?: boolean } | null;
}

/** True when the container game-<gameId> runs (or restarts). False when missing. */
export async function gameContainerRunning(ctx: ActionContext, gameId: string): Promise<boolean> {
  const docker = ctx.host.docker;
  if (!docker) return false;
  try {
    const info = (await docker.getContainer(`game-${gameId}`).inspect()) as InspectState;
    return info.State?.Running === true || info.State?.Restarting === true;
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return false;
    throw new ActionError('failed', 'docker inspect failed', false);
  }
}

function manager(ctx: ActionContext): WakeManager {
  if (!ctx.wake) throw new ActionError('failed', 'wake listeners are not available', false);
  return ctx.wake;
}

export async function gameWakeArm(
  params: RpcParams<'game.wake.arm'>,
  ctx: ActionContext,
): Promise<GameWakeArmData> {
  const wake = manager(ctx);
  await assertPortsPublished(ctx.homelabRoot, params.gameId, params.ports);
  if (await gameContainerRunning(ctx, params.gameId)) {
    throw new ActionError('busy', 'the game is running', false);
  }
  return wake.arm(params.gameId, params.mode, params.ports, params.motd);
}

export async function gameWakeDisarm(
  params: RpcParams<'game.wake.disarm'>,
  ctx: ActionContext,
): Promise<{ disarmed: true }> {
  if (!GAME_NAME.test(params.gameId)) throw new ActionError('bad_path', 'invalid game name');
  await manager(ctx).disarm(params.gameId);
  return { disarmed: true };
}
