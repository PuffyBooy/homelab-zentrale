import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import type { StreamData, StreamEnd } from '@hz/shared';
import type { Compression } from '../src/actions/game-transfer.js';
import { StreamManager, type TransferOut } from '../src/streams.js';

/** Test helpers for game.export / game.import: frame recorder, tar builder. */

function hasZstd(): boolean {
  const z = zlib as unknown as { zstdCompressSync?: unknown };
  if (typeof z.zstdCompressSync !== 'function') return false;
  try {
    execFileSync('zstd', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** zstd like production when the zstd binary is installed, else gzip. */
export const COMPRESSION: Compression = hasZstd() ? 'zstd' : 'gzip';

export function compress(tar: Buffer): Buffer {
  if (COMPRESSION === 'gzip') return zlib.gzipSync(tar);
  const z = zlib as unknown as { zstdCompressSync: (b: Buffer) => Buffer };
  return z.zstdCompressSync(tar);
}

export type Frame = StreamData | StreamEnd | TransferOut;

export function recordingStreams(): { streams: StreamManager; frames: Frame[] } {
  const frames: Frame[] = [];
  const streams = new StreamManager({
    send: (m) => {
      frames.push(m);
      return true;
    },
    sendTransfer: (m) => {
      frames.push(m);
      return true;
    },
    bufferedAmount: () => 0,
  });
  return { streams, frames };
}

export async function waitFor<T>(fn: () => T | undefined, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function streamEnd(frames: Frame[]): StreamEnd | undefined {
  return frames.find((f): f is StreamEnd => f.type === 'stream.end');
}

export const waitEnd = (frames: Frame[], ms?: number) => waitFor(() => streamEnd(frames), ms);

export function progressText(frames: Frame[]): string {
  return frames
    .filter((f): f is StreamData => f.type === 'stream.data')
    .map((f) => f.chunk)
    .join('');
}

// ---------------------------------------------------------------------------
// Minimal ustar writer, to build archives tar itself would never create.

export interface TarEntry {
  name: string;
  /** ustar typeflag: 0 file, 1 hardlink, 2 symlink, 3 char dev, 4 block dev, 5 dir, 6 fifo, x pax. */
  type: '0' | '1' | '2' | '3' | '4' | '5' | '6' | 'x';
  data?: Buffer | string;
  linkname?: string;
  mode?: number;
}

function octal(n: number, len: number): string {
  return `${n.toString(8).padStart(len - 1, '0')}\0`;
}

function header(e: TarEntry, size: number): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(e.name, 0, 100, 'utf8');
  h.write(octal(e.mode ?? (e.type === '5' ? 0o755 : 0o644), 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(1_700_000_000, 12), 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write(e.type, 156, 'ascii');
  if (e.linkname) h.write(e.linkname, 157, 100, 'utf8');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  if (e.type === '3' || e.type === '4') {
    h.write(octal(1, 8), 329, 'ascii');
    h.write(octal(3, 8), 337, 'ascii');
  }
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}

/** A pax extended header that overrides the next member's path. */
export function paxPath(p: string): TarEntry {
  const body = ` path=${p}\n`;
  let len = body.length + 2;
  while (`${len}${body}`.length !== len) len += 1;
  return { name: 'PaxHeaders/x', type: 'x', data: `${len}${body}` };
}

export function makeTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = typeof e.data === 'string' ? Buffer.from(e.data) : (e.data ?? Buffer.alloc(0));
    parts.push(header(e, data.length));
    if (data.length > 0) {
      parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512, 0));
    }
  }
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}
