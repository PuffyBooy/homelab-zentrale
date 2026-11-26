import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { StreamData, StreamEnd } from '@hz/shared';
import type { ActionContext } from '../src/actions/index.js';
import type { RunOptions, RunResult, Spawner } from '../src/exec.js';
import { createLogger } from '../src/log.js';
import { StreamManager } from '../src/streams.js';

/** Test helpers for the game.* actions: context, fake RCON / query servers on localhost. */

export interface CtxRecord {
  runs: { file: string; args: readonly string[]; opts?: RunOptions }[];
  logs: string[];
  sent: (StreamData | StreamEnd)[];
}

export function makeCtx(
  root: string,
  over: Partial<ActionContext> = {},
  runResult: RunResult = { code: 0, stdout: '', stderr: '' },
): { ctx: ActionContext; rec: CtxRecord } {
  const rec: CtxRecord = { runs: [], logs: [], sent: [] };
  const ctx: ActionContext = {
    name: 'heimserver',
    allowTerminal: false,
    homelabRoot: `${root}/`,
    host: {
      hostProc: '/proc',
      hostRoot: '/nonexistent',
      docker: null,
      exec: async (): Promise<RunResult> => ({ code: 0, stdout: '', stderr: '' }),
    },
    log: createLogger('debug', (line) => rec.logs.push(line)),
    later: () => undefined,
    streams: new StreamManager({
      send: (m) => {
        rec.sent.push(m);
        return true;
      },
      bufferedAmount: () => 0,
    }),
    run: async (file, args, opts): Promise<RunResult> => {
      rec.runs.push(opts ? { file, args, opts } : { file, args });
      return runResult;
    },
    dockerSocket: '/var/run/docker.sock',
    spawn: (() => {
      throw new Error('spawn not expected');
    }) as Spawner,
    dataDir: '/nonexistent-data',
    ...over,
  };
  return { ctx, rec };
}

// ---------------------------------------------------------------------------
// Fake RCON server (Minecraft behaviour).

export interface FakeRcon {
  port: number;
  commands: string[];
  logins: string[];
  close(): Promise<void>;
}

export interface FakeRconOptions {
  password: string;
  /** Answer per command; default echoes "ok: <cmd>". */
  answer?: (cmd: string) => string;
  /** Split answers into packets of this many bytes (Minecraft: 4096). */
  fragment?: number;
  /** Never answer commands (timeout tests). */
  silent?: boolean;
  /** Source servers send an empty RESPONSE_VALUE before the auth response. */
  sourceStyleAuth?: boolean;
}

function packet(id: number, type: number, body: Buffer | string): Buffer {
  const b = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const buf = Buffer.alloc(14 + b.length);
  buf.writeInt32LE(10 + b.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  b.copy(buf, 12);
  return buf;
}

export async function startFakeRcon(opts: FakeRconOptions): Promise<FakeRcon> {
  const commands: string[] = [];
  const logins: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => undefined);
    let buf = Buffer.alloc(0);
    let authed = false;
    s.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const size = buf.readInt32LE(0);
        if (buf.length < 4 + size) return;
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.subarray(12, 4 + size - 2).toString('utf8');
        buf = buf.subarray(4 + size);
        if (type === 3) {
          logins.push(body);
          authed = body === opts.password;
          if (opts.sourceStyleAuth) s.write(packet(id, 0, ''));
          s.write(packet(authed ? id : -1, 2, ''));
        } else if (!authed) {
          s.destroy();
        } else if (type === 2) {
          commands.push(body);
          if (opts.silent) continue;
          const out = Buffer.from(opts.answer ? opts.answer(body) : `ok: ${body}`, 'utf8');
          const step = opts.fragment ?? 4096;
          if (out.length === 0) s.write(packet(id, 0, ''));
          for (let i = 0; i < out.length; i += step)
            s.write(packet(id, 0, out.subarray(i, i + step)));
        } else if (!opts.silent) {
          s.write(packet(id, 0, `Unknown request ${type.toString(16)}`));
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    commands,
    logins,
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

// ---------------------------------------------------------------------------
// Fake Minecraft Java status (server list ping).

function varint(n: number): Buffer {
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

function readVarint(buf: Buffer, off: number): [number, number] | null {
  let n = 0;
  let shift = 0;
  for (let i = off; i < buf.length && i < off + 5; i++) {
    const b = buf[i] as number;
    n |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [n, i + 1 - off];
    shift += 7;
  }
  return null;
}

export async function startFakeJavaStatus(status: unknown): Promise<{
  port: number;
  close(): Promise<void>;
}> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => undefined);
    let buf = Buffer.alloc(0);
    let frames = 0;
    s.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const len = readVarint(buf, 0);
        if (!len || buf.length < len[1] + len[0]) return;
        const frame = buf.subarray(len[1], len[1] + len[0]);
        buf = buf.subarray(len[1] + len[0]);
        frames++;
        const id = frame[0];
        if (frames === 1) continue; // handshake
        if (id === 0) {
          const json = Buffer.from(JSON.stringify(status), 'utf8');
          const payload = Buffer.concat([varint(0), varint(json.length), json]);
          s.write(Buffer.concat([varint(payload.length), payload]));
        } else if (id === 1) {
          s.write(Buffer.concat([varint(frame.length), frame]));
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

// ---------------------------------------------------------------------------
// Fake Palworld REST API (what gamedig's palworld protocol calls).

export async function startFakePalworld(password: string): Promise<{
  port: number;
  auths: string[];
  close(): Promise<void>;
}> {
  const auths: string[] = [];
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    auths.push(auth);
    if (auth !== `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`) {
      res.writeHead(401).end();
      return;
    }
    const body: Record<string, unknown> = {
      '/v1/api/info': { version: 'v0.6.1', servername: 'Homelab' },
      '/v1/api/players': { players: [{ name: '§aMia' }, { name: 'Bob' }] },
      '/v1/api/settings': {},
      '/v1/api/metrics': { currentplayernum: 2, maxplayernum: 16 },
    };
    const data = body[req.url ?? ''];
    if (!data) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    auths,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/** A port on 127.0.0.1 with nothing listening. */
export async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
