import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateVAPIDKeys } from 'web-push';
import {
  notifySettingsSchema,
  pushDeviceListResponseSchema,
  pushDeviceResponseSchema,
  vapidResponseSchema,
} from '@hz/shared';
import { openDatabase } from '../src/db/index.js';
import { readSetting } from '../src/db/settings.js';
import { auditLog, pushSubscriptions } from '../src/db/schema.js';
import { VAPID_SETTING } from '../src/push/vapid.js';
import { authHeaders, completeSetup, emptyDir, makeApp, type TestApp } from './helpers.js';
import { makeDevice, MockPushService } from './push-helpers.js';

let t: TestApp | undefined;
let mock: MockPushService | undefined;
afterEach(async () => {
  await t?.app.close();
  t = undefined;
  await mock?.stop();
  mock = undefined;
});

async function setup(env: Record<string, string> = {}) {
  mock = new MockPushService();
  await mock.start();
  t = await makeApp({ pushTransport: mock.transport, env });
  const a = await completeSetup(t);
  return { t, mock, headers: authHeaders(a.cookie) };
}

describe('VAPID keys', () => {
  it('are generated once, stored encrypted and stable across restarts', async () => {
    const file = join(emptyDir(), 'hz.sqlite');
    const first = await makeApp({ db: openDatabase(file) });
    const a = await completeSetup(first);
    const k1 = vapidResponseSchema.parse(
      (await first.app.inject({ url: '/api/push/vapid', headers: authHeaders(a.cookie) })).json(),
    ).publicKey;
    expect(k1).toMatch(/^[A-Za-z0-9_-]{87}$/);
    const stored = readSetting(first.db.db, VAPID_SETTING) as Record<string, string>;
    expect(Object.keys(stored).sort()).toEqual(['privateKeyEnc', 'publicKey']);
    expect(stored.privateKeyEnc).toMatch(/^v1:/);
    await first.app.close();

    t = await makeApp({ db: openDatabase(file) });
    expect(t.app.hzCore.push.publicKey).toBe(k1);
  });

  it('come from HZ_VAPID_PUBLIC/HZ_VAPID_PRIVATE when set', async () => {
    const keys = generateVAPIDKeys();
    t = await makeApp({
      env: { HZ_VAPID_PUBLIC: keys.publicKey, HZ_VAPID_PRIVATE: keys.privateKey },
    });
    expect(t.app.hzCore.push.publicKey).toBe(keys.publicKey);
    expect(readSetting(t.db.db, VAPID_SETTING)).toBeUndefined();
  });
});

describe('push subscriptions', () => {
  it('subscribe, list (host only), re-subscribe updates, delete; all audited', async () => {
    const { t, headers } = await setup();
    const d1 = makeDevice('/a');
    const r1 = await t.app.inject({
      method: 'POST',
      url: '/api/push/subscriptions',
      headers,
      payload: { subscription: d1.subscription, label: 'Pixel' },
    });
    expect(r1.statusCode).toBe(200);
    const dev = pushDeviceResponseSchema.parse(r1.json()).device;
    expect(dev).toMatchObject({ label: 'Pixel', endpointHost: 'push.test', lastOkAt: null });

    const r2 = await t.app.inject({
      method: 'POST',
      url: '/api/push/subscriptions',
      headers,
      payload: { subscription: d1.subscription, label: 'Pixel 9' },
    });
    expect(pushDeviceResponseSchema.parse(r2.json()).device.id).toBe(dev.id);

    const list = pushDeviceListResponseSchema.parse(
      (await t.app.inject({ url: '/api/push/subscriptions', headers })).json(),
    ).devices;
    expect(list).toHaveLength(1);
    expect(list[0]?.label).toBe('Pixel 9');
    expect(JSON.stringify(list)).not.toContain('/a');

    // Endpoint and keys are stored encrypted.
    const row = t.db.db.select().from(pushSubscriptions).get();
    expect(row?.endpointEnc).toMatch(/^v1:/);
    expect(row?.keysEnc).toMatch(/^v1:/);
    expect(JSON.stringify(row)).not.toContain(d1.subscription.keys.auth);
    expect(JSON.stringify(row)).not.toContain('push.test/a');

    const del = await t.app.inject({
      method: 'DELETE',
      url: `/api/push/subscriptions/${dev.id}`,
      headers,
    });
    expect(del.json()).toEqual({ ok: true });
    const again = await t.app.inject({
      method: 'DELETE',
      url: `/api/push/subscriptions/${dev.id}`,
      headers,
    });
    expect(again.statusCode).toBe(404);
    const actions = t.db.db
      .select()
      .from(auditLog)
      .all()
      .filter((x) => x.action.startsWith('push.'))
      .map((x) => x.action);
    expect(actions).toEqual(['push.subscribed', 'push.subscribed', 'push.unsubscribed']);
  });

  it('test push reaches every device; 404/410 remove the device, 500 keeps it', async () => {
    const { t, mock, headers } = await setup();
    const devices = ['/ok', '/gone', '/missing', '/broken'].map((p) => makeDevice(p));
    for (const d of devices) {
      await t.app.inject({
        method: 'POST',
        url: '/api/push/subscriptions',
        headers,
        payload: { subscription: d.subscription },
      });
    }
    mock.status.set('/gone', 410);
    mock.status.set('/missing', 404);
    mock.status.set('/broken', 500);
    const res = await t.app.inject({ method: 'POST', url: '/api/push/test', headers });
    expect(res.json()).toEqual({ ok: true, sent: 1 });
    expect(mock.hits.map((h) => h.path).sort()).toEqual(['/broken', '/gone', '/missing', '/ok']);
    const okHit = mock.hits.find((h) => h.path === '/ok');
    expect(devices[0]?.decrypt(okHit?.body ?? Buffer.alloc(0))).toMatchObject({
      title: 'Testnachricht',
      level: 'info',
    });
    const left = t.app.hzCore.push.list();
    expect(left).toHaveLength(2);
    expect(left.find((d) => d.lastOkAt !== null)).toBeDefined();
  });

  it('rejects keys that are not a P-256 point / 16-byte secret', async () => {
    const { t, headers } = await setup();
    const d = makeDevice('/x');
    for (const keys of [
      { ...d.subscription.keys, p256dh: 'A'.repeat(87) },
      { ...d.subscription.keys, auth: 'A'.repeat(30) },
    ]) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/push/subscriptions',
        headers,
        payload: { subscription: { ...d.subscription, keys } },
      });
      expect(res.statusCode).toBe(400);
    }
    expect(t.app.hzCore.push.list()).toEqual([]);
  });
});

describe('notify settings', () => {
  it('defaults, partial PATCH, validation, persisted and audited', async () => {
    const { t, headers } = await setup();
    const get = await t.app.inject({ url: '/api/settings/notify', headers });
    expect(get.json()).toEqual({
      quietStart: '23:00',
      quietEnd: '07:00',
      warnBundleMinutes: 30,
      weeklyReport: true,
    });
    const patch = await t.app.inject({
      method: 'PATCH',
      url: '/api/settings/notify',
      headers,
      payload: { quietStart: '22:30', warnBundleMinutes: 60 },
    });
    expect(notifySettingsSchema.parse(patch.json())).toEqual({
      quietStart: '22:30',
      quietEnd: '07:00',
      warnBundleMinutes: 60,
      weeklyReport: true,
    });
    for (const payload of [
      { quietStart: '24:00' },
      { quietEnd: '7:00' },
      { warnBundleMinutes: 1 },
      { weeklyReport: 'yes' },
      { other: 1 },
    ]) {
      const bad = await t.app.inject({
        method: 'PATCH',
        url: '/api/settings/notify',
        headers,
        payload,
      });
      expect(bad.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await t.app.inject({ url: '/api/settings/notify', headers })).json()).toMatchObject({
      quietStart: '22:30',
      warnBundleMinutes: 60,
    });
    expect(
      t.db.db
        .select()
        .from(auditLog)
        .all()
        .filter((a) => a.action === 'settings.notify'),
    ).toHaveLength(1);
  });
});
