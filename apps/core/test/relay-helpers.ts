import type { RelayRoute } from '@hz/shared';
import {
  createEnrollToken,
  helloMsg,
  inventoryMsg,
  metricsMsg,
  until,
  WsClient,
  type Received,
} from './agent-helpers.js';
import { gameRequest, type GameSetup } from './games-helpers.js';

export const INGRESS_TS_IP = '100.64.0.9';
export const INGRESS_PUBLIC_IP = '198.51.100.7';

/** How the fake ingress agent answers relay.set. */
export interface IngressBehaviour {
  /** rpc error instead of a result (e.g. not_allowed without HZ_AGENT_ALLOW_RELAY). */
  refuse: { code: string; message: string } | null;
  /** Route ids reported as not listening, with the agent's reason. */
  failRoutes: Map<string, string>;
}

export interface FakeIngress {
  ws: WsClient;
  serverId: string;
  token: string;
  name: string;
  /** Every relay.set the agent received (route lists). */
  sets: RelayRoute[][];
  behaviour: IngressBehaviour;
  rpcs: Received[];
  /** Round trip so earlier frames are processed by the core. */
  keepAlive(): Promise<void>;
  sendInventory(over?: { tailscaleIp?: string; publicIp?: string }): Promise<void>;
}

function attach(
  ws: WsClient,
  serverId: string,
  token: string,
  name: string,
  behaviour: IngressBehaviour,
  sets: RelayRoute[][],
): FakeIngress {
  const rpcs: Received[] = [];
  let pongs = 0;
  ws.ws.on('message', (raw) => {
    const m = JSON.parse(String(raw)) as Received;
    if (m.type === 'ping') ws.send({ type: 'pong', ts: m.ts });
    if (m.type === 'pong') pongs += 1;
    if (m.type !== 'rpc') return;
    rpcs.push(m);
    const id = m.id as string;
    if (m.action !== 'relay.set') {
      ws.send({ type: 'rpc.result', id, ok: true, data: null });
      return;
    }
    const routes = (m.params as { routes: RelayRoute[] }).routes;
    sets.push(routes);
    if (behaviour.refuse) {
      ws.send({ type: 'rpc.result', id, ok: false, error: behaviour.refuse });
      return;
    }
    ws.send({
      type: 'rpc.result',
      id,
      ok: true,
      data: {
        routes: routes.map((r) => {
          const err = behaviour.failRoutes.get(r.id);
          return { id: r.id, ok: err === undefined, error: err ?? null };
        }),
      },
    });
  });
  const keepAlive = async () => {
    const before = pongs;
    ws.send({ type: 'ping', ts: new Date().toISOString() });
    await until(() => pongs > before);
  };
  return {
    ws,
    serverId,
    token,
    name,
    sets,
    behaviour,
    rpcs,
    keepAlive,
    sendInventory: async (over = {}) => {
      ws.send(
        inventoryMsg({
          system: {
            hostname: name,
            os: 'Ubuntu 24.04',
            kernel: '6.8.0',
            arch: 'x64',
            tailscaleIp: over.tailscaleIp ?? INGRESS_TS_IP,
            publicIp: over.publicIp ?? INGRESS_PUBLIC_IP,
          },
          containers: [],
          listeningPorts: [{ proto: 'tcp', address: '0.0.0.0', port: 22, process: 'sshd' }],
        }),
      );
      await keepAlive();
    },
  };
}

/** Enrolls a third sim server as ingress (hello with capabilities.relay). */
export async function addIngress(
  s: GameSetup,
  clients: WsClient[],
  opts: { name?: string; relay?: boolean; publicIp?: string } = {},
): Promise<FakeIngress> {
  const name = opts.name ?? 'edge';
  const enroll = await createEnrollToken(s.t, s.cookie, name);
  const ws = await WsClient.connect(`${s.url}/agent`);
  clients.push(ws);
  ws.send(
    helloMsg(enroll, {
      name,
      capabilities: { terminal: false, docker: true, relay: opts.relay ?? true },
    }),
  );
  const enrolled = await ws.nextOfType('enrolled');
  await ws.nextOfType('welcome');
  const ing = attach(
    ws,
    enrolled.serverId as string,
    enrolled.agentToken as string,
    name,
    { refuse: null, failRoutes: new Map() },
    [],
  );
  ws.send(metricsMsg());
  await ing.sendInventory(opts.publicIp ? { publicIp: opts.publicIp } : {});
  return ing;
}

/** The ingress agent reconnects (same token, new socket; keeps the recorded sets). */
export async function reconnectIngress(
  s: GameSetup,
  clients: WsClient[],
  old: FakeIngress,
): Promise<FakeIngress> {
  old.ws.ws.terminate();
  await until(() => !s.t.app.hzCore.hub.isConnected(old.serverId));
  const ws = await WsClient.connect(`${s.url}/agent`);
  clients.push(ws);
  // Answer before the hello: the core sends relay.set right after welcome.
  const ing = attach(ws, old.serverId, old.token, old.name, old.behaviour, old.sets);
  ws.send(
    helloMsg(old.token, {
      name: old.name,
      capabilities: { terminal: false, docker: true, relay: true },
    }),
  );
  await ws.nextOfType('welcome');
  await ing.keepAlive();
  return ing;
}

export function putIngress(s: GameSetup, serverId: string, payload: Record<string, unknown> = {}) {
  return gameRequest(s, 'PUT', `/api/servers/${serverId}/ingress`, {
    enabled: true,
    publicIp: null,
    portFrom: 25565,
    portTo: 25600,
    ...payload,
  });
}

export function putRelay(s: GameSetup, gameId: string, payload: Record<string, unknown>) {
  return gameRequest(s, 'PUT', `/api/games/${gameId}/relay`, payload);
}

/** Waits for background relay work (queued reconciles, DNS). */
export async function relayIdle(s: GameSetup): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await s.t.app.hzCore.relay.idle();
  await s.t.app.hzCore.games.idle();
  await new Promise((r) => setImmediate(r));
  await s.t.app.hzCore.relay.idle();
}
