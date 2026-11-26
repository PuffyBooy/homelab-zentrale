import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TRANSFER_CHUNK_BYTES,
  TRANSFER_WINDOW,
  type TransferBegin,
  type TransferChunk,
  type TransferEnd,
} from '@hz/shared';
import { isDirLocked } from '../src/actions/dir-lock.js';
import { gameExport } from '../src/actions/game-export.js';
import { IMPORT_RESULT_PREFIX, gameImport } from '../src/actions/game-import.js';
import { exportTarArgs } from '../src/actions/game-transfer.js';
import { Dispatcher } from '../src/actions/index.js';
import { spawnFile } from '../src/exec.js';
import { makeCtx } from './game-helpers.js';
import {
  COMPRESSION,
  progressText,
  recordingStreams,
  streamEnd,
  waitEnd,
  waitFor,
  type Frame,
} from './migrate-helpers.js';

let base: string;
let root: string;
let games: string;
let n = 0;

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hz-export-')));
  root = path.join(base, 'homelab');
  games = path.join(root, 'games');
  await mkdir(games, { recursive: true });
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const nextId = () => `export-${String(++n).padStart(4, '0')}-${randomBytes(3).toString('hex')}`;
const opts = (idleTimeoutMs?: number) => ({
  compression: COMPRESSION,
  ...(idleTimeoutMs ? { idleTimeoutMs } : {}),
});

const chunksIn = (frames: Frame[]) =>
  frames.filter((f): f is TransferChunk => f.type === 'transfer.chunk');
const beginOf = (frames: Frame[]) =>
  frames.find((f): f is TransferBegin => f.type === 'transfer.begin');
const endOf = (frames: Frame[]) => frames.find((f): f is TransferEnd => f.type === 'transfer.end');

async function makeGame(name: string, bigBytes = 0): Promise<string> {
  const dir = path.join(games, name);
  await mkdir(path.join(dir, 'data', 'world', 'region'), { recursive: true });
  await mkdir(path.join(dir, 'data', 'empty'), { recursive: true });
  await writeFile(path.join(dir, 'data', 'world', 'level.dat'), 'level');
  await writeFile(path.join(dir, 'data', 'world', 'region', 'r.0.0.mca'), randomBytes(5000));
  await writeFile(path.join(dir, 'data', 'server.properties'), 'motd=Hallo Wien\n');
  if (bigBytes > 0) await writeFile(path.join(dir, 'data', 'big.bin'), randomBytes(bigBytes));
  await writeFile(path.join(dir, '.env'), 'RCON_PASSWORD=not-for-the-target\n', { mode: 0o600 });
  await writeFile(path.join(dir, 'compose.yml'), 'services: {}\n');
  return dir;
}

function setup() {
  const { streams, frames } = recordingStreams();
  const { ctx } = makeCtx(root, { streams, spawn: spawnFile });
  return { ctx, streams, frames };
}

/** Acks every chunk as it arrives until the stream ends. */
async function ackAll(s: ReturnType<typeof setup>, id: string): Promise<void> {
  let acked = -1;
  while (!streamEnd(s.frames)) {
    const last = chunksIn(s.frames).at(-1);
    if (last && last.seq > acked) {
      acked = last.seq;
      s.streams.deliver({ type: 'transfer.ack', streamId: id, seq: acked });
    }
    await new Promise((r) => setTimeout(r, 2));
  }
}

function archiveOf(frames: Frame[]): Buffer {
  return Buffer.concat(chunksIn(frames).map((c) => Buffer.from(c.data, 'base64')));
}

async function tree(dir: string, rel = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of (await readdir(path.join(dir, rel))).sort()) {
    const p = path.join(rel, name);
    const st = await lstat(path.join(dir, p));
    if (st.isDirectory()) {
      out[`${p}/`] = 'dir';
      Object.assign(out, await tree(dir, p));
    } else {
      out[p] = createHash('sha256')
        .update(await readFile(path.join(dir, p)))
        .digest('hex');
    }
  }
  return out;
}

const backupFiles = async (name: string) =>
  readdir(path.join(root, 'backups', name)).catch(() => [] as string[]);

describe('game.export', () => {
  it('archives only data/, never .env or compose.yml', async () => {
    expect(
      exportTarArgs('/opt/homelab/backups/mc/.export-x.tar.zst', '/opt/homelab/games/mc').slice(-2),
    ).toEqual(['--', 'data']);
    await makeGame('only-data');
    const s = setup();
    const id = nextId();
    await gameExport({ gameId: 'only-data', maxBytes: 1e9 }, s.ctx, id, opts());
    s.streams.activate(id);
    await ackAll(s, id);
    expect(streamEnd(s.frames)).toEqual({ type: 'stream.end', streamId: id, code: 0 });
    const archive = archiveOf(s.frames);
    const file = path.join(base, `${id}.tar`);
    await writeFile(file, archive);
    const flag = COMPRESSION === 'zstd' ? '--zstd' : '--gzip';
    const names = execFileSync('tar', ['--list', flag, '--file', file], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    expect(names.every((m) => m === 'data/' || m.startsWith('data/'))).toBe(true);
    expect(names.some((m) => m.includes('.env') || m.includes('compose.yml'))).toBe(false);
    expect(names).toContain('data/world/level.dat');
    // The secret never travels in any frame.
    expect(JSON.stringify(s.frames)).not.toContain('not-for-the-target');
    expect(archive.toString('latin1')).not.toContain('not-for-the-target');
  });

  it('announces size and sha256 and sends exact chunk sizes', async () => {
    await makeGame('sizes', TRANSFER_CHUNK_BYTES * 3);
    const s = setup();
    const id = nextId();
    await gameExport({ gameId: 'sizes', maxBytes: 1e9 }, s.ctx, id, opts());
    s.streams.activate(id);
    await ackAll(s, id);
    const begin = beginOf(s.frames);
    const archive = archiveOf(s.frames);
    expect(begin?.bytes).toBe(archive.length);
    expect(begin?.sha256).toBe(createHash('sha256').update(archive).digest('hex'));
    const chunks = chunksIn(s.frames);
    expect(begin?.chunks).toBe(chunks.length);
    expect(chunks.map((c) => c.seq)).toEqual([...Array(chunks.length).keys()]);
    for (const c of chunks.slice(0, -1)) {
      expect(Buffer.from(c.data, 'base64').length).toBe(TRANSFER_CHUNK_BYTES);
    }
    expect(endOf(s.frames)).toMatchObject({ bytes: begin?.bytes, sha256: begin?.sha256 });
    // Order: begin, chunks, end, stream.end. Temp file gone, lock free.
    const types = s.frames.map((f) => f.type).filter((t) => t !== 'stream.data');
    expect(types[0]).toBe('transfer.begin');
    expect(types.slice(-2)).toEqual(['transfer.end', 'stream.end']);
    expect(await backupFiles('sizes')).toEqual([]);
    expect(isDirLocked(path.join(games, 'sizes'))).toBe(false);
  });

  it('never has more than TRANSFER_WINDOW unacknowledged chunks in flight', async () => {
    await makeGame('window', TRANSFER_CHUNK_BYTES * (TRANSFER_WINDOW * 2 + 5));
    const s = setup();
    const id = nextId();
    await gameExport({ gameId: 'window', maxBytes: 1e9 }, s.ctx, id, opts());
    s.streams.activate(id);
    await waitFor(() => (chunksIn(s.frames).length >= TRANSFER_WINDOW ? true : undefined));
    await new Promise((r) => setTimeout(r, 300));
    expect(chunksIn(s.frames)).toHaveLength(TRANSFER_WINDOW);

    s.streams.deliver({ type: 'transfer.ack', streamId: id, seq: 9 });
    await waitFor(() => (chunksIn(s.frames).length >= TRANSFER_WINDOW + 10 ? true : undefined));
    await new Promise((r) => setTimeout(r, 200));
    expect(chunksIn(s.frames)).toHaveLength(TRANSFER_WINDOW + 10);
    // No transfer.end before the last chunk is acknowledged.
    expect(endOf(s.frames)).toBeUndefined();

    let acked = 9;
    while (!streamEnd(s.frames)) {
      const sent = chunksIn(s.frames).length;
      expect(sent - (acked + 1)).toBeLessThanOrEqual(TRANSFER_WINDOW);
      if (sent - 1 > acked) {
        acked = Math.min(acked + 3, sent - 1);
        s.streams.deliver({ type: 'transfer.ack', streamId: id, seq: acked });
      }
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(streamEnd(s.frames)?.code).toBe(0);
  });

  it('aborts with too_large above maxBytes and deletes the temp file', async () => {
    await makeGame('too-large', 300_000);
    const s = setup();
    const id = nextId();
    await gameExport({ gameId: 'too-large', maxBytes: 10_000 }, s.ctx, id, opts());
    s.streams.activate(id);
    expect(await waitEnd(s.frames)).toMatchObject({ code: 1, error: 'too_large' });
    expect(beginOf(s.frames)).toBeUndefined();
    expect(await backupFiles('too-large')).toEqual([]);
  });

  it('aborts with timeout when the core stops acknowledging', async () => {
    await makeGame('idle', TRANSFER_CHUNK_BYTES * 2);
    const s = setup();
    const id = nextId();
    await gameExport({ gameId: 'idle', maxBytes: 1e9 }, s.ctx, id, opts(200));
    s.streams.activate(id);
    expect(await waitEnd(s.frames)).toMatchObject({ code: 1, error: 'timeout' });
    expect(await backupFiles('idle')).toEqual([]);
  });

  it('an ack for a chunk that was never sent is a sequence error', async () => {
    await makeGame('bad-ack', TRANSFER_CHUNK_BYTES * 2);
    const s = setup();
    const id = nextId();
    await gameExport({ gameId: 'bad-ack', maxBytes: 1e9 }, s.ctx, id, opts());
    s.streams.activate(id);
    await waitFor(() => beginOf(s.frames));
    s.streams.deliver({ type: 'transfer.ack', streamId: id, seq: 5000 });
    expect(await waitEnd(s.frames)).toMatchObject({ code: 1, error: 'sequence' });
    expect(await backupFiles('bad-ack')).toEqual([]);
  });

  it('stream.cancel stops, deletes the temp file and sends no stream.end', async () => {
    await makeGame('cancel', TRANSFER_CHUNK_BYTES * (TRANSFER_WINDOW + 2));
    const s = setup();
    const id = nextId();
    await gameExport({ gameId: 'cancel', maxBytes: 1e9 }, s.ctx, id, opts());
    s.streams.activate(id);
    await waitFor(() => (chunksIn(s.frames).length > 0 ? true : undefined));
    s.streams.cancel(id);
    await waitFor(() => (isDirLocked(path.join(games, 'cancel')) ? undefined : true));
    expect(streamEnd(s.frames)).toBeUndefined();
    expect(await backupFiles('cancel')).toEqual([]);
  });

  it('fails early with bad_archive when data/ contains a symlink or FIFO', async () => {
    for (const [name, make] of [
      ['has-symlink', (d: string) => symlink('/etc/passwd', path.join(d, 'data', 'link'))],
      ['has-fifo', async (d: string) => execFileSync('mkfifo', [path.join(d, 'data', 'fifo')])],
    ] as const) {
      const dir = await makeGame(name);
      await make(dir);
      const s = setup();
      const id = nextId();
      await gameExport({ gameId: name, maxBytes: 1e9 }, s.ctx, id, opts());
      s.streams.activate(id);
      expect(await waitEnd(s.frames)).toMatchObject({ code: 1, error: 'bad_archive' });
      expect(beginOf(s.frames)).toBeUndefined();
      expect(chunksIn(s.frames)).toHaveLength(0);
      expect(progressText(s.frames)).toMatch(
        /error: archive member rejected: (symlink|other) not allowed/,
      );
      expect(await backupFiles(name)).toEqual([]);
      // The source is untouched.
      expect((await readdir(dir)).sort()).toEqual(['.env', 'compose.yml', 'data']);
    }
  });

  it('refuses symlinked or missing folders before the result', async () => {
    const outside = await realpath(await mkdtemp(path.join(base, 'outside-')));
    await mkdir(path.join(outside, 'data'));
    await symlink(outside, path.join(games, 'linked'));
    const { ctx } = setup();
    await expect(
      gameExport({ gameId: 'linked', maxBytes: 1e9 }, ctx, nextId()),
    ).rejects.toMatchObject({
      code: 'bad_path',
    });
    await mkdir(path.join(games, 'data-link'));
    await symlink(path.join(outside, 'data'), path.join(games, 'data-link', 'data'));
    await expect(
      gameExport({ gameId: 'data-link', maxBytes: 1e9 }, ctx, nextId()),
    ).rejects.toMatchObject({ code: 'bad_path' });
    await expect(
      gameExport({ gameId: 'missing', maxBytes: 1e9 }, ctx, nextId()),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await readdir(outside)).toEqual(['data']);
  });

  it('is allowlisted and dispatched as a stream (no not_allowed placeholder)', async () => {
    await makeGame('dispatch');
    const s = setup();
    const d = new Dispatcher(s.ctx, () => undefined);
    const id = nextId();
    const r = await d.handle({
      type: 'rpc',
      id,
      action: 'game.export',
      params: { gameId: 'dispatch' },
    });
    expect(r).toMatchObject({ ok: true, data: { streamId: id } });
    s.streams.cancel(id);
    const bad = await d.handle({
      type: 'rpc',
      id: nextId(),
      action: 'game.export',
      params: { gameId: '../etc' },
    });
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
  });
});

describe('game.export -> game.import round trip', () => {
  it('produces identical files at the target', async () => {
    const src = await makeGame('round-src', TRANSFER_CHUNK_BYTES * 2 + 123);
    // Source side.
    const a = setup();
    const exportId = nextId();
    await gameExport({ gameId: 'round-src', maxBytes: 1e9 }, a.ctx, exportId, opts());
    a.streams.activate(exportId);
    await ackAll(a, exportId);
    expect(streamEnd(a.frames)?.code).toBe(0);
    const begin = beginOf(a.frames) as TransferBegin;

    // Target side: a different game folder, compose.write already ran.
    await mkdir(path.join(games, 'round-dst'));
    await writeFile(path.join(games, 'round-dst', 'compose.yml'), 'services: {}\n');
    const b = setup();
    const importId = nextId();
    const params = {
      gameId: 'round-dst',
      bytes: begin.bytes,
      sha256: begin.sha256,
      chunks: begin.chunks,
    };
    await gameImport(params, b.ctx, importId, opts());
    b.streams.activate(importId);
    const chunks = chunksIn(a.frames);
    for (const c of chunks) {
      while (c.seq - b.frames.filter((f) => f.type === 'transfer.ack').length >= TRANSFER_WINDOW) {
        await new Promise((r) => setTimeout(r, 2));
      }
      b.streams.deliver({ ...c, streamId: importId });
    }
    const end = endOf(a.frames) as TransferEnd;
    b.streams.deliver({ ...end, streamId: importId });
    expect(await waitEnd(b.frames)).toEqual({ type: 'stream.end', streamId: importId, code: 0 });
    expect(progressText(b.frames)).toContain(IMPORT_RESULT_PREFIX);

    expect(await tree(path.join(games, 'round-dst', 'data'))).toEqual(
      await tree(path.join(src, 'data')),
    );
    expect((await readdir(path.join(games, 'round-dst'))).sort()).toEqual(['compose.yml', 'data']);
    // The source is unchanged.
    expect((await readdir(src)).sort()).toEqual(['.env', 'compose.yml', 'data']);
  });
});
