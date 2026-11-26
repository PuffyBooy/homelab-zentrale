import net from 'node:net';
import { ActionError } from './types.js';

/**
 * Minimal Source/Minecraft RCON client (TCP, little endian packets:
 * size, id, type, body\0\0).
 *
 * The client of minecraft-server-util is not used: its execute() has no timeout,
 * a failed login leaves the promise pending and packet sizes are not bounded.
 * This one:
 * - connects only to 127.0.0.1 (RCON is published on loopback only),
 * - bounds every packet (MAX_PACKET) and the collected output (maxOutput),
 * - has one deadline for connect + login + command,
 * - detects the end of a (possibly fragmented) response by sending an empty
 *   RESPONSE_VALUE packet right after the command: Minecraft answers it with
 *   "Unknown request 0", Source servers mirror it; both after the command output.
 *   If a server ignores it, a short idle gap after the last fragment ends the read.
 * Error messages never contain the password or the server's output.
 */

const TYPE_AUTH = 3;
const TYPE_EXEC = 2;
const TYPE_AUTH_RESPONSE = 2;
const TYPE_RESPONSE = 0;
/** Body limit of a single packet we accept (Minecraft sends <= 4096, Source <= 4096). */
const MAX_PACKET = 64 * 1024;
const IDLE_END_MS = 300;

export const RCON_HOST = '127.0.0.1';

export interface RconOptions {
  port: number;
  password: string;
  timeoutMs: number;
  /** Max bytes of command output to keep (rest is dropped). Default 64 KiB. */
  maxOutput?: number;
}

interface Packet {
  id: number;
  type: number;
  body: Buffer;
}

export function encodePacket(id: number, type: number, body: string): Buffer {
  const b = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + b.length);
  buf.writeInt32LE(10 + b.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  b.copy(buf, 12);
  // two NUL bytes are already zero
  return buf;
}

class RconSession {
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private waiter: ((p: Packet) => void) | null = null;
  private failure: Error | null = null;
  private onFail: ((e: Error) => void) | null = null;

  constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => this.fail(new ActionError('failed', 'rcon connection failed', false)));
    socket.on('close', () => this.fail(new ActionError('failed', 'rcon connection closed', false)));
  }

  private fail(err: Error): void {
    if (this.failure) return;
    this.failure = err;
    this.onFail?.(err);
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 4) return;
      const size = this.buf.readInt32LE(0);
      if (size < 10 || size > MAX_PACKET + 10) {
        this.fail(new ActionError('failed', 'invalid rcon packet', false));
        this.socket.destroy();
        return;
      }
      if (this.buf.length < 4 + size) return;
      const id = this.buf.readInt32LE(4);
      const type = this.buf.readInt32LE(8);
      // body ends with two NUL bytes
      const body = this.buf.subarray(12, 4 + size - 2);
      this.buf = this.buf.subarray(4 + size);
      this.waiter?.({ id, type, body: Buffer.from(body) });
    }
  }

  /** Waits for packets; `handle` returns true when done. Rejects on failure. */
  read(handle: (p: Packet) => boolean, idleEnd?: () => boolean): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      let idle: NodeJS.Timeout | null = null;
      const done = (err?: Error) => {
        if (idle) clearTimeout(idle);
        this.waiter = null;
        this.onFail = null;
        if (err) reject(err);
        else resolve();
      };
      this.onFail = (err) => {
        // A closed connection after some output still counts as an answer.
        if (idleEnd?.()) done();
        else done(err);
      };
      this.waiter = (p) => {
        try {
          if (handle(p)) {
            done();
            return;
          }
        } catch (err) {
          done(err as Error);
          return;
        }
        if (idleEnd) {
          if (idle) clearTimeout(idle);
          idle = setTimeout(() => {
            if (idleEnd()) done();
          }, IDLE_END_MS);
        }
      };
    });
  }

  send(type: number, body: string): number {
    const id = this.nextId++;
    this.socket.write(encodePacket(id, type, body));
    return id;
  }

  async login(password: string): Promise<void> {
    const id = this.send(TYPE_AUTH, password);
    await this.read((p) => {
      // Source servers send an empty RESPONSE_VALUE before the auth response.
      if (p.type !== TYPE_AUTH_RESPONSE) return false;
      if (p.id === -1) throw new ActionError('failed', 'rcon authentication failed', false);
      return p.id === id;
    });
  }

  async exec(command: string, maxOutput: number): Promise<string> {
    const id = this.send(TYPE_EXEC, command);
    const end = this.send(TYPE_RESPONSE, '');
    const parts: Buffer[] = [];
    let size = 0;
    let got = false;
    await this.read(
      (p) => {
        if (p.id === end) return true;
        if (p.id !== id) return false;
        got = true;
        if (size < maxOutput) {
          const part = p.body.subarray(0, maxOutput - size);
          parts.push(part);
          size += part.length;
        }
        return false;
      },
      () => got,
    );
    return Buffer.concat(parts).toString('utf8');
  }
}

/**
 * Connects to 127.0.0.1:<port>, logs in and runs the commands in order.
 * Returns one output per command. Rejects with ActionError (failed/timeout).
 */
export async function rconRun(opts: RconOptions, commands: readonly string[]): Promise<string[]> {
  for (const c of commands) {
    if (c.length === 0 || /[\r\n\0]/.test(c)) {
      throw new ActionError('invalid_params', 'single line only');
    }
  }
  const maxOutput = opts.maxOutput ?? 64 * 1024;
  const socket = new net.Socket();
  let timer: NodeJS.Timeout | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      socket.destroy();
      reject(new ActionError('timeout', 'rcon timed out', false));
    }, opts.timeoutMs);
  });
  const work = (async () => {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', () =>
        reject(new ActionError('failed', 'rcon connection failed', false)),
      );
      socket.connect({ host: RCON_HOST, port: opts.port });
    });
    const session = new RconSession(socket);
    await session.login(opts.password);
    const out: string[] = [];
    for (const c of commands) out.push(await session.exec(c, maxOutput));
    return out;
  })();
  // Never leave an unhandled rejection behind when the deadline wins.
  work.catch(() => undefined);
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    socket.destroy();
  }
}
