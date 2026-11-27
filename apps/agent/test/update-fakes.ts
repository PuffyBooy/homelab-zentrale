import { PassThrough } from 'node:stream';
import type Docker from 'dockerode';
import type { UpdateInspect } from '../src/actions/container-update.js';
import type { ReplaceDocker } from '../src/update/replace.js';
import type { ImageMetaLike } from '../src/update/versions.js';

export const AGENT_ID = 'a'.repeat(64);
export const CORE_ID = 'c'.repeat(64);
export const NEW_ID = 'e'.repeat(64);
export const HELPER_ID = 'f'.repeat(64);
export const OLD_IMG = `sha256:${'1'.repeat(64)}`;
export const NEW_IMG = `sha256:${'2'.repeat(64)}`;
export const AGENT_REF = 'ghcr.io/puffybooy/homelab-agent:latest';
export const CORE_REF = 'ghcr.io/puffybooy/homelab-core:latest';

export function agentInfo(over: Partial<UpdateInspect> = {}): UpdateInspect {
  return {
    Id: AGENT_ID,
    Name: '/homelab-agent',
    Image: OLD_IMG,
    State: { Running: true },
    Config: {
      Image: AGENT_REF,
      Env: ['HZ_AGENT_DATA=/data'],
      Labels: {
        'hz.role': 'agent',
        'com.docker.compose.project': 'homelab-agent',
        'org.opencontainers.image.version': 'sha-1111111',
      },
    },
    HostConfig: {
      NetworkMode: 'host',
      PidMode: 'host',
      Binds: ['/var/run/docker.sock:/var/run/docker.sock', '/proc:/host/proc:ro'],
      Mounts: [{ Type: 'volume', Source: 'homelab-agent_agent-data', Target: '/data' }],
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
    },
    Mounts: [
      {
        Type: 'bind',
        Source: '/var/run/docker.sock',
        Destination: '/var/run/docker.sock',
        RW: true,
      },
      { Type: 'bind', Source: '/proc', Destination: '/host/proc', RW: false },
      { Type: 'volume', Name: 'homelab-agent_agent-data', Destination: '/data', RW: true },
    ],
    ...over,
  };
}

export function coreInfo(): UpdateInspect {
  return {
    Id: CORE_ID,
    Name: '/homelab-zentrale-core-1',
    Image: OLD_IMG,
    State: { Running: true },
    Config: {
      Image: CORE_REF,
      Labels: { 'hz.role': 'core', 'com.docker.compose.project': 'homelab-zentrale' },
    },
    HostConfig: {
      NetworkMode: 'host',
      Mounts: [{ Type: 'volume', Source: 'hz-data', Target: '/data' }],
    },
    Mounts: [{ Type: 'volume', Name: 'hz-data', Destination: '/data', RW: true }],
  };
}

export const img = (
  id: string,
  version?: string,
  extra: Record<string, string> = {},
): ImageMetaLike => ({
  Id: id,
  Created: '2026-11-20T10:00:00.123456789Z',
  Config: {
    Labels: {
      ...(version ? { 'org.opencontainers.image.version': version } : {}),
      'org.opencontainers.image.revision': '1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d',
      ...extra,
    },
  },
});

export interface FakeOpts {
  /** What the tag points to after a pull (default: new image). */
  remote?: Record<string, string>;
  pullFails?: boolean;
  /** Health of the new container: healthy (default), unhealthy, exit, none (no health check). */
  newHealth?: 'healthy' | 'unhealthy' | 'exit' | 'none' | 'starting';
  failAt?: 'create' | 'start' | 'rename-back' | 'start-old' | 'helper-start';
  extraCores?: number;
  /** Updater helper containers listed by listContainers. */
  helpers?: { Id: string; State: string; run: string }[];
  noCore?: boolean;
}

export function fakeDocker(o: FakeOpts = {}) {
  const calls: string[] = [];
  const created: Docker.ContainerCreateOptions[] = [];
  const tags = new Map<string, string>([
    [AGENT_REF, OLD_IMG],
    [CORE_REF, OLD_IMG],
  ]);
  const images = new Map<string, ImageMetaLike>([
    [OLD_IMG, img(OLD_IMG, 'sha-1111111')],
    [NEW_IMG, img(NEW_IMG, 'sha-2222222', { 'org.opencontainers.image.created': 'not a date' })],
  ]);
  const infos = new Map<string, UpdateInspect>([
    [AGENT_ID, agentInfo()],
    [CORE_ID, coreInfo()],
  ]);
  const names = new Map<string, string>([
    [AGENT_ID, 'homelab-agent'],
    [CORE_ID, 'homelab-zentrale-core-1'],
  ]);
  const running = new Set<string>([AGENT_ID, CORE_ID]);
  const removed = new Set<string>();
  let renameCount = 0;
  const label = (id: string) =>
    id === AGENT_ID ? 'old' : id === CORE_ID ? 'core' : id === HELPER_ID ? 'helper' : 'new';
  const err = (statusCode: number) => Object.assign(new Error('docker'), { statusCode });

  const docker: ReplaceDocker = {
    getContainer(id) {
      return {
        inspect: async () => {
          const info = infos.get(id);
          if (info && !removed.has(id)) return info;
          if (id === NEW_ID && !removed.has(id)) {
            const h = o.newHealth ?? 'healthy';
            if (h === 'exit') return { State: { Running: false, ExitCode: 1 }, RestartCount: 0 };
            return {
              State: { Running: true, ...(h === 'none' ? {} : { Health: { Status: h } }) },
              RestartCount: 0,
            };
          }
          throw err(404);
        },
        rename: async ({ name }) => {
          calls.push(`rename ${label(id)} ${name.replace(/-hz-old-.*/, '-hz-old')}`);
          renameCount += 1;
          if (o.failAt === 'rename-back' && renameCount === 2) throw err(500);
          names.set(id, name);
        },
        stop: async () => {
          calls.push(`stop ${label(id)}`);
          running.delete(id);
        },
        start: async () => {
          calls.push(`start ${label(id)}`);
          if (id === NEW_ID && o.failAt === 'start') throw err(500);
          if (id === HELPER_ID && o.failAt === 'helper-start') throw err(500);
          if ((id === AGENT_ID || id === CORE_ID) && o.failAt === 'start-old') throw err(500);
          running.add(id);
        },
        remove: async () => {
          calls.push(`remove ${label(id)}`);
          removed.add(id);
          running.delete(id);
        },
      };
    },
    getImage(ref) {
      return {
        inspect: async () => {
          const id = tags.get(ref) ?? ref;
          const meta = images.get(id);
          if (!meta) throw err(404);
          return meta;
        },
      };
    },
    createContainer: async (opts) => {
      created.push(opts);
      const isHelper = opts.Labels?.['hz.role'] === 'updater';
      calls.push(isHelper ? 'create helper' : `create ${opts.name} ${opts.Image}`);
      if (!isHelper && o.failAt === 'create') throw err(409);
      return { id: isHelper ? HELPER_ID : NEW_ID };
    },
    getNetwork(name) {
      return {
        connect: async () => {
          calls.push(`connect ${name}`);
        },
      };
    },
    pull: async (ref) => {
      calls.push(`pull ${ref}`);
      if (o.pullFails) throw err(500);
      tags.set(ref, o.remote?.[ref] ?? NEW_IMG);
      const s = new PassThrough();
      s.end();
      return s;
    },
    modem: {
      followProgress(_s, done) {
        done(null, [{ status: 'ok' }]);
      },
    },
    listContainers: async (opts) => {
      const f = JSON.parse(opts.filters ?? '{}') as { label?: string[] };
      const out: unknown[] = [];
      for (const [id, info] of infos) {
        if (removed.has(id)) continue;
        const labels = info.Config.Labels ?? {};
        if (f.label?.some((l) => labels[l.split('=')[0] ?? ''] !== l.split('=')[1])) continue;
        out.push({
          Id: id,
          Names: [`/${names.get(id)}`],
          State: running.has(id) ? 'running' : 'exited',
          Labels: labels,
        });
      }
      if (o.noCore) return out.filter((c) => (c as { Id: string }).Id !== CORE_ID);
      const f2 = JSON.parse(opts.filters ?? '{}') as { label?: string[] };
      if (f2.label?.includes('hz.role=updater')) {
        return (o.helpers ?? [])
          .filter((h) => !removed.has(h.Id))
          .map((h) => ({
            Id: h.Id,
            Names: [`/hz-updater-${h.run}`],
            State: h.State,
            Labels: { 'hz.role': 'updater', 'hz.update.run': h.run },
          }));
      }
      for (let i = 0; i < (o.extraCores ?? 0); i += 1) {
        out.push({
          Id: `${i}`.repeat(64),
          Names: ['/core2'],
          State: 'running',
          Labels: { 'hz.role': 'core' },
        });
      }
      return out;
    },
  };
  return { docker, calls, created, tags, names, running, removed };
}
