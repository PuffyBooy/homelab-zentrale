import type { LightMyRequestResponse } from 'fastify';
import {
  estimateAzureCost,
  cloudMachineResponseSchema,
  type CloudMachine,
  type ContainerInfo,
  type Modules,
} from '@hz/shared';
import {
  FAKE_AZURE_CLIENT,
  FAKE_AZURE_GROUP,
  FAKE_AZURE_SECRET,
  FAKE_AZURE_SUBSCRIPTION,
  FAKE_AZURE_TENANT,
  FAKE_PRICES,
  FAKE_TAILSCALE_KEY,
  FakeAzure,
} from '../../../e2e/helpers/fake-azure.js';
import {
  helloMsg,
  inventoryMsg,
  listen,
  metricsMsg,
  until,
  withStepUp,
  WsClient,
  type Received,
} from './agent-helpers.js';
import { FIXTURE_TEMPLATES, ONLINE, type StatusAnswer } from './games-helpers.js';
import { authHeaders, completeSetup, makeApp, type TestApp } from './helpers.js';

export {
  FAKE_AZURE_CLIENT,
  FAKE_AZURE_GROUP,
  FAKE_AZURE_SECRET,
  FAKE_AZURE_SUBSCRIPTION,
  FAKE_AZURE_TENANT,
  FAKE_TAILSCALE_KEY,
  FakeAzure,
};

/** Running price of Standard_B2ms with 32 GB StandardSSD and a public IP at the fake prices. */
export const B2MS_RUNNING = estimateAzureCost({
  computeEurPerHour: FAKE_PRICES.Standard_B2ms ?? 0,
  diskType: 'StandardSSD_LRS',
  diskGb: 32,
  publicIp: true,
  source: 'live',
}).runningEurPerHour;

export interface CloudSetup {
  t: TestApp;
  url: string;
  cookie: string;
  secret: string;
  headers: Record<string, string>;
  azure: FakeAzure;
}

/** App with the cloud and games modules on, an admin and the fake Azure as transport. */
export async function withCloud(
  opts: {
    modules?: Partial<Modules>;
    env?: Record<string, string>;
    account?: boolean;
    captureLogs?: boolean;
  } = {},
): Promise<CloudSetup> {
  const azure = new FakeAzure();
  const t = await makeApp({
    env: { HZ_GAME_TEMPLATES_DIR: FIXTURE_TEMPLATES, ...opts.env },
    modules: { cloud: true, games: true, ...opts.modules },
    cloudFetch: azure.fetch,
    ...(opts.captureLogs ? { captureLogs: true } : {}),
  });
  const admin = await completeSetup(t);
  const url = await listen(t);
  const s: CloudSetup = { t, url, ...admin, headers: authHeaders(admin.cookie), azure };
  if (opts.account !== false) await setAccount(s);
  return s;
}

export function req(
  s: CloudSetup,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return s.t.app.inject({
    method,
    url,
    headers: s.headers,
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
}

export async function setAccount(s: CloudSetup, over: Record<string, unknown> = {}): Promise<void> {
  const res = await withStepUp(s.t, () =>
    req(s, 'PUT', '/api/cloud/azure', {
      tenantId: FAKE_AZURE_TENANT,
      clientId: FAKE_AZURE_CLIENT,
      clientSecret: FAKE_AZURE_SECRET,
      subscriptionId: FAKE_AZURE_SUBSCRIPTION,
      resourceGroup: FAKE_AZURE_GROUP,
      tailscaleAuthKey: FAKE_TAILSCALE_KEY,
      ...over,
    }),
  );
  if (res.statusCode !== 200) throw new Error(`account ${res.statusCode} ${res.body}`);
}

export const MC_GAME = { templateId: 'minecraft-java', name: 'survival', values: {} } as const;

export function orderBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'azure',
    name: 'hz-mc',
    size: 'Standard_B2ms',
    confirmEurPerHour: B2MS_RUNNING,
    game: MC_GAME,
    ...over,
  };
}

export async function order(
  s: CloudSetup,
  over: Record<string, unknown> = {},
): Promise<CloudMachine> {
  const res = await req(s, 'POST', '/api/cloud/machines', orderBody(over));
  if (res.statusCode !== 202) throw new Error(`order ${res.statusCode} ${res.body}`);
  return cloudMachineResponseSchema.parse(res.json()).machine;
}

/** Moves the clock, runs the scheduler and waits for the cloud tick (not for game starts). */
export async function cloudTick(s: CloudSetup, ms = 5_000, agent?: SimAgent): Promise<void> {
  s.t.clock.advance(ms);
  if (agent?.connected) await agent.keepAlive(s.t);
  await s.t.app.hzCore.scheduler.tick();
  await s.t.app.hzCore.cloud.idle();
}

export function machineOf(s: CloudSetup, id: string): CloudMachine {
  return s.t.app.hzCore.cloud.machine(id);
}

/** Ticks until the machine reaches `state` (at most `n` ticks). */
export async function untilState(
  s: CloudSetup,
  id: string,
  state: CloudMachine['state'],
  agent?: SimAgent,
  n = 20,
): Promise<CloudMachine> {
  for (let i = 0; i < n; i++) {
    const m = machineOf(s, id);
    if (m.state === state) return m;
    await cloudTick(s, 5_000, agent);
  }
  const m = machineOf(s, id);
  throw new Error(`state ${m.state} (${m.stateText}), wanted ${state}`);
}

let dockerSeq = 0x200000000000;

/**
 * The agent that cloud-init would install: exchanges the onboarding code found in the
 * VM's customData, enrolls, and answers compose.* / game.* like the real one.
 */
export class SimAgent {
  ws: WsClient | null = null;
  agentToken = '';
  serverId = '';
  readonly rpcs: Received[] = [];
  readonly running = new Map<string, ContainerInfo>();
  status: StatusAnswer = { ...ONLINE, players: { online: 0, max: 20, names: [] } };
  private pongs = 0;

  constructor(readonly name: string) {}

  get connected(): boolean {
    return this.ws !== null && this.ws.closeInfo === null;
  }

  async enroll(s: CloudSetup, code: string): Promise<void> {
    const ex = await s.t.app.inject({
      method: 'POST',
      url: '/api/onboarding/exchange',
      headers: {
        host: 'hz.test',
        'x-forwarded-for': '100.64.0.50',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ code }),
    });
    if (ex.statusCode !== 200) throw new Error(`exchange ${ex.statusCode}`);
    const enrollToken = /HZ_AGENT_TOKEN=(\S+)/.exec(ex.body)?.[1];
    if (!enrollToken) throw new Error('no enroll token');
    const ws = await WsClient.connect(`${s.url}/agent`);
    // Handler first: the core may send RPCs right after the welcome.
    this.attach(s, ws);
    ws.send(helloMsg(enrollToken, { name: this.name }));
    const enrolled = await ws.nextOfType('enrolled');
    await ws.nextOfType('welcome');
    this.agentToken = enrolled.agentToken as string;
    this.serverId = enrolled.serverId as string;
    this.report(s);
  }

  async reconnect(s: CloudSetup): Promise<void> {
    // A rebooted VM: containers are gone until compose up.
    this.running.clear();
    const ws = await WsClient.connect(`${s.url}/agent`);
    this.attach(s, ws);
    ws.send(helloMsg(this.agentToken, { name: this.name }));
    await ws.nextOfType('welcome');
    this.report(s);
  }

  /** metrics + inventory, as the agent sends them after the welcome. */
  report(s: CloudSetup): void {
    this.ws?.send(metricsMsg({ ramPct: 10 }));
    this.ws?.send(this.inventory(s));
  }

  async disconnect(): Promise<void> {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.close();
    await ws.closed;
  }

  private inventory(s: CloudSetup) {
    return inventoryMsg({
      ts: new Date(s.t.clock.t).toISOString(),
      system: {
        hostname: this.name,
        os: 'Ubuntu 24.04',
        kernel: '6.8.0',
        arch: 'x64',
        tailscaleIp: '100.64.0.77',
      },
      containers: [...this.running.values()],
      listeningPorts: [{ proto: 'tcp', address: '0.0.0.0', port: 25565, process: 'java' }],
    });
  }

  sendMetrics(): void {
    this.ws?.send(metricsMsg({ ramPct: 10 }));
  }

  async keepAlive(t: TestApp): Promise<void> {
    if (!this.ws) return;
    const before = this.pongs;
    this.ws.send({ type: 'ping', ts: new Date(t.clock.t).toISOString() });
    await until(() => this.pongs > before);
  }

  private attach(s: CloudSetup, ws: WsClient): void {
    this.ws = ws;
    ws.ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as Received;
      if (m.type === 'pong') this.pongs += 1;
      if (m.type === 'ping') ws.send({ type: 'pong', ts: m.ts });
      if (m.type !== 'rpc') return;
      this.rpcs.push(m);
      const id = m.id as string;
      const params = m.params as Record<string, unknown>;
      const ok = (d: unknown) => ws.send({ type: 'rpc.result', id, ok: true, data: d });
      const dir = (params.dir ?? params.gameDir) as string | undefined;
      const name = dir?.split('/').pop() ?? '';
      switch (m.action as string) {
        case 'compose.up':
          dockerSeq += 1;
          this.running.set(name, {
            dockerId: dockerSeq.toString(16).padStart(12, '0'),
            name: `game-${name}`,
            image: 'itzg/minecraft-server:latest',
            composeProject: name,
            composeService: 'server',
            composeDir: dir ?? '',
            state: 'running',
            health: 'none',
            statusText: 'Up 1 second',
            startedAt: new Date(s.t.clock.t).toISOString(),
            ports: [],
            memBytes: 3 * 1024 ** 3,
            game: name,
          });
          ws.send(this.inventory(s));
          ok({ output: '' });
          return;
        case 'compose.down':
        case 'game.remove':
          this.running.delete(name);
          ws.send(this.inventory(s));
          ok(m.action === 'game.remove' ? null : { output: '' });
          return;
        case 'game.status':
          ok(this.status);
          return;
        case 'game.backup':
          // No world data yet (like a fresh game): the delete goes on without a backup.
          ws.send({
            type: 'rpc.result',
            id,
            ok: false,
            error: { code: 'not_found', message: 'no data' },
          });
          return;
        case 'game.wake.arm':
          ok({ listening: params.ports });
          return;
        case 'compose.write':
          ok({ dir, files: Object.keys(params.files as object) });
          return;
        default:
          ok(null);
      }
    });
  }
}

/** Orders a Minecraft machine and lets the simulated agent enroll; game is ready afterwards. */
export async function orderedWithGame(
  s: CloudSetup,
  over: Record<string, unknown> = {},
): Promise<{ machine: CloudMachine; agent: SimAgent; gameId: string }> {
  const ordered = await order(s, over);
  await untilState(s, ordered.id, 'installing');
  const code = s.azure.onboardingCode(ordered.name);
  if (!code) throw new Error('no code in cloud-init');
  const agent = new SimAgent(ordered.name);
  await agent.enroll(s, code);
  await until(() => s.t.app.hzCore.hub.isConnected(agent.serverId));
  await untilState(s, ordered.id, 'running', agent);
  // The pending game is created on the next running tick; then its setup runs.
  await cloudTick(s, 5_000, agent);
  await s.t.app.hzCore.games.idle();
  const m = machineOf(s, ordered.id);
  const gameId = m.gameIds[0];
  if (!gameId) throw new Error(`no game: ${m.stateText}`);
  for (let i = 0; i < 5; i++) {
    const g = s.t.app.hzCore.games.summary(gameId);
    if (g?.status === 'ok') break;
    await cloudTick(s, 5_000, agent);
    await s.t.app.hzCore.games.idle();
  }
  return { machine: m, agent, gameId };
}
