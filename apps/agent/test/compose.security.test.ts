import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  composeFilesSchema,
  rpcParamsByAction,
  type AgentEvent,
  type RpcEnvelope,
} from '@hz/shared';
import { Dispatcher, type ActionContext } from '../src/actions/index.js';
import {
  composeArgs,
  composeTarget,
  composeUp,
  composeWrite,
  findComposeFile,
} from '../src/actions/compose.js';
import { ActionError } from '../src/actions/types.js';
import type { RunOptions, RunResult } from '../src/exec.js';
import { createLogger } from '../src/log.js';
import { resolveHomelabPath } from '../src/paths.js';
import { StreamManager } from '../src/streams.js';

let base: string;
let root: string;
let outside: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hz-compose-')));
  root = path.join(base, 'homelab');
  outside = path.join(base, 'outside');
  await mkdir(path.join(root, 'apps', 'web'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(root, 'apps', 'web', 'compose.yml'), 'services: {}\n');
  await writeFile(path.join(outside, 'compose.yml'), 'services: {}\n');
  // dir symlink that leaves the root
  await symlink(outside, path.join(root, 'escape'));
  // compose file symlink that leaves the root
  await mkdir(path.join(root, 'apps', 'sneaky'));
  await symlink(
    path.join(outside, 'compose.yml'),
    path.join(root, 'apps', 'sneaky', 'compose.yml'),
  );
  // compose file symlink inside the root is fine
  await mkdir(path.join(root, 'apps', 'linked'));
  await symlink(
    path.join(root, 'apps', 'web', 'compose.yml'),
    path.join(root, 'apps', 'linked', 'compose.yml'),
  );
  // compose.yml that is a directory
  await mkdir(path.join(root, 'apps', 'weird', 'compose.yml'), { recursive: true });
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

function ctx(
  calls: { file: string; args: readonly string[]; opts?: RunOptions }[] = [],
): ActionContext {
  return {
    name: 'heimserver',
    allowTerminal: false,
    homelabRoot: `${root}/`,
    host: {
      hostProc: '/proc',
      hostRoot: '/nonexistent',
      docker: null,
      exec: async (): Promise<RunResult> => ({ code: 0, stdout: '', stderr: '' }),
    },
    log: createLogger('error', () => undefined),
    later: () => undefined,
    streams: new StreamManager({ send: () => true, bufferedAmount: () => 0 }),
    run: async (file, args, opts): Promise<RunResult> => {
      calls.push(opts ? { file, args, opts } : { file, args });
      return { code: 0, stdout: 'done', stderr: '' };
    },
    dockerSocket: '/var/run/docker.sock',
    spawn: () => {
      throw new Error('spawn not expected');
    },
    dataDir: '/nonexistent-data',
  };
}

const rpc = (action: string, params: unknown): RpcEnvelope => ({
  type: 'rpc',
  id: 'rpc_compose1',
  action,
  params,
});

describe('compose dir (dispatcher)', () => {
  it.each([
    '/etc',
    '/opt/homelab',
    '/opt/homelab/',
    '/opt/homelab/../etc',
    '/opt/homelab/./x',
    '/opt/homelab//x',
    '/opt/homelabx/y',
    'opt/homelab/x',
    '/opt/homelab/x\0y',
  ])('rejects %j for compose.up/down/pull/write without running anything', async (dir) => {
    const calls: { file: string; args: readonly string[] }[] = [];
    const events: AgentEvent[] = [];
    const d = new Dispatcher(ctx(calls), (e) => events.push(e));
    for (const action of ['compose.up', 'compose.down', 'compose.pull']) {
      const res = await d.handle(rpc(action, { dir }));
      expect(res.ok).toBe(false);
      expect(res.ok === false && ['invalid_params', 'bad_path']).toContain(
        res.ok === false && res.error.code,
      );
    }
    const res = await d.handle(rpc('compose.write', { dir, files: { 'compose.yml': 'x' } }));
    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
    expect(events.every((e) => e.event.kind === 'denied')).toBe(true);
    expect(events).toHaveLength(4);
  });

  it('the realpath check catches a dir symlink out of the root', async () => {
    const r = await resolveHomelabPath(path.join(root, 'escape'), `${root}/`);
    expect(r).toMatchObject({ ok: false });
    const deeper = await resolveHomelabPath(path.join(root, 'escape', 'new', 'dir'), `${root}/`);
    expect(deeper).toMatchObject({ ok: false });
  });
});

describe('compose file lookup', () => {
  it('finds compose.yml in the project dir', async () => {
    const f = await findComposeFile(path.join(root, 'apps', 'web'), `${root}/`);
    expect(f).toBe(path.join(root, 'apps', 'web', 'compose.yml'));
  });

  it('follows a symlink only when it stays inside the root', async () => {
    const f = await findComposeFile(path.join(root, 'apps', 'linked'), `${root}/`);
    expect(f).toBe(path.join(root, 'apps', 'web', 'compose.yml'));
  });

  it('rejects a compose.yml symlink that points outside', async () => {
    await expect(
      findComposeFile(path.join(root, 'apps', 'sneaky'), `${root}/`),
    ).rejects.toMatchObject({
      code: 'bad_path',
    });
  });

  it('rejects a compose.yml that is not a regular file', async () => {
    await expect(
      findComposeFile(path.join(root, 'apps', 'weird'), `${root}/`),
    ).rejects.toMatchObject({
      code: 'bad_path',
    });
  });

  it('reports a missing dir or file as not_found', async () => {
    await expect(findComposeFile(path.join(root, 'nope'), `${root}/`)).rejects.toMatchObject({
      code: 'not_found',
    });
    await mkdir(path.join(root, 'empty'), { recursive: true });
    await expect(findComposeFile(path.join(root, 'empty'), `${root}/`)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('compose exec', () => {
  it('uses fixed argument arrays', () => {
    expect(composeArgs('up', '/opt/homelab/a', '/opt/homelab/a/compose.yml')).toEqual([
      'compose',
      '--ansi',
      'never',
      '--project-directory',
      '/opt/homelab/a',
      '-f',
      '/opt/homelab/a/compose.yml',
      'up',
      '-d',
      '--remove-orphans',
    ]);
    expect(composeArgs('down', '/d', '/d/compose.yml').slice(-2)).toEqual([
      'down',
      '--remove-orphans',
    ]);
    expect(composeArgs('pull', '/d', '/d/compose.yml').slice(-2)).toEqual(['pull', '--quiet']);
  });

  it('runs docker compose with the checked paths and only DOCKER_HOST/DOCKER_CONFIG', async () => {
    const calls: { file: string; args: readonly string[]; opts?: RunOptions }[] = [];
    const dir = path.join(root, 'apps', 'web');
    const res = await composeUp({ dir }, ctx(calls));
    expect(res).toEqual({ output: 'done' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe('docker');
    expect(calls[0]?.args).toEqual(composeArgs('up', dir, path.join(dir, 'compose.yml')));
    expect(Object.keys(calls[0]?.opts?.env ?? {}).sort()).toEqual(['DOCKER_CONFIG', 'DOCKER_HOST']);
  });

  it('never runs docker for a compose file outside the root', async () => {
    const calls: { file: string; args: readonly string[] }[] = [];
    await expect(
      composeUp({ dir: path.join(root, 'apps', 'sneaky') }, ctx(calls)),
    ).rejects.toBeInstanceOf(ActionError);
    expect(calls).toEqual([]);
  });

  it('turns a non-zero exit into failed', async () => {
    const c = ctx();
    c.run = async () => ({ code: 1, stdout: '', stderr: 'no such service' });
    await expect(composeUp({ dir: path.join(root, 'apps', 'web') }, c)).rejects.toMatchObject({
      code: 'failed',
    });
  });
});

describe('compose.write file names', () => {
  const schema = rpcParamsByAction['compose.write'];
  it.each([
    '../compose.yml',
    '..',
    // '.env' is allowed since M6 (composeFileNameSchema; games.security.test.ts), other dotfiles not.
    '.env.local',
    '.envrc',
    '.hidden',
    'a/b.yml',
    'a\\b',
    '/etc/passwd',
    '',
    'x'.repeat(101),
    'compose.yml\0',
    '__proto__',
    'con fig.yml',
    'a..b',
  ])('rejects %j', (name) => {
    const r = schema.safeParse({ dir: '/opt/homelab/games/mc', files: { [name]: 'x' } });
    expect(r.success).toBe(false);
  });

  it.each(['compose.yml', 'server.properties', 'game.env', 'Dockerfile', 'a-b_c.1'])(
    'accepts %j',
    (n) => {
      expect(schema.safeParse({ dir: '/opt/homelab/games/mc', files: { [n]: 'x' } }).success).toBe(
        true,
      );
    },
  );

  it('limits the number of files', () => {
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${i}.yml`, 'x']));
    expect(composeFilesSchema.safeParse(many).success).toBe(false);
    expect(composeFilesSchema.safeParse({}).success).toBe(false);
  });

  it('re-checks names in the handler', async () => {
    await expect(
      composeWrite({ dir: path.join(root, 'w0'), files: { '../x': 'x' } }, ctx()),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });
});

describe('compose.write', () => {
  it('creates the dir and writes files atomically with mode 0640', async () => {
    const dir = path.join(root, 'games', 'mc1');
    const res = await composeWrite(
      { dir, files: { 'compose.yml': 'services: {}\n', 'game.env': 'A=1\n' } },
      ctx(),
    );
    expect(res).toEqual({ dir, files: ['compose.yml', 'game.env'] });
    expect(await readFile(path.join(dir, 'compose.yml'), 'utf8')).toBe('services: {}\n');
    expect((await stat(path.join(dir, 'compose.yml'))).mode & 0o777).toBe(0o640);
    expect((await stat(path.join(dir, 'game.env'))).mode & 0o777).toBe(0o640);
    // No temp files left over.
    expect((await readdir(dir)).sort()).toEqual(['compose.yml', 'game.env']);
  });

  it('replaces an existing file', async () => {
    const dir = path.join(root, 'games', 'mc2');
    await composeWrite({ dir, files: { 'compose.yml': 'one' } }, ctx());
    await composeWrite({ dir, files: { 'compose.yml': 'two' } }, ctx());
    expect(await readFile(path.join(dir, 'compose.yml'), 'utf8')).toBe('two');
  });

  it('replaces a symlink at the target instead of writing through it', async () => {
    const dir = path.join(root, 'games', 'mc3');
    await mkdir(dir, { recursive: true });
    const victim = path.join(outside, 'victim.txt');
    await writeFile(victim, 'original');
    await symlink(victim, path.join(dir, 'compose.yml'));
    await composeWrite({ dir, files: { 'compose.yml': 'evil?' } }, ctx());
    expect(await readFile(victim, 'utf8')).toBe('original');
    expect((await lstat(path.join(dir, 'compose.yml'))).isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(dir, 'compose.yml'), 'utf8')).toBe('evil?');
  });

  it('refuses a dir that resolves outside the root', async () => {
    await expect(
      composeWrite({ dir: path.join(root, 'escape', 'x'), files: { 'compose.yml': 'x' } }, ctx()),
    ).rejects.toMatchObject({ code: 'bad_path' });
    expect(await readdir(outside)).not.toContain('x');
  });

  it('refuses to replace a directory', async () => {
    const dir = path.join(root, 'games', 'mc4');
    await mkdir(path.join(dir, 'compose.yml'), { recursive: true });
    await expect(composeWrite({ dir, files: { 'compose.yml': 'x' } }, ctx())).rejects.toMatchObject(
      {
        code: 'bad_path',
      },
    );
  });

  it('keeps a symlinked dir inside the root working (realpath used)', async () => {
    await symlink(path.join(root, 'games', 'mc1'), path.join(root, 'mc-link'));
    const check = await resolveHomelabPath(path.join(root, 'mc-link'), `${root}/`);
    expect(check).toEqual({ ok: true, path: path.join(root, 'games', 'mc1') });
    expect(await readlink(path.join(root, 'mc-link'))).toBe(path.join(root, 'games', 'mc1'));
  });
});

describe('compose target (project name, override and extra files)', () => {
  const docker = (labels: Record<string, string> | null) => ({
    listContainers: async () => (labels ? [{ Labels: labels }] : []),
  });

  it('adds the default override file when no containers exist yet', async () => {
    const dir = path.join(root, 'apps', 'ovr');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'compose.yml'), 'services: {}\n');
    await writeFile(path.join(dir, 'compose.override.yml'), 'services: {}\n');
    expect(await composeTarget(dir, `${root}/`, docker(null))).toEqual({
      files: [path.join(dir, 'compose.yml'), path.join(dir, 'compose.override.yml')],
    });
  });

  it('keeps the project name and every -f file from the labels', async () => {
    const dir = path.join(root, 'apps', 'web');
    const extra = path.join(dir, 'prod.yml');
    await writeFile(extra, 'services: {}\n');
    const t = await composeTarget(
      dir,
      `${root}/`,
      docker({
        'com.docker.compose.project': 'myweb',
        'com.docker.compose.project.config_files': `${path.join(dir, 'compose.yml')},${extra}`,
      }),
    );
    expect(t).toEqual({ project: 'myweb', files: [path.join(dir, 'compose.yml'), extra] });
    expect(composeArgs('up', dir, t.files, t.project)).toEqual([
      'compose',
      '--ansi',
      'never',
      '--project-directory',
      dir,
      '-p',
      'myweb',
      '-f',
      path.join(dir, 'compose.yml'),
      '-f',
      extra,
      'up',
      '-d',
      '--remove-orphans',
    ]);
  });

  it('refuses label files outside the homelab root', async () => {
    const dir = path.join(root, 'apps', 'web');
    await expect(
      composeTarget(
        dir,
        `${root}/`,
        docker({
          'com.docker.compose.project': 'web',
          'com.docker.compose.project.config_files': path.join(outside, 'compose.yml'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'bad_path' });
  });

  it('ignores an invalid project name from the labels', async () => {
    const dir = path.join(root, 'apps', 'web');
    const t = await composeTarget(
      dir,
      `${root}/`,
      docker({ 'com.docker.compose.project': '-p evil' }),
    );
    expect(t.project).toBeUndefined();
  });
});
