import type { ContainerInfo, Modules } from '@hz/shared';
import {
  createEnrollToken,
  helloMsg,
  inventoryMsg,
  listen,
  until,
  WsClient,
  type Received,
} from './agent-helpers.js';
import { info } from './container-helpers.js';
import { authHeaders, completeSetup, makeApp, type TestApp } from './helpers.js';

/** Shared setup of the M20 automation suites (tasks, selfheal, speedtest). */
export interface AutoSetup {
  t: TestApp;
  url: string;
  cookie: string;
  secret: string;
  agent: WsClient;
  serverId: string;
  rpcs: Received[];
}

export type Reply = (rpc: Received) => Record<string, unknown> | null | 'silent';

export const MIN = 60_000;

/**
 * App with the M20 modules on (unless overridden), an admin and an enrolled sim
 * agent that answers every RPC with ok/null unless `reply` says otherwise.
 * `tasks: true` makes the agent report capabilities.tasks (HZ_AGENT_ALLOW_TASKS=1).
 */
export async function withAutomation(
  clients: WsClient[],
  opts: {
    modules?: Partial<Modules>;
    tasks?: boolean;
    containers?: ContainerInfo[];
    reply?: Reply;
    captureLogs?: boolean;
    name?: string;
  } = {},
): Promise<AutoSetup> {
  const t = await makeApp({
    modules: { tasks: true, selfheal: true, speedtest: true, ...opts.modules },
    // The fake clock jumps minutes at a time; the sim agent must not go stale.
    agentOptions: { staleAfterMs: 365 * 24 * 60 * MIN },
    ...(opts.captureLogs ? { captureLogs: true } : {}),
  });
  const admin = await completeSetup(t);
  const url = await listen(t);
  const name = opts.name ?? 'heimserver';
  const token = await createEnrollToken(t, admin.cookie, name);
  const agent = await WsClient.connect(`${url}/agent`);
  clients.push(agent);
  agent.send(
    helloMsg(token, {
      name,
      capabilities: { terminal: false, docker: true, ...(opts.tasks ? { tasks: true } : {}) },
    }),
  );
  const enrolled = await agent.nextOfType('enrolled');
  await agent.nextOfType('welcome');
  const serverId = enrolled.serverId as string;
  const rpcs: Received[] = [];
  agent.ws.on('message', (data) => {
    const m = JSON.parse(String(data)) as Received;
    if (m.type !== 'rpc') return;
    rpcs.push(m);
    const r = opts.reply?.(m) ?? null;
    if (r === 'silent') return;
    agent.send(r ?? { type: 'rpc.result', id: m.id, ok: true, data: null });
  });
  const list = opts.containers ?? [info('webapp'), info('hz-agent', { role: 'agent' })];
  agent.send(inventoryMsg({ containers: list }));
  await until(() => t.app.hzCore.containers.list().length === list.length);
  return { t, url, ...admin, agent, serverId, rpcs };
}

export function api(
  s: Pick<AutoSetup, 't' | 'cookie'>,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  return s.t.app.inject({
    method,
    url,
    headers: authHeaders(s.cookie),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

/** Grants a step-up on every session (15 min) without moving the clock. */
export function grantStepUp(t: TestApp): void {
  t.db.sqlite.prepare('UPDATE sessions SET step_up_until = ?').run(t.clock.t + 15 * MIN);
}

export function dropStepUp(t: TestApp): void {
  t.db.sqlite.prepare('UPDATE sessions SET step_up_until = NULL').run();
}

export const rpcsOf = (s: AutoSetup, action: string): Received[] =>
  s.rpcs.filter((r) => r.action === action);

export const ok = (m: Received, data: unknown = null) => ({
  type: 'rpc.result',
  id: m.id,
  ok: true,
  data,
});

export const rpcFail = (m: Received, code: string, message = '') => ({
  type: 'rpc.result',
  id: m.id,
  ok: false,
  error: { code, message },
});

/** Waits (real time) until no feature work is in flight. */
export async function settle(s: AutoSetup): Promise<void> {
  const f = s.t.app.hzCore.features;
  await Promise.all([f.tasks.idle(), f.selfheal.idle(), f.speedtest.idle()]);
}

/** Moves the fake clock, runs the scheduler once and waits for the started work. */
export async function advance(s: AutoSetup, ms: number): Promise<void> {
  s.t.clock.advance(ms);
  await s.t.app.hzCore.scheduler.tick();
  await settle(s);
}
