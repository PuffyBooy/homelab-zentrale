import { describe, expect, it } from 'vitest';
import { hostCpuCount, limitContainer, type LimitDocker } from '../src/actions/container-limit.js';
import { detailsFromInspect, mapContainer } from '../src/collect/docker.js';

const ID = 'e'.repeat(64);

function docker(opts: { info?: () => Promise<unknown>; updateErr?: number } = {}) {
  const bodies: unknown[] = [];
  const d: LimitDocker = {
    getContainer: () => ({
      inspect: async () => ({ Id: ID, Config: { Labels: {} } }),
      update: async (b: unknown) => {
        if (opts.updateErr) throw Object.assign(new Error('x'), { statusCode: opts.updateErr });
        bodies.push(b);
      },
    }),
    info: opts.info ?? (async () => ({ NCPU: 8 })),
  };
  return { d, bodies };
}

describe('container.limit', () => {
  it('applies the value and returns it', async () => {
    const { d, bodies } = docker();
    await expect(limitContainer(d, { id: 'web', cpus: 0.25 })).resolves.toEqual({ cpus: 0.25 });
    expect(bodies).toEqual([{ NanoCpus: 250_000_000 }]);
  });

  it('host CPU count: Docker NCPU, else the fallback', async () => {
    expect(await hostCpuCount(docker().d)).toBe(8);
    const broken = docker({ info: () => Promise.reject(new Error('down')) }).d;
    expect(await hostCpuCount(broken, 3)).toBe(3);
    const odd = docker({ info: async () => ({ NCPU: 'many' }) }).d;
    expect(await hostCpuCount(odd, 0)).toBe(1);
  });

  it('maps Docker errors', async () => {
    await expect(
      limitContainer(docker({ updateErr: 404 }).d, { id: 'web', cpus: 1 }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      limitContainer(docker({ updateErr: 400 }).d, { id: 'web', cpus: 1 }),
    ).rejects.toMatchObject({ code: 'failed' });
  });
});

describe('inventory: role and cpuLimit', () => {
  const listed = (labels: Record<string, string>) =>
    ({
      Id: ID,
      Names: ['/web'],
      Image: 'nginx',
      ImageID: 'sha256:1',
      Command: '',
      Created: 0,
      State: 'running',
      Status: 'Up 1 hour',
      Ports: [],
      Labels: labels,
      HostConfig: { NetworkMode: 'bridge' },
      NetworkSettings: { Networks: {} },
      Mounts: [],
    }) as unknown as Parameters<typeof mapContainer>[0];

  it('reads cpuLimit from HostConfig.NanoCpus', () => {
    expect(detailsFromInspect({ Id: ID, HostConfig: { NanoCpus: 1_500_000_000 } }).cpuLimit).toBe(
      1.5,
    );
    expect(detailsFromInspect({ Id: ID, HostConfig: { NanoCpus: 0 } }).cpuLimit).toBeNull();
    expect(detailsFromInspect({ Id: ID, HostConfig: {} }).cpuLimit).toBeNull();
    expect(detailsFromInspect({ Id: ID }).cpuLimit).toBeUndefined();
  });

  it('reports role only for core and agent, and the limit', () => {
    expect(mapContainer(listed({ 'hz.role': 'core' }))?.role).toBe('core');
    expect(mapContainer(listed({ 'hz.role': 'agent' }))?.role).toBe('agent');
    expect(mapContainer(listed({ 'hz.role': 'web' }))?.role).toBeUndefined();
    expect(mapContainer(listed({}), { cpuLimit: 0.5 })?.cpuLimit).toBe(0.5);
    expect(mapContainer(listed({}), { cpuLimit: null })?.cpuLimit).toBeNull();
    expect(mapContainer(listed({}))).not.toHaveProperty('cpuLimit');
  });

  it('reports the homelab.game label only when it is a valid game folder name (M12)', () => {
    expect(mapContainer(listed({ 'homelab.game': 'mc-survival' }))?.game).toBe('mc-survival');
    for (const bad of ['../etc', 'MC', 'a', '-x', 'a'.repeat(40), 'mc/../x', '']) {
      const c = mapContainer(listed({ 'homelab.game': bad }));
      expect(c, bad).not.toBeNull();
      expect(c).not.toHaveProperty('game');
    }
    expect(mapContainer(listed({}))).not.toHaveProperty('game');
  });
});
