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
import { gameRemove } from '../src/actions/game-remove.js';
import type { HostContext } from '../src/host.js';
import { makeCtx } from './game-helpers.js';

let base: string;
let root: string;
let games: string;
let outside: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hz-remove-')));
  root = path.join(base, 'homelab');
  games = path.join(root, 'games');
  outside = path.join(base, 'outside');
  await mkdir(games, { recursive: true });
  await mkdir(path.join(root, 'apps', 'web'), { recursive: true });
  await writeFile(path.join(root, 'apps', 'web', 'compose.yml'), 'services: {}\n');
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'victim.txt'), 'precious');
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

async function makeGame(name: string): Promise<string> {
  const dir = path.join(games, name);
  await mkdir(path.join(dir, 'data', 'world'), { recursive: true });
  await writeFile(path.join(dir, 'compose.yml'), 'services: {}\n');
  await writeFile(path.join(dir, '.env'), 'RCON_PASSWORD=x\n', { mode: 0o600 });
  await writeFile(path.join(dir, 'data', 'world', 'level.dat'), 'level');
  return dir;
}

function dockerWith(labels: Record<string, string>): HostContext['docker'] {
  return {
    listContainers: async () => [{ Id: 'a'.repeat(64), Labels: labels }],
    getContainer: () => ({
      inspect: async () => ({ Id: 'a'.repeat(64), Config: { Labels: labels } }),
    }),
  } as unknown as HostContext['docker'];
}

describe('game.remove', () => {
  it('runs compose down --volumes, then deletes only the game folder; backups stay', async () => {
    const dir = await makeGame('mc');
    await mkdir(path.join(root, 'backups', 'mc'), { recursive: true });
    await writeFile(path.join(root, 'backups', 'mc', 'mc-20261126-100000.tar.zst'), 'b');
    // symlinks inside are removed, never followed
    await symlink(path.join(outside, 'victim.txt'), path.join(dir, 'data', 'link'));
    await symlink(outside, path.join(dir, 'data', 'dirlink'));
    const { ctx, rec } = makeCtx(root);
    await expect(gameRemove({ gameDir: dir }, ctx)).resolves.toEqual({ removed: true });
    expect(rec.runs).toHaveLength(1);
    expect(rec.runs[0]?.file).toBe('docker');
    expect(rec.runs[0]?.args.slice(-3)).toEqual(['down', '--remove-orphans', '--volumes']);
    expect(rec.runs[0]?.args).toContain(dir);
    expect(await readdir(games)).not.toContain('mc');
    expect((await readdir(games)).some((n) => n.includes('removing'))).toBe(false);
    expect(await readFile(path.join(outside, 'victim.txt'), 'utf8')).toBe('precious');
    expect(await readdir(outside)).toEqual(['victim.txt']);
    expect(await readdir(path.join(root, 'backups', 'mc'))).toEqual(['mc-20261126-100000.tar.zst']);
  });

  it.each([
    ['another homelab folder', () => path.join(root, 'apps', 'web')],
    ['the games folder', () => games],
    ['the backups folder', () => path.join(root, 'backups')],
    ['a nested folder', () => path.join(games, 'keep', 'data')],
  ])('refuses %s and deletes nothing', async (_l, dir) => {
    await makeGame('keep');
    await mkdir(path.join(root, 'backups'), { recursive: true });
    const { ctx, rec } = makeCtx(root);
    await expect(gameRemove({ gameDir: dir() }, ctx)).rejects.toMatchObject({ code: 'bad_path' });
    expect(rec.runs).toEqual([]);
    expect(await readdir(path.join(root, 'apps', 'web'))).toEqual(['compose.yml']);
    expect(await readdir(games)).toContain('keep');
  });

  it('refuses a game folder symlinked to another place', async () => {
    await symlink(path.join(root, 'apps', 'web'), path.join(games, 'sneaky'));
    const { ctx, rec } = makeCtx(root);
    await expect(gameRemove({ gameDir: path.join(games, 'sneaky') }, ctx)).rejects.toMatchObject({
      code: 'bad_path',
    });
    expect(rec.runs).toEqual([]);
    expect(await readdir(path.join(root, 'apps', 'web'))).toEqual(['compose.yml']);
  });

  it('refuses projects with the agent or the core container', async () => {
    for (const role of ['agent', 'core']) {
      const dir = await makeGame(`prot-${role}`);
      const { ctx, rec } = makeCtx(root);
      ctx.host = { ...ctx.host, docker: dockerWith({ 'hz.role': role }) };
      await expect(gameRemove({ gameDir: dir }, ctx)).rejects.toMatchObject({
        code: 'not_allowed',
      });
      expect(rec.runs).toEqual([]);
      expect(await readdir(games)).toContain(`prot-${role}`);
    }
  });

  it('keeps the folder when compose down fails', async () => {
    const dir = await makeGame('down-fails');
    const { ctx } = makeCtx(root, {}, { code: 1, stdout: '', stderr: 'boom' });
    await expect(gameRemove({ gameDir: dir }, ctx)).rejects.toMatchObject({ code: 'failed' });
    expect(await readdir(games)).toContain('down-fails');
  });

  it('removes a folder without compose file without running docker', async () => {
    const dir = path.join(games, 'half');
    await mkdir(path.join(dir, 'data'), { recursive: true });
    const { ctx, rec } = makeCtx(root);
    await gameRemove({ gameDir: dir }, ctx);
    expect(rec.runs).toEqual([]);
    expect(await readdir(games)).not.toContain('half');
  });
});
