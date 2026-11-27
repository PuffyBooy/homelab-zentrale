import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostPathProblem, projectLocation } from '../src/actions/stack.js';
import type { RunOptions, RunResult } from '../src/exec.js';
import { ok, rpc } from './admin-helpers.js';
import { APP_ID, OTHER_ID, newState, setupDocker, type FakeContainer } from './docker-fakes.js';

let base: string;
let hostRoot: string;
let homelab: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hz-stack-')));
  hostRoot = path.join(base, 'host');
  homelab = path.join(base, 'homelab');
  await mkdir(path.join(hostRoot, 'srv', 'web'), { recursive: true });
  await writeFile(path.join(hostRoot, 'srv', 'web', 'compose.yml'), 'services: {}\n');
  await writeFile(path.join(hostRoot, 'srv', 'web', 'override.yml'), 'services: {}\n');
  await mkdir(path.join(hostRoot, 'srv', 'web', 'adir.yml'));
  await symlink('/etc/passwd', path.join(hostRoot, 'srv', 'web', 'link.yml'));
  await mkdir(path.join(homelab, 'apps', 'blog'), { recursive: true });
  await writeFile(path.join(homelab, 'apps', 'blog', 'compose.yml'), 'services: {}\n');
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

function webContainer(
  id: string,
  name: string,
  labels: Record<string, string> = {},
): FakeContainer {
  return {
    Id: id,
    Names: [`/${name}`],
    Image: 'nginx',
    ImageID: `sha256:${'2'.repeat(64)}`,
    State: 'running',
    Labels: {
      'com.docker.compose.project': 'web',
      'com.docker.compose.project.working_dir': '/srv/web',
      'com.docker.compose.project.config_files': '/srv/web/compose.yml,/srv/web/override.yml',
      ...labels,
    },
    Mounts: [],
    NetworkSettings: { Networks: {} },
  };
}

interface Exec {
  file: string;
  args: readonly string[];
  opts?: RunOptions | undefined;
}

function setup(
  containers: FakeContainer[],
  exec: (f: string, a: readonly string[]) => RunResult = () => ok(),
) {
  const st = newState({ containers });
  const runs: Exec[] = [];
  const s = setupDocker(st, exec, {
    homelabRoot: homelab,
    hostExec: 'nsenter',
    run: async (file, args, opts) => {
      runs.push({ file, args, opts });
      return ok();
    },
  });
  (s.ctx.host as { hostRoot: string }).hostRoot = hostRoot;
  return { ...s, st, runs };
}

describe('stack.op: refusals', () => {
  it('unknown project -> not_found', async () => {
    const { d } = setup([]);
    expect(await d.handle(rpc('stack.op', { project: 'nope', op: 'stop' }))).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('a project with a protected container is refused for every op', async () => {
    for (const op of ['start', 'stop', 'restart', 'pull', 'up', 'down']) {
      const { d, st, execCalls, runs, events } = setup([
        webContainer(APP_ID, 'web'),
        webContainer(OTHER_ID, 'agent', { 'hz.role': 'agent' }),
      ]);
      const r = await d.handle(rpc('stack.op', { project: 'web', op }));
      expect(r).toMatchObject({ ok: false, error: { code: 'not_allowed' } });
      expect(st.calls.filter((c) => !c.startsWith('list'))).toEqual([]);
      expect(execCalls).toEqual([]);
      expect(runs).toEqual([]);
      expect(events.some((e) => e.event.kind === 'denied')).toBe(true);
    }
  });

  it('rejects invalid project names before docker is asked', async () => {
    const { d, st } = setup([]);
    for (const project of ['Web', '-p', 'a b', '../x']) {
      expect(await d.handle(rpc('stack.op', { project, op: 'up' }))).toMatchObject({
        ok: false,
        error: { code: 'invalid_params' },
      });
    }
    expect(st.calls).toEqual([]);
  });

  it('containers that disagree on their labels -> failed', async () => {
    const { d, execCalls } = setup([
      webContainer(APP_ID, 'web'),
      webContainer(OTHER_ID, 'db', { 'com.docker.compose.project.working_dir': '/srv/other' }),
    ]);
    expect(await d.handle(rpc('stack.op', { project: 'web', op: 'up' }))).toMatchObject({
      ok: false,
      error: { code: 'failed' },
    });
    const { d: d2 } = setup([
      webContainer(APP_ID, 'web'),
      webContainer(OTHER_ID, 'db', {
        'com.docker.compose.project.config_files': '/srv/web/compose.yml',
      }),
    ]);
    expect(await d2.handle(rpc('stack.op', { project: 'web', op: 'pull' }))).toMatchObject({
      ok: false,
      error: { code: 'failed' },
    });
    expect(execCalls).toEqual([]);
  });

  it('projectLocation needs both labels', () => {
    expect(() =>
      projectLocation([
        webContainer(APP_ID, 'a', { 'com.docker.compose.project.config_files': '' }),
      ]),
    ).toThrow();
  });
});

describe('stack.op: api ops', () => {
  it('stop/restart with t=30 per container, 304 counts as unchanged', async () => {
    const { d, st } = setup([webContainer(APP_ID, 'web'), webContainer(OTHER_ID, 'db')]);
    st.opError = { [`stop ${APP_ID}`]: 304 };
    const r = await d.handle(rpc('stack.op', { project: 'web', op: 'stop' }));
    expect(r).toMatchObject({ ok: true, data: { containers: 2, via: 'api' } });
    expect(st.calls).toContain(`stop ${APP_ID} {"t":30}`);
    expect(st.calls).toContain(`stop ${OTHER_ID} {"t":30}`);
    const r2 = await d.handle(rpc('stack.op', { project: 'web', op: 'restart' }));
    expect(r2).toMatchObject({ ok: true, data: { via: 'api' } });
    expect(st.calls).toContain(`restart ${APP_ID} {"t":30}`);
  });

  it('a docker error is failed without docker text', async () => {
    const { d, st } = setup([webContainer(APP_ID, 'web')]);
    st.opError = { [`start ${APP_ID}`]: 500 };
    const r = await d.handle(rpc('stack.op', { project: 'web', op: 'start' }));
    expect(r).toMatchObject({ ok: false, error: { code: 'failed' } });
    expect(JSON.stringify(r)).not.toContain('hunter2');
  });
});

describe('stack.op: host compose', () => {
  it('runs a fixed argv on the host; down never has --volumes', async () => {
    const { d, execCalls } = setup([webContainer(APP_ID, 'web'), webContainer(OTHER_ID, 'db')]);
    for (const op of ['pull', 'up', 'down'] as const) {
      const r = await d.handle(rpc('stack.op', { project: 'web', op }));
      expect(r).toMatchObject({ ok: true, data: { containers: 2, via: 'host' } });
    }
    const base = [
      'compose',
      '--ansi',
      'never',
      '--project-directory',
      '/srv/web',
      '-p',
      'web',
      '-f',
      '/srv/web/compose.yml',
      '-f',
      '/srv/web/override.yml',
    ];
    expect(execCalls.map((c) => [c.file, ...c.args])).toEqual([
      ['docker', ...base, 'pull', '--quiet'],
      ['docker', ...base, 'up', '-d', '--remove-orphans'],
      ['docker', ...base, 'down', '--remove-orphans'],
    ]);
    for (const c of execCalls) expect(c.args).not.toContain('--volumes');
    expect(execCalls[0]?.opts?.timeoutMs).toBe(15 * 60_000);
  });

  it.each([
    ['/', '/compose.yml'],
    ['/proc/1', '/proc/1/compose.yml'],
    ['/srv/../etc', '/srv/web/compose.yml'],
    ['srv/web', '/srv/web/compose.yml'],
    ['-f', '/srv/web/compose.yml'],
    ['/srv/web/', '/srv/web/compose.yml'],
    ['/srv//web', '/srv/web/compose.yml'],
    ['/srv/web', '../compose.yml'],
    ['/srv/web', '/sys/x.yml'],
    ['/srv/web', '/run/docker.sock'],
    ['/srv/web', '/srv/web/./compose.yml'],
    ['/srv/web', '/srv/web/compose.yml\n--volumes'],
  ])('rejects working dir %j / file %j', async (dir, file) => {
    const { d, execCalls } = setup([
      webContainer(APP_ID, 'web', {
        'com.docker.compose.project.working_dir': dir,
        'com.docker.compose.project.config_files': file,
      }),
    ]);
    const r = await d.handle(rpc('stack.op', { project: 'web', op: 'up' }));
    expect(r).toMatchObject({ ok: false, error: { code: 'bad_path' } });
    expect(execCalls).toEqual([]);
  });

  it('hostPathProblem', () => {
    expect(hostPathProblem('/srv/web')).toBeNull();
    for (const bad of [
      '/',
      '/proc',
      '/proc/x',
      '/dev/sda',
      '../x',
      'x',
      '-x',
      '/a/..',
      '/a\u0007',
      '',
    ]) {
      expect(hostPathProblem(bad)).not.toBeNull();
    }
  });

  it('every file must be a regular file on the host (no dir, no symlink, no missing file)', async () => {
    for (const f of ['/srv/web/adir.yml', '/srv/web/link.yml', '/srv/web/missing.yml']) {
      const { d, execCalls } = setup([
        webContainer(APP_ID, 'web', { 'com.docker.compose.project.config_files': f }),
      ]);
      const r = await d.handle(rpc('stack.op', { project: 'web', op: 'up' }));
      expect(r).toMatchObject({ ok: false, error: { code: 'bad_path' } });
      expect(execCalls).toEqual([]);
    }
  });

  it('host exec disabled -> failed', async () => {
    const { d, ctx, execCalls } = setup([webContainer(APP_ID, 'web')]);
    ctx.hostExec = 'none';
    expect(await d.handle(rpc('stack.op', { project: 'web', op: 'up' }))).toMatchObject({
      ok: false,
      error: { code: 'failed', message: 'host commands are disabled' },
    });
    expect(execCalls).toEqual([]);
  });

  it('missing compose plugin on the host -> failed with a clear message', async () => {
    for (const res of [
      { code: 1, stdout: '', stderr: "docker: 'compose' is not a docker command." },
      { code: 127, stdout: '', stderr: '' },
    ]) {
      const { d } = setup([webContainer(APP_ID, 'web')], () => res);
      expect(await d.handle(rpc('stack.op', { project: 'web', op: 'pull' }))).toMatchObject({
        ok: false,
        error: { code: 'failed', message: 'docker compose not available on the host' },
      });
    }
  });

  it('compose failure output is not echoed', async () => {
    const { d } = setup([webContainer(APP_ID, 'web')], () => ({
      code: 1,
      stdout: '',
      stderr: 'error PASSWORD=hunter2',
    }));
    const r = await d.handle(rpc('stack.op', { project: 'web', op: 'up' }));
    expect(r).toMatchObject({ ok: false, error: { code: 'failed' } });
    expect(JSON.stringify(r)).not.toContain('hunter2');
  });
});

describe('stack.op: below the homelab root', () => {
  const blog = (labels: Record<string, string> = {}) =>
    webContainer(APP_ID, 'blog', {
      'com.docker.compose.project': 'blog',
      'com.docker.compose.project.working_dir': path.join(homelab, 'apps', 'blog'),
      'com.docker.compose.project.config_files': path.join(homelab, 'apps', 'blog', 'compose.yml'),
      ...labels,
    });

  it("uses the agent's own compose ('inside'), never the host", async () => {
    const { d, runs, execCalls } = setup([blog()]);
    const r = await d.handle(rpc('stack.op', { project: 'blog', op: 'down' }));
    expect(r).toMatchObject({ ok: true, data: { containers: 1, via: 'inside' } });
    expect(execCalls).toEqual([]);
    const dir = path.join(homelab, 'apps', 'blog');
    expect(runs.map((x) => [x.file, ...x.args])).toEqual([
      [
        'docker',
        'compose',
        '--ansi',
        'never',
        '--project-directory',
        dir,
        '-p',
        'blog',
        '-f',
        path.join(dir, 'compose.yml'),
        'down',
        '--remove-orphans',
      ],
    ]);
    expect(runs[0]?.opts?.env?.DOCKER_HOST).toBe('unix:///var/run/docker.sock');
  });

  it.each([
    () => `${homelab}/apps/x/../blog`,
    () => `${homelab}/apps/../../host/srv/web`,
    () => `${homelab}/apps/missing`,
    () => homelab,
  ])('a non-canonical or missing working dir is bad_path, never run (%#)', async (dir) => {
    const { d, runs, execCalls } = setup([
      blog({ 'com.docker.compose.project.working_dir': dir() }),
    ]);
    const r = await d.handle(rpc('stack.op', { project: 'blog', op: 'up' }));
    expect(r).toMatchObject({
      ok: false,
      error: { code: expect.stringMatching(/bad_path|not_found/) },
    });
    expect(runs).toEqual([]);
    expect(execCalls).toEqual([]);
  });

  it('a compose file outside the root is refused', async () => {
    const { d, runs } = setup([
      blog({
        'com.docker.compose.project.config_files': path.join(hostRoot, 'srv', 'web', 'compose.yml'),
      }),
    ]);
    const r = await d.handle(rpc('stack.op', { project: 'blog', op: 'up' }));
    expect(r).toMatchObject({ ok: false, error: { code: 'bad_path' } });
    expect(runs).toEqual([]);
  });
});
