import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveHomelabPath } from '../src/paths.js';

let base: string;
let root: string;
let outside: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hz-paths-')));
  root = path.join(base, 'homelab');
  outside = path.join(base, 'outside');
  await mkdir(path.join(root, 'games', 'mc'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'secret.txt'), 'x');
  await writeFile(path.join(root, 'games', 'mc', 'compose.yml'), 'x');
  // Symlink inside the root that points outside.
  await symlink(outside, path.join(root, 'escape'));
  // Symlink to /etc.
  await symlink('/etc', path.join(root, 'etc-link'));
  // Symlink that stays inside the root.
  await symlink(path.join(root, 'games'), path.join(root, 'games-link'));
  // Dangling symlink pointing outside (a write through it would land outside).
  await symlink(path.join(outside, 'not-yet'), path.join(root, 'dangling'));
  // Loop.
  await symlink(path.join(root, 'loop-b'), path.join(root, 'loop-a'));
  await symlink(path.join(root, 'loop-a'), path.join(root, 'loop-b'));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const r = (p: string) => resolveHomelabPath(p, `${root}/`);

describe('resolveHomelabPath', () => {
  it('accepts an existing directory below the root', async () => {
    expect(await r(`${root}/games/mc`)).toEqual({ ok: true, path: `${root}/games/mc` });
  });

  it('accepts a path that does not exist yet (parent is resolved)', async () => {
    expect(await r(`${root}/games/new-server/data`)).toEqual({
      ok: true,
      path: `${root}/games/new-server/data`,
    });
  });

  it('follows symlinks that stay inside and returns the real path', async () => {
    expect(await r(`${root}/games-link/mc`)).toEqual({ ok: true, path: `${root}/games/mc` });
  });

  it('rejects a symlink that points outside', async () => {
    expect((await r(`${root}/escape`)).ok).toBe(false);
    expect((await r(`${root}/escape/secret.txt`)).ok).toBe(false);
    expect((await r(`${root}/etc-link/passwd`)).ok).toBe(false);
  });

  it('rejects a non-existing path below an escaping symlink', async () => {
    expect((await r(`${root}/escape/new/dir`)).ok).toBe(false);
  });

  it('rejects dangling symlinks and loops', async () => {
    expect(await r(`${root}/dangling`)).toMatchObject({ ok: false });
    expect(await r(`${root}/dangling/sub`)).toMatchObject({ ok: false });
    expect(await r(`${root}/loop-a`)).toMatchObject({ ok: false });
  });

  it('rejects .. traversal', async () => {
    expect((await r(`${root}/../outside/secret.txt`)).ok).toBe(false);
    expect((await r(`${root}/games/../../outside`)).ok).toBe(false);
  });

  it('rejects the root itself and foreign absolute paths', async () => {
    expect((await r(root)).ok).toBe(false);
    expect((await r(`${root}/`)).ok).toBe(false);
    expect((await r('/etc/passwd')).ok).toBe(false);
    expect((await r(`${root}-evil/x`)).ok).toBe(false);
    expect((await r(outside)).ok).toBe(false);
  });

  it('rejects relative paths, NUL bytes and non-strings', async () => {
    expect((await r('games/mc')).ok).toBe(false);
    expect((await r(`${root}/games\0/mc`)).ok).toBe(false);
    expect((await resolveHomelabPath(42, root)).ok).toBe(false);
    expect((await resolveHomelabPath(undefined, root)).ok).toBe(false);
    expect((await r('')).ok).toBe(false);
  });

  it('defaults to /opt/homelab/', async () => {
    expect((await resolveHomelabPath('/etc/passwd')).ok).toBe(false);
    expect((await resolveHomelabPath('/opt/homelab/../etc')).ok).toBe(false);
  });

  it('works when the root itself is a symlink', async () => {
    const linkRoot = path.join(base, 'root-link');
    await symlink(root, linkRoot);
    expect(await resolveHomelabPath(`${linkRoot}/games/mc`, `${linkRoot}/`)).toEqual({
      ok: true,
      path: `${root}/games/mc`,
    });
    expect((await resolveHomelabPath(`${linkRoot}/escape`, `${linkRoot}/`)).ok).toBe(false);
  });
});
