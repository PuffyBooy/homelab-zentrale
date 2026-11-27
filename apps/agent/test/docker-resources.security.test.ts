import { describe, expect, it } from 'vitest';
import { imagePull, pullTarget } from '../src/actions/docker-resources.js';
import { rpc } from './admin-helpers.js';
import {
  AGENT_ID,
  APP_ID,
  IMG_AGENT,
  IMG_APP,
  IMG_DANGLING,
  NET_APP,
  NET_BRIDGE,
  NET_HZ,
  newState,
  setupDocker,
  at,
} from './docker-fakes.js';

const images = [
  { Id: IMG_AGENT, RepoTags: ['ghcr.io/x/agent:1'], Size: 100, Created: 1_700_000_000 },
  { Id: IMG_APP, RepoTags: ['nginx:1.27', 'nginx:latest'], Size: 200, Created: 1_700_000_000 },
  { Id: IMG_DANGLING, RepoTags: ['<none>:<none>'], Size: 50, Created: 1_700_000_000 },
  { Id: 'not-an-id', RepoTags: null, Size: 1, Created: 0 },
];

describe('docker.images', () => {
  it('counts users, marks protected and dangling images', async () => {
    const st = newState({ images });
    const r = await setupDocker(st).d.handle(rpc('docker.images', {}));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const list = (r.data as { images: { id: string }[] }).images;
    expect(list).toEqual([
      expect.objectContaining({ id: IMG_AGENT, containers: 1, protected: true, dangling: false }),
      expect.objectContaining({
        id: IMG_APP,
        containers: 1,
        protected: false,
        tags: ['nginx:1.27', 'nginx:latest'],
      }),
      expect.objectContaining({ id: IMG_DANGLING, containers: 0, dangling: true, tags: [] }),
    ]);
  });
});

describe('image.remove', () => {
  it('refuses an image a protected container uses', async () => {
    const st = newState();
    at(st.containers, 0).State = 'exited';
    const r = await setupDocker(st).d.handle(rpc('image.remove', { id: IMG_AGENT }));
    expect(r).toMatchObject({ ok: false, error: { code: 'not_allowed' } });
    expect(st.calls.some((c) => c.startsWith('rmi'))).toBe(false);
  });

  it('removes without force and maps 409 to busy', async () => {
    const st = newState();
    const r = await setupDocker(st).d.handle(rpc('image.remove', { id: IMG_APP }));
    expect(r).toMatchObject({ ok: true });
    expect(st.removeOpts).toEqual([{ force: false, noprune: false }]);
    const busy = newState({ removeError: 409 });
    const r2 = await setupDocker(busy).d.handle(rpc('image.remove', { id: IMG_APP }));
    expect(r2).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(JSON.stringify(r2)).not.toContain('hunter2');
    const gone = newState({ removeError: 404 });
    const r3 = await setupDocker(gone).d.handle(rpc('image.remove', { id: IMG_APP }));
    expect(r3).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });
});

describe('image.pull', () => {
  it('pulls without auth and reports id and tags', async () => {
    const st = newState({ pulledImage: { Id: IMG_APP, RepoTags: ['nginx:1.27'] } });
    const r = await setupDocker(st).d.handle(rpc('image.pull', { ref: 'nginx:1.27' }));
    expect(r).toMatchObject({ ok: true, data: { id: IMG_APP, tags: ['nginx:1.27'] } });
    expect(st.calls).toContain('pull nginx:1.27 {}');
  });

  it('rejects refs that look like options or contain a scheme', async () => {
    for (const ref of ['--all-tags', 'https://evil/x', 'nginx latest', 'Nginx']) {
      const st = newState();
      const r = await setupDocker(st).d.handle(rpc('image.pull', { ref }));
      expect(r).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
      expect(st.calls).toEqual([]);
    }
  });

  it('maps registry errors without docker text', async () => {
    const nf = newState({ pull: { output: [{ error: 'manifest unknown: token=hunter2' }] } });
    const r = await setupDocker(nf).d.handle(rpc('image.pull', { ref: 'nginx:nope' }));
    expect(r).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(JSON.stringify(r)).not.toContain('hunter2');
    const failed = newState({ pull: { err: new Error('unauthorized: hunter2') } });
    const r2 = await setupDocker(failed).d.handle(rpc('image.pull', { ref: 'nginx:1' }));
    expect(r2).toMatchObject({ ok: false, error: { code: 'failed' } });
    expect(JSON.stringify(r2)).not.toContain('hunter2');
  });

  it('times out', async () => {
    const st = newState();
    const { ctx } = setupDocker(st);
    (ctx.host.docker as unknown as { modem: { followProgress: () => void } }).modem.followProgress =
      () => undefined;
    await expect(imagePull({ ref: 'nginx:1' }, ctx, { timeoutMs: 10 })).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('drops the tag when a digest is given', () => {
    const d = `sha256:${'a'.repeat(64)}`;
    expect(pullTarget(`nginx:1.27@${d}`)).toBe(`nginx@${d}`);
    expect(pullTarget(`reg:5000/a/b:1@${d}`)).toBe(`reg:5000/a/b@${d}`);
    expect(pullTarget(`reg:5000/a/b@${d}`)).toBe(`reg:5000/a/b@${d}`);
    expect(pullTarget('reg:5000/a/b')).toBe('reg:5000/a/b');
  });
});

describe('docker.volumes / volume.remove', () => {
  const volumes = [
    { Name: 'agent-data', Driver: 'local', CreatedAt: '2026-01-01T00:00:00Z', Labels: null },
    {
      Name: 'web-data',
      Driver: 'local',
      CreatedAt: '2026-01-01T00:00:00+01:00',
      Labels: { 'com.docker.compose.project': 'web' },
    },
    { Name: 'loose', Driver: 'local' },
  ];
  const df = {
    Volumes: [
      { Name: 'agent-data', UsageData: { Size: 10, RefCount: 1 } },
      { Name: 'web-data', UsageData: { Size: -1, RefCount: 1 } },
    ],
  };

  it('lists sizes, users and protection', async () => {
    const st = newState({ volumes, df });
    const r = await setupDocker(st).d.handle(rpc('docker.volumes', {}));
    expect(r).toMatchObject({
      ok: true,
      data: {
        volumes: [
          { name: 'agent-data', sizeBytes: 10, containers: ['homelab-agent'], protected: true },
          {
            name: 'web-data',
            sizeBytes: null,
            containers: ['web'],
            composeProject: 'web',
            protected: false,
            createdAt: '2025-12-31T23:00:00.000Z',
          },
          { name: 'loose', sizeBytes: null, containers: [], protected: false, createdAt: null },
        ],
      },
    });
  });

  it('a failing df only leaves sizes empty', async () => {
    const st = newState({ volumes });
    const { ctx, d } = setupDocker(st);
    (ctx.host.docker as unknown as { df: () => Promise<never> }).df = () =>
      Promise.reject(new Error('x'));
    const r = await d.handle(rpc('docker.volumes', {}));
    expect(r.ok).toBe(true);
  });

  it('refuses a volume of a protected container (also when stopped)', async () => {
    const st = newState();
    at(st.containers, 0).State = 'exited';
    const r = await setupDocker(st).d.handle(rpc('volume.remove', { name: 'agent-data' }));
    expect(r).toMatchObject({ ok: false, error: { code: 'not_allowed' } });
    expect(st.calls.some((c) => c.startsWith('volume rm'))).toBe(false);
  });

  it('removes without force, 409 -> busy', async () => {
    const st = newState();
    expect(
      await setupDocker(st).d.handle(rpc('volume.remove', { name: 'web-data' })),
    ).toMatchObject({ ok: true });
    expect(st.removeOpts).toEqual([{ force: false }]);
    const busy = newState({ removeError: 409 });
    expect(
      await setupDocker(busy).d.handle(rpc('volume.remove', { name: 'web-data' })),
    ).toMatchObject({
      ok: false,
      error: { code: 'busy' },
    });
  });
});

describe('docker.networks / network.remove', () => {
  const networks = [
    { Id: NET_BRIDGE, Name: 'bridge', Driver: 'bridge', Scope: 'local' },
    {
      Id: NET_HZ,
      Name: 'hznet',
      Driver: 'bridge',
      Scope: 'local',
      Containers: { [AGENT_ID]: { Name: 'homelab-agent' } },
    },
    {
      Id: NET_APP,
      Name: 'web_default',
      Driver: 'bridge',
      Scope: 'local',
      Labels: { 'com.docker.compose.project': 'web' },
      Containers: { ['0'.repeat(64)]: { Name: 'sidecar' } },
    },
  ];

  it('lists builtin, protected and attached containers (from inspect and the container list)', async () => {
    const st = newState({ networks });
    const r = await setupDocker(st).d.handle(rpc('docker.networks', {}));
    expect(r).toMatchObject({
      ok: true,
      data: {
        networks: [
          { id: NET_BRIDGE, builtin: true, protected: false, containers: [] },
          { id: NET_HZ, builtin: false, protected: true, containers: ['homelab-agent'] },
          { id: NET_APP, builtin: false, protected: false, composeProject: 'web' },
        ],
      },
    });
    if (r.ok) {
      const app = at((r.data as { networks: { containers: string[] }[] }).networks, 2);
      expect(app.containers.sort()).toEqual(['sidecar', 'web']);
    }
  });

  it('refuses builtin and protected networks', async () => {
    for (const id of [NET_BRIDGE, NET_HZ]) {
      const st = newState({ networks });
      const r = await setupDocker(st).d.handle(rpc('network.remove', { id }));
      expect(r).toMatchObject({ ok: false, error: { code: 'not_allowed' } });
      expect(st.calls.some((c) => c.startsWith('network rm'))).toBe(false);
    }
  });

  it('refuses a network only a stopped protected container is attached to', async () => {
    const st = newState({
      networks: [{ Id: NET_HZ, Name: 'hznet', Driver: 'bridge', Scope: 'local' }],
    });
    at(st.containers, 0).State = 'exited';
    const r = await setupDocker(st).d.handle(rpc('network.remove', { id: NET_HZ }));
    expect(r).toMatchObject({ ok: false, error: { code: 'not_allowed' } });
  });

  it('removes others; 409 and 403 -> busy, 404 -> not_found', async () => {
    const st = newState({ networks });
    expect(await setupDocker(st).d.handle(rpc('network.remove', { id: NET_APP }))).toMatchObject({
      ok: true,
    });
    for (const [code, want] of [
      [409, 'busy'],
      [403, 'busy'],
      [404, 'not_found'],
    ] as const) {
      const s = newState({ networks, removeError: code });
      expect(await setupDocker(s).d.handle(rpc('network.remove', { id: NET_APP }))).toMatchObject({
        ok: false,
        error: { code: want },
      });
    }
    const missing = newState({ networks });
    expect(
      await setupDocker(missing).d.handle(rpc('network.remove', { id: '8'.repeat(64) })),
    ).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });
});

describe('no docker', () => {
  it('every list fails cleanly', async () => {
    const { setupAdmin } = await import('./admin-helpers.js');
    const { d } = setupAdmin();
    for (const a of ['docker.images', 'docker.volumes', 'docker.networks']) {
      expect(await d.handle(rpc(a, {}))).toMatchObject({ ok: false, error: { code: 'failed' } });
    }
    expect(APP_ID).toHaveLength(64);
  });
});
