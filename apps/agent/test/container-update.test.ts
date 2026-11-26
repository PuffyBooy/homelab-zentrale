import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  buildRecreatePlan,
  hiddenDuringUpdate,
  pullableRef,
  updateContainer,
  type ImageConfigLike,
  type UpdateDocker,
  type UpdateInspect,
} from '../src/actions/container-update.js';
import { createLogger } from '../src/log.js';

const OLD_ID = 'a'.repeat(64);
const NEW_ID = 'b'.repeat(64);
const OLD_IMG = `sha256:${'1'.repeat(64)}`;
const NEW_IMG = `sha256:${'2'.repeat(64)}`;

function inspect(over: Partial<UpdateInspect> = {}): UpdateInspect {
  return {
    Id: OLD_ID,
    Name: '/web',
    Image: OLD_IMG,
    State: { Running: true },
    Config: {
      Hostname: OLD_ID.slice(0, 12),
      Image: 'nginx:1.27',
      Env: ['PATH=/usr/bin', 'NGINX_VERSION=1.27.0', 'MY_SETTING=1'],
      Cmd: ['nginx', '-g', 'daemon off;'],
      Entrypoint: ['/docker-entrypoint.sh'],
      Labels: { maintainer: 'nginx', 'my.label': 'x' },
      ExposedPorts: { '80/tcp': {}, '8080/tcp': {} },
      Volumes: { '/var/cache/nginx': {} },
      WorkingDir: '',
      StopSignal: 'SIGQUIT',
    },
    HostConfig: {
      NetworkMode: 'appnet',
      Binds: ['/opt/homelab/web/html:/usr/share/nginx/html:ro'],
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      PortBindings: { '80/tcp': [{ HostIp: '', HostPort: '8080' }] },
    },
    Mounts: [
      { Type: 'bind', Destination: '/usr/share/nginx/html', RW: false },
      { Type: 'volume', Name: 'f00ba4', Destination: '/var/cache/nginx', RW: true },
    ],
    NetworkSettings: {
      Networks: {
        appnet: { Aliases: [OLD_ID.slice(0, 12), 'web', 'www'], IPAMConfig: null },
        monitoring: { Aliases: ['web-metrics'] },
      },
    },
    ...over,
  };
}

const oldImage: ImageConfigLike = {
  Id: OLD_IMG,
  Config: {
    Env: ['PATH=/usr/bin', 'NGINX_VERSION=1.27.0'],
    Cmd: ['nginx', '-g', 'daemon off;'],
    Entrypoint: ['/docker-entrypoint.sh'],
    Labels: { maintainer: 'nginx' },
    ExposedPorts: { '80/tcp': {} },
    StopSignal: 'SIGQUIT',
  },
};

describe('recreate plan', () => {
  it('keeps user settings and drops image defaults', () => {
    const { create, extraNetworks } = buildRecreatePlan(inspect(), oldImage, 'nginx:1.27');
    expect(create.name).toBe('web');
    expect(create.Image).toBe('nginx:1.27');
    expect(create.Hostname).toBeUndefined();
    expect(create.Env).toEqual(['MY_SETTING=1']);
    expect(create.Labels).toEqual({ 'my.label': 'x' });
    expect(create.Cmd).toBeUndefined();
    expect(create.Entrypoint).toBeUndefined();
    expect(create.ExposedPorts).toEqual({ '8080/tcp': {} });
    expect(create.StopSignal).toBeUndefined();
    expect(create.HostConfig?.RestartPolicy).toEqual({
      Name: 'unless-stopped',
      MaximumRetryCount: 0,
    });
    expect(create.HostConfig?.Binds).toEqual(['/opt/homelab/web/html:/usr/share/nginx/html:ro']);
    // anonymous volume carried over
    expect(create.HostConfig?.Mounts).toEqual([
      { Type: 'volume', Source: 'f00ba4', Target: '/var/cache/nginx', ReadOnly: false },
    ]);
    expect(create.NetworkingConfig?.EndpointsConfig).toEqual({ appnet: { Aliases: ['www'] } });
    expect(extraNetworks).toEqual([['monitoring', { Aliases: ['web-metrics'] }]]);
  });

  it('keeps Cmd when the entrypoint was overridden', () => {
    const info = inspect();
    info.Config.Entrypoint = ['/bin/sh', '-c'];
    const { create } = buildRecreatePlan(info, oldImage, 'nginx:1.27');
    expect(create.Entrypoint).toEqual(['/bin/sh', '-c']);
    expect(create.Cmd).toEqual(['nginx', '-g', 'daemon off;']);
  });

  it('copies everything when the old image is gone', () => {
    const { create } = buildRecreatePlan(inspect(), null, 'nginx:1.27');
    expect(create.Env).toHaveLength(3);
    expect(create.Cmd).toEqual(['nginx', '-g', 'daemon off;']);
  });

  it('host networking has no endpoint config', () => {
    const info = inspect({ HostConfig: { NetworkMode: 'host' } });
    const { create, extraNetworks } = buildRecreatePlan(info, oldImage, 'x:1');
    expect(create.NetworkingConfig).toBeUndefined();
    expect(extraNetworks).toEqual([]);
  });

  it('default bridge never gets aliases', () => {
    const info = inspect({
      HostConfig: { NetworkMode: 'default' },
      NetworkSettings: { Networks: { bridge: { Aliases: ['a'] } } },
    });
    expect(buildRecreatePlan(info, oldImage, 'x:1').create.NetworkingConfig).toEqual({
      EndpointsConfig: { bridge: {} },
    });
  });

  it('only pulls real references', () => {
    expect(pullableRef('nginx:1.27')).toBe(true);
    expect(pullableRef('ghcr.io/a/b:1@sha256:abc')).toBe(true);
    expect(pullableRef(OLD_IMG)).toBe(false);
    expect(pullableRef('1'.repeat(64))).toBe(false);
    expect(pullableRef('a b')).toBe(false);
    expect(pullableRef('--help')).toBe(false);
  });
});

interface FakeOpts {
  info?: UpdateInspect;
  pullFails?: boolean;
  pullError?: boolean;
  localImageId?: string;
  failAt?: 'rename' | 'create' | 'connect' | 'start' | 'remove';
  newExits?: boolean;
}

function fakeDocker(o: FakeOpts = {}) {
  const calls: string[] = [];
  const info = o.info ?? inspect();
  const names = new Map<string, string>([[OLD_ID, 'web']]);
  const containers = new Set<string>([OLD_ID]);
  const running = new Set<string>(info.State.Running ? [OLD_ID] : []);
  let renamesFailed = 0;
  const err = (statusCode: number) => Object.assign(new Error('docker'), { statusCode });
  const docker: UpdateDocker = {
    getContainer(id) {
      return {
        inspect: async () => {
          calls.push(`inspect ${id === OLD_ID || id === 'web' ? 'old' : 'new'}`);
          if (id === OLD_ID || id === 'web') return info;
          if (!containers.has(id)) throw err(404);
          return {
            State: o.newExits
              ? { Running: false, ExitCode: 1 }
              : { Running: running.has(id), ExitCode: 0 },
          };
        },
        rename: async ({ name }) => {
          calls.push(`rename ${id === OLD_ID ? 'old' : 'new'} ${name}`);
          if (o.failAt === 'rename' && renamesFailed === 0) {
            renamesFailed += 1;
            throw err(500);
          }
          names.set(id, name);
        },
        stop: async () => {
          calls.push(`stop ${id === OLD_ID ? 'old' : 'new'}`);
          running.delete(id);
        },
        start: async () => {
          calls.push(`start ${id === OLD_ID ? 'old' : 'new'}`);
          if (id !== OLD_ID && o.failAt === 'start') throw err(500);
          running.add(id);
        },
        remove: async () => {
          calls.push(`remove ${id === OLD_ID ? 'old' : 'new'}`);
          if (id === OLD_ID && o.failAt === 'remove') throw err(500);
          containers.delete(id);
          names.delete(id);
          running.delete(id);
        },
      };
    },
    getImage(ref) {
      return {
        inspect: async () => {
          if (ref === OLD_IMG) return oldImage;
          return { Id: o.localImageId ?? NEW_IMG, Config: oldImage.Config };
        },
      };
    },
    createContainer: async (opts) => {
      calls.push(`create ${opts.name} ${opts.Image}`);
      if (o.failAt === 'create') throw err(409);
      containers.add(NEW_ID);
      names.set(NEW_ID, opts.name ?? '');
      return { id: NEW_ID };
    },
    getNetwork(name) {
      return {
        connect: async () => {
          calls.push(`connect ${name}`);
          if (o.failAt === 'connect') throw err(500);
        },
      };
    },
    pull: async (ref) => {
      calls.push(`pull ${ref}`);
      if (o.pullFails) throw err(404);
      const s = new PassThrough();
      s.end();
      return s;
    },
    modem: {
      followProgress(_stream, done) {
        if (o.pullError) done(null, [{ status: 'x' }, { error: 'manifest unknown' }]);
        else done(null, [{ status: 'Downloaded newer image' }]);
      },
    },
  };
  return { docker, calls, names, containers, running };
}

const opts = { settleMs: 0, log: createLogger('error', () => undefined), now: () => 1000 };

describe('container update', () => {
  it('pulls, recreates with the same name and removes the old container', async () => {
    const f = fakeDocker();
    const r = await updateContainer(f.docker, 'web', opts);
    expect(r).toEqual({
      updated: true,
      imageId: NEW_IMG,
      previousImageId: OLD_IMG,
      pulled: true,
      oldRemoved: true,
    });
    expect(f.calls).toEqual([
      'inspect old',
      'pull nginx:1.27',
      'rename old web-hz-old-rs',
      'create web nginx:1.27',
      'connect monitoring',
      'stop old',
      'start new',
      'inspect new',
      'remove old',
    ]);
    expect([...f.containers]).toEqual([NEW_ID]);
    expect(f.names.get(NEW_ID)).toBe('web');
  });

  it('does nothing when the image did not change', async () => {
    const f = fakeDocker({ localImageId: OLD_IMG });
    const r = await updateContainer(f.docker, 'web', opts);
    expect(r).toMatchObject({ updated: false, imageId: OLD_IMG });
    expect(f.calls).toEqual(['inspect old', 'pull nginx:1.27']);
  });

  it('uses a newer local tag when the pull fails', async () => {
    const f = fakeDocker({ pullFails: true });
    const r = await updateContainer(f.docker, 'web', opts);
    expect(r).toMatchObject({ updated: true, pulled: false, imageId: NEW_IMG });
  });

  it('fails when the pull fails and there is nothing newer', async () => {
    const f = fakeDocker({ pullError: true, localImageId: OLD_IMG });
    await expect(updateContainer(f.docker, 'web', opts)).rejects.toMatchObject({ code: 'failed' });
    expect(f.calls.some((c) => c.startsWith('rename'))).toBe(false);
  });

  it('refuses compose containers with invalid_params', async () => {
    const info = inspect();
    info.Config.Labels = { 'com.docker.compose.project': 'web' };
    const f = fakeDocker({ info });
    await expect(updateContainer(f.docker, 'web', opts)).rejects.toMatchObject({
      code: 'invalid_params',
      message: expect.stringMatching(/compose/),
    });
    expect(f.calls).toEqual(['inspect old']);
  });

  it('refuses containers created from an image id', async () => {
    const info = inspect();
    info.Config.Image = OLD_IMG;
    const f = fakeDocker({ info });
    await expect(updateContainer(f.docker, 'web', opts)).rejects.toMatchObject({
      code: 'invalid_params',
    });
  });

  it('nothing changes when the rename fails', async () => {
    const f = fakeDocker({ failAt: 'rename' });
    await expect(updateContainer(f.docker, 'web', opts)).rejects.toMatchObject({ code: 'failed' });
    expect(f.calls.some((c) => c.startsWith('create') || c.startsWith('stop'))).toBe(false);
    expect(f.running.has(OLD_ID)).toBe(true);
  });

  it.each(['create', 'connect', 'start'] as const)('rolls back when %s fails', async (failAt) => {
    const f = fakeDocker({ failAt });
    await expect(updateContainer(f.docker, 'web', opts)).rejects.toMatchObject({
      code: 'failed',
      message: expect.stringMatching(/rolled back/),
    });
    expect([...f.containers]).toEqual([OLD_ID]);
    expect(f.names.get(OLD_ID)).toBe('web');
    expect(f.running.has(OLD_ID)).toBe(true);
    expect(f.calls).not.toContain('remove old');
  });

  it('rolls back when the new container exits right away', async () => {
    const f = fakeDocker({ newExits: true });
    await expect(updateContainer(f.docker, 'web', opts)).rejects.toMatchObject({
      message: expect.stringMatching(/at check, rolled back/),
    });
    expect(f.calls.slice(-4)).toEqual(['inspect new', 'remove new', 'rename old web', 'start old']);
    expect(f.running.has(OLD_ID)).toBe(true);
  });

  it('a stopped container stays stopped and is not started', async () => {
    const f = fakeDocker({ info: inspect({ State: { Running: false } }) });
    const r = await updateContainer(f.docker, 'web', opts);
    expect(r.updated).toBe(true);
    expect(f.calls.some((c) => c.startsWith('start') || c.startsWith('stop'))).toBe(false);
  });

  it('reports when the old container could not be removed', async () => {
    const f = fakeDocker({ failAt: 'remove' });
    const r = await updateContainer(f.docker, 'web', opts);
    expect(r).toMatchObject({ updated: true, oldRemoved: false });
  });

  it('hides the old container from inventory and events only while updating', async () => {
    const f = fakeDocker();
    const create = f.docker.createContainer.bind(f.docker);
    let hiddenDuring = false;
    f.docker.createContainer = async (o) => {
      hiddenDuring = hiddenDuringUpdate.has(OLD_ID);
      return create(o);
    };
    await updateContainer(f.docker, 'web', opts);
    expect(hiddenDuring).toBe(true);
    expect(hiddenDuringUpdate.has(OLD_ID)).toBe(false);
    // also released after a failed update (a leftover must become visible)
    await expect(
      updateContainer(fakeDocker({ failAt: 'start' }).docker, 'web', opts),
    ).rejects.toBeDefined();
    expect(hiddenDuringUpdate.size).toBe(0);
  });

  it('runs one update per container at a time', async () => {
    const f = fakeDocker();
    const [a, b] = await Promise.allSettled([
      updateContainer(f.docker, 'web', opts),
      updateContainer(f.docker, 'web', opts),
    ]);
    expect(a.status).toBe('fulfilled');
    expect(b).toMatchObject({ status: 'rejected', reason: { code: 'busy' } });
  });
});
