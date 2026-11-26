import { fileURLToPath } from 'node:url';
import type { ContainerInfo, Modules } from '@hz/shared';
import {
  enrollAgent,
  inventoryMsg,
  listen,
  metricsMsg,
  until,
  type Received,
  type WsClient,
} from './agent-helpers.js';
import { authHeaders, completeSetup, makeApp, type TestApp } from './helpers.js';

export const APP_FIXTURES = fileURLToPath(new URL('./fixtures/apps', import.meta.url));

/** How the simulated agent answers. `fail` maps an action to an rpc error. */
export interface AppAgentBehaviour {
  fail: Partial<Record<string, { code: string; message: string }>>;
  /** Extra listening ports the inventory reports. */
  listening: { proto: 'tcp' | 'udp'; address: string; port: number }[];
}

export interface AppsSetup {
  t: TestApp;
  cookie: string;
  secret: string;
  agent: WsClient;
  serverId: string;
  rpcs: Received[];
  behaviour: AppAgentBehaviour;
  headers: Record<string, string>;
  running: Map<string, ContainerInfo>;
  sendInventory: () => Promise<void>;
  /** Waits for the background work of the apps module. */
  idle: () => Promise<void>;
}

let dockerSeq = 0x200000000000;
const nextDockerId = (): string => (dockerSeq++).toString(16).padStart(12, '0');

/**
 * App with the given built-in templates dir (via HZ_APP_TEMPLATES_DIR), module
 * `apps` on, an admin and an enrolled fake agent that answers compose.* and
 * app.remove like the real one (compose up adds a container with the app's
 * compose dir to the inventory, down/remove takes it away).
 */
export async function withApps(
  clients: WsClient[],
  opts: {
    templatesDir?: string;
    captureLogs?: boolean;
    modules?: Partial<Modules>;
    ramPct?: number;
    /** Report no Tailscale IP in the inventory. */
    noTailscaleIp?: boolean;
    arch?: string;
  } = {},
): Promise<AppsSetup> {
  const prev = process.env.HZ_APP_TEMPLATES_DIR;
  process.env.HZ_APP_TEMPLATES_DIR = opts.templatesDir ?? APP_FIXTURES;
  let t: TestApp;
  try {
    t = await makeApp({
      modules: { apps: true, ...opts.modules },
      ...(opts.captureLogs ? { captureLogs: true } : {}),
    });
  } finally {
    if (prev === undefined) delete process.env.HZ_APP_TEMPLATES_DIR;
    else process.env.HZ_APP_TEMPLATES_DIR = prev;
  }
  const admin = await completeSetup(t);
  const url = await listen(t);
  const e = await enrollAgent(t, url, admin.cookie);
  clients.push(e.agent);
  const rpcs: Received[] = [];
  const running = new Map<string, ContainerInfo>();
  const behaviour: AppAgentBehaviour = { fail: {}, listening: [] };
  const pongs = { n: 0 };
  const inventory = () => {
    const base = inventoryMsg({
      containers: [...running.values()],
      listeningPorts: [
        { proto: 'tcp', address: '0.0.0.0', port: 22, process: 'sshd' },
        ...behaviour.listening,
      ],
    });
    const system = { ...base.system, ...(opts.arch ? { arch: opts.arch } : {}) };
    if (opts.noTailscaleIp) delete system.tailscaleIp;
    return { ...base, system };
  };
  e.agent.ws.on('message', (data) => {
    const m = JSON.parse(String(data)) as Received;
    if (m.type === 'pong') pongs.n += 1;
    if (m.type === 'ping') e.agent.send({ type: 'pong', ts: m.ts });
    if (m.type !== 'rpc') return;
    rpcs.push(m);
    const id = m.id as string;
    const action = m.action as string;
    const params = m.params as Record<string, unknown>;
    const ok = (d: unknown) => e.agent.send({ type: 'rpc.result', id, ok: true, data: d });
    const failure = behaviour.fail[action];
    if (failure) {
      e.agent.send({ type: 'rpc.result', id, ok: false, error: failure });
      return;
    }
    const dir =
      typeof params.dir === 'string' ? params.dir : `/opt/homelab/apps/${String(params.appId)}`;
    const name = dir.split('/').pop() ?? '';
    switch (action) {
      case 'compose.up':
        running.set(name, {
          dockerId: nextDockerId(),
          name,
          image: 'vaultwarden/server:1.32.7',
          composeProject: name,
          composeService: 'vaultwarden',
          composeDir: dir,
          state: 'running',
          health: 'healthy',
          statusText: 'Up 1 second',
          ports: [],
        });
        e.agent.send(inventory());
        ok({ output: '' });
        return;
      case 'compose.down':
        running.delete(name);
        e.agent.send(inventory());
        ok({ output: '' });
        return;
      case 'compose.pull':
        ok({ output: '' });
        return;
      case 'app.remove':
        running.delete(name);
        e.agent.send(inventory());
        ok({ removed: true });
        return;
      case 'compose.write':
        ok({ dir, files: Object.keys(params.files as object) });
        return;
      default:
        e.agent.send({
          type: 'rpc.result',
          id,
          ok: false,
          error: { code: 'not_allowed', message: 'unexpected' },
        });
    }
  });
  const sync = async (): Promise<void> => {
    const before = pongs.n;
    e.agent.send({ type: 'ping', ts: new Date(t.clock.t).toISOString() });
    await until(() => pongs.n > before);
  };
  e.agent.send(metricsMsg({ ramPct: opts.ramPct ?? 40 }));
  e.agent.send(inventory());
  await sync();
  const svc = t.app.hzCore.features.apps.service;
  return {
    t,
    ...admin,
    agent: e.agent,
    serverId: e.serverId,
    rpcs,
    behaviour,
    headers: authHeaders(admin.cookie),
    running,
    sendInventory: async () => {
      e.agent.send(inventory());
      await sync();
    },
    idle: async () => {
      await svc.idle();
      await sync();
    },
  };
}

export function rpcsOf(s: AppsSetup, action: string): Received[] {
  return s.rpcs.filter((r) => r.action === action);
}

export function appRequest(
  s: AppsSetup,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
) {
  return s.t.app.inject({
    method,
    url,
    headers: s.headers,
    ...(payload ? { payload } : {}),
  });
}

export const installBody = (
  s: AppsSetup,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  templateId: 'vaultwarden',
  serverId: s.serverId,
  appId: 'vault',
  name: 'Vaultwarden Familie',
  ...over,
});

/** Minimal custom template body (meta + compose). */
export function customTemplate(
  compose: string,
  meta: Record<string, unknown> = {},
): { meta: Record<string, unknown>; compose: string } {
  return {
    meta: {
      id: 'meine-app',
      name: 'Meine App',
      description: 'Eigene Vorlage',
      category: 'werkzeuge',
      version: '1.0',
      arch: ['amd64', 'arm64'],
      minRamMb: 64,
      params: [{ type: 'port', key: 'WEB_PORT', label: 'Web-Port', default: 9300, web: true }],
      ...meta,
    },
    compose,
  };
}

export const SAFE_CUSTOM_COMPOSE = `services:
  web:
    image: nginx:1.27
    ports:
      - "\${BIND}:\${WEB_PORT}:80"
    volumes:
      - ./data/html:/usr/share/nginx/html:ro
`;
