import { PassThrough } from 'node:stream';
import type Docker from 'dockerode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentEventSchema, containerInfoSchema } from '@hz/shared';
import {
  ContainerCollector,
  cpuPercent,
  cpuSample,
  detailsFromInspect,
  mapContainer,
  memoryUsage,
  normalizeDockerTime,
} from '../src/collect/docker.js';
import { DockerEventWatcher, JsonLines, mapDockerEvent } from '../src/collect/docker-events.js';
import { debounce } from '../src/debounce.js';
import { createLogger } from '../src/log.js';

const ID = 'c'.repeat(64);
const ev = (Action: string, Attributes: Record<string, string> = {}) => ({
  Type: 'container',
  Action,
  Actor: { ID, Attributes: { name: 'web', ...Attributes } },
  time: 1,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('docker event mapping', () => {
  it('maps die with exit code', () => {
    const m = mapDockerEvent(ev('die', { exitCode: '137' }));
    expect(m).toEqual({
      dockerId: ID,
      event: { kind: 'container', dockerId: ID, name: 'web', action: 'die', exitCode: 137 },
    });
    expect(
      agentEventSchema.safeParse({ type: 'event', ts: new Date().toISOString(), event: m?.event })
        .success,
    ).toBe(true);
  });

  it('maps health_status and oom', () => {
    expect(mapDockerEvent(ev('health_status: unhealthy'))?.event).toEqual({
      kind: 'container',
      dockerId: ID,
      name: 'web',
      action: 'health_status',
      health: 'unhealthy',
    });
    expect(mapDockerEvent(ev('oom'))?.event).toEqual({ kind: 'oom', dockerId: ID, name: 'web' });
  });

  it('reports start/stop/restart, only refreshes on create/destroy/kill', () => {
    for (const a of ['start', 'stop', 'restart'])
      expect(mapDockerEvent(ev(a))?.event).toBeDefined();
    for (const a of ['create', 'destroy', 'kill', 'pause', 'rename']) {
      const m = mapDockerEvent(ev(a));
      expect(m).toEqual({ dockerId: ID });
    }
  });

  it('ignores exec events, other types and garbage', () => {
    expect(mapDockerEvent(ev('exec_create: /bin/sh -c curl'))).toBeNull();
    expect(mapDockerEvent(ev('exec_die'))).toBeNull();
    expect(mapDockerEvent(ev('attach'))).toBeNull();
    expect(mapDockerEvent({ ...ev('start'), Type: 'network' })).toBeNull();
    expect(mapDockerEvent({ ...ev('start'), Actor: { ID: 'not-an-id' } })).toBeNull();
    expect(mapDockerEvent(null)).toBeNull();
    expect(mapDockerEvent('start')).toBeNull();
    expect(mapDockerEvent(ev('die', { exitCode: '1; rm' }))?.event).not.toHaveProperty('exitCode');
  });

  it('parses JSON lines across chunks', () => {
    const got: unknown[] = [];
    const j = new JsonLines((v) => got.push(v));
    j.push('{"a":1}\n{"b"');
    j.push(':2}\nnot json\n');
    j.push(Buffer.from('{"c":3}\n'));
    expect(got).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });
});

describe('debounce', () => {
  it('runs once after a burst', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 1000, 5000);
    for (let i = 0; i < 10; i += 1) {
      d.trigger();
      vi.advanceTimersByTime(100);
    }
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(d.pending).toBe(false);
  });

  it('runs at least every maxWait under constant events', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 1000, 5000);
    for (let i = 0; i < 100; i += 1) {
      d.trigger();
      vi.advanceTimersByTime(500);
    }
    // 50 s of events every 0.5 s -> about one run per 5 s
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(9);
    expect(fn.mock.calls.length).toBeLessThanOrEqual(11);
  });

  it('can be cancelled', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 1000);
    d.trigger();
    d.cancel();
    vi.advanceTimersByTime(10_000);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('event watcher', () => {
  it('forwards events, requests inventory and reconnects after the stream ends', async () => {
    vi.useFakeTimers();
    const streams: PassThrough[] = [];
    const docker = {
      getEvents: vi.fn(async () => {
        const s = new PassThrough();
        streams.push(s);
        return s;
      }),
    };
    const events: unknown[] = [];
    const changes: (string | null)[] = [];
    const w = new DockerEventWatcher(docker as unknown as Pick<Docker, 'getEvents'>, {
      log: createLogger('error', () => undefined),
      onEvent: (e) => events.push(e),
      onChange: (id) => changes.push(id),
      backoffBaseMs: 100,
      backoffMaxMs: 100,
    });
    w.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(docker.getEvents).toHaveBeenCalledTimes(1);
    expect(changes).toEqual([null]);
    streams[0]?.write(`${JSON.stringify(ev('stop'))}\n${JSON.stringify(ev('exec_start: x'))}\n`);
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toHaveLength(1);
    expect(changes).toEqual([null, ID]);

    streams[0]?.destroy();
    await vi.advanceTimersByTimeAsync(150);
    expect(docker.getEvents).toHaveBeenCalledTimes(2);
    // After a reconnect everything may have changed.
    expect(changes.at(-1)).toBeNull();
    w.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(docker.getEvents).toHaveBeenCalledTimes(2);
  });

  it('retries when subscribing fails', async () => {
    vi.useFakeTimers();
    let n = 0;
    const docker = {
      getEvents: vi.fn(async () => {
        n += 1;
        if (n < 3) throw new Error('daemon down');
        return new PassThrough();
      }),
    };
    const w = new DockerEventWatcher(docker as unknown as Pick<Docker, 'getEvents'>, {
      log: createLogger('error', () => undefined),
      onEvent: () => undefined,
      onChange: () => undefined,
      backoffBaseMs: 100,
      backoffMaxMs: 100,
    });
    w.start();
    await vi.advanceTimersByTimeAsync(500);
    expect(docker.getEvents).toHaveBeenCalledTimes(3);
    w.stop();
  });
});

describe('container details and stats', () => {
  it('reads inspect details', () => {
    expect(
      detailsFromInspect({
        Id: ID,
        RestartCount: 3,
        State: {
          Status: 'exited',
          ExitCode: 137,
          StartedAt: '2026-11-26T10:00:00.123456789Z',
          Health: { Status: 'unhealthy' },
        },
      }),
    ).toEqual({
      startedAt: '2026-11-26T10:00:00.123Z',
      restartCount: 3,
      exitCode: 137,
      health: 'unhealthy',
    });
    expect(normalizeDockerTime('0001-01-01T00:00:00Z')).toBeUndefined();
    expect(normalizeDockerTime('garbage')).toBeUndefined();
  });

  it('computes CPU share of the host and memory without file cache', () => {
    const a = cpuSample({
      cpu_stats: { cpu_usage: { total_usage: 1_000 }, system_cpu_usage: 10_000 },
    });
    const b = cpuSample({
      cpu_stats: { cpu_usage: { total_usage: 1_500 }, system_cpu_usage: 20_000 },
    });
    expect(a && b && cpuPercent(a, b)).toBe(5);
    expect(cpuSample({})).toBeNull();
    expect(memoryUsage({ memory_stats: { usage: 1000, stats: { inactive_file: 300 } } })).toBe(700);
    expect(
      memoryUsage({ memory_stats: { usage: 1000, stats: { total_inactive_file: 100 } } }),
    ).toBe(900);
    expect(memoryUsage({ memory_stats: {} })).toBeUndefined();
  });

  it('maps a running container with details and usage to a valid ContainerInfo', () => {
    const c = mapContainer(
      {
        Id: ID,
        Names: ['/web'],
        Image: 'nginx:1.27',
        ImageID: 'sha256:abc',
        Command: '',
        Created: 0,
        State: 'running',
        Status: 'Up 2 hours (healthy)',
        Ports: [
          { IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' },
          { IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' },
          { IP: '::', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' },
        ],
        Labels: {
          'com.docker.compose.project': 'web',
          'com.docker.compose.service': 'nginx',
          'com.docker.compose.project.working_dir': '/opt/homelab/web',
        },
        HostConfig: { NetworkMode: 'bridge' },
        NetworkSettings: { Networks: {} },
        Mounts: [],
      } as unknown as Docker.ContainerInfo,
      { startedAt: '2026-11-26T08:00:00.000Z', restartCount: 0, health: 'healthy' },
      { cpu: 2.5, memBytes: 1234 },
    );
    expect(c).not.toBeNull();
    expect(containerInfoSchema.safeParse(c).success).toBe(true);
    expect(c).toMatchObject({
      composeProject: 'web',
      composeService: 'nginx',
      composeDir: '/opt/homelab/web',
      startedAt: '2026-11-26T08:00:00.000Z',
      restartCount: 0,
      cpu: 2.5,
      memBytes: 1234,
      health: 'healthy',
    });
    expect(c?.ports).toHaveLength(2);
  });

  it('caches inspect, refreshes stats at most per interval and computes CPU from two samples', async () => {
    let now = 0;
    let usage = 1_000;
    let system = 10_000;
    const inspect = vi.fn(async () => ({
      Id: ID,
      RestartCount: 1,
      State: { Status: 'running', StartedAt: '2026-11-26T08:00:00Z' },
    }));
    const stats = vi.fn(async () => ({
      cpu_stats: { cpu_usage: { total_usage: usage }, system_cpu_usage: system },
      memory_stats: { usage: 5000, stats: { inactive_file: 1000 } },
    }));
    const docker = {
      listContainers: async () => [
        {
          Id: ID,
          Names: ['/web'],
          Image: 'nginx',
          State: 'running',
          Status: 'Up 1 hour',
          Ports: [],
          Labels: {},
        },
      ],
      getContainer: () => ({ inspect, stats }),
    };
    const col = new ContainerCollector(docker as never, {
      statsIntervalMs: 55_000,
      now: () => now,
    });
    const first = await col.list();
    expect(first[0]).toMatchObject({ memBytes: 4000, restartCount: 1 });
    expect(first[0]?.cpu).toBeUndefined();

    now = 10_000;
    await col.list();
    expect(stats).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledTimes(1);

    now = 60_000;
    usage = 2_000;
    system = 20_000;
    const third = await col.list();
    expect(stats).toHaveBeenCalledTimes(2);
    expect(third[0]?.cpu).toBe(10);

    col.invalidate(ID.slice(0, 12));
    await col.list();
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('leaves out hidden containers', async () => {
    const docker = {
      listContainers: async () => [
        {
          Id: ID,
          Names: ['/web'],
          Image: 'x',
          State: 'exited',
          Status: 'Exited (0)',
          Ports: [],
          Labels: {},
        },
      ],
      getContainer: () => ({ inspect: async () => ({ Id: ID }), stats: async () => ({}) }),
    };
    expect(
      await new ContainerCollector(docker as never, { hide: (id) => id === ID }).list(),
    ).toEqual([]);
  });

  it('returns an empty list without docker', async () => {
    expect(await new ContainerCollector(null).list()).toEqual([]);
  });
});
