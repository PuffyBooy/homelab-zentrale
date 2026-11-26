import { execFileSync } from 'node:child_process';
import {
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, RpcEnvelope } from '@hz/shared';
import { acquireDirLock } from '../src/actions/dir-lock.js';
import { gameBackupsPurge } from '../src/actions/game-backups-purge.js';
import { Dispatcher } from '../src/actions/index.js';
import { makeCtx } from './game-helpers.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);

let base: string;
let root: string;
let backups: string;
let outside: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hz-purge-')));
  root = path.join(base, 'homelab');
  backups = path.join(root, 'backups');
  outside = path.join(base, 'outside');
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});
beforeEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
  await mkdir(path.join(root, 'games'), { recursive: true });
  await mkdir(outside, { recursive: true });
});

/** Writes a file and sets its mtime `ageDays` before NOW. */
async function file(p: string, ageDays: number, content = 'ZSTD'): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, content);
  const t = new Date(NOW - ageDays * DAY);
  await utimes(p, t, t);
}

const archive = (game: string, stamp: string) =>
  path.join(backups, game, `${game}-${stamp}.tar.zst`);
const exists = (p: string) =>
  lstat(p).then(
    () => true,
    () => false,
  );

function purge(gameId: string, olderThanDays: number) {
  const { ctx } = makeCtx(root);
  return gameBackupsPurge({ gameId, olderThanDays }, ctx, () => NOW);
}

describe('game.backups.purge', () => {
  it('deletes only archives older than N days', async () => {
    await file(archive('mc', '20261001-030000'), 56);
    await file(archive('mc', '20261110-030000'), 16);
    await file(archive('mc', '20261125-030000'), 1);
    await file(archive('mc', '20261126-030000'), 0.2);

    expect(await purge('mc', 14)).toEqual({ removed: 2 });
    expect((await readdir(path.join(backups, 'mc'))).sort()).toEqual([
      'mc-20261125-030000.tar.zst',
      'mc-20261126-030000.tar.zst',
    ]);
  });

  it('removes the backup folder when it ends up empty', async () => {
    await file(archive('mc', '20261001-030000'), 56);
    expect(await purge('mc', 1)).toEqual({ removed: 1 });
    expect(await exists(path.join(backups, 'mc'))).toBe(false);
    expect(await exists(backups)).toBe(true);
  });

  it('keeps the folder when other files remain', async () => {
    await file(archive('mc', '20261001-030000'), 56);
    await file(path.join(backups, 'mc', 'notes.txt'), 56);
    expect(await purge('mc', 1)).toEqual({ removed: 1 });
    expect(await readdir(path.join(backups, 'mc'))).toEqual(['notes.txt']);
  });

  it('does not touch other games, foreign names or temp files of a running backup', async () => {
    await file(archive('mc', '20261001-030000'), 56);
    await file(archive('mc2', '20261001-030000'), 56);
    await file(path.join(backups, 'mc', 'mc2-20261001-030000.tar.zst'), 56);
    await file(path.join(backups, 'mc', '.mc-20261001-030000.tar.zst.deadbeef.partial'), 56);
    await file(path.join(backups, 'mc', 'mc-20261001-030000.tar.zst.bak'), 56);

    expect(await purge('mc', 1)).toEqual({ removed: 1 });
    expect((await readdir(path.join(backups, 'mc'))).sort()).toEqual([
      '.mc-20261001-030000.tar.zst.deadbeef.partial',
      'mc-20261001-030000.tar.zst.bak',
      'mc2-20261001-030000.tar.zst',
    ]);
    expect(await exists(archive('mc2', '20261001-030000'))).toBe(true);
  });

  it('returns 0 when the game has no backups', async () => {
    expect(await purge('mc', 7)).toEqual({ removed: 0 });
    await mkdir(backups);
    expect(await purge('mc', 7)).toEqual({ removed: 0 });
  });

  it('never follows a symlinked archive out of the folder', async () => {
    const target = path.join(outside, 'precious.tar.zst');
    await file(target, 100, 'precious');
    await mkdir(path.join(backups, 'mc'), { recursive: true });
    const link = archive('mc', '20261001-030000');
    await symlink(target, link);
    const t = new Date(NOW - 100 * DAY);
    await lutimes(link, t, t);

    expect(await purge('mc', 1)).toEqual({ removed: 0 });
    expect(await readFile(target, 'utf8')).toBe('precious');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  it('refuses a backup folder that is a symlink to outside', async () => {
    await file(path.join(outside, 'mc-20261001-030000.tar.zst'), 100);
    await mkdir(backups, { recursive: true });
    await symlink(outside, path.join(backups, 'mc'));

    await expect(purge('mc', 1)).rejects.toMatchObject({ code: 'bad_path' });
    expect(await readdir(outside)).toEqual(['mc-20261001-030000.tar.zst']);
  });

  it('refuses a backups root that is a symlink to outside', async () => {
    await file(path.join(outside, 'mc', 'mc-20261001-030000.tar.zst'), 100);
    await symlink(outside, backups);

    await expect(purge('mc', 1)).rejects.toMatchObject({ code: 'bad_path' });
    expect(await exists(path.join(outside, 'mc', 'mc-20261001-030000.tar.zst'))).toBe(true);
  });

  it('refuses a backup "folder" that is a regular file', async () => {
    await file(path.join(backups, 'mc'), 100);
    await expect(purge('mc', 1)).rejects.toMatchObject({ code: 'bad_path' });
    expect(await exists(path.join(backups, 'mc'))).toBe(true);
  });

  it('skips non-regular files: directories and FIFOs with an archive name', async () => {
    const dirLike = archive('mc', '20261001-030000');
    await mkdir(dirLike, { recursive: true });
    await file(path.join(dirLike, 'inner'), 100);
    const t = new Date(NOW - 100 * DAY);
    await utimes(dirLike, t, t);
    const fifo = archive('mc', '20261002-030000');
    execFileSync('mkfifo', [fifo]);
    await utimes(fifo, t, t);

    expect(await purge('mc', 1)).toEqual({ removed: 0 });
    expect((await lstat(dirLike)).isDirectory()).toBe(true);
    expect(await exists(path.join(dirLike, 'inner'))).toBe(true);
    expect((await lstat(fifo)).isFIFO()).toBe(true);
  });

  it('rejects traversal and malformed game ids before touching the disk', async () => {
    await file(path.join(root, 'mc-20261001-030000.tar.zst'), 100);
    for (const id of ['..', '.', '../games', 'mc/../..', '/etc', 'MC', '', 'a', 'mc\0', '-mc']) {
      await expect(purge(id, 1)).rejects.toMatchObject({ code: 'bad_path' });
    }
    expect(await exists(path.join(root, 'mc-20261001-030000.tar.zst'))).toBe(true);
  });

  it('is busy while a backup of the same game runs', async () => {
    await file(archive('mc', '20261001-030000'), 56);
    const release = acquireDirLock(path.join(root, 'games', 'mc'));
    try {
      await expect(purge('mc', 1)).rejects.toMatchObject({ code: 'busy' });
    } finally {
      release();
    }
    expect(await purge('mc', 1)).toEqual({ removed: 1 });
  });
});

describe('game.backups.purge via the dispatcher', () => {
  const rpc = (params: unknown): RpcEnvelope => ({
    type: 'rpc',
    id: 'rpc_purge001',
    action: 'game.backups.purge',
    params,
  });

  function dispatcher() {
    const events: AgentEvent[] = [];
    const { ctx, rec } = makeCtx(root);
    return { d: new Dispatcher(ctx, (e) => events.push(e)), events, rec };
  }

  it('runs a valid request and returns { removed }', async () => {
    await file(archive('mc', '20200101-030000'), 0);
    // Real clock here: make the file really old.
    const t = new Date('2020-01-01T03:00:00Z');
    await utimes(archive('mc', '20200101-030000'), t, t);
    const { d, rec } = dispatcher();
    const r = await d.handle(rpc({ gameId: 'mc', olderThanDays: 30 }));
    expect(r).toEqual({ type: 'rpc.result', id: 'rpc_purge001', ok: true, data: { removed: 1 } });
    expect(rec.runs).toEqual([]);
  });

  it.each([
    [{ gameId: '../mc', olderThanDays: 1 }],
    [{ gameId: 'mc/x', olderThanDays: 1 }],
    [{ gameId: '..', olderThanDays: 1 }],
    [{ gameId: 'mc', olderThanDays: 0 }],
    [{ gameId: 'mc', olderThanDays: 3651 }],
    [{ gameId: 'mc', olderThanDays: 1.5 }],
    [{ gameId: 'mc', olderThanDays: '7' }],
    [{ gameId: 'mc' }],
    [{ gameId: 'mc', olderThanDays: 1, dir: '/opt/homelab/backups' }],
  ])('denies invalid params %j', async (params) => {
    const { d, events } = dispatcher();
    const r = await d.handle(rpc(params));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_params');
    expect(events.map((e) => e.event.kind)).toEqual(['denied']);
  });
});
