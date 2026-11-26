import {
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
import { gameRestoreDoneDataSchema, rpcParamsByAction } from '@hz/shared';
import { isDirLocked } from '../src/actions/dir-lock.js';
import {
  BEFORE_RESTORE_DIR,
  RESTORE_RESULT_PREFIX,
  gameRestore,
} from '../src/actions/game-restore.js';
import { cleanupStaleTransfers } from '../src/actions/game-transfer.js';
import { ActionError } from '../src/actions/types.js';
import { spawnFile } from '../src/exec.js';
import type { HostContext } from '../src/host.js';
import { makeCtx } from './game-helpers.js';
import {
  COMPRESSION,
  compress,
  makeTar,
  progressText,
  recordingStreams,
  waitEnd,
  type TarEntry,
} from './migrate-helpers.js';

let base: string;
let root: string;
let games: string;
let backups: string;
let outside: string;
let n = 0;

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hz-restore-')));
  root = path.join(base, 'homelab');
  games = path.join(root, 'games');
  backups = path.join(root, 'backups');
  outside = path.join(base, 'outside');
  await mkdir(games, { recursive: true });
  await mkdir(backups, { recursive: true });
  await mkdir(outside, { recursive: true });
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const okEntries = (level = 'restored'): TarEntry[] => [
  { name: 'data/', type: '5' },
  { name: 'data/world/', type: '5' },
  { name: 'data/world/level.dat', type: '0', data: level },
];

/** A game with data/world/level.dat = "current" and one backup with `entries`. */
async function makeGame(entries: TarEntry[]) {
  const gameId = `game-${++n}`;
  const dir = path.join(games, gameId);
  await mkdir(path.join(dir, 'data', 'world'), { recursive: true });
  await writeFile(path.join(dir, 'data', 'world', 'level.dat'), 'current');
  await mkdir(path.join(backups, gameId), { recursive: true });
  const fileName = `${gameId}-20261126-100000.tar.zst`;
  await writeFile(path.join(backups, gameId, fileName), compress(makeTar(entries)));
  return { gameId, dir, fileName };
}

function dockerRunning(running: () => boolean): HostContext['docker'] {
  return {
    getContainer: () => ({ inspect: async () => ({ State: { Running: running() } }) }),
  } as unknown as HostContext['docker'];
}

function setup(docker: HostContext['docker'] = null) {
  const { streams, frames } = recordingStreams();
  const { ctx } = makeCtx(root, { streams, spawn: spawnFile });
  ctx.host = { ...ctx.host, docker };
  return { ctx, streams, frames };
}

const nextId = () => `restore-${String(++n).padStart(4, '0')}`;

async function run(g: { gameId: string; fileName: string }, docker: HostContext['docker'] = null) {
  const s = setup(docker);
  const id = nextId();
  const res = await gameRestore(g, s.ctx, id, { compression: COMPRESSION });
  expect(res).toEqual({ streamId: id });
  s.streams.activate(id);
  const end = await waitEnd(s.frames);
  return { end, text: progressText(s.frames), id };
}

function rejectsWith(p: Promise<unknown>, code: string) {
  return expect(p).rejects.toSatisfy((e: unknown) => e instanceof ActionError && e.code === code);
}

async function expectUntouched(dir: string, gameId: string) {
  expect(await readFile(path.join(dir, 'data', 'world', 'level.dat'), 'utf8')).toBe('current');
  expect(await readdir(dir)).toEqual(['data']);
  expect((await readdir(games)).filter((f) => f.startsWith('.restore-'))).toEqual([]);
  expect(await readdir(outside)).toEqual([]);
  expect(isDirLocked(dir)).toBe(false);
  expect(gameId).toBeTruthy();
}

describe('game.restore', () => {
  it('restores the backup, keeps the old data once, never starts the game', async () => {
    const g = await makeGame(okEntries());
    const { end, text } = await run(g);
    expect(end).toMatchObject({ code: 0 });
    const last = text.trim().split('\n').at(-1) ?? '';
    expect(last.startsWith(RESTORE_RESULT_PREFIX)).toBe(true);
    expect(
      gameRestoreDoneDataSchema.parse(JSON.parse(last.slice(RESTORE_RESULT_PREFIX.length))),
    ).toEqual({
      entries: 3,
    });
    expect(await readFile(path.join(g.dir, 'data', 'world', 'level.dat'), 'utf8')).toBe('restored');
    expect(await readFile(path.join(g.dir, BEFORE_RESTORE_DIR, 'world', 'level.dat'), 'utf8')).toBe(
      'current',
    );
    // a second restore replaces the kept copy (only one is kept)
    const again = await run(g);
    expect(again.end).toMatchObject({ code: 0 });
    expect(await readFile(path.join(g.dir, BEFORE_RESTORE_DIR, 'world', 'level.dat'), 'utf8')).toBe(
      'restored',
    );
    expect((await readdir(g.dir)).sort()).toEqual([BEFORE_RESTORE_DIR, 'data'].sort());
    expect((await readdir(games)).filter((f) => f.startsWith('.restore-'))).toEqual([]);
    expect(isDirLocked(g.dir)).toBe(false);
  });

  it.each<[string, TarEntry[]]>([
    [
      'a path escape',
      [...okEntries(), { name: 'data/../../../outside/evil', type: '0', data: 'x' }],
    ],
    ['an absolute path', [...okEntries(), { name: '/tmp/evil', type: '0', data: 'x' }]],
    ['a member outside data/', [...okEntries(), { name: 'other/file', type: '0', data: 'x' }]],
    ['a symlink', [...okEntries(), { name: 'data/link', type: '2', linkname: '/etc/passwd' }]],
    ['a hardlink', [...okEntries(), { name: 'data/hard', type: '1', linkname: '/etc/passwd' }]],
    ['a device', [...okEntries(), { name: 'data/dev', type: '3' }]],
  ])('refuses an archive with %s and leaves the old data in place', async (_label, entries) => {
    const g = await makeGame(entries);
    const { end, text } = await run(g);
    expect(end).toMatchObject({ code: 1, error: 'bad_archive' });
    expect(text).toContain('error:');
    await expectUntouched(g.dir, g.gameId);
  });

  it('a broken archive fails and leaves the old data', async () => {
    const g = await makeGame(okEntries());
    await writeFile(path.join(backups, g.gameId, g.fileName), 'not an archive');
    const { end } = await run(g);
    expect(end).toMatchObject({ code: 1 });
    await expectUntouched(g.dir, g.gameId);
  });

  it('is busy while the container runs (before the result and right before the swap)', async () => {
    const g = await makeGame(okEntries());
    const s = setup(dockerRunning(() => true));
    await rejectsWith(gameRestore(g, s.ctx, nextId(), { compression: COMPRESSION }), 'busy');
    await expectUntouched(g.dir, g.gameId);

    // the game starts while the archive is being extracted: nothing is swapped
    let calls = 0;
    const { end } = await run(
      g,
      dockerRunning(() => ++calls > 1),
    );
    expect(end).toMatchObject({ code: 1 });
    await expectUntouched(g.dir, g.gameId);
  });

  it('refuses other games, symlinked backups and odd names', async () => {
    const g = await makeGame(okEntries());
    const h = await makeGame(okEntries());
    const { ctx } = setup();
    // the backup of another game
    await rejectsWith(
      gameRestore({ gameId: g.gameId, fileName: h.fileName }, ctx, nextId()),
      'invalid_params',
    );
    // a symlinked backup file
    await writeFile(path.join(outside, 'x.tar.zst'), compress(makeTar(okEntries())));
    const linkName = `${g.gameId}-20261126-110000.tar.zst`;
    await symlink(path.join(outside, 'x.tar.zst'), path.join(backups, g.gameId, linkName));
    await rejectsWith(
      gameRestore({ gameId: g.gameId, fileName: linkName }, ctx, nextId()),
      'bad_path',
    );
    await rm(path.join(outside, 'x.tar.zst'));
    // missing backup
    await rejectsWith(
      gameRestore(
        { gameId: g.gameId, fileName: `${g.gameId}-20200101-000000.tar.zst` },
        ctx,
        nextId(),
      ),
      'not_found',
    );
    // a symlinked backups/<game> folder
    const k = `game-${++n}`;
    await mkdir(path.join(games, k, 'data'), { recursive: true });
    await symlink(outside, path.join(backups, k));
    await rejectsWith(
      gameRestore({ gameId: k, fileName: `${k}-20261126-100000.tar.zst` }, ctx, nextId()),
      'bad_path',
    );
    // the schema refuses paths in the file name
    const schema = rpcParamsByAction['game.restore'];
    expect(schema.safeParse({ gameId: g.gameId, fileName: `../${g.fileName}` }).success).toBe(
      false,
    );
    expect(schema.safeParse({ gameId: '../x', fileName: g.fileName }).success).toBe(false);
    await expectUntouched(g.dir, g.gameId);
  });

  it('is busy while another action holds the folder lock', async () => {
    const g = await makeGame(okEntries());
    const s = setup();
    const first = nextId();
    await gameRestore(g, s.ctx, first, { compression: COMPRESSION });
    await rejectsWith(gameRestore(g, s.ctx, nextId(), { compression: COMPRESSION }), 'busy');
    s.streams.activate(first);
    await waitEnd(s.frames);
  });

  it('stale restore staging folders are removed on agent start', async () => {
    const stale = path.join(games, '.restore-abcdefgh1234');
    await mkdir(stale);
    await writeFile(path.join(stale, 'x'), 'x');
    expect(await cleanupStaleTransfers(root)).toContain(stale);
  });
});
