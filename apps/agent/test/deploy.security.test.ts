import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rpcParamsByAction, type AgentEvent, type StreamData, type StreamEnd } from '@hz/shared';
import { Dispatcher, handlers, hasGitSegment, type ActionContext } from '../src/actions/index.js';
import { ActionError } from '../src/actions/types.js';
import { resolveHomelabPath } from '../src/paths.js';

const table = handlers as unknown as Record<string, unknown>;
import { ensureDeployKey } from '../src/actions/deploy-key.js';
import {
  checkRepoUrl,
  findDeployScript,
  prepareDir,
  GIT,
  gitArgs,
  gitEnv,
  KNOWN_HOSTS_FILE,
  sshCommand,
} from '../src/actions/deploy.js';
import { isDirLocked } from '../src/actions/dir-lock.js';
import {
  ExecPolicyError,
  PROGRAMS,
  isDeployScriptCall,
  runFile,
  spawnFile,
  type SpawnCallbacks,
  type SpawnOptions,
  type SpawnResult,
} from '../src/exec.js';
import type { RunResult } from '../src/exec.js';
import { createLogger } from '../src/log.js';
import { StreamManager } from '../src/streams.js';

const SHA = 'a'.repeat(40);
const URL_HTTPS = 'https://github.com/alex/site.git';
const URL_SSH = 'git@github.com:alex/private.git';

let base: string;
let root: string;
let outside: string;
let dataDir: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hz-deploy-')));
  root = path.join(base, 'homelab');
  outside = path.join(base, 'outside');
  dataDir = path.join(base, 'data');
  await mkdir(path.join(root, 'apps'), { recursive: true });
  await mkdir(outside);
  await mkdir(dataDir, { mode: 0o700 });
  await writeFile(path.join(outside, 'deploy.sh'), 'echo pwned\n');
  await symlink(outside, path.join(root, 'apps', 'escape'));
  await mkdir(path.join(root, 'apps', 'repo', '.git'), { recursive: true });
  await mkdir(path.join(root, 'apps', 'gitfile'));
  await writeFile(path.join(root, 'apps', 'gitfile', '.git'), 'gitdir: /etc\n');
  await mkdir(path.join(root, 'apps', 'gitlink'));
  await symlink(outside, path.join(root, 'apps', 'gitlink', '.git'));
  await mkdir(path.join(root, 'apps', 'full'));
  await writeFile(path.join(root, 'apps', 'full', 'data.db'), 'x');
  await mkdir(path.join(root, 'apps', 'envonly'));
  await writeFile(path.join(root, 'apps', 'envonly', '.env'), 'A=1\n');
  await symlink(path.join(root, 'apps', 'repo', '.git'), path.join(root, 'apps', 'into-git'));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

interface SpawnCall {
  file: string;
  args: readonly string[];
  opts: SpawnOptions | undefined;
}

/** Fake spawner: records calls; `gate` keeps a call running until released. */
function fakeSpawn(
  behave: (c: SpawnCall, cb: SpawnCallbacks) => Promise<SpawnResult> | SpawnResult,
) {
  const calls: SpawnCall[] = [];
  const spawn: ActionContext['spawn'] = (file, args, cb, opts) => {
    const c = { file, args, opts };
    calls.push(c);
    let killed: (r: SpawnResult) => void = () => undefined;
    const kill = new Promise<SpawnResult>((r) => (killed = r));
    const done = Promise.race([Promise.resolve().then(() => behave(c, cb)), kill]);
    return {
      done,
      kill: () => killed({ code: null, error: 'killed' }),
      pause: () => undefined,
      resume: () => undefined,
    };
  };
  return { spawn, calls };
}

function setup(
  opts: {
    origin?: string;
    spawn?: ActionContext['spawn'];
    docker?: unknown;
    logLines?: string[];
  } = {},
) {
  const events: AgentEvent[] = [];
  const sent: (StreamData | StreamEnd)[] = [];
  const runCalls: { file: string; args: readonly string[] }[] = [];
  const streams = new StreamManager({ send: (m) => (sent.push(m), true), bufferedAmount: () => 0 });
  const fallback = fakeSpawn(() => ({ code: 0 }));
  const ctx: ActionContext = {
    name: 'heimserver',
    allowTerminal: false,
    homelabRoot: `${root}/`,
    host: {
      hostProc: '/proc',
      hostRoot: '/nonexistent',
      docker: (opts.docker ?? null) as ActionContext['host']['docker'],
      exec: async (): Promise<RunResult> => ({ code: 0, stdout: '', stderr: '' }),
    },
    log: createLogger('debug', (l) => opts.logLines?.push(l)),
    later: () => undefined,
    streams,
    run: async (file, args): Promise<RunResult> => {
      runCalls.push({ file, args });
      return { code: 0, stdout: `${opts.origin ?? URL_HTTPS}\n`, stderr: '' };
    },
    dockerSocket: '/var/run/docker.sock',
    spawn: opts.spawn ?? fallback.spawn,
    dataDir,
  };
  const d = new Dispatcher(ctx, (e) => events.push(e));
  /**
   * The schema only accepts /opt/homelab/ paths; the temp root is not there. Like the
   * compose tests, path-resolved calls go to the handler directly (dir = resolved path,
   * as the dispatcher passes it); then the stream goes live like after rpc.result.
   */
  const call = async (action: string, raw: unknown, id = 'rpc_deploy01') => {
    const p = raw as Record<string, unknown>;
    const parsed = rpcParamsByAction[action as 'deploy.run'].safeParse({
      ...p,
      dir: '/opt/homelab/x',
    });
    if (!parsed.success) return { ok: false as const, error: { code: 'invalid_params' } };
    const checked = await resolveHomelabPath(p.dir, ctx.homelabRoot);
    if (!checked.ok || hasGitSegment(p.dir) || hasGitSegment(checked.path)) {
      return { ok: false as const, error: { code: 'bad_path' } };
    }
    const fn = table[action] as (x: unknown, c: ActionContext, id: string) => Promise<unknown>;
    try {
      const data = await fn({ ...parsed.data, ...p, dir: checked.path }, ctx, id);
      ctx.streams.activate(id);
      return { ok: true as const, data };
    } catch (err) {
      ctx.streams.discard(id);
      if (err instanceof ActionError) return { ok: false as const, error: { code: err.code } };
      throw err;
    }
  };
  return { d, call, events, sent, runCalls, ctx, fallbackCalls: fallback.calls };
}

const params = (over: Record<string, unknown> = {}) => ({
  dir: path.join(root, 'apps', 'repo'),
  repoUrl: URL_HTTPS,
  sha: SHA,
  method: 'compose',
  ...over,
});

async function waitEnd(sent: (StreamData | StreamEnd)[]): Promise<StreamEnd> {
  for (let i = 0; i < 200; i++) {
    const end = sent.find((m): m is StreamEnd => m.type === 'stream.end');
    if (end) return end;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('no stream.end');
}

describe('deploy.run params (schema + agent)', () => {
  it.each([
    '--upload-pack=touch /tmp/hz-pwned',
    '-x',
    `-${'a'.repeat(39)}`,
    'HEAD',
    'main',
    'a'.repeat(39),
    'a'.repeat(41),
    'A'.repeat(40),
    `${'a'.repeat(39)} `,
    `${'a'.repeat(20)}\n${'a'.repeat(19)}`,
  ])('refuses sha %j before anything runs', async (sha) => {
    const { d, fallbackCalls, runCalls, events } = setup();
    const res = await d.handle({
      type: 'rpc',
      id: 'rpc_sha00001',
      action: 'deploy.run',
      params: params({ sha, dir: '/opt/homelab/apps/x' }),
    });
    expect(res).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    expect(fallbackCalls).toHaveLength(0);
    expect(runCalls).toHaveLength(0);
    expect(events[0]?.event.kind).toBe('denied');
  });

  it.each([
    'file:///etc',
    'ext::sh -c touch% /tmp/pwned',
    '--upload-pack=touch /tmp/x',
    'http://github.com/a/b',
    'https://evil.example/a/b',
    'https://github.com.evil.example/a/b',
    'git@evil.example:a/b',
    'ssh://git@github.com/a/b',
    'https://github.com/a/b;id',
    'https://github.com/a/b c',
    'https://github.com/a/b/c',
    'https://token@github.com/a/b',
  ])('refuses repoUrl %j', async (repoUrl) => {
    const { call, fallbackCalls } = setup();
    const res = await call('deploy.run', params({ repoUrl }));
    expect(res).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    expect(fallbackCalls).toHaveLength(0);
  });

  it.each([
    'https://github.com/../x',
    'https://github.com/-a/b',
    'https://github.com/a/..',
    'git@github.com:a/.git',
  ])('agent check refuses %j even if the schema passes it', (url) => {
    expect(() => checkRepoUrl(url)).toThrow();
  });

  it('accepts normal GitHub URLs', () => {
    for (const u of [
      URL_HTTPS,
      'https://github.com/alex/site',
      URL_SSH,
      'https://github.com/a.b/c_d-e',
    ]) {
      expect(() => checkRepoUrl(u)).not.toThrow();
    }
  });

  it('refuses unknown fields (no extra git options can be smuggled in)', () => {
    const r = rpcParamsByAction['deploy.run'].safeParse({ ...params(), args: ['--upload-pack=x'] });
    expect(r.success).toBe(false);
  });

  it('git@ URLs need keyName, https URLs refuse it, a missing key is not_found', async () => {
    const { call, fallbackCalls } = setup();
    expect(await call('deploy.run', params({ repoUrl: URL_SSH }))).toMatchObject({
      ok: false,
      error: { code: 'invalid_params' },
    });
    expect(await call('deploy.run', params({ keyName: 'site' }))).toMatchObject({
      ok: false,
      error: { code: 'invalid_params' },
    });
    expect(
      await call('deploy.run', params({ repoUrl: URL_SSH, keyName: 'missing' })),
    ).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(fallbackCalls).toHaveLength(0);
  });
});

describe('deploy.run dir', () => {
  it.each(['/etc', '/opt/homelab/../etc', '/opt/homelab'])(
    'refuses %j at the schema',
    async (dir) => {
      const { d, fallbackCalls } = setup();
      const res = await d.handle({
        type: 'rpc',
        id: 'rpc_dir00001',
        action: 'deploy.run',
        params: params({ dir }),
      });
      expect(res.ok).toBe(false);
      expect(fallbackCalls).toHaveLength(0);
    },
  );

  it('refuses a symlink that leaves the root (and a new dir below it)', async () => {
    const { call, fallbackCalls } = setup();
    for (const dir of [
      path.join(root, 'apps', 'escape'),
      path.join(root, 'apps', 'escape', 'new'),
    ]) {
      const res = await call('deploy.run', params({ dir }));
      expect(res).toMatchObject({ ok: false, error: { code: 'bad_path' } });
    }
    expect(fallbackCalls).toHaveLength(0);
  });

  it('the dispatcher refuses paths with a .git segment for every path action', async () => {
    const { d, fallbackCalls, runCalls } = setup();
    for (const dir of ['/opt/homelab/apps/x/.git', '/opt/homelab/apps/x/.GIT/hooks']) {
      for (const [action, p] of [
        ['deploy.run', params({ dir })],
        ['compose.write', { dir, files: { config: '[core]\n\tfsmonitor = id\n' } }],
        ['compose.up', { dir }],
      ] as const) {
        const res = await d.handle({ type: 'rpc', id: 'rpc_git00001', action, params: p });
        // The shared schema already refuses it (invalid_params); the dispatcher check
        // (bad_path) is the second line for resolved paths.
        expect(res.ok).toBe(false);
        expect(res.ok === false && ['invalid_params', 'bad_path']).toContain(
          res.ok === false ? res.error.code : '',
        );
      }
    }
    expect(fallbackCalls).toHaveLength(0);
    expect(runCalls).toHaveLength(0);
  });

  it('a symlink into a .git directory resolves to a .git path; deploy refuses it too', async () => {
    const link = await resolveHomelabPath(path.join(root, 'apps', 'into-git'), `${root}/`);
    expect(link.ok && hasGitSegment(link.path)).toBe(true);
    await expect(
      prepareDir(path.join(root, 'apps', 'repo', '.git'), `${root}/`),
    ).rejects.toMatchObject({
      code: 'bad_path',
    });
    await expect(readFile(path.join(root, 'apps', 'repo', '.git', 'config'))).rejects.toThrow();
  });

  it('refuses a .git file (gitdir: …) or a .git symlink', async () => {
    const { call, fallbackCalls } = setup();
    for (const name of ['gitfile', 'gitlink']) {
      const res = await call('deploy.run', params({ dir: path.join(root, 'apps', name) }));
      expect(res).toMatchObject({ ok: false, error: { code: 'bad_path' } });
    }
    expect(fallbackCalls).toHaveLength(0);
  });

  it('refuses a non-empty directory that is not a repository', async () => {
    const { call, fallbackCalls } = setup();
    const res = await call('deploy.run', params({ dir: path.join(root, 'apps', 'full') }));
    expect(res).toMatchObject({ ok: false, error: { code: 'not_allowed' } });
    expect(fallbackCalls).toHaveLength(0);
  });

  it('a directory with only .env is initialised; a missing dir is created', async () => {
    for (const name of ['envonly', 'brand-new']) {
      const { call, sent, fallbackCalls } = setup();
      const res = await call(
        'deploy.run',
        params({ dir: path.join(root, 'apps', name) }),
        `rpc_new_${name}`,
      );
      expect(res.ok).toBe(true);
      await waitEnd(sent);
      const subs = fallbackCalls.filter((c) => c.file === 'git').map((c) => c.args.slice(-6));
      expect(subs[0]?.slice(-2)).toEqual(['init', '--quiet']);
      expect(subs[1]?.slice(-5)).toEqual(['remote', 'add', 'origin', '--', URL_HTTPS]);
    }
    expect(await readFile(path.join(root, 'apps', 'envonly', '.env'), 'utf8')).toBe('A=1\n');
  });
});

describe('deploy.run origin', () => {
  it('refuses when origin of the existing repository differs from repoUrl', async () => {
    const { call, fallbackCalls, runCalls } = setup({
      origin: 'https://github.com/someone/else.git',
    });
    const res = await call('deploy.run', params());
    expect(res).toMatchObject({ ok: false, error: { code: 'not_allowed' } });
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]?.args.slice(-3)).toEqual(['remote', 'get-url', 'origin']);
    expect(fallbackCalls).toHaveLength(0);
  });
});

describe('deploy.run commands', () => {
  it('runs fetch, checkout and compose up --build with fixed arguments', async () => {
    await writeFile(path.join(root, 'apps', 'repo', 'compose.yml'), 'services: {}\n');
    const { call, sent, fallbackCalls } = setup();
    const res = await call('deploy.run', params());
    expect(res).toMatchObject({ ok: true, data: { streamId: 'rpc_deploy01' } });
    const end = await waitEnd(sent);
    expect(end.code).toBe(0);
    const dir = path.join(root, 'apps', 'repo');
    const [fetch, checkout, compose] = fallbackCalls;
    expect(fetch?.file).toBe('git');
    expect(fetch?.args.slice(0, 2)).toEqual(['-C', dir]);
    expect(fetch?.args).toContain('protocol.allow=never');
    expect(fetch?.args).toContain('core.hooksPath=/dev/null');
    expect(fetch?.args.slice(-4)).toEqual([
      'fetch',
      '--prune',
      '--no-recurse-submodules',
      'origin',
    ]);
    expect(checkout?.args.slice(-5)).toEqual(['checkout', '--force', '--detach', SHA, '--']);
    expect(compose?.file).toBe('docker');
    expect(compose?.args.slice(-4)).toEqual(['up', '-d', '--build', '--remove-orphans']);
    expect(compose?.args).toContain(path.join(dir, 'compose.yml'));
    expect(fetch?.opts?.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' });
    expect(fetch?.opts?.env?.GIT_SSH_COMMAND).toBeUndefined();
    const progress = sent
      .filter((m): m is StreamData => m.type === 'stream.data' && m.channel === 'progress')
      .map((m) => m.chunk);
    expect(progress[0]).toBe('$ git fetch --prune --no-recurse-submodules origin\n');
    expect(progress[1]).toBe(
      `$ git -c advice.detachedHead=false checkout --force --detach ${SHA} --\n`,
    );
    expect(progress[2]).toMatch(/^\$ docker compose /);
    // rpc.result came first: no stream message was sent before activate (queue).
    expect(sent.at(-1)?.type).toBe('stream.end');
  });

  it('streams output and ends with the failing exit code', async () => {
    const { spawn } = fakeSpawn((c, cb) => {
      if (c.args.includes('fetch')) {
        cb.onStderr(Buffer.from('fatal: could not read from remote\n'));
        return { code: 128 };
      }
      return { code: 0 };
    });
    const { call, sent } = setup({ spawn });
    expect((await call('deploy.run', params())).ok).toBe(true);
    const end = await waitEnd(sent);
    expect(end.code).toBe(128);
    expect(end.error).toMatch(/fetch/);
    expect(
      sent.some(
        (m) =>
          m.type === 'stream.data' && m.channel === 'stderr' && m.chunk.includes('could not read'),
      ),
    ).toBe(true);
  });

  it('with a deploy key: ssh with the bundled known_hosts, strict host keys; key not in stream or log', async () => {
    const line = await ensureDeployKey(dataDir, 'private');
    const keyText = await readFile(path.join(dataDir, 'deploy-keys', 'private'), 'utf8');
    const logLines: string[] = [];
    const { spawn, calls } = fakeSpawn(() => ({ code: 0 }));
    const { call, sent } = setup({ spawn, origin: URL_SSH, logLines });
    const res = await call('deploy.run', params({ repoUrl: URL_SSH, keyName: 'private' }));
    expect(res.ok).toBe(true);
    await waitEnd(sent);
    const ssh = calls[0]?.opts?.env?.GIT_SSH_COMMAND ?? '';
    expect(ssh).toContain(`-i ${path.join(dataDir, 'deploy-keys', 'private')}`);
    expect(ssh).toContain('StrictHostKeyChecking=yes');
    expect(ssh).toContain(`UserKnownHostsFile=${KNOWN_HOSTS_FILE}`);
    expect(ssh).toContain('IdentitiesOnly=yes');
    const everything = JSON.stringify([res, sent, logLines]);
    for (const l of keyText.split('\n').slice(1, -2)) expect(everything).not.toContain(l);
    expect(everything).not.toContain('GIT_SSH_COMMAND');
    expect(everything).not.toContain(line.split(' ')[1]);
  });

  it('cancel kills the running step and sends no stream.end', async () => {
    const { spawn, calls } = fakeSpawn(() => new Promise<SpawnResult>(() => undefined));
    const { call, sent, ctx } = setup({ spawn });
    expect((await call('deploy.run', params(), 'rpc_cancel01')).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(isDirLocked(path.join(root, 'apps', 'repo'))).toBe(true);
    ctx.streams.cancel('rpc_cancel01');
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(1);
    expect(sent.some((m) => m.type === 'stream.end')).toBe(false);
    expect(isDirLocked(path.join(root, 'apps', 'repo'))).toBe(false);
  });
});

describe('deploy.run lock (shared with compose)', () => {
  it('a running deploy blocks another deploy and compose actions in the same dir', async () => {
    let release: (r: SpawnResult) => void = () => undefined;
    const { spawn } = fakeSpawn((c) =>
      c.args.includes('fetch') ? new Promise<SpawnResult>((r) => (release = r)) : { code: 0 },
    );
    const { call, sent } = setup({ spawn });
    const dir = path.join(root, 'apps', 'repo');
    expect((await call('deploy.run', params(), 'rpc_lock0001')).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(await call('deploy.run', params(), 'rpc_lock0002')).toMatchObject({
      ok: false,
      error: { code: 'busy' },
    });
    for (const action of ['compose.up', 'compose.down', 'compose.pull']) {
      expect(await call(action, { dir }, 'rpc_lock0003')).toMatchObject({
        ok: false,
        error: { code: 'busy' },
      });
    }
    expect(
      await call('compose.write', { dir, files: { 'compose.yml': 'x' } }, 'rpc_lock0004'),
    ).toMatchObject({
      ok: false,
      error: { code: 'busy' },
    });
    release({ code: 0 });
    await waitEnd(sent);
    await new Promise((r) => setTimeout(r, 10));
    expect(isDirLocked(dir)).toBe(false);
  });

  it('a running compose action blocks deploy.run', async () => {
    let release: (r: RunResult) => void = () => undefined;
    const { ctx, call, fallbackCalls } = setup();
    ctx.run = (file) =>
      file === 'docker'
        ? new Promise<RunResult>((r) => (release = r))
        : Promise.resolve({ code: 0, stdout: `${URL_HTTPS}\n`, stderr: '' });
    const dir = path.join(root, 'apps', 'repo');
    const up = call('compose.up', { dir }, 'rpc_lockc001');
    await new Promise((r) => setTimeout(r, 20));
    const res = await call('deploy.run', params(), 'rpc_lockc002');
    expect(fallbackCalls).toHaveLength(0);
    expect(res).toMatchObject({ ok: false, error: { code: 'busy' } });
    release({ code: 0, stdout: '', stderr: '' });
    expect((await up).ok).toBe(true);
  });
});

describe('deploy.run protected projects', () => {
  it('refuses a project that contains the agent or core container', async () => {
    for (const role of ['agent', 'core']) {
      const docker = {
        listContainers: async () => [{ Id: 'f'.repeat(64), Labels: { 'hz.role': role } }],
        getContainer: () => ({ inspect: async () => ({}) }),
      };
      const { call, fallbackCalls, runCalls } = setup({ docker });
      const res = await call('deploy.run', params());
      expect(res).toMatchObject({ ok: false, error: { code: 'not_allowed' } });
      expect(fallbackCalls).toHaveLength(0);
      expect(runCalls).toHaveLength(0);
    }
  });
});

describe('deploy.sh', () => {
  it('must be a regular file directly in the dir (no symlink, also not to a file inside)', async () => {
    const dir = path.join(root, 'apps', 'scripted');
    await mkdir(dir, { recursive: true });
    await expect(findDeployScript(dir, `${root}/`)).rejects.toMatchObject({ code: 'not_found' });
    await symlink(path.join(outside, 'deploy.sh'), path.join(dir, 'deploy.sh'));
    await expect(findDeployScript(dir, `${root}/`)).rejects.toMatchObject({ code: 'bad_path' });
    await rm(path.join(dir, 'deploy.sh'));
    await writeFile(path.join(dir, 'real.sh'), 'echo ok\n');
    await symlink(path.join(dir, 'real.sh'), path.join(dir, 'deploy.sh'));
    await expect(findDeployScript(dir, `${root}/`)).rejects.toMatchObject({ code: 'bad_path' });
    await rm(path.join(dir, 'deploy.sh'));
    await mkdir(path.join(dir, 'deploy.sh'));
    await expect(findDeployScript(dir, `${root}/`)).rejects.toMatchObject({ code: 'bad_path' });
    await rm(path.join(dir, 'deploy.sh'), { recursive: true });
    await writeFile(path.join(dir, 'deploy.sh'), 'echo ok\n');
    expect(await findDeployScript(dir, `${root}/`)).toBe(path.join(dir, 'deploy.sh'));
  });

  it('a symlinked deploy.sh ends the stream with an error and runs nothing', async () => {
    const dir = path.join(root, 'apps', 'evil-script');
    await mkdir(path.join(dir, '.git'), { recursive: true });
    await symlink(path.join(outside, 'deploy.sh'), path.join(dir, 'deploy.sh'));
    const { call, sent, fallbackCalls } = setup();
    expect((await call('deploy.run', params({ dir, method: 'script' }))).ok).toBe(true);
    const end = await waitEnd(sent);
    expect(end.code).not.toBe(0);
    expect(fallbackCalls.map((c) => c.file)).toEqual(['git', 'git']);
  });

  it('runs /bin/sh <dir>/deploy.sh with cwd, timeout and a minimal env', async () => {
    const dir = path.join(root, 'apps', 'good-script');
    await mkdir(path.join(dir, '.git'), { recursive: true });
    await writeFile(path.join(dir, 'deploy.sh'), 'echo ok\n');
    const { call, sent, fallbackCalls } = setup();
    expect((await call('deploy.run', params({ dir, method: 'script' }))).ok).toBe(true);
    expect((await waitEnd(sent)).code).toBe(0);
    const s = fallbackCalls[2];
    expect(s?.file).toBe('/bin/sh');
    expect(s?.args).toEqual([path.join(dir, 'deploy.sh')]);
    expect(s?.opts?.cwd).toBe(dir);
    expect(s?.opts?.timeoutMs).toBe(20 * 60_000);
    expect(Object.keys(s?.opts?.env ?? {}).sort()).toEqual([
      'DEPLOY_SHA',
      'DOCKER_CONFIG',
      'DOCKER_HOST',
      'HOME',
    ]);
    expect(s?.opts?.env?.DEPLOY_SHA).toBe(SHA);
  });
});

describe('exec policy for deploy', () => {
  it('sh stays out of PROGRAMS; the spawner only allows /bin/sh <abs>/deploy.sh', () => {
    expect(PROGRAMS.has('sh')).toBe(false);
    expect(PROGRAMS.has('/bin/sh')).toBe(false);
    expect(PROGRAMS.has('ssh-keygen')).toBe(false);
    expect(() => runFile('/bin/sh', ['/opt/homelab/x/deploy.sh'])).toThrow(ExecPolicyError);
    const cb = { onStdout: () => undefined, onStderr: () => undefined };
    for (const args of [
      ['-c', 'id'],
      ['deploy.sh'],
      ['/opt/homelab/x/deploy.sh', 'extra'],
      ['/opt/homelab/x/../deploy.sh'],
      ['/opt/homelab/x/evil.sh'],
      [],
    ]) {
      expect(isDeployScriptCall('/bin/sh', args)).toBe(false);
      expect(() => spawnFile('/bin/sh', args, cb)).toThrow(ExecPolicyError);
    }
    expect(() => spawnFile('sh', ['/opt/homelab/x/deploy.sh'], cb)).toThrow(ExecPolicyError);
    expect(() => spawnFile('bash', ['/opt/homelab/x/deploy.sh'], cb)).toThrow(ExecPolicyError);
    expect(isDeployScriptCall('/bin/sh', ['/opt/homelab/x/deploy.sh'])).toBe(true);
  });

  it('spawner refuses disallowed env keys and relative cwd', () => {
    const cb = { onStdout: () => undefined, onStderr: () => undefined };
    expect(() =>
      spawnFile('git', ['--version'], cb, { env: { HZ_AGENT_TOKEN: 'x' } as never }),
    ).toThrow(ExecPolicyError);
    expect(() =>
      spawnFile('git', ['--version'], cb, { env: { GIT_DIR: '/etc' } as never }),
    ).toThrow(ExecPolicyError);
    expect(() => spawnFile('git', ['--version'], cb, { cwd: 'relative' })).toThrow(ExecPolicyError);
  });

  it('git argument builders put request values after fixed options or --', () => {
    const args = gitArgs('/opt/homelab/apps/x', ['https', 'ssh'], GIT.checkout(SHA));
    expect(args.slice(0, 2)).toEqual(['-C', '/opt/homelab/apps/x']);
    expect(args.at(-1)).toBe('--');
    expect(args.at(-2)).toBe(SHA);
    expect(() => GIT.checkout('--upload-pack=x')).toThrow();
    expect(() => gitArgs('relative', ['https'], GIT.fetch())).toThrow();
    expect(GIT.remoteAdd(URL_HTTPS)).toEqual(['remote', 'add', 'origin', '--', URL_HTTPS]);
    expect(gitArgs('/x', ['https'], [])).not.toContain('protocol.file.allow=always');
  });

  it('GIT_SSH_COMMAND only takes harmless paths (git runs it through a shell)', () => {
    expect(() => sshCommand('/data/deploy-keys/a;id')).toThrow();
    expect(() => sshCommand('/data/deploy keys/a')).toThrow();
    expect(() => sshCommand('/data/deploy-keys/$(id)')).toThrow();
    expect(() => sshCommand('/data/k', '/x y')).toThrow();
    expect(sshCommand('/data/deploy-keys/a')).toMatch(
      /^ssh -F \/dev\/null -i \/data\/deploy-keys\/a /,
    );
    expect(gitEnv('/opt/homelab/apps/x').GIT_CEILING_DIRECTORIES).toBe('/opt/homelab/apps');
  });
});
