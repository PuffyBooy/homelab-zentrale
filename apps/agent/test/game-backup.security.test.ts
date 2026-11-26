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
import type { StreamData, StreamEnd } from '@hz/shared';
import {
  applyRetention,
  BACKUP_RESULT_PREFIX,
  backupStamp,
  gameBackup,
  tarArgs,
} from '../src/actions/game-backup.js';
import { isDirLocked } from '../src/actions/dir-lock.js';
import { spawnFile, type SpawnResult, type Spawner } from '../src/exec.js';
import type { HostContext } from '../src/host.js';
import { makeCtx, startFakeRcon } from './game-helpers.js';

const PASSWORD = 'Backup-Rcon-Secret-0815-abc';

let base: string;
let root: string;
let games: string;
let outside: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hz-backup-')));
  root = path.join(base, 'homelab');
  games = path.join(root, 'games');
  outside = path.join(base, 'outside');
  await mkdir(games, { recursive: true });
  await mkdir(outside, { recursive: true });
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

async function makeGame(name: string, env?: string): Promise<string> {
  const dir = path.join(games, name);
  await mkdir(path.join(dir, 'data', 'world'), { recursive: true });
  await writeFile(path.join(dir, 'data', 'world', 'level.dat'), 'level');
  if (env !== undefined) await writeFile(path.join(dir, '.env'), env, { mode: 0o600 });
  return dir;
}

interface SpawnCall {
  file: string;
  args: readonly string[];
}

/** Pretends to be tar: writes a fake archive to the --file argument. */
function fakeTar(calls: SpawnCall[], result: SpawnResult = { code: 0 }): Spawner {
  return (file, args, cb) => {
    calls.push({ file, args });
    const archive = args[args.indexOf('--file') + 1] as string;
    const done = (async () => {
      if (result.code === 0 || result.code === 1) await writeFile(archive, 'ZSTD-ARCHIVE');
      cb.onStderr(Buffer.from('tar: some note\n'));
      return result;
    })();
    return { done, kill: () => undefined, pause: () => undefined, resume: () => undefined };
  };
}

async function waitEnd(sent: (StreamData | StreamEnd)[]): Promise<StreamEnd> {
  for (let i = 0; i < 400; i++) {
    const end = sent.find((m): m is StreamEnd => m.type === 'stream.end');
    if (end) return end;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('stream did not end');
}

const progressText = (sent: (StreamData | StreamEnd)[]) =>
  sent
    .filter((m): m is StreamData => m.type === 'stream.data')
    .map((m) => m.chunk)
    .join('');

function resultOf(sent: (StreamData | StreamEnd)[]): { path: string; sizeBytes: number } {
  const line = progressText(sent)
    .split('\n')
    .find((l) => l.startsWith(BACKUP_RESULT_PREFIX));
  if (!line) throw new Error('no result line');
  return JSON.parse(line.slice(BACKUP_RESULT_PREFIX.length)) as {
    path: string;
    sizeBytes: number;
  };
}

describe('game.backup', () => {
  it('uses fixed tar arguments with absolute paths', () => {
    expect(tarArgs('/opt/homelab/backups/mc/a.tar.zst', '/opt/homelab/games/mc')).toEqual([
      '--create',
      '--zstd',
      '--force-local',
      '--one-file-system',
      '--warning=no-file-changed',
      '--file',
      '/opt/homelab/backups/mc/a.tar.zst',
      '--directory',
      '/opt/homelab/games/mc',
      '--',
      'data',
    ]);
    expect(() => tarArgs('x.tar.zst', '/opt/homelab/games/mc')).toThrow();
    expect(backupStamp(new Date('2026-11-26T08:05:09Z'))).toBe('20261126-080509');
  });

  it('writes <name>-<stamp>.tar.zst under backups/<name>/ and reports path and size', async () => {
    const dir = await makeGame('mc');
    const calls: SpawnCall[] = [];
    const { ctx, rec } = makeCtx(root, { spawn: fakeTar(calls) });
    const res = await gameBackup(
      { gameDir: dir, keep: 7 },
      ctx,
      'rpc_backup0001',
      () => new Date('2026-11-26T10:00:00Z'),
    );
    expect(res).toEqual({ streamId: 'rpc_backup0001' });
    expect(isDirLocked(dir)).toBe(true);
    ctx.streams.activate('rpc_backup0001');
    const end = await waitEnd(rec.sent);
    expect(end).toMatchObject({ code: 0 });
    expect(isDirLocked(dir)).toBe(false);
    const expected = path.join(root, 'backups', 'mc', 'mc-20261126-100000.tar.zst');
    expect(resultOf(rec.sent)).toEqual({ path: expected, sizeBytes: 12 });
    expect(await readFile(expected, 'utf8')).toBe('ZSTD-ARCHIVE');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe('tar');
    expect(calls[0]?.args.at(-1)).toBe('data');
    expect(calls[0]?.args[calls[0].args.indexOf('--directory') + 1]).toBe(dir);
    // the temp file was renamed, nothing else is left behind
    expect(await readdir(path.join(root, 'backups', 'mc'))).toEqual(['mc-20261126-100000.tar.zst']);
  });

  it('keeps only the newest `keep` backups', async () => {
    const dir = await makeGame('keep');
    const bdir = path.join(root, 'backups', 'keep');
    await mkdir(bdir, { recursive: true });
    for (const d of ['20261101', '20261102', '20261103', '20261104']) {
      await writeFile(path.join(bdir, `keep-${d}-120000.tar.zst`), 'old');
    }
    await writeFile(path.join(bdir, 'notes.txt'), 'keep me');
    await writeFile(path.join(bdir, 'other-20261101-120000.tar.zst'), 'not mine');
    const { ctx, rec } = makeCtx(root, { spawn: fakeTar([]) });
    await gameBackup(
      { gameDir: dir, keep: 2 },
      ctx,
      'rpc_backup0002',
      () => new Date('2026-11-26T10:00:00Z'),
    );
    ctx.streams.activate('rpc_backup0002');
    expect(await waitEnd(rec.sent)).toMatchObject({ code: 0 });
    expect((await readdir(bdir)).sort()).toEqual([
      'keep-20261104-120000.tar.zst',
      'keep-20261126-100000.tar.zst',
      'notes.txt',
      'other-20261101-120000.tar.zst',
    ]);
    expect(progressText(rec.sent)).toContain('removed 3 old backup(s)');
  });

  it('retention never follows a symlink and skips directories', async () => {
    const bdir = path.join(base, 'ret');
    await mkdir(bdir);
    const victim = path.join(outside, 'victim.txt');
    await writeFile(victim, 'precious');
    await symlink(victim, path.join(bdir, 'r1-20200101-000000.tar.zst'));
    await mkdir(path.join(bdir, 'r1-20200102-000000.tar.zst'));
    await writeFile(path.join(bdir, 'r1-20200103-000000.tar.zst'), 'x');
    await applyRetention(bdir, 'r1', 1);
    expect(await readFile(victim, 'utf8')).toBe('precious');
    expect((await readdir(bdir)).sort()).toEqual([
      'r1-20200102-000000.tar.zst',
      'r1-20200103-000000.tar.zst',
    ]);
  });

  it('refuses a backups folder that is a symlink (path stays under backups/<name>)', async () => {
    const r2 = path.join(base, 'homelab2');
    await mkdir(path.join(r2, 'games', 'mc', 'data'), { recursive: true });
    await symlink(outside, path.join(r2, 'backups'));
    const { ctx } = makeCtx(r2, { spawn: fakeTar([]) });
    await expect(
      gameBackup({ gameDir: path.join(r2, 'games', 'mc'), keep: 7 }, ctx, 'rpc_backup0003'),
    ).rejects.toMatchObject({ code: 'bad_path' });

    const r3 = path.join(base, 'homelab3');
    await mkdir(path.join(r3, 'games', 'mc', 'data'), { recursive: true });
    await mkdir(path.join(r3, 'backups'), { recursive: true });
    await symlink(outside, path.join(r3, 'backups', 'mc'));
    const c3 = makeCtx(r3, { spawn: fakeTar([]) });
    await expect(
      gameBackup({ gameDir: path.join(r3, 'games', 'mc'), keep: 7 }, c3.ctx, 'rpc_backup0004'),
    ).rejects.toMatchObject({ code: 'bad_path' });
    expect(await readdir(outside)).not.toContain('mc');
  });

  it('refuses a data symlink, a missing data folder and folders outside games/', async () => {
    const dir = path.join(games, 'linked-data');
    await mkdir(dir);
    await symlink(outside, path.join(dir, 'data'));
    const { ctx } = makeCtx(root, { spawn: fakeTar([]) });
    await expect(
      gameBackup({ gameDir: dir, keep: 7 }, ctx, 'rpc_backup0005'),
    ).rejects.toMatchObject({
      code: 'bad_path',
    });
    const empty = path.join(games, 'no-data');
    await mkdir(empty);
    await expect(
      gameBackup({ gameDir: empty, keep: 7 }, ctx, 'rpc_backup0006'),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      gameBackup({ gameDir: path.join(root, 'backups'), keep: 7 }, ctx, 'rpc_backup0007'),
    ).rejects.toMatchObject({ code: 'bad_path' });
    expect(ctx.streams.size).toBe(0);
  });

  it('a failing tar ends the stream with an error and leaves no partial file', async () => {
    const dir = await makeGame('fails');
    const { ctx, rec } = makeCtx(root, { spawn: fakeTar([], { code: 2 }) });
    await gameBackup({ gameDir: dir, keep: 7 }, ctx, 'rpc_backup0008');
    ctx.streams.activate('rpc_backup0008');
    expect(await waitEnd(rec.sent)).toMatchObject({ code: 1, error: 'tar failed (exit 2)' });
    expect(await readdir(path.join(root, 'backups', 'fails'))).toEqual([]);
  });

  it('Minecraft: save-off / save-all flush before, save-on after; the password never shows up', async () => {
    const rcon = await startFakeRcon({ password: PASSWORD });
    try {
      const dir = await makeGame('mcsave', `RCON_PASSWORD=${PASSWORD}\nPORT_RCON=${rcon.port}\n`);
      const docker = {
        getContainer: (id: string) => ({
          inspect: async () => {
            expect(id).toBe('game-mcsave');
            return {
              Config: {
                Labels: { 'homelab.game': 'mcsave', 'homelab.template': 'minecraft-java' },
              },
            };
          },
        }),
      } as unknown as HostContext['docker'];
      const calls: SpawnCall[] = [];
      const { ctx, rec } = makeCtx(root, { spawn: fakeTar(calls) });
      ctx.host = { ...ctx.host, docker };
      await gameBackup({ gameDir: dir, keep: 7 }, ctx, 'rpc_backup0009');
      ctx.streams.activate('rpc_backup0009');
      expect(await waitEnd(rec.sent)).toMatchObject({ code: 0 });
      expect(rcon.commands).toEqual(['save-off', 'save-all flush', 'save-on']);
      const all = JSON.stringify(rec.sent) + rec.logs.join('\n') + JSON.stringify(calls);
      expect(all).not.toContain(PASSWORD);
      expect(progressText(rec.sent)).toContain('world saved, autosave paused');
    } finally {
      await rcon.close();
    }
  });

  it('a second action on the same game is busy while the backup runs', async () => {
    const dir = await makeGame('busy');
    let finish: (r: SpawnResult) => void = () => undefined;
    const slow: Spawner = (_f, args) => {
      const archive = args[args.indexOf('--file') + 1] as string;
      const done = new Promise<SpawnResult>((r) => {
        finish = (res) => void writeFile(archive, 'x').then(() => r(res));
      });
      return { done, kill: () => undefined, pause: () => undefined, resume: () => undefined };
    };
    const { ctx, rec } = makeCtx(root, { spawn: slow });
    await gameBackup({ gameDir: dir, keep: 7 }, ctx, 'rpc_backup0010');
    await expect(
      gameBackup({ gameDir: dir, keep: 7 }, ctx, 'rpc_backup0011'),
    ).rejects.toMatchObject({
      code: 'busy',
    });
    ctx.streams.activate('rpc_backup0010');
    await new Promise((r) => setTimeout(r, 20));
    finish({ code: 0 });
    expect(await waitEnd(rec.sent)).toMatchObject({ code: 0 });
  });

  const hasZstd = (() => {
    try {
      execFileSync('zstd', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasZstd)('real tar + zstd produces an archive with data/', async () => {
    const dir = await makeGame('real');
    const { ctx, rec } = makeCtx(root, { spawn: spawnFile });
    await gameBackup({ gameDir: dir, keep: 7 }, ctx, 'rpc_backup0012');
    ctx.streams.activate('rpc_backup0012');
    expect(await waitEnd(rec.sent)).toMatchObject({ code: 0 });
    const { path: file } = resultOf(rec.sent);
    expect((await lstat(file)).isFile()).toBe(true);
    const list = execFileSync('tar', ['--zstd', '-tf', file], { encoding: 'utf8' });
    expect(list).toContain('data/world/level.dat');
  });
});
