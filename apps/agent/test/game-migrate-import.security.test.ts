import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TRANSFER_CHUNK_BYTES,
  TRANSFER_WINDOW,
  gameImportDoneDataSchema,
  type TransferAck,
} from '@hz/shared';
import { isDirLocked } from '../src/actions/dir-lock.js';
import { IMPORT_RESULT_PREFIX, gameImport } from '../src/actions/game-import.js';
import {
  cleanupStaleTransfers,
  extractTarArgs,
  listTarArgs,
  parseListLine,
  unquoteC,
  verifyExtractedTree,
} from '../src/actions/game-transfer.js';
import { ActionError } from '../src/actions/types.js';
import { spawnFile } from '../src/exec.js';
import { makeCtx } from './game-helpers.js';
import {
  COMPRESSION,
  compress,
  makeTar,
  paxPath,
  progressText,
  recordingStreams,
  waitEnd,
  type Frame,
  type TarEntry,
} from './migrate-helpers.js';

let base: string;
let root: string;
let games: string;
let outside: string;
let n = 0;

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hz-import-')));
  root = path.join(base, 'homelab');
  games = path.join(root, 'games');
  outside = path.join(base, 'outside');
  await mkdir(games, { recursive: true });
  await mkdir(outside, { recursive: true });
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const nextId = () => `import-${String(++n).padStart(4, '0')}-${randomBytes(3).toString('hex')}`;
const nextGame = () => `game-${n + 1}`;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const chunksOf = (bytes: number) => Math.ceil(bytes / TRANSFER_CHUNK_BYTES);

function setup() {
  const { streams, frames } = recordingStreams();
  const { ctx } = makeCtx(root, { streams, spawn: spawnFile });
  return { ctx, streams, frames };
}

const acksOf = (frames: Frame[]) =>
  frames.filter((f): f is TransferAck => f.type === 'transfer.ack');

/** Starts game.import for `archive` and returns the helpers to feed it. */
async function start(
  archive: Buffer,
  over: {
    gameId?: string;
    idleTimeoutMs?: number;
    bytes?: number;
    sha256?: string;
    chown?: (p: string, uid: number, gid: number) => Promise<void>;
  } = {},
) {
  const s = setup();
  const id = nextId();
  const gameId = over.gameId ?? nextGame();
  const bytes = over.bytes ?? archive.length;
  const params = { gameId, bytes, sha256: over.sha256 ?? sha(archive), chunks: chunksOf(bytes) };
  const res = await gameImport(params, s.ctx, id, {
    compression: COMPRESSION,
    ...(over.idleTimeoutMs ? { idleTimeoutMs: over.idleTimeoutMs } : {}),
    ...(over.chown ? { chown: over.chown } : {}),
  });
  expect(res).toEqual({ streamId: id });
  s.streams.activate(id);
  const staging = path.join(games, `.import-${id}`);
  const chunk = (seq: number, data: Buffer) =>
    s.streams.deliver({ type: 'transfer.chunk', streamId: id, seq, data: data.toString('base64') });
  /** Sends every chunk (respecting the window) and transfer.end. */
  const sendAll = async (end = { chunks: params.chunks, bytes, sha256: params.sha256 }) => {
    for (let seq = 0; seq < params.chunks; seq++) {
      while (seq - (acksOf(s.frames).length - 1) - 1 >= TRANSFER_WINDOW) {
        await new Promise((r) => setTimeout(r, 2));
      }
      chunk(seq, archive.subarray(seq * TRANSFER_CHUNK_BYTES, (seq + 1) * TRANSFER_CHUNK_BYTES));
    }
    s.streams.deliver({ type: 'transfer.end', streamId: id, ...end });
  };
  return { ...s, id, gameId, params, staging, chunk, sendAll };
}

async function expectClean(gameId: string, staging: string) {
  expect(await lstat(staging).catch(() => null)).toBeNull();
  expect(await lstat(path.join(games, gameId, 'data')).catch(() => null)).toBeNull();
  expect(await readdir(outside)).toEqual([]);
  expect((await readdir(games)).filter((f) => f.startsWith('.import-'))).toEqual([]);
  expect(isDirLocked(path.join(games, gameId))).toBe(false);
}

const okTar = (extra: TarEntry[] = []) =>
  compress(
    makeTar([
      { name: 'data/', type: '5' },
      { name: 'data/world/', type: '5' },
      { name: 'data/world/level.dat', type: '0', data: 'level' },
      ...extra,
    ]),
  );

describe('game.import listing parser', () => {
  it('parses files, dirs and C-quoted names', () => {
    expect(parseListLine('-rw-r--r-- 0/0   12 2024-01-01 10:00 "data/a b"')).toEqual({
      path: 'data/a b',
      kind: 'file',
      size: 12,
    });
    expect(parseListLine('drwxr-xr-x 0/0 0 2024-01-01 10:00 "data/"')?.kind).toBe('dir');
    expect(parseListLine('lrwxrwxrwx 0/0 0 2024-01-01 10:00 "data/s" -> "/etc"')?.kind).toBe(
      'symlink',
    );
    expect(parseListLine('hrw-r--r-- 0/0 0 2024-01-01 10:00 "data/h" link to "data/a"')?.kind).toBe(
      'hardlink',
    );
    expect(parseListLine('crw-r--r-- 0/0 1,3 2024-01-01 10:00 "data/null"')?.kind).toBe('other');
    expect(parseListLine('prw-r--r-- 0/0 0 2024-01-01 10:00 "data/fifo"')?.kind).toBe('other');
    // A file whose name looks like a symlink arrow stays one quoted name.
    expect(parseListLine('-rw-r--r-- 0/0 1 2024-01-01 10:00 "data/x -> y"')?.path).toBe(
      'data/x -> y',
    );
    expect(parseListLine('garbage')).toBeNull();
  });

  it('decodes escapes and rejects malformed or invalid UTF-8 names', () => {
    expect(unquoteC('data/\\303\\274mlaut')).toBe('data/ümlaut');
    expect(unquoteC('data/n\\nl\\"q\\\\b')).toBe('data/n\nl"q\\b');
    expect(unquoteC('data/\\377')).toBeNull();
    expect(unquoteC('data/\\')).toBeNull();
    expect(unquoteC('data/\\z')).toBeNull();
  });

  it('uses fixed, safe tar arguments', () => {
    const x = extractTarArgs(
      '/opt/homelab/games/.import-abcdefgh/archive',
      '/opt/homelab/games/.import-abcdefgh',
    );
    for (const flag of ['--no-same-owner', '--no-same-permissions', '--keep-old-files']) {
      expect(x).toContain(flag);
    }
    expect(x).not.toContain('--absolute-names');
    expect(x.slice(-2)).toEqual(['--', 'data']);
    expect(listTarArgs('/a/archive')).toContain('--absolute-names');
    expect(() => listTarArgs('relative')).toThrow(ActionError);
  });
});

describe('game.import refusals before the result', () => {
  it('is busy when data/ exists, and leaves it alone', async () => {
    const gameId = 'has-data';
    await mkdir(path.join(games, gameId, 'data'), { recursive: true });
    await writeFile(path.join(games, gameId, 'data', 'keep'), 'old');
    const { ctx } = setup();
    const archive = okTar();
    const p = { gameId, bytes: archive.length, sha256: sha(archive), chunks: 1 };
    await expect(gameImport(p, ctx, nextId())).rejects.toMatchObject({ code: 'busy' });
    expect(await readdir(path.join(games, gameId, 'data'))).toEqual(['keep']);
    expect((await readdir(games)).filter((f) => f.startsWith('.import-'))).toEqual([]);
  });

  it('is busy while another import for the game runs', async () => {
    const archive = okTar();
    const first = await start(archive, { gameId: 'twice' });
    const { ctx } = setup();
    const p = { gameId: 'twice', bytes: archive.length, sha256: sha(archive), chunks: 1 };
    await expect(gameImport(p, ctx, nextId())).rejects.toMatchObject({ code: 'busy' });
    first.streams.cancel(first.id);
    await new Promise((r) => setTimeout(r, 50));
    await expectClean('twice', first.staging);
  });

  it('refuses a game folder that is a symlink (bad_path)', async () => {
    await symlink(outside, path.join(games, 'linked'));
    const { ctx } = setup();
    const archive = okTar();
    const p = { gameId: 'linked', bytes: archive.length, sha256: sha(archive), chunks: 1 };
    await expect(gameImport(p, ctx, nextId())).rejects.toMatchObject({ code: 'bad_path' });
    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses a chunk count that does not match the size', async () => {
    const { ctx } = setup();
    const p = { gameId: 'count', bytes: 10, sha256: 'a'.repeat(64), chunks: 2 };
    await expect(gameImport(p, ctx, nextId())).rejects.toMatchObject({ code: 'invalid_params' });
  });
});

describe('game.import transfer checks', () => {
  it('rejects a sequence gap with `sequence` and cleans up', async () => {
    const archive = Buffer.concat([okTar(), randomBytes(TRANSFER_CHUNK_BYTES * 2)]);
    const t = await start(archive);
    t.chunk(0, archive.subarray(0, TRANSFER_CHUNK_BYTES));
    t.chunk(2, archive.subarray(2 * TRANSFER_CHUNK_BYTES, 3 * TRANSFER_CHUNK_BYTES));
    expect(await waitEnd(t.frames)).toMatchObject({ code: 1, error: 'sequence' });
    await expectClean(t.gameId, t.staging);
  });

  it('rejects a duplicate chunk and a chunk with the wrong size', async () => {
    const archive = Buffer.concat([okTar(), randomBytes(TRANSFER_CHUNK_BYTES * 2)]);
    const a = await start(archive);
    a.chunk(0, archive.subarray(0, TRANSFER_CHUNK_BYTES));
    a.chunk(0, archive.subarray(0, TRANSFER_CHUNK_BYTES));
    expect(await waitEnd(a.frames)).toMatchObject({ error: 'sequence' });
    await expectClean(a.gameId, a.staging);

    const b = await start(archive);
    b.chunk(0, archive.subarray(0, 100));
    expect(await waitEnd(b.frames)).toMatchObject({ error: 'sequence' });
    await expectClean(b.gameId, b.staging);
  });

  it('rejects more than TRANSFER_WINDOW unacknowledged chunks', async () => {
    const archive = randomBytes(TRANSFER_CHUNK_BYTES * (TRANSFER_WINDOW + 4));
    const t = await start(archive);
    // Synchronously, before any write completed: nothing is acked yet.
    for (let seq = 0; seq <= TRANSFER_WINDOW; seq++) {
      t.chunk(seq, archive.subarray(seq * TRANSFER_CHUNK_BYTES, (seq + 1) * TRANSFER_CHUNK_BYTES));
    }
    expect(await waitEnd(t.frames)).toMatchObject({ error: 'sequence' });
    await expectClean(t.gameId, t.staging);
  });

  it('acks every chunk in order', async () => {
    const archive = Buffer.concat([okTar(), randomBytes(TRANSFER_CHUNK_BYTES * 3)]);
    const t = await start(archive);
    await t.sendAll();
    await waitEnd(t.frames);
    expect(acksOf(t.frames).map((a) => a.seq)).toEqual([...Array(t.params.chunks).keys()]);
  });

  it('a checksum mismatch ends with checksum_mismatch and deletes staging', async () => {
    const archive = okTar();
    const t = await start(archive, { sha256: sha(Buffer.from('other')) });
    await t.sendAll();
    expect(await waitEnd(t.frames)).toMatchObject({ code: 1, error: 'checksum_mismatch' });
    await expectClean(t.gameId, t.staging);
  });

  it('a transfer.end that differs from the request is a checksum_mismatch', async () => {
    const archive = okTar();
    const t = await start(archive);
    await t.sendAll({ chunks: t.params.chunks, bytes: t.params.bytes, sha256: 'b'.repeat(64) });
    expect(await waitEnd(t.frames)).toMatchObject({ error: 'checksum_mismatch' });
    await expectClean(t.gameId, t.staging);
  });

  it('transfer.end before all chunks is a sequence error', async () => {
    const archive = Buffer.concat([okTar(), randomBytes(TRANSFER_CHUNK_BYTES)]);
    const t = await start(archive);
    t.chunk(0, archive.subarray(0, TRANSFER_CHUNK_BYTES));
    t.streams.deliver({
      type: 'transfer.end',
      streamId: t.id,
      chunks: t.params.chunks,
      bytes: t.params.bytes,
      sha256: t.params.sha256,
    });
    expect(await waitEnd(t.frames)).toMatchObject({ error: 'sequence' });
    await expectClean(t.gameId, t.staging);
  });

  it('times out without data and cleans up', async () => {
    const t = await start(okTar(), { idleTimeoutMs: 150 });
    expect(await waitEnd(t.frames)).toMatchObject({ code: 1, error: 'timeout' });
    await expectClean(t.gameId, t.staging);
  });

  it('stream.cancel deletes the staging folder without a stream.end', async () => {
    const archive = Buffer.concat([okTar(), randomBytes(TRANSFER_CHUNK_BYTES)]);
    const t = await start(archive);
    t.chunk(0, archive.subarray(0, TRANSFER_CHUNK_BYTES));
    t.streams.cancel(t.id);
    await new Promise((r) => setTimeout(r, 100));
    expect(t.frames.find((f) => f.type === 'stream.end')).toBeUndefined();
    await expectClean(t.gameId, t.staging);
  });
});

describe('game.import archive member checks', () => {
  const bad: [string, TarEntry[]][] = [
    ['parent traversal', [{ name: 'data/../../outside/evil', type: '0', data: 'x' }]],
    ['leading ..', [{ name: '../outside/evil', type: '0', data: 'x' }]],
    ['absolute path', [{ name: `${'/'}tmp/hz-evil-${process.pid}`, type: '0', data: 'x' }]],
    ['absolute data path', [{ name: '/data/evil', type: '0', data: 'x' }]],
    ['outside data/', [{ name: 'compose.yml', type: '0', data: 'x' }]],
    ['./ prefix', [{ name: './data/evil', type: '0', data: 'x' }]],
    ['symlink', [{ name: 'data/link', type: '2', linkname: outsideLink() }]],
    ['relative symlink', [{ name: 'data/link', type: '2', linkname: '../../..' }]],
    ['hardlink', [{ name: 'data/hard', type: '1', linkname: 'data/world/level.dat' }]],
    ['char device', [{ name: 'data/null', type: '3' }]],
    ['block device', [{ name: 'data/disk', type: '4' }]],
    ['fifo', [{ name: 'data/fifo', type: '6' }]],
    ['control character', [{ name: 'data/a\nb', type: '0', data: 'x' }]],
    ['pax path override', [paxPath('../outside/evil'), { name: 'data/ok', type: '0', data: 'x' }]],
    ['data as a file', [{ name: 'data', type: '0', data: 'x' }]],
  ];

  function outsideLink(): string {
    return '/etc';
  }

  for (const [label, entries] of bad) {
    it(`rejects ${label} with bad_archive and writes nothing`, async () => {
      const archive = compress(makeTar([{ name: 'data/', type: '5' }, ...entries]));
      const t = await start(archive);
      await t.sendAll();
      const end = await waitEnd(t.frames);
      expect(end).toMatchObject({ code: 1, error: 'bad_archive' });
      // Refused by the listing check, before tar extracted anything.
      expect(progressText(t.frames)).toContain('error: archive member rejected');
      expect(progressText(t.frames)).not.toContain('archive checked');
      expect(progressText(t.frames)).not.toContain(IMPORT_RESULT_PREFIX);
      await expectClean(t.gameId, t.staging);
      expect(await lstat(`/tmp/hz-evil-${process.pid}`).catch(() => null)).toBeNull();
    });
  }

  it('rejects a duplicate member at extraction (no overwrite)', async () => {
    const archive = okTar([{ name: 'data/world/level.dat', type: '0', data: 'evil' }]);
    const t = await start(archive);
    await t.sendAll();
    expect(await waitEnd(t.frames)).toMatchObject({ error: 'bad_archive' });
    await expectClean(t.gameId, t.staging);
  });

  it('rejects an empty archive and garbage that is not an archive', async () => {
    const a = await start(compress(makeTar([])));
    await a.sendAll();
    expect(await waitEnd(a.frames)).toMatchObject({ error: 'bad_archive' });
    await expectClean(a.gameId, a.staging);

    const b = await start(randomBytes(5000));
    await b.sendAll();
    expect(await waitEnd(b.frames)).toMatchObject({ error: 'bad_archive' });
    await expectClean(b.gameId, b.staging);
  });

  it('imports a good archive: files only, no special bits, result line', async () => {
    const gameId = 'good-import';
    await mkdir(path.join(games, gameId));
    await writeFile(path.join(games, gameId, 'compose.yml'), 'services: {}\n');
    const archive = okTar([{ name: 'data/suid', type: '0', data: 'x', mode: 0o4755 }]);
    const t = await start(archive, { gameId });
    await t.sendAll();
    expect(await waitEnd(t.frames)).toEqual({ type: 'stream.end', streamId: t.id, code: 0 });
    const line = progressText(t.frames)
      .split('\n')
      .find((l) => l.startsWith(IMPORT_RESULT_PREFIX));
    const result = gameImportDoneDataSchema.parse(
      JSON.parse((line ?? '').slice(IMPORT_RESULT_PREFIX.length)),
    );
    expect(result).toEqual({ bytes: archive.length, sha256: sha(archive), entries: 4 });
    const suid = await lstat(path.join(games, gameId, 'data', 'suid'));
    expect(suid.mode & 0o7000).toBe(0);
    expect((await readdir(path.join(games, gameId))).sort()).toEqual(['compose.yml', 'data']);
    expect(await lstat(t.staging).catch(() => null)).toBeNull();
    expect(isDirLocked(path.join(games, gameId))).toBe(false);
  });
});

describe('cleanupStaleTransfers', () => {
  it('removes staging folders and export temp files, nothing else', async () => {
    const r = await realpath(await mkdtemp(path.join(base, 'stale-')));
    await mkdir(path.join(r, 'games', '.import-abcdefgh12', 'data'), { recursive: true });
    await mkdir(path.join(r, 'games', 'mc', 'data'), { recursive: true });
    await mkdir(path.join(r, 'backups', 'mc'), { recursive: true });
    await writeFile(path.join(r, 'backups', 'mc', '.export-abcdefgh12.tar.zst'), 'x');
    await writeFile(path.join(r, 'backups', 'mc', 'mc-20240101-000000.tar.zst'), 'x');
    await symlink(outside, path.join(r, 'games', '.import-linklinklink'));
    const removed = await cleanupStaleTransfers(r);
    expect(removed.sort()).toEqual(
      [
        path.join(r, 'backups', 'mc', '.export-abcdefgh12.tar.zst'),
        path.join(r, 'games', '.import-abcdefgh12'),
      ].sort(),
    );
    expect(await readdir(path.join(r, 'backups', 'mc'))).toEqual(['mc-20240101-000000.tar.zst']);
    expect(await readdir(path.join(r, 'games', 'mc'))).toEqual(['data']);
  });
});

describe('game.import ownership', () => {
  it('verifyExtractedTree chowns every entry, only below the data folder', async () => {
    // Works without root: the owner is passed in, the chown is a mock.
    const root = await mkdtemp(path.join(os.tmpdir(), 'hz-tree-'));
    const dataDir = path.join(root, 'data');
    await mkdir(path.join(dataDir, 'world'), { recursive: true });
    await writeFile(path.join(dataDir, 'world', 'level.dat'), 'x');
    await writeFile(path.join(root, 'outside.txt'), 'x');
    const st = await lstat(dataDir);
    const want = { uid: st.uid + 1000, gid: st.gid + 1000 };
    const calls: [string, number, number][] = [];
    const n = await verifyExtractedTree(dataDir, {
      ...want,
      chown: async (p, uid, gid) => {
        calls.push([p, uid, gid]);
      },
    });
    expect(n).toBe(3);
    expect(calls.map((c) => c[0]).sort()).toEqual(
      [dataDir, path.join(dataDir, 'world'), path.join(dataDir, 'world', 'level.dat')].sort(),
    );
    for (const [, uid, gid] of calls) expect([uid, gid]).toEqual([want.uid, want.gid]);
    await rm(root, { recursive: true, force: true });
  });

  // Changing a folder's owner needs root; as non-root the test above covers the walk.
  const isRootUser = typeof process.getuid === 'function' && process.getuid() === 0;
  it.runIf(isRootUser)(
    'gives every extracted entry the uid:gid of the game folder, only below staging/data',
    async () => {
      const gameId = 'owned';
      await mkdir(path.join(games, gameId));
      const owner = await lstat(path.join(games, gameId));
      // Pretend the folder belongs to the game user: the mock sees the wanted owner.
      const calls: [string, number, number][] = [];
      const want = { uid: owner.uid + 1000, gid: owner.gid + 1000 };
      const { chown: realChown } = await import('node:fs/promises');
      await realChown(path.join(games, gameId), want.uid, want.gid);
      const archive = okTar([{ name: 'data/world/region/', type: '5' }]);
      const t = await start(archive, {
        gameId,
        chown: async (p, uid, gid) => {
          calls.push([p, uid, gid]);
        },
      });
      await t.sendAll();
      expect(await waitEnd(t.frames)).toMatchObject({ code: 0 });
      const stagedData = path.join(t.staging, 'data');
      expect(calls.map((c) => c[0]).sort()).toEqual(
        [
          stagedData,
          path.join(stagedData, 'world'),
          path.join(stagedData, 'world', 'level.dat'),
          path.join(stagedData, 'world', 'region'),
        ].sort(),
      );
      for (const [p, uid, gid] of calls) {
        expect(p === stagedData || p.startsWith(`${stagedData}/`)).toBe(true);
        expect([uid, gid]).toEqual([want.uid, want.gid]);
      }
    },
  );

  it('with the real lchown the files end up owned by the folder owner', async () => {
    const gameId = 'owned-real';
    await mkdir(path.join(games, gameId));
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    const { chown: realChown } = await import('node:fs/promises');
    if (isRoot) await realChown(path.join(games, gameId), 1000, 1000);
    const want = await lstat(path.join(games, gameId));
    const t = await start(okTar(), { gameId });
    await t.sendAll();
    expect(await waitEnd(t.frames)).toMatchObject({ code: 0 });
    const f = await lstat(path.join(games, gameId, 'data', 'world', 'level.dat'));
    expect([f.uid, f.gid]).toEqual([want.uid, want.gid]);
  });

  it('removes a game folder it created when the import fails', async () => {
    const t = await start(
      compress(
        makeTar([
          { name: 'data/', type: '5' },
          { name: 'data/x', type: '0', data: 'x' },
          { name: 'data/x', type: '0', data: 'y' },
        ]),
      ),
    );
    await t.sendAll();
    expect(await waitEnd(t.frames)).toMatchObject({ code: 1 });
    expect(await lstat(path.join(games, t.gameId)).catch(() => null)).toBeNull();
  });
});
