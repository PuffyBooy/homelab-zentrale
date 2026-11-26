import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PushSubscriptionJson } from '@hz/shared';
import type { PushTransport } from '../src/push/sender.js';

export interface PushHit {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/**
 * A local mock push service. Subscriptions use https://push.test/<path>
 * endpoints (the schema demands https); the transport sends the real web-push
 * POST (VAPID header, aes128gcm body) to this server over plain http.
 */
export class MockPushService {
  readonly hits: PushHit[] = [];
  /** Status per path; default 201. */
  readonly status = new Map<string, number>();
  private server: http.Server | null = null;
  private port = 0;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const path = req.url ?? '/';
        this.hits.push({ path, headers: req.headers, body: Buffer.concat(chunks) });
        res.statusCode = this.status.get(path) ?? 201;
        res.end();
      });
    });
    await new Promise<void>((r) => this.server?.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  readonly transport: PushTransport = {
    send: async (req) => {
      const u = new URL(req.endpoint);
      if (u.hostname !== 'push.test') throw new Error('unexpected endpoint');
      const res = await fetch(`http://127.0.0.1:${this.port}${u.pathname}`, {
        method: 'POST',
        headers: req.headers,
        ...(req.body ? { body: req.body } : {}),
      });
      await res.body?.cancel();
      return { statusCode: res.status };
    },
  };
}

export interface TestDevice {
  subscription: PushSubscriptionJson;
  /** Decrypts an aes128gcm push body (RFC 8291) like the browser would. */
  decrypt(body: Buffer): unknown;
}

/** A browser-like subscription with a real P-256 key and auth secret. */
export function makeDevice(path = '/device-1'): TestDevice {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const uaPublic = ecdh.getPublicKey();
  return {
    subscription: {
      endpoint: `https://push.test${path}`,
      expirationTime: null,
      keys: { p256dh: uaPublic.toString('base64url'), auth: auth.toString('base64url') },
    },
    decrypt(body) {
      const salt = body.subarray(0, 16);
      const idlen = body.readUInt8(20);
      const asPublic = body.subarray(21, 21 + idlen);
      const data = body.subarray(21 + idlen);
      const secret = ecdh.computeSecret(asPublic);
      const info = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
      const ikm = Buffer.from(hkdfSync('sha256', secret, auth, info, 32));
      const cek = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16));
      const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12));
      const d = createDecipheriv('aes-128-gcm', cek, nonce);
      d.setAuthTag(data.subarray(data.length - 16));
      const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
      // Strip padding: delimiter 0x02 followed by zeros.
      let end = plain.length - 1;
      while (end >= 0 && plain[end] === 0) end--;
      return JSON.parse(plain.subarray(0, end).toString('utf8')) as unknown;
    },
  };
}
