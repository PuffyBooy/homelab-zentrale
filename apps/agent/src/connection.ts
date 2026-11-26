import WebSocket from 'ws';
import {
  AGENT_CLOSE,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  agentToCoreSchema,
  parseCoreMessage,
  type AgentToCore,
  type CoreToAgent,
  type Inventory,
  type Metrics,
  type RpcEnvelope,
  type RpcResult,
  type TransferAck,
  type TransferChunk,
  type TransferEnd,
} from '@hz/shared';
import { PROTOCOL_PAUSE_MS, REJECT_PAUSE_MS, backoffDelay } from './backoff.js';
import type { Logger } from './log.js';
import { loadState, saveState } from './state.js';

export interface ConnectionOptions {
  coreUrl: string;
  name: string;
  dataDir: string;
  /** HZ_AGENT_TOKEN (enrollment or agent token). */
  envToken: string | undefined;
  allowTerminal: boolean;
  /** HZ_AGENT_ALLOW_RELAY=1 (capability relay in hello). */
  allowRelay?: boolean;
  docker: boolean;
  version: string;
  arch: string;
  osName: () => Promise<string>;
  log: Logger;
  collectMetrics: () => Promise<Metrics>;
  collectInventory: () => Promise<Inventory>;
  handleRpc: (env: RpcEnvelope) => Promise<RpcResult>;
  /** After an rpc.result was sent (sent=false: the socket was gone). Streams go live here. */
  onRpcResultSent?: (result: RpcResult, sent: boolean) => void;
  /** stream.cancel from the core. */
  onStreamCancel?: (streamId: string) => void;
  /** transfer.chunk / transfer.ack / transfer.end from the core (game.import, game.export). */
  onTransfer?: (msg: TransferChunk | TransferAck | TransferEnd) => void;
  /** The connection closed; every stream is lost for the core. */
  onDisconnect?: () => void;
  /** welcome received: the connection is ready (M17 health marker, pending update results). */
  onReady?: () => void;
  /** Test hook: creates the WebSocket. */
  createSocket?: (url: string) => WebSocket;
  random?: () => number;
  /** ws ping interval; a connection without any traffic for 2.5x is dead. Default 20 s. */
  heartbeatMs?: number;
  /** Time to wait for welcome/enrolled after hello. Default 15 s. */
  handshakeTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  rejectPauseMs?: number;
  protocolPauseMs?: number;
}

const MAX_PARALLEL_RPC = 8;
/** A session that lasted this long resets the backoff. */
const STABLE_MS = 30_000;

export type ConnectionPhase = 'idle' | 'connecting' | 'handshake' | 'ready' | 'waiting' | 'stopped';

/**
 * The outbound connection to the core (docs/ARCHITECTURE.md, Agent-Protokoll).
 * The agent never listens on a port; it dials HZ_CORE_URL and reconnects with
 * exponential backoff and jitter.
 */
export class AgentConnection {
  phase: ConnectionPhase = 'idle';
  serverId: string | null = null;
  /** Last delay chosen for a reconnect (for tests and logs). */
  lastDelayMs = 0;

  private ws: WebSocket | null = null;
  private token: string | undefined;
  private savedToken: string | undefined;
  private triedEnvAfterReject = false;
  private attempt = 0;
  private pauseMs: number | null = null;
  private lastTraffic = 0;
  private readyAt = 0;
  private inbox: Promise<void> = Promise.resolve();
  private timers: NodeJS.Timeout[] = [];
  private reconnectTimer: NodeJS.Timeout | null = null;
  private inFlight = 0;
  private busyMetrics = false;
  private busyInventory = false;
  /** An inventory was requested while one was being collected. */
  private inventoryAgain = false;

  constructor(private readonly o: ConnectionOptions) {
    o.log.addSecret(o.envToken);
  }

  async start(): Promise<void> {
    const state = await loadState(this.o.dataDir);
    if (state) {
      this.savedToken = state.agentToken;
      this.serverId = state.serverId;
      this.o.log.addSecret(state.agentToken);
    }
    this.token = this.savedToken ?? this.o.envToken;
    if (!this.token)
      throw new Error('no token: set HZ_AGENT_TOKEN (enrollment token from the core)');
    this.connect();
  }

  stop(): void {
    this.phase = 'stopped';
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.clearTimers();
    this.ws?.terminate();
    this.ws = null;
  }

  private clearTimers(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private connect(): void {
    if (this.phase === 'stopped') return;
    this.phase = 'connecting';
    this.pauseMs = null;
    const ws = this.o.createSocket
      ? this.o.createSocket(this.o.coreUrl)
      : new WebSocket(this.o.coreUrl, {
          maxPayload: MAX_MESSAGE_BYTES,
          handshakeTimeout: 15_000,
          perMessageDeflate: false,
          followRedirects: false,
        });
    this.ws = ws;

    ws.on('open', () => void this.onOpen(ws));
    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      this.lastTraffic = Date.now();
      if (isBinary) return;
      const raw = Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : Buffer.from(data).toString('utf8');
      const msg = parseCoreMessage(raw);
      if (!msg) {
        this.o.log.warn('invalid message from core dropped', { bytes: raw.length });
        return;
      }
      // Control messages run strictly in order (enrolled is saved before welcome is
      // handled); RPCs are only started in order and then run in parallel.
      this.inbox = this.inbox
        .then(() => this.onMessage(ws, msg))
        .catch((err: unknown) => this.o.log.error('message handling failed', { error: err }));
    });
    ws.on('pong', () => {
      this.lastTraffic = Date.now();
    });
    ws.on('error', (err) => {
      this.o.log.warn('connection error', { error: err.message });
    });
    ws.on('close', (code) => this.onClose(ws, code));
  }

  private async onOpen(ws: WebSocket): Promise<void> {
    if (ws !== this.ws) return;
    const token = this.token;
    if (!token) {
      ws.terminate();
      return;
    }
    this.phase = 'handshake';
    this.lastTraffic = Date.now();
    this.o.log.info('connected, sending hello', { url: this.o.coreUrl });
    const osName = (await this.o.osName()).slice(0, 120);
    this.send({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      name: this.o.name,
      version: this.o.version.slice(0, 40),
      arch: this.o.arch.slice(0, 20),
      os: osName,
      token,
      capabilities: {
        terminal: this.o.allowTerminal,
        docker: this.o.docker,
        relay: this.o.allowRelay === true,
      },
    });
    const handshakeTimeout = this.o.handshakeTimeoutMs ?? 15_000;
    this.timers.push(
      setTimeout(() => {
        if (ws === this.ws && this.phase === 'handshake') {
          this.o.log.warn('no welcome from core, reconnecting');
          ws.terminate();
        }
      }, handshakeTimeout),
    );
    const hb = this.o.heartbeatMs ?? 20_000;
    this.timers.push(
      setInterval(() => {
        if (ws !== this.ws) return;
        if (Date.now() - this.lastTraffic > hb * 2.5) {
          this.o.log.warn('connection dead (no traffic), reconnecting');
          ws.terminate();
          return;
        }
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, hb),
    );
  }

  private async onMessage(ws: WebSocket, msg: CoreToAgent): Promise<void> {
    if (ws !== this.ws) return;
    switch (msg.type) {
      case 'enrolled': {
        this.o.log.addSecret(msg.agentToken);
        // Use the new token from now on, even if saving fails (then it lives until restart).
        this.savedToken = msg.agentToken;
        this.token = msg.agentToken;
        this.serverId = msg.serverId;
        this.triedEnvAfterReject = false;
        try {
          await saveState(this.o.dataDir, {
            agentToken: msg.agentToken,
            serverId: msg.serverId,
            savedAt: new Date().toISOString(),
          });
          this.o.log.info('enrolled, agent token saved', { serverId: msg.serverId });
        } catch (err) {
          this.o.log.error('enrolled, but saving the agent token failed (is /data writable?)', {
            error: err,
          });
        }
        return;
      }
      case 'welcome': {
        this.phase = 'ready';
        this.serverId = msg.serverId;
        this.readyAt = Date.now();
        this.o.log.info('welcome', {
          serverId: msg.serverId,
          metricsIntervalS: msg.metricsIntervalS,
          inventoryIntervalS: msg.inventoryIntervalS,
        });
        this.startReporting(ws, msg.metricsIntervalS, msg.inventoryIntervalS);
        this.o.onReady?.();
        return;
      }
      case 'reject': {
        this.onReject(msg.code);
        ws.close(1000);
        return;
      }
      case 'ping':
        this.send({ type: 'pong', ts: new Date().toISOString() });
        return;
      case 'pong':
        return;
      case 'rpc': {
        if (this.phase !== 'ready') return;
        if (this.inFlight >= MAX_PARALLEL_RPC) {
          this.send({
            type: 'rpc.result',
            id: msg.id,
            ok: false,
            error: { code: 'busy', message: 'too many parallel actions' },
          });
          return;
        }
        this.inFlight += 1;
        void this.o
          .handleRpc(msg)
          .then((result) => {
            const sent = this.send(result);
            this.o.onRpcResultSent?.(result, sent);
          })
          .catch(() =>
            this.send({
              type: 'rpc.result',
              id: msg.id,
              ok: false,
              error: { code: 'failed', message: 'action failed' },
            }),
          )
          .finally(() => {
            this.inFlight -= 1;
          });
        return;
      }
      case 'stream.cancel':
        this.o.onStreamCancel?.(msg.streamId);
        return;
      case 'transfer.chunk':
      case 'transfer.ack':
      case 'transfer.end':
        if (this.phase !== 'ready') return;
        this.o.onTransfer?.(msg);
        return;
    }
  }

  private onReject(code: 'bad_token' | 'revoked' | 'protocol' | 'name_taken' | 'invalid'): void {
    this.o.log.error('core rejected the agent', { code });
    if (code === 'protocol') {
      this.pauseMs = this.o.protocolPauseMs ?? PROTOCOL_PAUSE_MS;
      return;
    }
    if (code === 'invalid') return; // normal backoff
    if (
      (code === 'bad_token' || code === 'revoked') &&
      this.token === this.savedToken &&
      this.o.envToken &&
      this.o.envToken !== this.savedToken &&
      !this.triedEnvAfterReject
    ) {
      // The saved token is dead but HZ_AGENT_TOKEN holds a different (new) one: try it once.
      this.triedEnvAfterReject = true;
      this.token = this.o.envToken;
      return;
    }
    this.pauseMs = this.o.rejectPauseMs ?? REJECT_PAUSE_MS;
  }

  private onClose(ws: WebSocket, code: number): void {
    if (ws !== this.ws) return;
    this.ws = null;
    this.clearTimers();
    this.o.onDisconnect?.();
    if (this.phase === 'stopped') return;
    // Reset the backoff only after a stable session, so a flapping core is not hammered.
    if (this.phase === 'ready' && Date.now() - this.readyAt >= STABLE_MS) this.attempt = 0;
    if (code === AGENT_CLOSE.REVOKED && this.pauseMs === null) {
      this.pauseMs = this.o.rejectPauseMs ?? REJECT_PAUSE_MS;
    }
    const delay =
      this.pauseMs ??
      backoffDelay(this.attempt, {
        baseMs: this.o.backoffBaseMs ?? 1000,
        maxMs: this.o.backoffMaxMs ?? 60_000,
        random: this.o.random ?? Math.random,
      });
    this.attempt += 1;
    this.lastDelayMs = delay;
    this.phase = 'waiting';
    this.o.log.info('disconnected, reconnecting', { closeCode: code, inMs: delay });
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private startReporting(ws: WebSocket, metricsS: number, inventoryS: number): void {
    const sendMetrics = async () => {
      if (this.busyMetrics || ws !== this.ws) return;
      this.busyMetrics = true;
      try {
        this.send(await this.o.collectMetrics());
      } catch (err) {
        this.o.log.warn('metrics failed', { error: err });
      } finally {
        this.busyMetrics = false;
      }
    };
    void sendMetrics();
    void this.sendInventory(ws);
    this.timers.push(setInterval(() => void sendMetrics(), metricsS * 1000));
    this.timers.push(setInterval(() => void this.sendInventory(ws), inventoryS * 1000));
  }

  private async sendInventory(ws: WebSocket): Promise<void> {
    if (ws !== this.ws) return;
    if (this.busyInventory) {
      this.inventoryAgain = true;
      return;
    }
    this.busyInventory = true;
    try {
      do {
        this.inventoryAgain = false;
        const inv = await this.o.collectInventory();
        if (ws !== this.ws) return;
        this.send(inv);
      } while (this.inventoryAgain);
    } catch (err) {
      this.o.log.warn('inventory failed', { error: err });
    } finally {
      this.busyInventory = false;
      this.inventoryAgain = false;
    }
  }

  /** Sends an inventory now (Docker event). No-op until the handshake is done. */
  requestInventory(): void {
    const ws = this.ws;
    if (!ws || this.phase !== 'ready') return;
    void this.sendInventory(ws);
  }

  /** True after welcome until the connection closes. */
  isReady(): boolean {
    return this.phase === 'ready' && this.ws !== null;
  }

  /** Bytes waiting in the WebSocket send buffer (stream backpressure). */
  bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  /** Sends a message after validating it against the protocol. Invalid messages are dropped. */
  send(msg: AgentToCore): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const parsed = agentToCoreSchema.safeParse(msg);
    if (!parsed.success) {
      this.o.log.warn('outgoing message does not match the protocol, dropped', {
        type: msg.type,
        issues: parsed.error.issues.slice(0, 5).map((i) => i.path.join('.')),
      });
      return false;
    }
    const raw = JSON.stringify(parsed.data);
    if (raw.length > MAX_MESSAGE_BYTES) {
      this.o.log.warn('outgoing message too large, dropped', { type: msg.type });
      return false;
    }
    ws.send(raw);
    return true;
  }
}
