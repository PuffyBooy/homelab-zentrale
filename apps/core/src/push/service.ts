import { eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { generateRequestDetails } from 'web-push';
import type { PushPayload, PushSubscriptionJson } from '@hz/shared';
import type { Clock } from '../clock.js';
import { randomToken, sha256Hex, type SecretBox } from '../crypto.js';
import type { Db } from '../db/index.js';
import { pushSubscriptions, type PushSubscriptionRow } from '../db/schema.js';
import type { PushTransport } from './sender.js';
import type { VapidKeys } from './vapid.js';

export interface PushDevice {
  id: string;
  label: string;
  endpointHost: string;
  createdAt: string;
  lastOkAt: string | null;
}

const ENDPOINT_AAD = 'push_subscriptions.endpoint';
const KEYS_AAD = 'push_subscriptions.keys';
/** Push services keep a message this long if the phone is offline. */
const TTL_S = 24 * 60 * 60;

function toDevice(r: PushSubscriptionRow): PushDevice {
  return {
    id: r.id,
    label: r.label,
    endpointHost: r.endpointHost,
    createdAt: new Date(r.createdAt).toISOString(),
    lastOkAt: r.lastOkAt === null ? null : new Date(r.lastOkAt).toISOString(),
  };
}

/** p256dh must be an uncompressed P-256 point (65 bytes), auth 16 bytes. */
export function subscriptionKeysValid(keys: { p256dh: string; auth: string }): boolean {
  const p = Buffer.from(keys.p256dh, 'base64url');
  const a = Buffer.from(keys.auth, 'base64url');
  return p.length === 65 && p[0] === 0x04 && a.length === 16;
}

/**
 * Web Push subscriptions and delivery. Endpoint and keys are stored encrypted;
 * only the endpoint host is shown or logged. Subscriptions the push service
 * reports as gone (404/410) are removed.
 */
export class PushService {
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly deps: {
      db: Db;
      box: SecretBox;
      now: Clock;
      log: FastifyBaseLogger;
      transport: PushTransport;
      vapid: VapidKeys;
      subject: string;
    },
  ) {}

  get publicKey(): string {
    return this.deps.vapid.publicKey;
  }

  list(): PushDevice[] {
    return this.deps.db
      .select()
      .from(pushSubscriptions)
      .orderBy(pushSubscriptions.createdAt)
      .all()
      .map(toDevice);
  }

  count(): number {
    return this.deps.db.select({ id: pushSubscriptions.id }).from(pushSubscriptions).all().length;
  }

  /** Stores a subscription; the same endpoint again updates keys and label. */
  subscribe(sub: PushSubscriptionJson, label: string): PushDevice {
    const now = this.deps.now();
    const box = this.deps.box;
    const endpointHash = sha256Hex(`push:${sub.endpoint}`);
    const endpointHost = new URL(sub.endpoint).hostname;
    const keysEnc = box.encrypt(
      JSON.stringify({ p256dh: sub.keys.p256dh, auth: sub.keys.auth }),
      KEYS_AAD,
    );
    const existing = this.deps.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpointHash, endpointHash))
      .get();
    if (existing) {
      this.deps.db
        .update(pushSubscriptions)
        .set({ keysEnc, label })
        .where(eq(pushSubscriptions.id, existing.id))
        .run();
      return toDevice({ ...existing, keysEnc, label });
    }
    const row: PushSubscriptionRow = {
      id: randomToken(12),
      endpointHash,
      endpointEnc: box.encrypt(sub.endpoint, ENDPOINT_AAD),
      endpointHost,
      keysEnc,
      label,
      createdAt: now,
      lastOkAt: null,
    };
    this.deps.db.insert(pushSubscriptions).values(row).run();
    this.deps.log.info({ deviceId: row.id, host: endpointHost }, 'push subscription added');
    return toDevice(row);
  }

  remove(id: string): boolean {
    const r = this.deps.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id)).run();
    return r.changes > 0;
  }

  deviceIds(): string[] {
    return this.deps.db
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .all()
      .map((r) => r.id);
  }

  /** Sends to the listed devices that still exist. Never throws. */
  sendTo(deviceIds: readonly string[], payload: PushPayload): Promise<number> {
    const p = this.deliverAll(payload, deviceIds);
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
    return p;
  }

  /** Sends to every device. Resolves with the number of accepted deliveries; never throws. */
  sendAll(payload: PushPayload): Promise<number> {
    const p = this.deliverAll(payload);
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
    return p;
  }

  /** Waits for deliveries in flight (tests). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private async deliverAll(payload: PushPayload, only?: readonly string[]): Promise<number> {
    const rows =
      only === undefined
        ? this.deps.db.select().from(pushSubscriptions).all()
        : only.length === 0
          ? []
          : this.deps.db
              .select()
              .from(pushSubscriptions)
              .where(inArray(pushSubscriptions.id, [...only]))
              .all();
    const results = await Promise.all(rows.map((r) => this.deliver(r, payload)));
    return results.filter(Boolean).length;
  }

  private async deliver(row: PushSubscriptionRow, payload: PushPayload): Promise<boolean> {
    const log = this.deps.log;
    const meta = { deviceId: row.id, host: row.endpointHost };
    let endpoint: string;
    let keys: { p256dh: string; auth: string };
    try {
      endpoint = this.deps.box.decrypt(row.endpointEnc, ENDPOINT_AAD);
      keys = JSON.parse(this.deps.box.decrypt(row.keysEnc, KEYS_AAD)) as typeof keys;
    } catch {
      log.warn(meta, 'push subscription unreadable, skipped');
      return false;
    }
    let status: number;
    try {
      const details = generateRequestDetails({ endpoint, keys }, JSON.stringify(payload), {
        vapidDetails: {
          subject: this.deps.subject,
          publicKey: this.deps.vapid.publicKey,
          privateKey: this.deps.vapid.privateKey,
        },
        TTL: TTL_S,
        contentEncoding: 'aes128gcm',
        urgency: payload.level === 'crit' ? 'high' : 'normal',
      });
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(details.headers)) headers[k] = String(v);
      ({ statusCode: status } = await this.deps.transport.send({
        endpoint: details.endpoint,
        headers,
        body: details.body,
      }));
    } catch (err) {
      // Only the error class: messages can contain the endpoint URL.
      log.warn({ ...meta, err: err instanceof Error ? err.name : 'error' }, 'push failed');
      return false;
    }
    if (status === 404 || status === 410) {
      this.remove(row.id);
      log.info({ ...meta, status }, 'push subscription expired, removed');
      return false;
    }
    if (status < 200 || status >= 300) {
      log.warn({ ...meta, status }, 'push rejected');
      return false;
    }
    this.deps.db
      .update(pushSubscriptions)
      .set({ lastOkAt: this.deps.now() })
      .where(eq(pushSubscriptions.id, row.id))
      .run();
    return true;
  }
}
