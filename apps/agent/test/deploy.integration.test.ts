import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StreamData, StreamEnd } from '@hz/shared';
import type { ActionContext } from '../src/actions/index.js';
import { checkOrigin, prepareDir, runDeploy, type DeployJob } from '../src/actions/deploy.js';
import { runFile, spawnFile, type RunResult } from '../src/exec.js';
import { createLogger } from '../src/log.js';
import { StreamManager } from '../src/streams.js';

/**
 * Real git against a local bare repository. The schema only allows GitHub URLs, so
 * the git steps are driven directly through runDeploy with a file:// remote and the
 * `file` transport enabled for this test only (production allows https and ssh).
 */

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

let base: string;
let root: string;
let remote: string;
let work: string;
const shas: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: base } },
  ).trim();
}

async function commit(files: Record<string, string>): Promise<string> {
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(work, name), text);
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', `c${shas.length}`);
  git(work, 'push', '-q', 'origin', 'HEAD:main');
  const sha = git(work, 'rev-parse', 'HEAD');
  shas.push(sha);
  return sha;
}

beforeAll(async () => {
  if (!hasGit()) return;
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hz-deploy-git-')));
  root = path.join(base, 'homelab');
  await mkdir(path.join(root, 'apps'), { recursive: true });
  remote = path.join(base, 'remote.git');
  work = path.join(base, 'work');
  git(base, 'init', '-q', '--bare', remote);
  git(base, 'init', '-q', work);
  git(work, 'remote', 'add', 'origin', remote);
  await commit({
    'deploy.sh':
      'echo "deploying $DEPLOY_SHA"\necho "$DEPLOY_SHA" > deployed.txt\necho to-stderr >&2\n',
    'app.txt': 'v1\n',
  });
  await commit({ 'app.txt': 'v2\n' });
});
afterAll(async () => {
  if (base) await rm(base, { recursive: true, force: true });
});

function ctx(sent: (StreamData | StreamEnd)[]): ActionContext {
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
    streams: new StreamManager({ send: (m) => (sent.push(m), true), bufferedAmount: () => 0 }),
    run: runFile,
    dockerSocket: '/var/run/docker.sock',
    spawn: spawnFile,
    dataDir: path.join(base, 'data'),
  };
}

async function deploy(dir: string, sha: string, url = `file://${remote}`) {
  const sent: (StreamData | StreamEnd)[] = [];
  const c = ctx(sent);
  const { init } = await prepareDir(dir, c.homelabRoot);
  if (!init) await checkOrigin(dir, url, c, ['file']);
  const job: DeployJob = { dir, repoUrl: url, sha, method: 'script', init, protocols: ['file'] };
  const sink = c.streams.open(`rpc_git_${sha.slice(0, 8)}`);
  c.streams.activate(sink.id);
  await runDeploy(job, c, sink);
  const end = sent.find((m): m is StreamEnd => m.type === 'stream.end');
  const text = (ch: string) =>
    sent
      .filter((m): m is StreamData => m.type === 'stream.data' && m.channel === ch)
      .map((m) => m.chunk)
      .join('');
  return { end, progress: text('progress'), stdout: text('stdout'), stderr: text('stderr') };
}

describe.skipIf(!hasGit())('deploy.run with real git', () => {
  it('initialises a new dir, checks out the sha and runs deploy.sh', async () => {
    const dir = path.join(root, 'apps', 'site');
    await mkdir(dir);
    await writeFile(path.join(dir, '.env'), 'SECRET_IN_ENV=1\n');
    const r = await deploy(dir, shas[0] ?? '');
    expect(r.end).toMatchObject({ code: 0 });
    expect(r.progress).toContain('$ git init --quiet\n');
    expect(r.progress).toContain(
      `$ git -c advice.detachedHead=false checkout --force --detach ${shas[0]} --\n`,
    );
    expect(r.progress).toContain('$ sh deploy.sh\n');
    expect(r.stdout).toContain(`deploying ${shas[0]}`);
    expect(r.stderr).toContain('to-stderr');
    expect(await readFile(path.join(dir, 'app.txt'), 'utf8')).toBe('v1\n');
    expect((await readFile(path.join(dir, 'deployed.txt'), 'utf8')).trim()).toBe(shas[0]);
    expect(await readFile(path.join(dir, '.env'), 'utf8')).toBe('SECRET_IN_ENV=1\n');
  });

  it('updates an existing repo, keeps untracked data, resets tracked changes, skips hooks', async () => {
    const dir = path.join(root, 'apps', 'site');
    await writeFile(path.join(dir, 'app.txt'), 'local edit\n');
    await writeFile(path.join(dir, 'uploads.db'), 'runtime data\n');
    const marker = path.join(base, 'hook-ran');
    const hook = path.join(dir, '.git', 'hooks', 'post-checkout');
    await writeFile(hook, `#!/bin/sh\ntouch ${marker}\n`);
    await chmod(hook, 0o755);
    const r = await deploy(dir, shas[1] ?? '');
    expect(r.end).toMatchObject({ code: 0 });
    expect(r.progress).not.toContain('git init');
    expect(await readFile(path.join(dir, 'app.txt'), 'utf8')).toBe('v2\n');
    expect(await readFile(path.join(dir, 'uploads.db'), 'utf8')).toBe('runtime data\n');
    await expect(lstat(marker)).rejects.toThrow();
  });

  it('rolls back to an older sha', async () => {
    const dir = path.join(root, 'apps', 'site');
    const r = await deploy(dir, shas[0] ?? '');
    expect(r.end).toMatchObject({ code: 0 });
    expect(await readFile(path.join(dir, 'app.txt'), 'utf8')).toBe('v1\n');
  });

  it('refuses an existing repo whose origin differs', async () => {
    const dir = path.join(root, 'apps', 'site');
    await expect(deploy(dir, shas[1] ?? '', `file://${base}/other.git`)).rejects.toMatchObject({
      code: 'not_allowed',
    });
  });

  it('ends with git exit code for an unknown sha', async () => {
    const dir = path.join(root, 'apps', 'site');
    const r = await deploy(dir, 'b'.repeat(40));
    expect(r.end?.code).not.toBe(0);
    expect(r.end?.error).toMatch(/checkout/);
  });

  it('the file transport is refused without the test override', async () => {
    const dir = path.join(root, 'apps', 'nofile');
    const sent: (StreamData | StreamEnd)[] = [];
    const c = ctx(sent);
    const { init } = await prepareDir(dir, c.homelabRoot);
    const sink = c.streams.open('rpc_git_nofile1');
    c.streams.activate(sink.id);
    await runDeploy(
      {
        dir,
        repoUrl: `file://${remote}`,
        sha: shas[0] ?? '',
        method: 'script',
        init,
        protocols: ['https', 'ssh'],
      },
      c,
      sink,
    );
    const end = sent.find((m): m is StreamEnd => m.type === 'stream.end');
    expect(end?.code).not.toBe(0);
    await expect(lstat(path.join(dir, 'app.txt'))).rejects.toThrow();
  });
});
