import { describe, expect, it } from 'vitest';
import { rpcActions, type AgentEvent, type RpcEnvelope } from '@hz/shared';
import { Dispatcher, handlers, type ActionContext } from '../src/actions/index.js';
import {
  createWolSend,
  magicPacket,
  WOL_WINDOW_MS,
  type WolDeps,
  type WolSocket,
} from '../src/actions/wol-send.js';
import { createLogger } from '../src/log.js';
import { StreamManager } from '../src/streams.js';

interface Sent {
  msg: Buffer;
  port: number;
  address: string;
}

function fakeSockets(mode: 'ok' | 'error' | 'hang' = 'ok') {
  const sent: Sent[] = [];
  const state = { created: 0, closed: 0, broadcastBeforeSend: [] as boolean[] };
  const createSocket = (): WolSocket => {
    state.created++;
    let broadcast = false;
    let onError: ((err: Error) => void) | undefined;
    return {
      setBroadcast: (flag) => {
        broadcast = flag;
      },
      send: (msg, port, address, cb) => {
        state.broadcastBeforeSend.push(broadcast);
        sent.push({ msg: Buffer.from(msg), port, address });
        if (mode === 'ok') cb(null, msg.length);
        else if (mode === 'error') onError?.(new Error('EACCES'));
      },
      bind: (cb) => cb(),
      on: (_event, listener) => {
        onError = listener;
      },
      close: () => {
        state.closed++;
      },
    };
  };
  return { sent, state, createSocket };
}

function setup(deps: Partial<WolDeps>) {
  const events: AgentEvent[] = [];
  const ctx = {
    name: 'heimserver',
    allowTerminal: false,
    homelabRoot: '/opt/homelab/',
    host: { hostProc: '/proc', hostRoot: '/', docker: null, exec: async () => ({}) },
    log: createLogger('error', () => undefined),
    later: () => undefined,
    streams: new StreamManager({ send: () => true, bufferedAmount: () => 0 }),
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    dockerSocket: '/var/run/docker.sock',
    spawn: () => {
      throw new Error('spawn not expected');
    },
    dataDir: '/nonexistent',
  } as unknown as ActionContext;
  const d = new Dispatcher(ctx, (e) => events.push(e), {
    ...handlers,
    'wol.send': createWolSend(deps),
  });
  return { d, events, ctx };
}

let n = 0;
const rpc = (params: unknown): RpcEnvelope => ({
  type: 'rpc',
  id: `rpc_wol${String(++n).padStart(6, '0')}`,
  action: 'wol.send',
  params,
});

const VALID = { mac: 'AA:BB:CC:DD:EE:FF', broadcast: '192.168.1.255', port: 9 };

describe('wol.send', () => {
  it('is in the allowlist and has a handler', () => {
    expect(rpcActions).toContain('wol.send');
    expect(typeof handlers['wol.send']).toBe('function');
  });

  it('builds the magic packet byte for byte', () => {
    const p = magicPacket('01:23:45:67:89:AB');
    expect(p.length).toBe(102);
    const expected = Buffer.concat([
      Buffer.alloc(6, 0xff),
      ...Array.from({ length: 16 }, () => Buffer.from([0x01, 0x23, 0x45, 0x67, 0x89, 0xab])),
    ]);
    expect(p.equals(expected)).toBe(true);
  });

  it('sends exactly one packet with broadcast enabled and closes the socket', async () => {
    const f = fakeSockets();
    const { d, events } = setup({ createSocket: f.createSocket });
    const res = await d.handle(rpc(VALID));
    expect(res).toMatchObject({ ok: true, data: { sent: true } });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.port).toBe(9);
    expect(f.sent[0]?.address).toBe('192.168.1.255');
    expect(f.sent[0]?.msg.equals(magicPacket('AA:BB:CC:DD:EE:FF'))).toBe(true);
    expect(f.state.broadcastBeforeSend).toEqual([true]);
    expect(f.state.created).toBe(1);
    expect(f.state.closed).toBe(1);
    expect(events).toHaveLength(0);
  });

  it('accepts 255.255.255.255 and port 7', async () => {
    const f = fakeSockets();
    const { d } = setup({ createSocket: f.createSocket });
    const res = await d.handle(rpc({ ...VALID, broadcast: '255.255.255.255', port: 7 }));
    expect(res.ok).toBe(true);
    expect(f.sent[0]).toMatchObject({ address: '255.255.255.255', port: 7 });
  });

  it('allows at most 6 packets per minute, then refuses with busy without sending', async () => {
    const f = fakeSockets();
    let now = 1_000_000;
    const { d } = setup({ createSocket: f.createSocket, now: () => now });
    for (let i = 0; i < 6; i++) {
      expect((await d.handle(rpc(VALID))).ok).toBe(true);
    }
    const refused = await d.handle(rpc({ ...VALID, mac: '02:00:00:00:00:01' }));
    expect(refused).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(f.sent).toHaveLength(6);
    expect(f.state.created).toBe(6);

    now += WOL_WINDOW_MS - 1;
    expect((await d.handle(rpc(VALID))).ok).toBe(false);
    now += 1;
    expect((await d.handle(rpc(VALID))).ok).toBe(true);
    expect(f.sent).toHaveLength(7);
  });

  it.each([
    ['lower case mac', { ...VALID, mac: 'aa:bb:cc:dd:ee:ff' }],
    ['dash mac', { ...VALID, mac: 'AA-BB-CC-DD-EE-FF' }],
    ['multicast mac', { ...VALID, mac: '01:00:5E:00:00:01' }],
    ['zero mac', { ...VALID, mac: '00:00:00:00:00:00' }],
    ['public broadcast', { ...VALID, broadcast: '8.8.8.255' }],
    ['hostname broadcast', { ...VALID, broadcast: 'evil.example' }],
    ['port 22', { ...VALID, port: 22 }],
    ['port as string', { ...VALID, port: '9' }],
    ['extra field', { ...VALID, payload: 'AAAA' }],
    ['missing mac', { broadcast: VALID.broadcast, port: 9 }],
  ])('refuses %s without sending', async (_name, params) => {
    const f = fakeSockets();
    const { d, events } = setup({ createSocket: f.createSocket });
    const res = await d.handle(rpc(params));
    expect(res).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    expect(events[0]?.event).toMatchObject({ kind: 'denied', action: 'wol.send' });
    expect(f.state.created).toBe(0);
    expect(f.sent).toHaveLength(0);
  });

  it('re-checks params inside the action (defence in depth)', async () => {
    const f = fakeSockets();
    const { ctx } = setup({});
    const send = createWolSend({ createSocket: f.createSocket });
    const bad = { ...VALID, broadcast: '1.2.3.4' } as Parameters<typeof send>[0];
    await expect(send(bad, ctx)).rejects.toMatchObject({ code: 'invalid_params' });
    const extra = { ...VALID, extra: 1 } as unknown as Parameters<typeof send>[0];
    await expect(send(extra, ctx)).rejects.toMatchObject({ code: 'invalid_params' });
    expect(f.state.created).toBe(0);
  });

  it('reports a socket error as failed and closes the socket', async () => {
    const f = fakeSockets('error');
    const { d } = setup({ createSocket: f.createSocket });
    const res = await d.handle(rpc(VALID));
    expect(res).toMatchObject({ ok: false, error: { code: 'failed' } });
    expect(f.state.closed).toBe(1);
  });

  it('times out and closes the socket', async () => {
    const f = fakeSockets('hang');
    const { d } = setup({ createSocket: f.createSocket, timeoutMs: 20 });
    const res = await d.handle(rpc(VALID));
    expect(res).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(f.state.closed).toBe(1);
  });
});
