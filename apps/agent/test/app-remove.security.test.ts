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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appRemoveDataSchema, rpcParamsByAction } from '@hz/shared';
import { appRemove } from '../src/actions/app-remove.js';
import type { HostContext } from '../src/host.js';
import { makeCtx } from './game-helpers.js';

let base: string;
let root: string;
let apps: string;
let outside: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hz-appremove-')));
  root = path.join(base, 'homelab');
  apps = path.join(root, 'apps');
  outside = path.join(base, 'outside');
  await mkdir(root, { recursive: true });
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});
beforeEach(async () => {
  await rm(apps, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
  await mkdir(apps, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'victim.txt'), 'precious');
});

async function makeApp(id: string): Promise<string> {
  const dir = path.join(apps, id);
  await mkdir(path.join(dir, 'data', 'config'), { recursive: true });
  await writeFile(path.join(dir, 'compose.yml'), 'services: {}\n');
  await writeFile(path.join(dir, '.env'), 'ADMIN_TOKEN=x\n', { mode: 0o600 });
  await writeFile(path.join(dir, 'data', 'config', 'db.sqlite'), 'db');
  return dir;
}

function dockerWith(labels: Record<string, string>): HostContext['docker'] {
  return {
    listContainers: async () => [{ Id: 'b'.repeat(64), Labels: labels }],
    getContainer: () => ({
      inspect: async () => ({ Id: 'b'.repeat(64), Config: { Labels: labels } }),
    }),
  } as unknown as HostContext['docker'];
}

describe('app.remove', () => {
  it('compose down --remove-orphans without -v; the folder stays without deleteData', async () => {
    const dir = await makeApp('vault');
    const { ctx, rec } = makeCtx(root);
    const r = await appRemove({ appId: 'vault', deleteData: false }, ctx);
    expect(appRemoveDataSchema.parse(r)).toEqual({ removed: false });
    expect(rec.runs).toHaveLength(1);
    expect(rec.runs[0]?.file).toBe('docker');
    expect(rec.runs[0]?.args.slice(-2)).toEqual(['down', '--remove-orphans']);
    expect(rec.runs[0]?.args).not.toContain('-v');
    expect(rec.runs[0]?.args).not.toContain('--volumes');
    expect(rec.runs[0]?.args).toContain(dir);
    expect(await readFile(path.join(dir, 'data', 'config', 'db.sqlite'), 'utf8')).toBe('db');
  });

  it('with deleteData deletes the folder, symlinks inside are unlinked, never followed', async () => {
    const dir = await makeApp('cloud');
    await symlink(path.join(outside, 'victim.txt'), path.join(dir, 'data', 'link'));
    await symlink(outside, path.join(dir, 'data', 'dirlink'));
    const { ctx, rec } = makeCtx(root);
    await expect(appRemove({ appId: 'cloud', deleteData: true }, ctx)).resolves.toEqual({
      removed: true,
    });
    expect(rec.runs[0]?.args).not.toContain('--volumes');
    expect(await readdir(apps)).toEqual([]);
    expect(await readdir(outside)).toEqual(['victim.txt']);
    expect(await readFile(path.join(outside, 'victim.txt'), 'utf8')).toBe('precious');
  });

  it('a missing folder (or apps/) is success and runs nothing', async () => {
    const { ctx, rec } = makeCtx(root);
    await expect(appRemove({ appId: 'nope', deleteData: true }, ctx)).resolves.toEqual({
      removed: false,
    });
    await rm(apps, { recursive: true });
    await expect(appRemove({ appId: 'nope', deleteData: true }, ctx)).resolves.toEqual({
      removed: false,
    });
    expect(rec.runs).toEqual([]);
  });

  it('refuses an app folder that is a symlink out of apps/ and deletes nothing', async () => {
    await symlink(outside, path.join(apps, 'escape'));
    const { ctx, rec } = makeCtx(root);
    await expect(appRemove({ appId: 'escape', deleteData: true }, ctx)).rejects.toMatchObject({
      code: 'bad_path',
    });
    expect(rec.runs).toEqual([]);
    expect(await readdir(outside)).toEqual(['victim.txt']);
  });

  it('refuses when apps/ itself is a symlink', async () => {
    await rm(apps, { recursive: true });
    await mkdir(path.join(outside, 'x'), { recursive: true });
    await symlink(outside, apps);
    const { ctx, rec } = makeCtx(root);
    await expect(appRemove({ appId: 'x', deleteData: true }, ctx)).rejects.toMatchObject({
      code: 'bad_path',
    });
    expect(rec.runs).toEqual([]);
    expect((await readdir(outside)).sort()).toEqual(['victim.txt', 'x']);
    await rm(apps);
  });

  it('never touches a project with an hz.role container', async () => {
    for (const role of ['agent', 'core']) {
      await makeApp(`prot-${role}`);
      const { ctx, rec } = makeCtx(root);
      ctx.host = { ...ctx.host, docker: dockerWith({ 'hz.role': role }) };
      await expect(
        appRemove({ appId: `prot-${role}`, deleteData: true }, ctx),
      ).rejects.toMatchObject({ code: 'not_allowed' });
      expect(rec.runs).toEqual([]);
      expect(await readdir(apps)).toContain(`prot-${role}`);
    }
  });

  it('keeps the folder when compose down fails', async () => {
    await makeApp('down-fails');
    const { ctx } = makeCtx(root, {}, { code: 1, stdout: '', stderr: 'boom' });
    await expect(appRemove({ appId: 'down-fails', deleteData: true }, ctx)).rejects.toMatchObject({
      code: 'failed',
    });
    expect(await readdir(apps)).toContain('down-fails');
  });

  it.each(['../games', '..', 'a/b', '/etc', 'App', '-a', 'a-', '.x', ''])(
    'the schema refuses the appId %j',
    (appId) => {
      expect(rpcParamsByAction['app.remove'].safeParse({ appId, deleteData: true }).success).toBe(
        false,
      );
    },
  );

  it('the handler refuses a bad appId even without the schema', async () => {
    const { ctx, rec } = makeCtx(root);
    await expect(appRemove({ appId: '../outside', deleteData: true }, ctx)).rejects.toMatchObject({
      code: 'bad_path',
    });
    expect(rec.runs).toEqual([]);
    expect(await readdir(outside)).toEqual(['victim.txt']);
  });
});
