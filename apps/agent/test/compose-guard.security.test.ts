import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { composeDown, composePull, composeUp } from '../src/actions/compose.js';
import { normalizeProjectName, relativePaths } from '../src/actions/compose-guard.js';
import type { HostContext } from '../src/host.js';
import { makeCtx } from './game-helpers.js';

let base: string;
let root: string;
let apps: string;
let outside: string;

const DIR_LABEL = 'com.docker.compose.project.working_dir';
const PROJECT_LABEL = 'com.docker.compose.project';

interface Fake {
  Id: string;
  Labels: Record<string, string>;
}

/** Docker mock that honours the label filter (key=value). */
function dockerWith(containers: Fake[]): HostContext['docker'] {
  return {
    listContainers: async (opts: { filters: string }) => {
      const want = (JSON.parse(opts.filters) as { label: string[] }).label;
      return containers.filter((c) =>
        want.every((l) => {
          const [k, v] = [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)];
          return c.Labels[k] === v;
        }),
      );
    },
    getContainer: (id: string) => ({
      inspect: async () => {
        const c = containers.find((x) => x.Id === id);
        if (!c) throw new Error('no such container');
        return { Id: c.Id, Config: { Labels: c.Labels } };
      },
    }),
  } as unknown as HostContext['docker'];
}

const container = (n: number, labels: Record<string, string>): Fake => ({
  Id: String(n).repeat(64).slice(0, 64),
  Labels: labels,
});

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hz-guard-')));
  root = path.join(base, 'homelab');
  apps = path.join(root, 'apps');
  outside = path.join(base, 'outside');
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});
beforeEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
  await mkdir(apps, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'agent.env'), 'HZ_AGENT_TOKEN=secret\n');
});

async function makeApp(id: string, compose: string, env?: string): Promise<string> {
  const dir = path.join(apps, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'compose.yml'), compose);
  if (env !== undefined) await writeFile(path.join(dir, '.env'), env, { mode: 0o600 });
  return dir;
}

const SIMPLE = 'services:\n  web:\n    image: nginx:1.27.0\n';

describe('compose project name collisions', () => {
  it('a new stack named like the agent project is refused (no compose run)', async () => {
    const dir = await makeApp('homelab-agent', SIMPLE);
    const { ctx, rec } = makeCtx(root);
    ctx.host = {
      ...ctx.host,
      docker: dockerWith([
        container(1, {
          [PROJECT_LABEL]: 'homelab-agent',
          [DIR_LABEL]: '/etc/homelab-agent',
          'hz.role': 'agent',
        }),
      ]),
    };
    for (const op of [composeUp, composeDown, composePull]) {
      await expect(op({ dir }, ctx)).rejects.toMatchObject({ code: 'not_allowed' });
    }
    expect(rec.runs).toEqual([]);
  });

  it('a new stack whose derived name belongs to another folder is refused', async () => {
    const dir = await makeApp('jellyfin', SIMPLE);
    const { ctx, rec } = makeCtx(root);
    ctx.host = {
      ...ctx.host,
      docker: dockerWith([
        container(2, { [PROJECT_LABEL]: 'jellyfin', [DIR_LABEL]: path.join(root, 'jellyfin') }),
      ]),
    };
    await expect(composeUp({ dir }, ctx)).rejects.toMatchObject({
      code: 'not_allowed',
      message: expect.stringContaining('already used by another stack'),
    });
    expect(rec.runs).toEqual([]);
  });

  it('honours COMPOSE_PROJECT_NAME in .env and top-level name: for the check', async () => {
    const other = dockerWith([
      container(3, { [PROJECT_LABEL]: 'shared', [DIR_LABEL]: path.join(root, 'other') }),
    ]);
    const a = await makeApp('a1', SIMPLE, 'COMPOSE_PROJECT_NAME=shared\n');
    const b = await makeApp('b1', `name: shared\n${SIMPLE}`);
    for (const dir of [a, b]) {
      const { ctx, rec } = makeCtx(root);
      ctx.host = { ...ctx.host, docker: other };
      await expect(composeUp({ dir }, ctx)).rejects.toMatchObject({ code: 'not_allowed' });
      expect(rec.runs).toEqual([]);
    }
  });

  it('refuses a project name built from variables', async () => {
    const dir = await makeApp('vars', `name: \${EVIL}\n${SIMPLE}`);
    const { ctx, rec } = makeCtx(root);
    ctx.host = { ...ctx.host, docker: dockerWith([]) };
    await expect(composeUp({ dir }, ctx)).rejects.toMatchObject({ code: 'bad_path' });
    expect(rec.runs).toEqual([]);
  });

  it('a free new stack runs with exactly the checked name as -p', async () => {
    const dir = await makeApp('vault', SIMPLE);
    const { ctx, rec } = makeCtx(root);
    ctx.host = { ...ctx.host, docker: dockerWith([]) };
    await composeUp({ dir }, ctx);
    const args = rec.runs[0]?.args ?? [];
    expect(args[args.indexOf('-p') + 1]).toBe('vault');
  });

  it('an existing project keeps its name from the labels (no rename)', async () => {
    const dir = await makeApp('site', SIMPLE);
    const { ctx, rec } = makeCtx(root);
    ctx.host = {
      ...ctx.host,
      docker: dockerWith([
        container(4, {
          [PROJECT_LABEL]: 'my-site-prod',
          [DIR_LABEL]: dir,
          'com.docker.compose.project.config_files': path.join(dir, 'compose.yml'),
        }),
      ]),
    };
    await composeUp({ dir }, ctx);
    const args = rec.runs[0]?.args ?? [];
    expect(args[args.indexOf('-p') + 1]).toBe('my-site-prod');
  });

  it('an existing project that also contains an hz.role container elsewhere is refused', async () => {
    const dir = await makeApp('mixed', SIMPLE);
    const { ctx, rec } = makeCtx(root);
    ctx.host = {
      ...ctx.host,
      docker: dockerWith([
        container(5, { [PROJECT_LABEL]: 'mixed', [DIR_LABEL]: dir }),
        container(6, { [PROJECT_LABEL]: 'mixed', [DIR_LABEL]: '/srv/core', 'hz.role': 'core' }),
      ]),
    };
    await expect(composeDown({ dir }, ctx)).rejects.toMatchObject({ code: 'not_allowed' });
    expect(rec.runs).toEqual([]);
  });

  it('normalizes folder names like compose', () => {
    expect(normalizeProjectName('My.App_1')).toBe('myapp_1');
    expect(normalizeProjectName('-_x')).toBe('x');
  });
});

describe('planted symlinks before compose.up', () => {
  const withMount = (src: string, extra = '') =>
    `services:\n  web:\n    image: nginx:1.27.0\n    volumes:\n      - ${src}:/c\n${extra}`;

  it.each([
    ['a bind source that is a symlink', './data/c', ['data/c']],
    ['a symlinked parent of the bind source', './data/sub/c', ['data']],
  ])('refuses %s (no compose run)', async (_l, src, linkAt) => {
    const dir = await makeApp('plant', withMount(src));
    await mkdir(path.join(dir, 'data'), { recursive: true });
    for (const l of linkAt) {
      await rm(path.join(dir, l), { recursive: true, force: true });
      await symlink(l === 'data' ? outside : path.join(outside, 'agent.env'), path.join(dir, l));
    }
    const { ctx, rec } = makeCtx(root);
    await expect(composeUp({ dir }, ctx)).rejects.toMatchObject({ code: 'bad_path' });
    expect(rec.runs).toEqual([]);
  });

  it('checks long syntax source:, configs/secrets file: and env_file', async () => {
    const variants = [
      'services:\n  web:\n    image: nginx:1.27.0\n    volumes:\n      - type: bind\n        source: ./data/c\n        target: /c\n',
      'services:\n  web:\n    image: nginx:1.27.0\nsecrets:\n  s:\n    file: ./data/c\n',
      'services:\n  web:\n    image: nginx:1.27.0\n    env_file:\n      - ./data/c\n',
    ];
    for (const [i, compose] of variants.entries()) {
      const dir = await makeApp(`long${i}`, compose);
      await mkdir(path.join(dir, 'data'), { recursive: true });
      await symlink(path.join(outside, 'agent.env'), path.join(dir, 'data', 'c'));
      const { ctx, rec } = makeCtx(root);
      await expect(composeUp({ dir }, ctx)).rejects.toMatchObject({ code: 'bad_path' });
      expect(rec.runs).toEqual([]);
    }
  });

  it('refuses relative paths that leave the stack folder', async () => {
    const dir = await makeApp('escape', withMount('../../outside'));
    const { ctx, rec } = makeCtx(root);
    await expect(composeUp({ dir }, ctx)).rejects.toMatchObject({ code: 'bad_path' });
    expect(rec.runs).toEqual([]);
  });

  it('allows real folders, missing sources and symlinks inside a mounted folder', async () => {
    const dir = await makeApp(
      'fine',
      withMount('./data/c', '      - ./data/missing/x:/m\n      - ./data/file.conf:/f:ro\n'),
    );
    await mkdir(path.join(dir, 'data', 'c'), { recursive: true });
    await writeFile(path.join(dir, 'data', 'file.conf'), 'x');
    // inside the mounted folder: resolved in the container, never by Docker on the host
    await symlink('/etc/passwd', path.join(dir, 'data', 'c', 'inner'));
    const { ctx, rec } = makeCtx(root);
    await expect(composeUp({ dir }, ctx)).resolves.toBeDefined();
    expect(rec.runs).toHaveLength(1);
  });

  it('finds relative paths in the usual compose spellings, ignores comments and URLs', () => {
    expect(
      relativePaths(
        [
          "      - './data/a:/a'",
          '      - ./data/b:/b:ro',
          '        source: ./data/c',
          '    file: "./data/d"',
          '      - .:/app',
          '    # - ./data/commented:/x',
          '      PAPERLESS_REDIS: redis://broker:6379',
          '    env_file: [./data/e, ../f]',
        ].join('\n'),
      ).sort(),
    ).toEqual(['.', '../f', './data/a', './data/b', './data/c', './data/d', './data/e'].sort());
  });
});
