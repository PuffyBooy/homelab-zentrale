import { containerDetailsDataSchema } from '@hz/shared';
import { describe, expect, it } from 'vitest';
import { computeStats, containerInspect, envKeysOf } from '../src/actions/container-inspect.js';
import { rpc } from './admin-helpers.js';
import { AGENT_ID, APP_ID, newState, setupDocker, at } from './docker-fakes.js';

const STATS = {
  cpu_stats: {
    cpu_usage: { total_usage: 3_000_000 },
    system_cpu_usage: 20_000_000,
    online_cpus: 4,
  },
  precpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 10_000_000 },
  memory_stats: { usage: 500, limit: 1000, stats: { inactive_file: 100 } },
  networks: { eth0: { rx_bytes: 10, tx_bytes: 20 }, eth1: { rx_bytes: 1, tx_bytes: 2 } },
  blkio_stats: {
    io_service_bytes_recursive: [
      { op: 'read', value: 5 },
      { op: 'Write', value: 7 },
      { op: 'Read', value: 1 },
    ],
  },
  pids_stats: { current: 3 },
};

function richInspect() {
  return {
    Created: '2026-11-01T10:00:00.123456789Z',
    RestartCount: 2,
    State: {
      Status: 'running',
      Running: true,
      ExitCode: 0,
      StartedAt: '2026-11-02T10:00:00Z',
      FinishedAt: '0001-01-01T00:00:00Z',
      Health: { Status: 'healthy' },
    },
    Config: {
      Image: 'nginx:1.27',
      Env: ['PASSWORD=hunter2', 'DB_URL=postgres://u:s3cr3t@db/x', 'EMPTY=', 'NOVALUE'],
      Labels: {
        'com.docker.compose.project': 'web',
        'com.docker.compose.service': 'web',
        token: 'hunter2',
      },
      Cmd: ['--password', 'hunter2'],
    },
    HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, Memory: 0 },
    Mounts: [
      {
        Type: 'volume',
        Name: 'web-data',
        Source: '/var/lib/docker/volumes/web-data/_data',
        Destination: '/data',
        RW: true,
      },
      { Type: 'bind', Source: '/srv/web/html', Destination: '/html', RW: false },
      { Type: 'tmpfs', Source: '', Destination: '/tmp', RW: true },
    ],
    NetworkSettings: {
      Networks: { web_default: { IPAddress: '172.18.0.2' }, other: { IPAddress: '' } },
      Ports: {
        '80/tcp': [
          { HostIp: '0.0.0.0', HostPort: '8080' },
          { HostIp: '::', HostPort: '8080' },
        ],
        '443/tcp': null,
        '53/udp': [{ HostIp: '', HostPort: '5353' }],
      },
    },
  };
}

describe('container.inspect', () => {
  it('maps the inspect and never leaks env values', async () => {
    const st = newState({ stats: STATS });
    at(st.containers, 1).State = 'running';
    at(st.containers, 1).inspect = richInspect();
    const r = await setupDocker(st).d.handle(rpc('container.inspect', { id: 'web' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = containerDetailsDataSchema.parse(r.data);
    expect(data.id).toBe(APP_ID);
    expect(data.name).toBe('web');
    expect(data.envKeys).toEqual(['PASSWORD', 'DB_URL', 'EMPTY', 'NOVALUE']);
    const json = JSON.stringify(r);
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('s3cr3t');
    expect(data.health).toBe('healthy');
    expect(data.finishedAt).toBeNull();
    expect(data.exitCode).toBeNull();
    expect(data.restartPolicy).toBe('unless-stopped');
    expect(data.mounts).toEqual([
      { type: 'volume', source: 'web-data', destination: '/data', rw: true },
      { type: 'bind', source: '/srv/web/html', destination: '/html', rw: false },
      { type: 'tmpfs', source: '', destination: '/tmp', rw: true },
    ]);
    expect(data.networks).toEqual([
      { name: 'web_default', ip: '172.18.0.2' },
      { name: 'other', ip: null },
    ]);
    expect(data.ports).toContainEqual({
      privatePort: 443,
      publicPort: null,
      protocol: 'tcp',
      ip: null,
    });
    expect(data.ports).toContainEqual({
      privatePort: 53,
      publicPort: 5353,
      protocol: 'udp',
      ip: null,
    });
    expect(data.composeProject).toBe('web');
    expect(data.protected).toBe(false);
    expect(data.stats).toMatchObject({
      cpuPercent: 80,
      memBytes: 400,
      memLimitBytes: null,
      pids: 3,
    });
    expect(st.calls).toContain('stats {"stream":false}');
  });

  it('marks the agent as protected', async () => {
    const st = newState({ stats: STATS });
    const r = await setupDocker(st).d.handle(rpc('container.inspect', { id: AGENT_ID }));
    expect(r).toMatchObject({ ok: true, data: { protected: true } });
  });

  it('stats are null when stopped, failing or slow (timeout)', async () => {
    const stopped = newState({ stats: STATS });
    const r = await setupDocker(stopped).d.handle(rpc('container.inspect', { id: APP_ID }));
    expect(r).toMatchObject({ ok: true, data: { stats: null } });
    expect(stopped.calls.some((c) => c.startsWith('stats'))).toBe(false);

    const failing = newState();
    at(failing.containers, 1).State = 'running';
    const r2 = await setupDocker(failing).d.handle(rpc('container.inspect', { id: APP_ID }));
    expect(r2).toMatchObject({ ok: true, data: { stats: null } });

    const slow = newState({ stats: STATS, statsDelayMs: 200 });
    at(slow.containers, 1).State = 'running';
    const { ctx } = setupDocker(slow);
    const data = await containerInspect({ id: APP_ID }, ctx, { statsTimeoutMs: 20 });
    expect(data.stats).toBeNull();
  });

  it('404 -> not_found, other failures -> failed', async () => {
    const r = await setupDocker(newState()).d.handle(rpc('container.inspect', { id: 'missing' }));
    expect(r).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('envKeysOf keeps names only and caps the count', () => {
    expect(envKeysOf(['A=1', 'B==2', '=x', 7 as unknown as string])).toEqual(['A', 'B']);
    expect(envKeysOf(Array.from({ length: 400 }, (_, i) => `K${i}=v`))).toHaveLength(300);
  });

  it('computeStats uses the memory limit only when one is set', () => {
    expect(computeStats(STATS, true).memLimitBytes).toBe(1000);
    expect(computeStats({}, false)).toMatchObject({ cpuPercent: 0, memBytes: 0, pids: 0 });
    const v1 = computeStats(
      { memory_stats: { usage: 300, stats: { total_inactive_file: 50 } } },
      false,
    );
    expect(v1.memBytes).toBe(250);
    expect(computeStats(STATS, false)).toMatchObject({
      netRxBytes: 11,
      netTxBytes: 22,
      blockReadBytes: 6,
      blockWriteBytes: 7,
    });
  });
});
