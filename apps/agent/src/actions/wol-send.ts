import dgram from 'node:dgram';
import { rpcParamsByAction, type RpcParams } from '@hz/shared';
import { ActionError, type ActionContext } from './types.js';

/** At most this many magic packets per window, across all targets. */
export const WOL_MAX_PER_WINDOW = 6;
export const WOL_WINDOW_MS = 60_000;
export const WOL_TIMEOUT_MS = 3000;
export const MAGIC_PACKET_BYTES = 102;

/** The part of a dgram socket the action uses (injectable for tests). */
export interface WolSocket {
  setBroadcast(flag: boolean): void;
  send(
    msg: Buffer,
    port: number,
    address: string,
    callback: (err: Error | null, bytes?: number) => void,
  ): void;
  bind(callback: () => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  close(): void;
}

export interface WolDeps {
  createSocket: () => WolSocket;
  now: () => number;
  timeoutMs: number;
}

const defaultDeps: WolDeps = {
  createSocket: () => dgram.createSocket('udp4') as unknown as WolSocket,
  now: () => Date.now(),
  timeoutMs: WOL_TIMEOUT_MS,
};

/** 6 x 0xFF followed by the 6 MAC bytes repeated 16 times (102 bytes). */
export function magicPacket(mac: string): Buffer {
  const bytes = mac.split(':').map((h) => Number.parseInt(h, 16));
  if (bytes.length !== 6 || bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
    throw new ActionError('invalid_params', 'invalid mac');
  }
  const macBuf = Buffer.from(bytes);
  const packet = Buffer.alloc(MAGIC_PACKET_BYTES, 0xff);
  for (let i = 0; i < 16; i++) macBuf.copy(packet, 6 + i * 6);
  return packet;
}

/**
 * wol.send: one Wake-on-LAN magic packet as UDP broadcast (host network).
 * The params are parsed again here with the shared schema, so this function
 * never sends anything but a magic packet to an allowed broadcast on port 7/9.
 */
export function createWolSend(overrides: Partial<WolDeps> = {}) {
  const deps: WolDeps = { ...defaultDeps, ...overrides };
  /** Timestamps of packets sent within the current window. */
  let sentAt: number[] = [];

  return async function wolSend(params: RpcParams<'wol.send'>, ctx: ActionContext) {
    const parsed = rpcParamsByAction['wol.send'].safeParse(params);
    if (!parsed.success) throw new ActionError('invalid_params', 'invalid wol.send params');
    const { mac, broadcast, port } = parsed.data;

    const now = deps.now();
    sentAt = sentAt.filter((t) => now - t < WOL_WINDOW_MS);
    if (sentAt.length >= WOL_MAX_PER_WINDOW) {
      throw new ActionError(
        'busy',
        'rate limited: at most 6 wake-on-lan packets per minute',
        false,
      );
    }
    sentAt.push(now);

    const packet = magicPacket(mac);
    await sendOnce(deps, packet, port, broadcast);
    ctx.log.info('wake-on-lan sent', { broadcast, port });
    return { sent: true };
  };
}

function sendOnce(deps: WolDeps, packet: Buffer, port: number, address: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = deps.createSocket();
    let done = false;
    const finish = (err?: ActionError) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closed
      }
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new ActionError('timeout', 'wake-on-lan send timed out', false)),
      deps.timeoutMs,
    );
    socket.on('error', () => finish(new ActionError('failed', 'wake-on-lan send failed', false)));
    socket.bind(() => {
      if (done) return;
      try {
        socket.setBroadcast(true);
        socket.send(packet, port, address, (err) => {
          finish(err ? new ActionError('failed', 'wake-on-lan send failed', false) : undefined);
        });
      } catch {
        finish(new ActionError('failed', 'wake-on-lan send failed', false));
      }
    });
  });
}

export const wolSend = createWolSend();
