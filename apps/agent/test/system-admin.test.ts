import { describe, expect, it, vi } from 'vitest';
import type Docker from 'dockerode';
import { summarizeDockerDf } from '../src/actions/system-docker-df.js';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  APT_GET,
  APT_UPDATE_ARGS,
  APT_UPGRADE_ARGS,
  parseAptSummary,
} from '../src/actions/system-upgrade.js';
import { ok, rpc, setupAdmin, type ExecFn } from './admin-helpers.js';

describe('system.shutdown', () => {
  it('requires confirmName to equal HZ_AGENT_NAME (denied event, nothing scheduled)', async () => {
    const { d, events, later, execCalls } = setupAdmin();
    const res = await d.handle(rpc('system.shutdown', { confirmName: 'heimserver' }));
    expect(res).toMatchObject({ ok: false, error: { code: 'confirm_mismatch' } });
    expect(events[0]?.event).toMatchObject({ kind: 'denied', action: 'system.shutdown' });
    expect(later).not.toHaveBeenCalled();
    expect(execCalls).toEqual([]);
  });

  it.each([
    {},
    { confirmName: '' },
    { confirmName: 'Oracle-A1' },
    { confirmName: 'oracle-a1', now: true },
  ])('rejects malformed params %j', async (params) => {
    const { d, later } = setupAdmin();
    const res = await d.handle(rpc('system.shutdown', params));
    expect(res).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    expect(later).not.toHaveBeenCalled();
  });

  it('schedules systemctl poweroff when confirmed', async () => {
    const { d, later, execCalls } = setupAdmin(() => ok('systemd 252'));
    const res = await d.handle(rpc('system.shutdown', { confirmName: 'oracle-a1' }));
    expect(res).toMatchObject({ ok: true, data: { scheduled: true } });
    (later.mock.calls[0]?.[0] as () => void)();
    expect(execCalls.map((c) => [c.file, ...c.args])).toEqual([
      ['systemctl', '--version'],
      ['systemctl', 'poweroff'],
    ]);
  });

  it('reboot keeps refusing a wrong name too', async () => {
    const { d, later } = setupAdmin();
    const res = await d.handle(rpc('system.reboot', { confirmName: 'pi' }));
    expect(res).toMatchObject({ ok: false, error: { code: 'confirm_mismatch' } });
    expect(later).not.toHaveBeenCalled();
  });
});

describe('system.upgrade', () => {
  const OUT = [
    'Reading package lists...',
    'The following packages will be upgraded:',
    '  curl libcurl4',
    '2 upgraded, 0 newly installed, 0 to remove and 3 not upgraded.',
  ].join('\n');

  it('parses the apt summary', () => {
    expect(parseAptSummary(OUT)).toEqual({ upgraded: 2, kept: 3 });
    expect(
      parseAptSummary('0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.'),
    ).toEqual({
      upgraded: 0,
      kept: 0,
    });
    expect(parseAptSummary('nothing')).toBeNull();
  });

  it('runs apt-get update + upgrade with fixed arguments only', async () => {
    const exec: ExecFn = (_f, a) => (a.includes('upgrade') ? ok(OUT) : ok('apt 2.6.1'));
    const { d, execCalls } = setupAdmin(exec);
    const res = await d.handle(rpc('system.upgrade', {}));
    expect(res).toMatchObject({ ok: true, data: { upgraded: 2, kept: 3, rebootRequired: false } });
    expect(execCalls.map((c) => [c.file, ...c.args])).toEqual([
      ['apt-get', '--version'],
      ['apt-get', 'update', '-q'],
      ['apt-get', ...APT_UPGRADE_ARGS],
    ]);
    const args = execCalls[2]?.args ?? [];
    expect(args).toContain('upgrade');
    for (const bad of [
      'dist-upgrade',
      'full-upgrade',
      'autoremove',
      '--allow-remove-essential',
      'remove',
      'purge',
    ]) {
      expect(args).not.toContain(bad);
    }
    expect(args).toContain('Dpkg::Options::=--force-confold');
    expect(execCalls[2]?.opts?.timeoutMs).toBeGreaterThan(30 * 60_000);
  });

  it('refuses any params', async () => {
    const { d, execCalls } = setupAdmin();
    const res = await d.handle(rpc('system.upgrade', { packages: ['x'] }));
    expect(res).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    expect(execCalls).toEqual([]);
  });

  it('fails on hosts without apt', async () => {
    const { d, execCalls } = setupAdmin(() => ({ code: 127, stdout: '', stderr: '' }));
    const res = await d.handle(rpc('system.upgrade', {}));
    expect(res).toMatchObject({
      ok: false,
      error: { code: 'failed', message: expect.stringMatching(/apt/) },
    });
    expect(execCalls).toHaveLength(1);
  });
});

describe('system.upgrade in a transient systemd unit', () => {
  const OUT = '5 upgraded, 0 newly installed, 0 to remove and 1 not upgraded.\n';

  async function hostWithSystemd(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hz-upg-'));
    await mkdir(path.join(root, 'run', 'systemd', 'system'), { recursive: true });
    return root;
  }

  it('runs apt-get via systemd-run with fixed argv and reads the summary from the unit log', async () => {
    const root = await hostWithSystemd();
    try {
      const exec: ExecFn = async (file, args) => {
        if (file === 'systemd-run' && args[0] !== '--version') {
          const unit = args[0]?.replace('--unit=', '') ?? '';
          await writeFile(
            path.join(root, 'run', `${unit}.log`),
            args.includes('upgrade') ? OUT : 'ok\n',
          );
        }
        return ok('x 1');
      };
      const { d, execCalls, ctx } = setupAdmin(exec);
      ctx.host.hostRoot = root;
      const res = await d.handle(rpc('system.upgrade', {}));
      expect(res).toMatchObject({ ok: true, data: { upgraded: 5, kept: 1 } });
      const runs = execCalls.filter((c) => c.file === 'systemd-run' && c.args[0] !== '--version');
      expect(runs).toHaveLength(2);
      for (const [i, aptArgs] of [APT_UPDATE_ARGS, APT_UPGRADE_ARGS].entries()) {
        const a = runs[i]?.args ?? [];
        expect(a[0]).toMatch(/^--unit=hz-upgrade-[0-9a-f]{8}$/);
        const unit = (a[0] ?? '').slice('--unit='.length);
        expect(a.slice(1)).toEqual([
          '--collect',
          '--wait',
          '--quiet',
          '--service-type=exec',
          `--property=StandardOutput=file:/run/${unit}.log`,
          '--property=StandardError=inherit',
          '--setenv=DEBIAN_FRONTEND=noninteractive',
          '--setenv=LANG=C',
          '--setenv=LC_ALL=C',
          '--',
          APT_GET,
          ...aptArgs,
        ]);
      }
      // apt-get itself only for the probe; never directly in the agent's cgroup.
      expect(execCalls.filter((c) => c.file === 'apt-get').map((c) => c.args)).toEqual([
        ['--version'],
      ]);
      // Logs are removed after reading.
      expect((await readdir(path.join(root, 'run'))).filter((f) => f.endsWith('.log'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('after 40 min it stops waiting but never stops the unit', async () => {
    const root = await hostWithSystemd();
    try {
      const exec: ExecFn = (file, args) =>
        file === 'systemd-run' && args.includes('upgrade')
          ? { code: null, stdout: '', stderr: '', error: 'timeout' }
          : ok('x 1');
      const { d, execCalls, ctx } = setupAdmin(exec);
      ctx.host.hostRoot = root;
      const res = await d.handle(rpc('system.upgrade', {}));
      expect(res).toMatchObject({
        ok: false,
        error: { code: 'timeout', message: expect.stringMatching(/left running/) },
      });
      expect(execCalls.some((c) => c.file === 'systemctl')).toBe(false);
      const up = execCalls.find((c) => c.file === 'systemd-run' && c.args.includes('upgrade'));
      expect(up?.opts?.timeoutMs).toBeGreaterThan(30 * 60_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('falls back to apt-get directly when systemd-run is missing', async () => {
    const root = await hostWithSystemd();
    try {
      const exec: ExecFn = (file, a) =>
        file === 'systemd-run'
          ? { code: 127, stdout: '', stderr: '' }
          : a.includes('upgrade')
            ? ok(OUT)
            : ok('x');
      const { d, execCalls, ctx } = setupAdmin(exec);
      ctx.host.hostRoot = root;
      const res = await d.handle(rpc('system.upgrade', {}));
      expect(res).toMatchObject({ ok: true, data: { upgraded: 5 } });
      expect(execCalls.filter((c) => c.file === 'apt-get').map((c) => c.args[0])).toEqual([
        '--version',
        'update',
        '-y',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('system.dockerDf', () => {
  it('summarizes images, containers, volumes and build cache', () => {
    expect(
      summarizeDockerDf({
        LayersSize: 900,
        Images: [
          { Size: 500, SharedSize: 100, Containers: 1 },
          { Size: 300, SharedSize: 100, Containers: 0 },
          { Size: 200, SharedSize: -1, Containers: 0 },
        ],
        Containers: [
          { State: 'running', SizeRw: 10 },
          { State: 'exited', SizeRw: 5 },
        ],
        Volumes: [
          { UsageData: { Size: 1000, RefCount: 1 } },
          { UsageData: { Size: 50, RefCount: 0 } },
          { UsageData: { Size: -1, RefCount: 0 } },
        ],
        BuildCache: [
          { Size: 70, InUse: false },
          { Size: 30, InUse: true },
        ],
      }),
    ).toEqual({
      images: { count: 3, bytes: 900, unusedCount: 2, unusedBytes: 400 },
      containers: { count: 2, running: 1, bytes: 15 },
      volumes: { count: 3, bytes: 1050, unusedCount: 2, unusedBytes: 50 },
      buildCache: { count: 2, bytes: 100, unusedBytes: 70 },
    });
  });

  it('copes with an empty answer', () => {
    expect(summarizeDockerDf({}).images).toEqual({
      count: 0,
      bytes: 0,
      unusedCount: 0,
      unusedBytes: 0,
    });
  });
});

describe('system.cleanup items', () => {
  function dockerFake() {
    return {
      pruneImages: vi.fn(async () => ({ SpaceReclaimed: 100 })),
      pruneBuilder: vi.fn(async () => ({ SpaceReclaimed: 7 })),
      pruneContainers: vi.fn(),
      pruneVolumes: vi.fn(),
      df: vi.fn(async () => ({})),
    };
  }

  it('only "docker-build-cache" prunes only the build cache', async () => {
    const docker = dockerFake();
    const { d, ctx, execCalls } = setupAdmin();
    ctx.host.docker = docker as unknown as Docker;
    const res = await d.handle(rpc('system.cleanup', { items: ['docker-build-cache'] }));
    expect(res).toMatchObject({ ok: true, data: { freedBytes: 7 } });
    expect(docker.pruneBuilder).toHaveBeenCalledTimes(1);
    expect(docker.pruneImages).not.toHaveBeenCalled();
    expect(docker.pruneContainers).not.toHaveBeenCalled();
    expect(docker.pruneVolumes).not.toHaveBeenCalled();
    expect(execCalls).toEqual([]);
  });

  it('without items cleans everything, never containers or volumes', async () => {
    const docker = dockerFake();
    const { d, ctx } = setupAdmin(() =>
      ok('Archived and active journals take up 100.0M in the file system.'),
    );
    ctx.host.docker = docker as unknown as Docker;
    const res = await d.handle(rpc('system.cleanup', {}));
    expect(res.ok).toBe(true);
    expect(docker.pruneImages).toHaveBeenCalledTimes(1);
    expect(docker.pruneBuilder).toHaveBeenCalledTimes(1);
    expect(docker.pruneContainers).not.toHaveBeenCalled();
    expect(docker.pruneVolumes).not.toHaveBeenCalled();
  });

  it.each([
    { items: [] },
    { items: ['containers'] },
    { items: ['journal', 'journal'] },
    { items: ['volumes'] },
  ])('rejects %j', async (params) => {
    const { d } = setupAdmin();
    const res = await d.handle(rpc('system.cleanup', params));
    expect(res).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
  });
});
