import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  AGENT_CLOSE,
  PROTOCOL_VERSION,
  parseAgentMessage,
  type AgentToCore,
  type Inventory,
  type Metrics,
} from '@hz/shared';
import { AgentConnection, type ConnectionOptions } from '../src/connection.js';
import { createLogger } from '../src/log.js';
import { loadState } from '../src/state.js';

const ENROLL_TOKEN = 'enroll_AAAAAAAAAAAAAAAAAAAAAAAA';
const AGENT_TOKEN = 'agent_BBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const metrics: Metrics = {
  type: 'metrics',
  ts: new Date().toISOString(),
  cpu: 12.5,
  ram: { usedBytes: 1, totalBytes: 2 },
  swap: { usedBytes: 0, totalBytes: 0 },
  disks: [],
  temp: null,
  net: { rxBps: 0, txBps: 0 },
  uptimeS: 10,
};
const inventory: Inventory = {
  type: 'inventory',
  ts: new Date().toISOString(),
  system: { hostname: 'h', os: 'Debian', kernel: '6.1', arch: 'arm64' },
  containers: [],
  updates: null,
  rebootRequired: false,
  sshFailed24h: null,
  fail2banBanned: null,
  listeningPorts: [],
};

let wss: WebSocketServer;
let url: string;
let dataDir: string;
let logLines: string[];
let conn: AgentConnection | null;
/** Received, parsed messages per connection. */
let received: AgentToCore[][];
let onConnection: (ws: WebSocket, index: number) => void;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'hz-agent-data-'));
  logLines = [];
  received = [];
  conn = null;
  onConnection = () => undefined;
  wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/agent' });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/agent`;
  wss.on('connection', (ws) => {
    const idx = received.length;
    const msgs: AgentToCore[] = [];
    received.push(msgs);
    ws.on('message', (data) => {
      const raw = data.toString();
      const parsed = parseAgentMessage(raw);
      // The agent must only send protocol-valid messages.
      expect(parsed, raw).not.toBeNull();
      if (parsed) msgs.push(parsed);
    });
    onConnection(ws, idx);
  });
});

afterEach(async () => {
  conn?.stop();
  for (const c of wss.clients) c.terminate();
  await new Promise<void>((r) => wss.close(() => r()));
  await rm(dataDir, { recursive: true, force: true });
});

function makeConn(over: Partial<ConnectionOptions> = {}): AgentConnection {
  conn = new AgentConnection({
    coreUrl: url,
    name: 'ci-agent',
    dataDir,
    envToken: ENROLL_TOKEN,
    allowTerminal: false,
    docker: false,
    version: '0.0.0',
    arch: 'amd64',
    osName: async () => 'Debian GNU/Linux 12',
    log: createLogger('debug', (l) => logLines.push(l)),
    collectMetrics: async () => ({ ...metrics, ts: new Date().toISOString() }),
    collectInventory: async () => ({ ...inventory, ts: new Date().toISOString() }),
    handleRpc: async (env) => ({
      type: 'rpc.result',
      id: env.id,
      ok: true,
      data: { echo: env.action },
    }),
    random: () => 0,
    backoffBaseMs: 20,
    backoffMaxMs: 80,
    rejectPauseMs: 60_000,
    protocolPauseMs: 120_000,
    heartbeatMs: 1000,
    handshakeTimeoutMs: 2000,
    ...over,
  });
  return conn;
}

async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const send = (ws: WebSocket, msg: unknown) =>
  ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
const welcome = {
  type: 'welcome',
  serverId: 'srv_1',
  protocol: 1,
  metricsIntervalS: 5,
  inventoryIntervalS: 15,
};

describe('handshake and enrollment', () => {
  it('sends hello with protocol version and capabilities', async () => {
    makeConn();
    await conn?.start();
    await until(() => received[0]?.length === 1);
    expect(received[0]?.[0]).toEqual({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      name: 'ci-agent',
      version: '0.0.0',
      arch: 'amd64',
      os: 'Debian GNU/Linux 12',
      token: ENROLL_TOKEN,
      capabilities: { terminal: false, docker: false, relay: false },
    });
  });

  it('announces the relay capability only with HZ_AGENT_ALLOW_RELAY', async () => {
    makeConn({ allowRelay: true });
    await conn?.start();
    await until(() => received[0]?.length === 1);
    expect(received[0]?.[0]).toMatchObject({
      type: 'hello',
      capabilities: { terminal: false, docker: false, relay: true },
    });
  });

  it('stores the agent token with mode 0600 and uses it on reconnect; tokens never hit the log', async () => {
    onConnection = (ws, idx) => {
      ws.once('message', () => {
        if (idx === 0) {
          send(ws, { type: 'enrolled', agentToken: AGENT_TOKEN, serverId: 'srv_1' });
          send(ws, welcome);
          setTimeout(() => ws.close(1001), 50);
        } else send(ws, welcome);
      });
    };
    makeConn();
    await conn?.start();
    await until(() => received.length >= 2 && (received[1]?.length ?? 0) >= 1);
    const hello2 = received[1]?.[0];
    expect(hello2).toMatchObject({ type: 'hello', token: AGENT_TOKEN });

    const file = path.join(dataDir, 'agent.json');
    // The token is used right away; the atomic save (fsync + rename) may finish a
    // moment after the reconnect on a slow runner.
    await until(() => logLines.some((l) => l.includes('agent token saved')));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      agentToken: AGENT_TOKEN,
      serverId: 'srv_1',
    });
    expect(await loadState(dataDir)).toMatchObject({ agentToken: AGENT_TOKEN });

    const log = logLines.join('\n');
    expect(log).toContain('enrolled');
    expect(log).not.toContain(AGENT_TOKEN);
    expect(log).not.toContain(ENROLL_TOKEN);
  });

  it('sends metrics and inventory after welcome', async () => {
    onConnection = (ws) => ws.once('message', () => send(ws, welcome));
    makeConn();
    await conn?.start();
    await until(() => (received[0] ?? []).some((m) => m.type === 'inventory'));
    expect(received[0]?.map((m) => m.type)).toEqual(
      expect.arrayContaining(['hello', 'metrics', 'inventory']),
    );
  });
});

describe('invalid frames', () => {
  it('drops broken, unknown and oversized frames and keeps the connection', async () => {
    onConnection = (ws) => {
      ws.once('message', () => {
        send(ws, welcome);
        send(ws, 'not json');
        send(ws, '{"type":"rpc"}');
        send(ws, { type: 'exec', cmd: 'rm -rf /' });
        send(ws, { type: 'rpc', id: 'short', action: 'container.start', params: { id: 'x' } });
        send(ws, { ...welcome, extra: true });
        send(ws, { type: 'enrolled', agentToken: 'short', serverId: 'x' });
        ws.send(Buffer.from([0, 1, 2]), { binary: true });
        // A valid RPC afterwards still works.
        send(ws, {
          type: 'rpc',
          id: 'rpc_abcdefgh',
          action: 'container.start',
          params: { id: 'web' },
        });
      });
    };
    makeConn();
    await conn?.start();
    await until(() => (received.flat() ?? []).some((m) => m.type === 'rpc.result'));
    const results = received.flat().filter((m) => m.type === 'rpc.result');
    expect(results).toEqual([
      { type: 'rpc.result', id: 'rpc_abcdefgh', ok: true, data: { echo: 'container.start' } },
    ]);
    expect(await loadState(dataDir)).toBeNull();
    expect(logLines.some((l) => l.includes('invalid message from core dropped'))).toBe(true);
  });

  it('closes on an oversized frame (maxPayload) and reconnects', async () => {
    onConnection = (ws, idx) =>
      ws.once('message', () => {
        if (idx === 0) send(ws, JSON.stringify({ type: 'ping', ts: 'x'.repeat(2 * 1024 * 1024) }));
        else send(ws, welcome);
      });
    makeConn();
    await conn?.start();
    await until(() => received.length >= 2 && conn?.phase === 'ready');
  });

  it('ignores rpc before welcome', async () => {
    let rpcSent = false;
    onConnection = (ws) => {
      ws.once('message', () => {
        send(ws, {
          type: 'rpc',
          id: 'rpc_abcdefgh',
          action: 'container.start',
          params: { id: 'web' },
        });
        rpcSent = true;
      });
    };
    makeConn();
    await conn?.start();
    await until(() => rpcSent);
    await new Promise((r) => setTimeout(r, 100));
    expect(received[0]?.filter((m) => m.type === 'rpc.result')).toEqual([]);
  });

  it('answers JSON ping with pong', async () => {
    onConnection = (ws) =>
      ws.once('message', () => {
        send(ws, welcome);
        send(ws, { type: 'ping', ts: new Date().toISOString() });
      });
    makeConn();
    await conn?.start();
    await until(() => received.flat().some((m) => m.type === 'pong'));
  });
});

describe('reconnect', () => {
  it('reconnects with backoff after the core drops the connection', async () => {
    onConnection = (ws, idx) => {
      if (idx < 2) ws.once('message', () => ws.terminate());
      else ws.once('message', () => send(ws, welcome));
    };
    makeConn();
    await conn?.start();
    await until(() => received.length >= 3);
    expect(conn?.lastDelayMs).toBeGreaterThanOrEqual(20);
  });

  it('pauses long after reject bad_token (no hammering)', async () => {
    onConnection = (ws) =>
      ws.once('message', () => {
        send(ws, { type: 'reject', code: 'bad_token' });
        ws.close(AGENT_CLOSE.REJECTED);
      });
    makeConn();
    await conn?.start();
    await until(() => conn?.phase === 'waiting');
    expect(conn?.lastDelayMs).toBe(60_000);
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toHaveLength(1);
  });

  it('pauses long when the core closes with REVOKED', async () => {
    onConnection = (ws) => ws.once('message', () => ws.close(AGENT_CLOSE.REVOKED));
    makeConn();
    await conn?.start();
    await until(() => conn?.phase === 'waiting');
    expect(conn?.lastDelayMs).toBe(60_000);
  });

  it('pauses even longer on a protocol mismatch', async () => {
    onConnection = (ws) => ws.once('message', () => send(ws, { type: 'reject', code: 'protocol' }));
    makeConn();
    await conn?.start();
    await until(() => conn?.phase === 'waiting');
    expect(conn?.lastDelayMs).toBe(120_000);
  });

  it('a revoked saved token falls back once to a new HZ_AGENT_TOKEN', async () => {
    onConnection = (ws, idx) =>
      ws.once('message', () => {
        if (idx === 0) {
          send(ws, { type: 'enrolled', agentToken: AGENT_TOKEN, serverId: 'srv_1' });
          send(ws, welcome);
          setTimeout(() => ws.close(1001), 30);
        } else send(ws, { type: 'reject', code: 'revoked' });
      });
    makeConn();
    await conn?.start();
    await until(() => received.length >= 3 && (received[2]?.length ?? 0) >= 1);
    expect(received[1]?.[0]).toMatchObject({ token: AGENT_TOKEN });
    expect(received[2]?.[0]).toMatchObject({ token: ENROLL_TOKEN });
    await until(() => conn?.phase === 'waiting' && conn?.lastDelayMs === 60_000);
  });

  it('detects a dead connection (no pong) and reconnects', async () => {
    onConnection = (ws, idx) => {
      if (idx === 0) {
        ws.once('message', () => send(ws, welcome));
        // Stop answering pings: pause the underlying socket.
        setTimeout(() => (ws as unknown as { _socket: { pause(): void } })._socket.pause(), 50);
      } else ws.once('message', () => send(ws, welcome));
    };
    makeConn({ heartbeatMs: 100 });
    await conn?.start();
    await until(() => received.length >= 2, 4000);
  });
});

describe('transfer frames (M11)', () => {
  it('routes valid transfer frames after welcome and drops invalid ones', async () => {
    const got: unknown[] = [];
    onConnection = (ws) => {
      ws.once('message', () => {
        send(ws, { type: 'transfer.chunk', streamId: 'early-stream', seq: 0, data: 'AAAA' });
        send(ws, welcome);
        setTimeout(() => {
          // Not base64, wrong padding, negative seq, unknown field: all dropped.
          send(ws, {
            type: 'transfer.chunk',
            streamId: 'stream-0001',
            seq: 0,
            data: 'not base64!',
          });
          send(ws, { type: 'transfer.chunk', streamId: 'stream-0001', seq: 0, data: 'AAA' });
          send(ws, { type: 'transfer.ack', streamId: 'stream-0001', seq: -1 });
          send(ws, { type: 'transfer.ack', streamId: 'stream-0001', seq: 0, extra: 1 });
          send(ws, { type: 'transfer.chunk', streamId: 'stream-0001', seq: 0, data: 'AAAA' });
          send(ws, { type: 'transfer.ack', streamId: 'stream-0001', seq: 3 });
          send(ws, {
            type: 'transfer.end',
            streamId: 'stream-0001',
            chunks: 1,
            bytes: 3,
            sha256: 'a'.repeat(64),
          });
        }, 50);
      });
    };
    makeConn({ onTransfer: (m) => got.push(m) });
    await conn?.start();
    await until(() => got.length >= 3);
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toEqual([
      { type: 'transfer.chunk', streamId: 'stream-0001', seq: 0, data: 'AAAA' },
      { type: 'transfer.ack', streamId: 'stream-0001', seq: 3 },
      {
        type: 'transfer.end',
        streamId: 'stream-0001',
        chunks: 1,
        bytes: 3,
        sha256: 'a'.repeat(64),
      },
    ]);
  });
});

describe('M17: ready hook and saved update results', () => {
  it('onReady fires after welcome, onDisconnect on close; a saved result goes out after reconnect', async () => {
    const { writeResult, flushResults } = await import('../src/update/results.js');
    const { readdir } = await import('node:fs/promises');
    await writeResult(dataDir, {
      kind: 'update_result',
      runId: 'run_persist1',
      target: 'core',
      outcome: 'updated',
    });
    let ready = 0;
    let down = 0;
    onConnection = (ws, idx) =>
      ws.once('message', () => {
        send(ws, welcome);
        if (idx === 0) setTimeout(() => ws.close(1001), 30);
      });
    const c: AgentConnection = makeConn({
      onReady: () => {
        ready += 1;
        // Offline at the first welcome? The file must stay until a send succeeds.
        void flushResults(dataDir, (m) => (ready === 1 ? false : c.send(m)));
      },
      onDisconnect: () => {
        down += 1;
      },
    });
    await c.start();
    await until(() => ready >= 2 && down >= 1);
    await until(() => (received[1] ?? []).some((m) => m.type === 'event'));
    const ev = (received[1] ?? []).find((m) => m.type === 'event');
    expect(ev).toMatchObject({ event: { kind: 'update_result', runId: 'run_persist1' } });
    expect((received[0] ?? []).some((m) => m.type === 'event')).toBe(false);
    // Deleted only after the send (unlink right after it).
    for (
      let i = 0;
      i < 100 && (await readdir(dataDir)).some((f) => f.startsWith('update-result-'));
      i++
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await readdir(dataDir)).not.toContain('update-result-run_persist1.json');
    expect(c.isReady()).toBe(true);
  });
});
