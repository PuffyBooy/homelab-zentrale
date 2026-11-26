import { createHash } from 'node:crypto';
import type { AgentEvent, ContainerInfo } from '@hz/shared';
import { randomToken } from '../src/crypto.js';
import { servers } from '../src/db/schema.js';
import {
  enrollAgent,
  inventoryMsg,
  listen,
  until,
  type Received,
  type WsClient,
} from './agent-helpers.js';
import { completeSetup, makeApp, type TestApp } from './helpers.js';

/** Hex docker id derived from a label, so tests can recreate containers. */
export const dockerIdOf = (label: string): string =>
  createHash('sha256').update(label).digest('hex').slice(0, 64);

export function info(name: string, over: Partial<ContainerInfo> = {}): ContainerInfo {
  return {
    dockerId: dockerIdOf(name),
    name,
    image: `${name}:latest`,
    state: 'running',
    health: 'none',
    statusText: 'Up 1 hour',
    ports: [],
    ...over,
  };
}

/** A server row without an agent (for service-level tests). */
export function insertServer(t: TestApp, name = 'heimserver'): string {
  const id = randomToken(16);
  t.db.db
    .insert(servers)
    .values({
      id,
      name,
      location: 'Wien',
      arch: 'x64',
      os: 'Ubuntu',
      tailscaleIp: null,
      publicIp: null,
      agentVersion: null,
      capabilitiesJson: null,
      thresholdsJson: '{}',
      allowTerminal: false,
      createdAt: t.clock.t,
      lastSeen: t.clock.t,
    })
    .run();
  return id;
}

export function inventory(t: TestApp, serverId: string, list: ContainerInfo[]): void {
  t.app.hzCore.servers.ingestInventory(serverId, inventoryMsg({ containers: list }));
}

export function event(t: TestApp, serverId: string, e: AgentEvent['event']): void {
  t.app.hzCore.servers.onEvent(serverId, {
    type: 'event',
    ts: new Date(t.clock.t).toISOString(),
    event: e,
  });
}

export function containerByName(t: TestApp, name: string, serverId?: string) {
  return t.app.hzCore.containers.list(serverId).find((c) => c.name === name);
}

export interface AgentSetup {
  t: TestApp;
  url: string;
  cookie: string;
  secret: string;
  agent: WsClient;
  serverId: string;
  rpcs: Received[];
}

/**
 * App + admin + enrolled agent that answers every RPC (ok, data null) unless
 * `reply` returns something else. All RPCs are collected in `rpcs`.
 */
export async function withAgent(
  clients: WsClient[],
  opts: {
    containers?: ContainerInfo[];
    reply?: (rpc: Received) => Record<string, unknown> | null | 'silent';
  } = {},
): Promise<AgentSetup> {
  const t = await makeApp({ liveOptions: { throttleMs: 10, appendThrottleMs: 5 } });
  const admin = await completeSetup(t);
  const url = await listen(t);
  const e = await enrollAgent(t, url, admin.cookie);
  clients.push(e.agent);
  const rpcs: Received[] = [];
  e.agent.ws.on('message', (data) => {
    const m = JSON.parse(String(data)) as Received;
    if (m.type !== 'rpc') return;
    rpcs.push(m);
    if (m.action === 'container.logs') return; // streams are driven by the test
    const r = opts.reply?.(m) ?? null;
    if (r === 'silent') return;
    e.agent.send(r ?? { type: 'rpc.result', id: m.id, ok: true, data: null });
  });
  const list = opts.containers ?? [
    info('homeassistant'),
    info('old', { state: 'exited', exitCode: 0 }),
  ];
  e.agent.send(inventoryMsg({ containers: list }));
  await until(() => t.app.hzCore.containers.list().length === list.length);
  return { t, url, ...admin, agent: e.agent, serverId: e.serverId, rpcs };
}
