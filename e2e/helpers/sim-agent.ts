import { WebSocket } from 'ws';

/**
 * Simulated agent for e2e: speaks the protocol from packages/shared/src/agent-protocol.ts
 * (hello -> enrolled/welcome -> metrics + inventory) and answers the RPCs the web UI can
 * trigger in M2 (cleanup preview, cleanup). Nothing here runs a real command.
 */

const PROTOCOL_VERSION = 1;
const GB = 1024 ** 3;

export interface SimAgentOptions {
  url: string;
  name: string;
  token: string;
  cpu?: number;
  ramUsed?: number;
  ramTotal?: number;
  diskUsed?: number;
  diskTotal?: number;
  temp?: number | null;
  tailscaleIp?: string;
  metricsEveryMs?: number;
}

type Msg = { type: string; [k: string]: unknown };

export class SimAgent {
  serverId: string | null = null;
  agentToken: string | null = null;
  readonly received: Msg[] = [];
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly o: SimAgentOptions) {}

  /** Connects, sends hello and waits for welcome. */
  async connect(): Promise<void> {
    const ws = new WebSocket(this.o.url);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const fail = (err: unknown): void =>
        reject(err instanceof Error ? err : new Error(String(err)));
      ws.once('error', fail);
      ws.once('close', (code) => fail(new Error(`closed before welcome: ${code}`)));
      ws.once('open', () => {
        this.send({
          type: 'hello',
          protocol: PROTOCOL_VERSION,
          name: this.o.name,
          version: '0.0.0-e2e',
          arch: 'x64',
          os: 'Debian GNU/Linux 12 (bookworm)',
          token: this.agentToken ?? this.o.token,
          capabilities: { terminal: false, docker: false },
        });
      });
      ws.on('message', (raw) => {
        let msg: Msg;
        try {
          msg = JSON.parse(String(raw)) as Msg;
        } catch {
          return;
        }
        this.received.push(msg);
        if (msg.type === 'enrolled') {
          this.agentToken = String(msg.agentToken);
          this.serverId = String(msg.serverId);
        } else if (msg.type === 'welcome') {
          this.serverId = String(msg.serverId);
          ws.removeAllListeners('error');
          ws.removeAllListeners('close');
          resolve();
        } else if (msg.type === 'reject') {
          fail(new Error(`rejected: ${String(msg.code)}`));
        } else if (msg.type === 'ping') {
          this.send({ type: 'pong', ts: new Date().toISOString() });
        } else if (msg.type === 'rpc') {
          this.answer(msg);
        }
      });
    });
    this.sendMetrics();
    this.sendInventory();
    this.timer = setInterval(() => this.sendMetrics(), this.o.metricsEveryMs ?? 5000);
  }

  /** Simulates a stopped agent: socket gone, no more reports. */
  disconnect(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.ws?.terminate();
    this.ws = null;
  }

  sendMetrics(): void {
    const o = this.o;
    this.send({
      type: 'metrics',
      ts: new Date().toISOString(),
      cpu: o.cpu ?? 23,
      load1: 0.4,
      ram: { usedBytes: o.ramUsed ?? 7.8 * GB, totalBytes: o.ramTotal ?? 16 * GB },
      swap: { usedBytes: 0.2 * GB, totalBytes: 2 * GB },
      disks: [
        {
          mount: '/',
          fs: 'ext4',
          usedBytes: o.diskUsed ?? 389 * GB,
          totalBytes: o.diskTotal ?? 480 * GB,
        },
      ],
      temp: o.temp === undefined ? 44.5 : o.temp,
      net: { rxBps: 1.2 * 1024 ** 2, txBps: 340 * 1024 },
      uptimeS: 12 * 86400 + 4 * 3600,
    });
  }

  sendInventory(): void {
    this.send({
      type: 'inventory',
      ts: new Date().toISOString(),
      system: {
        hostname: this.o.name,
        os: 'Debian GNU/Linux 12 (bookworm)',
        kernel: '6.1.0-28-amd64',
        arch: 'x64',
        cpuModel: 'Intel N100',
        cpuCores: 4,
        tailscaleIp: this.o.tailscaleIp ?? '100.64.0.20',
      },
      containers: [],
      updates: { total: 12, security: 3 },
      rebootRequired: true,
      sshFailed24h: 41,
      fail2banBanned: 2,
      listeningPorts: [
        { proto: 'tcp', address: '0.0.0.0', port: 22, process: 'sshd' },
        { proto: 'tcp', address: '127.0.0.1', port: 8123, process: 'python3' },
      ],
    });
  }

  private answer(msg: Msg): void {
    const id = String(msg.id);
    if (msg.action === 'system.cleanupPreview') {
      this.send({
        type: 'rpc.result',
        id,
        ok: true,
        data: {
          items: [
            { kind: 'apt-cache', bytes: 1.2 * GB },
            { kind: 'journal', bytes: 0.8 * GB },
            { kind: 'docker-images', bytes: 6.4 * GB, detail: '7 Images' },
          ],
          totalBytes: 8.4 * GB,
        },
      });
    } else if (msg.action === 'system.cleanup') {
      this.send({ type: 'rpc.result', id, ok: true, data: { freedBytes: 8.4 * GB } });
    } else {
      this.send({
        type: 'rpc.result',
        id,
        ok: false,
        error: { code: 'not_allowed', message: 'not simulated' },
      });
    }
  }

  private send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
