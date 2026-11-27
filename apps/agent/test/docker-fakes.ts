import type { ActionContext } from '../src/actions/types.js';
import { setupAdmin, type ExecFn } from './admin-helpers.js';

/** A minimal in-memory Docker for the M23 actions. Every call is recorded. */

export const AGENT_ID = 'a'.repeat(64);
export const CORE_ID = 'c'.repeat(64);
export const APP_ID = 'b'.repeat(64);
export const OTHER_ID = 'd'.repeat(64);
export const IMG_AGENT = `sha256:${'1'.repeat(64)}`;
export const IMG_APP = `sha256:${'2'.repeat(64)}`;
export const IMG_DANGLING = `sha256:${'3'.repeat(64)}`;
export const NET_BRIDGE = 'e'.repeat(64);
export const NET_APP = 'f'.repeat(64);
export const NET_HZ = '9'.repeat(64);

export interface FakeContainer {
  Id: string;
  Names: string[];
  Image: string;
  ImageID: string;
  State: string;
  Labels: Record<string, string>;
  Mounts: { Type: string; Name?: string; Source?: string; Destination: string; RW: boolean }[];
  NetworkSettings: { Networks: Record<string, { NetworkID: string; IPAddress?: string }> };
  inspect?: Record<string, unknown>;
}

export const httpErr = (statusCode: number, message = 'docker said: SECRET=hunter2') =>
  Object.assign(new Error(message), { statusCode });

export function defaultContainers(): FakeContainer[] {
  return [
    {
      Id: AGENT_ID,
      Names: ['/homelab-agent'],
      Image: 'ghcr.io/x/agent:1',
      ImageID: IMG_AGENT,
      State: 'running',
      Labels: { 'hz.role': 'agent', 'com.docker.compose.project': 'homelab-agent' },
      Mounts: [{ Type: 'volume', Name: 'agent-data', Destination: '/data', RW: true }],
      NetworkSettings: { Networks: { hznet: { NetworkID: NET_HZ } } },
    },
    {
      Id: APP_ID,
      Names: ['/web'],
      Image: 'nginx:1.27',
      ImageID: IMG_APP,
      State: 'exited',
      Labels: {
        'com.docker.compose.project': 'web',
        'com.docker.compose.service': 'web',
        'com.docker.compose.project.working_dir': '/srv/web',
        'com.docker.compose.project.config_files': '/srv/web/compose.yml',
      },
      Mounts: [
        { Type: 'volume', Name: 'web-data', Destination: '/data', RW: true },
        { Type: 'bind', Source: '/srv/web/html', Destination: '/html', RW: false },
      ],
      NetworkSettings: { Networks: { web_default: { NetworkID: NET_APP } } },
    },
  ];
}

export interface FakeDockerState {
  containers: FakeContainer[];
  calls: string[];
  removeOpts: unknown[];
  /** Status code thrown by the next remove of any kind. */
  removeError?: number;
  images: unknown[];
  volumes: unknown[];
  df: unknown;
  networks: {
    Id: string;
    Name: string;
    Driver: string;
    Scope: string;
    Labels?: Record<string, string>;
    Containers?: Record<string, { Name: string }>;
  }[];
  stats?: unknown;
  statsDelayMs?: number;
  opError?: Record<string, number>;
  pull?: { err?: Error | null; output?: unknown[] };
  pulledImage?: unknown;
}

export function fakeDocker(state: FakeDockerState) {
  const { calls } = state;
  const find = (ref: string) =>
    state.containers.find(
      (c) => c.Id === ref || c.Id.startsWith(ref) || c.Names.includes(`/${ref}`),
    );
  const opFail = (op: string, id: string) => {
    const code = state.opError?.[`${op} ${id}`];
    if (code) throw httpErr(code);
  };
  return {
    listContainers: async (opts: { all: boolean; filters?: string }) => {
      calls.push(`list ${opts.filters ?? ''}`);
      let list = state.containers;
      if (opts.filters) {
        const f = JSON.parse(opts.filters) as { label?: string[] };
        for (const l of f.label ?? []) {
          const [k, v] = [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)];
          list = list.filter((c) => c.Labels[k] === v);
        }
      }
      return list.map(({ inspect: _i, ...c }) => c);
    },
    getContainer: (ref: string) => ({
      inspect: async () => {
        calls.push(`inspect ${ref}`);
        const c = find(ref);
        if (!c) throw httpErr(404);
        return {
          Id: c.Id,
          Name: c.Names[0],
          Image: c.ImageID,
          Config: { Labels: c.Labels, Image: c.Image },
          State: {
            Status: c.State,
            Running: c.State === 'running',
            Paused: c.State === 'paused',
            Restarting: c.State === 'restarting',
          },
          ...c.inspect,
        };
      },
      remove: async (opts: unknown) => {
        calls.push(`rm ${ref}`);
        state.removeOpts.push(opts);
        if (state.removeError) throw httpErr(state.removeError);
      },
      start: async () => {
        calls.push(`start ${ref}`);
        opFail('start', ref);
      },
      stop: async (o: unknown) => {
        calls.push(`stop ${ref} ${JSON.stringify(o)}`);
        opFail('stop', ref);
      },
      restart: async (o: unknown) => {
        calls.push(`restart ${ref} ${JSON.stringify(o)}`);
        opFail('restart', ref);
      },
      stats: async (opts: unknown) => {
        calls.push(`stats ${JSON.stringify(opts)}`);
        if (state.statsDelayMs) await new Promise((r) => setTimeout(r, state.statsDelayMs));
        if (!state.stats) throw httpErr(500);
        return state.stats;
      },
    }),
    listImages: async () => state.images,
    getImage: (ref: string) => ({
      inspect: async () => {
        calls.push(`image inspect ${ref}`);
        if (!state.pulledImage) throw httpErr(404);
        return state.pulledImage;
      },
      remove: async (opts: unknown) => {
        calls.push(`rmi ${ref}`);
        state.removeOpts.push(opts);
        if (state.removeError) throw httpErr(state.removeError);
      },
    }),
    pull: async (ref: string, opts: unknown) => {
      calls.push(`pull ${ref} ${JSON.stringify(opts)}`);
      return { destroy: () => undefined } as unknown as NodeJS.ReadableStream;
    },
    modem: {
      followProgress: (_s: unknown, done: (err: Error | null, out: unknown[]) => void) => {
        setTimeout(() => done(state.pull?.err ?? null, state.pull?.output ?? []), 0);
      },
    },
    listVolumes: async () => ({ Volumes: state.volumes }),
    df: async () => state.df,
    getVolume: (name: string) => ({
      remove: async (opts: unknown) => {
        calls.push(`volume rm ${name}`);
        state.removeOpts.push(opts);
        if (state.removeError) throw httpErr(state.removeError);
      },
    }),
    listNetworks: async () =>
      state.networks.map(({ Containers: _c, ...n }) => ({ ...n, Containers: {} })),
    getNetwork: (id: string) => ({
      inspect: async () => {
        calls.push(`network inspect ${id}`);
        const n = state.networks.find((x) => x.Id === id);
        if (!n) throw httpErr(404);
        return n;
      },
      remove: async () => {
        calls.push(`network rm ${id}`);
        if (state.removeError) throw httpErr(state.removeError);
      },
    }),
  };
}

export function newState(over: Partial<FakeDockerState> = {}): FakeDockerState {
  return {
    containers: defaultContainers(),
    calls: [],
    removeOpts: [],
    images: [],
    volumes: [],
    df: { Volumes: [] },
    networks: [],
    ...over,
  };
}

/** A dispatcher whose ctx.host.docker is the fake. */
export function setupDocker(
  state: FakeDockerState,
  exec?: ExecFn,
  overrides: Partial<ActionContext> = {},
) {
  const s = setupAdmin(exec, overrides);
  (s.ctx.host as { docker: unknown }).docker = fakeDocker(state);
  return s;
}

/** Element `i` or a thrown error (no non-null assertions in tests). */
export function at<T>(list: readonly T[], i: number): T {
  const v = list[i];
  if (v === undefined) throw new Error(`no element ${i}`);
  return v;
}
