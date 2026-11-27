import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDuOutput, summarizeDu } from '../src/actions/system-du.js';
import { resolveDuPath, resolveHostPath } from '../src/host-resolve.js';
import { ok, rpc, setupAdmin } from './admin-helpers.js';

let hostRoot: string;

beforeAll(async () => {
  hostRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hz-du-')));
  for (const d of ['proc/1', 'sys', 'run/user', 'dev', 'var/lib/docker', 'home/anna', 'srv'])
    await mkdir(path.join(hostRoot, d), { recursive: true });
  await writeFile(path.join(hostRoot, 'var', 'big.img'), 'x');
  // Absolute symlinks are relative to the HOST root, not to the agent's root.
  await symlink('/proc', path.join(hostRoot, 'var', 'x'));
  await symlink('/proc/1', path.join(hostRoot, 'var', 'deep'));
  await symlink('../../run/user', path.join(hostRoot, 'var', 'lib', 'rel'));
  await symlink('/sys', path.join(hostRoot, 'srv', 'sys-link'));
  await symlink('/home/anna', path.join(hostRoot, 'srv', 'anna'));
  await symlink('loop2', path.join(hostRoot, 'srv', 'loop1'));
  await symlink('loop1', path.join(hostRoot, 'srv', 'loop2'));
  await symlink('/var/x', path.join(hostRoot, 'srv', 'chain'));
  await symlink('../../../../..', path.join(hostRoot, 'srv', 'up'));
});
afterAll(async () => {
  await rm(hostRoot, { recursive: true, force: true });
});

const ctx = () => ({ hostRoot });

describe('host path resolution (inside the host root)', () => {
  it('resolves absolute targets against the host root', async () => {
    expect(await resolveHostPath(ctx(), '/srv/anna')).toEqual({ ok: true, path: '/home/anna' });
    expect(await resolveHostPath(ctx(), '/var/x')).toEqual({ ok: true, path: '/proc' });
  });

  it('never climbs above the host root with ..', async () => {
    expect(await resolveHostPath(ctx(), '/srv/up')).toEqual({ ok: true, path: '/' });
  });

  it('refuses symlink loops and missing paths', async () => {
    expect(await resolveHostPath(ctx(), '/srv/loop1')).toMatchObject({ ok: false });
    expect(await resolveHostPath(ctx(), '/nope')).toMatchObject({ ok: false });
  });
});

describe('system.du path check (after realpath)', () => {
  it.each(['/var/x', '/var/deep', '/var/lib/rel', '/srv/sys-link', '/srv/chain'])(
    '%s resolves into a denied root and is refused',
    async (p) => {
      const r = await resolveDuPath(ctx(), p);
      expect(r).toMatchObject({ ok: false });
    },
  );

  it('allows a normal directory and a symlink to one', async () => {
    expect(await resolveDuPath(ctx(), '/var')).toEqual({ ok: true, path: '/var' });
    expect(await resolveDuPath(ctx(), '/srv/anna')).toEqual({ ok: true, path: '/home/anna' });
    expect(await resolveDuPath(ctx(), '/')).toEqual({ ok: true, path: '/' });
  });

  it('refuses files', async () => {
    expect(await resolveDuPath(ctx(), '/var/big.img')).toMatchObject({ ok: false });
  });

  it('refuses /proc mounted somewhere else (pseudo file system)', async () => {
    // Pretend the host root is the test machine's procfs: /self -> /<pid> is a normal-looking
    // directory name, but statfs says proc.
    const r = await resolveDuPath({ hostRoot: '/proc' }, '/self');
    expect(r).toEqual({ ok: false, reason: 'path not allowed (pseudo file system)' });
  });

  it('through the dispatcher: bad_path, denied event, du never runs', async () => {
    const { d, events, execCalls, ctx: c } = setupAdmin();
    c.host.hostRoot = hostRoot;
    const res = await d.handle(rpc('system.du', { path: '/var/x' }));
    expect(res).toMatchObject({ ok: false, error: { code: 'bad_path' } });
    expect(events[0]?.event).toMatchObject({ kind: 'denied', action: 'system.du' });
    expect(execCalls).toEqual([]);
  });

  it.each(['/proc', '/sys/kernel', '/dev', '/run/x', 'var', '/var/../proc', '/var/', '//var'])(
    'schema refuses %s before anything runs',
    async (p) => {
      const { d, execCalls } = setupAdmin();
      const res = await d.handle(rpc('system.du', { path: p }));
      expect(res).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
      expect(execCalls).toEqual([]);
    },
  );

  it('runs du with fixed flags on the resolved path and returns the children', async () => {
    const out = ['1000\t/home/anna/a', '5000\t/home/anna/b', '6100\t/home/anna', ''].join('\0');
    const { d, execCalls, ctx: c } = setupAdmin(() => ok(out));
    c.host.hostRoot = hostRoot;
    const res = await d.handle(rpc('system.du', { path: '/srv/anna' }));
    expect(execCalls[0]).toMatchObject({
      file: 'du',
      args: ['-x', '-a', '-B1', '-d1', '-0', '--', '/home/anna'],
    });
    expect(res).toMatchObject({
      ok: true,
      data: {
        path: '/home/anna',
        totalBytes: 6100,
        entries: [
          { name: 'b', bytes: 5000, dir: false },
          { name: 'a', bytes: 1000, dir: false },
        ],
        truncated: false,
      },
    });
  });

  it('a du timeout is reported as timeout', async () => {
    const { d, ctx: c } = setupAdmin(() => ({
      code: null,
      stdout: '',
      stderr: '',
      error: 'timeout',
    }));
    c.host.hostRoot = hostRoot;
    const res = await d.handle(rpc('system.du', { path: '/var' }));
    expect(res).toMatchObject({ ok: false, error: { code: 'timeout' } });
  });

  it('fails soft when du is missing', async () => {
    const { d, ctx: c, events } = setupAdmin(() => ({ code: 127, stdout: '', stderr: '' }));
    c.host.hostRoot = hostRoot;
    const res = await d.handle(rpc('system.du', { path: '/var' }));
    expect(res).toMatchObject({ ok: false, error: { code: 'failed' } });
    expect(events).toEqual([]);
  });
});

describe('du parser', () => {
  it('parses NUL records, names with newlines and tabs', () => {
    const out = '10\t/var/a\nb\0' + '20\t/var/c\td\0' + 'junk\0' + '30\t/var\0';
    expect(parseDuOutput(out)).toEqual([
      { bytes: 10, path: '/var/a\nb' },
      { bytes: 20, path: '/var/c\td' },
      { bytes: 30, path: '/var' },
    ]);
  });

  it('total is the line of the dir itself; children largest first, basename only', () => {
    const s = summarizeDu('/', [
      { bytes: 5, path: '/etc' },
      { bytes: 50, path: '/var' },
      { bytes: 1, path: '/var/deeper' },
      { bytes: 60, path: '/' },
    ]);
    expect(s).toEqual({
      totalBytes: 60,
      children: [
        { name: 'var', bytes: 50 },
        { name: 'etc', bytes: 5 },
      ],
    });
  });

  it('caps at 30 entries and marks truncated', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `${i + 1}\t/var/f${i}`);
    const out = [...lines, '999\t/var', ''].join('\0');
    const { d, ctx: c } = setupAdmin(() => ok(out));
    c.host.hostRoot = hostRoot;
    const res = await d.handle(rpc('system.du', { path: '/var' }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const data = res.data as { entries: { name: string }[]; truncated: boolean };
    expect(data.entries).toHaveLength(30);
    expect(data.entries[0]?.name).toBe('f39');
    expect(data.truncated).toBe(true);
  });
});
