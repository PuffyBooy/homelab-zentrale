import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, type Inventory, type Metrics } from '@hz/shared';
import { authHeaders, totpCode, type TestApp } from './helpers.js';

const GB = 1024 ** 3;

/** Starts the app on a random port. Returns ws://127.0.0.1:<port>. */
export async function listen(t: TestApp): Promise<string> {
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = t.app.server.address() as AddressInfo;
  return `ws://127.0.0.1:${addr.port}`;
}

export interface Received {
  type: string;
  [k: string]: unknown;
}

/** A simulated agent (or browser) over a real ws client. */
export class WsClient {
  readonly received: Received[] = [];
  private cursor = 0;
  private waiters: (() => void)[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  closeInfo: { code: number; reason: string } | null = null;

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      this.received.push(JSON.parse(String(data)) as Received);
      this.wakeAll();
    });
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        this.closeInfo = { code, reason: reason.toString() };
        resolve(this.closeInfo);
        this.wakeAll();
      });
    });
    ws.on('error', () => undefined);
  }

  private wakeAll(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }

  static connect(url: string, headers: Record<string, string> = {}): Promise<WsClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      const client = new WsClient(ws);
      ws.once('open', () => resolve(client));
      ws.once('unexpected-response', (_req, res) => {
        reject(new Error(`unexpected response ${res.statusCode}`));
      });
      ws.once('error', reject);
    });
  }

  /** Rejects with the HTTP status if the upgrade is refused. */
  static async status(url: string, headers: Record<string, string> = {}): Promise<number> {
    return new Promise((resolve) => {
      const ws = new WebSocket(url, { headers });
      ws.once('open', () => {
        ws.close();
        resolve(101);
      });
      ws.once('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
        ws.terminate();
      });
      ws.once('error', () => resolve(-1));
    });
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  sendRaw(data: string | Buffer): void {
    this.ws.send(data);
  }

  /** Next message (after the ones already taken) that matches; waits up to timeoutMs. */
  async next(match: (m: Received) => boolean = () => true, timeoutMs = 3000): Promise<Received> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (this.cursor < this.received.length) {
        const m = this.received[this.cursor++];
        if (m && match(m)) return m;
      }
      if (this.closeInfo) throw new Error(`socket closed (${this.closeInfo.code})`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('timeout waiting for message');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  nextOfType(type: string, timeoutMs?: number): Promise<Received> {
    return this.next((m) => m.type === type, timeoutMs);
  }

  close(): void {
    this.ws.close();
  }
}

export function helloMsg(
  token: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'hello',
    protocol: PROTOCOL_VERSION,
    name: 'heimserver',
    version: '0.2.0',
    arch: 'x64',
    os: 'Ubuntu 24.04',
    token,
    capabilities: { terminal: false, docker: true },
    ...over,
  };
}

export function metricsMsg(
  v: { cpu?: number; ramPct?: number; diskPct?: number; temp?: number | null } = {},
): Metrics {
  const ramTotal = 16 * GB;
  const diskTotal = 1000 * GB;
  return {
    type: 'metrics',
    ts: new Date().toISOString(),
    cpu: v.cpu ?? 12,
    ram: { usedBytes: ((v.ramPct ?? 40) / 100) * ramTotal, totalBytes: ramTotal },
    swap: { usedBytes: 0, totalBytes: 2 * GB },
    disks: [
      {
        mount: '/',
        fs: 'ext4',
        usedBytes: ((v.diskPct ?? 50) / 100) * diskTotal,
        totalBytes: diskTotal,
      },
    ],
    temp: v.temp === undefined ? 45 : v.temp,
    net: { rxBps: 1000, txBps: 500 },
    uptimeS: 3600,
  };
}

export function inventoryMsg(over: Partial<Inventory> = {}): Inventory {
  return {
    type: 'inventory',
    ts: new Date().toISOString(),
    system: {
      hostname: 'heimserver',
      os: 'Ubuntu 24.04',
      kernel: '6.8.0',
      arch: 'x64',
      tailscaleIp: '100.64.0.5',
    },
    containers: [
      {
        dockerId: 'abcdef012345',
        name: 'homeassistant',
        image: 'ghcr.io/home-assistant/home-assistant:stable',
        state: 'running',
        health: 'healthy',
        statusText: 'Up 3 hours',
        ports: [{ privatePort: 8123, publicPort: 8123, proto: 'tcp' }],
      },
      {
        dockerId: 'bcdef0123456',
        name: 'old',
        image: 'busybox',
        state: 'exited',
        health: 'none',
        statusText: 'Exited (0)',
        ports: [],
      },
    ],
    updates: { total: 4, security: 0 },
    rebootRequired: false,
    sshFailed24h: 3,
    fail2banBanned: null,
    listeningPorts: [{ proto: 'tcp', address: '0.0.0.0', port: 22, process: 'sshd' }],
    ...over,
  };
}

/** POST /api/servers/enroll as admin; returns the one-time token. */
export async function createEnrollToken(
  t: TestApp,
  cookie: string,
  name = 'heimserver',
): Promise<string> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/servers/enroll',
    headers: authHeaders(cookie),
    payload: { name, location: 'Wien' },
  });
  if (res.statusCode !== 200) throw new Error(`enroll ${res.statusCode}`);
  return res.json<{ token: string }>().token;
}

export interface Enrolled {
  agent: WsClient;
  serverId: string;
  agentToken: string;
}

/** Full enrollment flow; leaves the agent connected after `welcome`. */
export async function enrollAgent(
  t: TestApp,
  url: string,
  cookie: string,
  name = 'heimserver',
): Promise<Enrolled> {
  const token = await createEnrollToken(t, cookie, name);
  const agent = await WsClient.connect(`${url}/agent`);
  agent.send(helloMsg(token, { name }));
  const enrolled = await agent.nextOfType('enrolled');
  await agent.nextOfType('welcome');
  return {
    agent,
    serverId: enrolled.serverId as string,
    agentToken: enrolled.agentToken as string,
  };
}

/** Reconnects with a permanent agent token; resolves after `welcome`. */
export async function connectAgent(
  url: string,
  agentToken: string,
  name = 'heimserver',
): Promise<WsClient> {
  const agent = await WsClient.connect(`${url}/agent`);
  agent.send(helloMsg(agentToken, { name }));
  await agent.nextOfType('welcome');
  return agent;
}

/** Waits until `cond` is true (polling, real time). */
export async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Step-up with the next TOTP code (moves the fake clock one step). */
export async function stepUp(t: TestApp, secret: string, cookie: string): Promise<void> {
  t.clock.advance(30_000);
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/auth/step-up',
    headers: authHeaders(cookie),
    payload: { code: totpCode(secret, t.clock.t) },
  });
  if (res.statusCode !== 200) throw new Error(`step-up ${res.statusCode}`);
}
