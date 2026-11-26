import { afterEach, describe, expect, it } from 'vitest';
import { notifySettingsSchema, type NotifySettings, type PushPayload } from '@hz/shared';
import { AlertService } from '../src/alerts/service.js';
import { weeklyReportText } from '../src/alerts/weekly-report.js';
import { fromLocal } from '../src/calendar.js';
import { openDatabase, type DbHandle } from '../src/db/index.js';
import { decide, Notifier } from '../src/push/notifier.js';
import { authHeaders, completeSetup, makeApp, type TestApp } from './helpers.js';
import { makeDevice, MockPushService } from './push-helpers.js';

let h: DbHandle | undefined;
let t: TestApp | undefined;
let mock: MockPushService | undefined;
afterEach(async () => {
  h?.close();
  h = undefined;
  await t?.app.close();
  t = undefined;
  await mock?.stop();
  mock = undefined;
});

const DEFAULTS: NotifySettings = notifySettingsSchema.parse({});
const DAY_TIME = fromLocal(2026, 11, 26, 14, 0);
const NIGHT = fromLocal(2026, 11, 26, 23, 30);
const MIN = 60_000;

const silentLog = {
  warn: () => undefined,
} as unknown as ConstructorParameters<typeof Notifier>[0]['log'];

function setup(settings: Partial<NotifySettings> = {}, db?: DbHandle) {
  h = db ?? openDatabase(':memory:');
  const clock = { t: DAY_TIME };
  const alerts = new AlertService(h.db, () => clock.t);
  const sent: PushPayload[] = [];
  const sentTo: { ids: string[]; payload: PushPayload }[] = [];
  const devices = { ids: ['dev-a', 'dev-b'] };
  const notifier = new Notifier({
    alerts,
    db: h.db,
    push: {
      sendAll: (p) => {
        sent.push(p);
        return Promise.resolve(1);
      },
      sendTo: (ids, p) => {
        sentTo.push({ ids: [...ids].sort(), payload: p });
        return Promise.resolve(ids.length);
      },
      deviceIds: () => [...devices.ids],
    },
    now: () => clock.t,
    settings: () => ({ ...DEFAULTS, ...settings }),
    log: silentLog,
  });
  return { alerts, clock, sent, sentTo, devices, notifier, h };
}

describe('push policy: decide()', () => {
  const alert = (level: 'ok' | 'info' | 'warn' | 'crit') => ({
    id: 'aaaaaaaaaaaa',
    key: 'k',
    level,
    title: 't',
    body: 'b',
    serverId: null,
    source: 'check' as const,
    state: 'open' as const,
    openedAt: new Date(0).toISOString(),
    ackedAt: null,
    resolvedAt: null,
  });

  it('crit immediately, day and night', () => {
    for (const now of [DAY_TIME, NIGHT]) {
      expect(decide({ kind: 'opened', alert: alert('crit') }, DEFAULTS, now)).toBe('now');
      expect(
        decide({ kind: 'changed', alert: alert('crit'), previousLevel: 'warn' }, DEFAULTS, now),
      ).toBe('now');
    }
  });

  it('warn is bundled by day and deferred to the digest in quiet hours', () => {
    expect(decide({ kind: 'opened', alert: alert('warn') }, DEFAULTS, DAY_TIME)).toBe('bundle');
    expect(decide({ kind: 'opened', alert: alert('warn') }, DEFAULTS, NIGHT)).toBe('defer');
  });

  it('OK of a crit pushes even at night, OK of a warn only by day (bundled)', () => {
    const recCrit = { kind: 'recovered' as const, alert: alert('ok'), resolved: alert('crit') };
    const recWarn = { kind: 'recovered' as const, alert: alert('ok'), resolved: alert('warn') };
    expect(decide(recCrit, DEFAULTS, NIGHT)).toBe('now');
    expect(decide(recWarn, DEFAULTS, NIGHT)).toBe('defer');
    expect(decide(recWarn, DEFAULTS, DAY_TIME)).toBe('bundle');
  });

  it('info (weekly report) by day only; ack, close and same-level changes never push', () => {
    expect(decide({ kind: 'logged', alert: alert('info') }, DEFAULTS, DAY_TIME)).toBe('now');
    expect(decide({ kind: 'logged', alert: alert('info') }, DEFAULTS, NIGHT)).toBe('defer');
    expect(decide({ kind: 'acked', alert: alert('crit') }, DEFAULTS, DAY_TIME)).toBe('drop');
    expect(decide({ kind: 'closed', alert: alert('crit') }, DEFAULTS, DAY_TIME)).toBe('drop');
    expect(
      decide({ kind: 'changed', alert: alert('crit'), previousLevel: 'crit' }, DEFAULTS, DAY_TIME),
    ).toBe('drop');
  });

  it('respects custom quiet hours', () => {
    const s = { ...DEFAULTS, quietStart: '12:00', quietEnd: '15:00' };
    expect(decide({ kind: 'opened', alert: alert('warn') }, s, DAY_TIME)).toBe('defer');
    expect(decide({ kind: 'opened', alert: alert('warn') }, s, NIGHT)).toBe('bundle');
  });
});

describe('Notifier: bundling', () => {
  it('first warn goes out at once, the next ones at most once per window as one push', () => {
    const { alerts, clock, sent, notifier } = setup({ warnBundleMinutes: 30 });
    alerts.raise('a', 'warn', 'Disk bei 86 %', 'b', null, 'server');
    expect(sent.map((p) => p.title)).toEqual(['Disk bei 86 %']);
    clock.t += 5 * MIN;
    alerts.raise('b', 'warn', 'shop antwortet langsam', 'b', null, 'check');
    clock.t += 5 * MIN;
    alerts.raise('c', 'warn', 'SSL-Zertifikat von shop läuft ab', 'b', null, 'check');
    expect(sent).toHaveLength(1);
    expect(notifier.queued).toBe(2);
    clock.t += 19 * MIN;
    notifier.flush();
    expect(sent).toHaveLength(1);
    clock.t += 1 * MIN; // 30 min after the first push
    notifier.flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ title: '2 Meldungen', level: 'warn', tag: 'warn-bundle' });
    expect(sent[1]?.body).toBe('shop antwortet langsam\nSSL-Zertifikat von shop läuft ab');
    expect(notifier.queued).toBe(0);
  });

  it('crit is never delayed by the warn window', () => {
    const { alerts, clock, sent } = setup();
    alerts.raise('a', 'warn', 'w', 'b', null, 'server');
    clock.t += MIN;
    alerts.raise('b', 'crit', 'shop ist nicht erreichbar', 'b', null, 'check');
    expect(sent.map((p) => p.level)).toEqual(['warn', 'crit']);
  });

  it('drops warns from the bundle that were resolved or escalated meanwhile', () => {
    const { alerts, clock, sent, notifier } = setup();
    alerts.raise('a', 'warn', 'first', 'b', null, 'server');
    clock.t += MIN;
    alerts.raise('b', 'warn', 'gone', 'b', null, 'server');
    alerts.raise('c', 'warn', 'escalates', 'b', null, 'server');
    alerts.resolveById(alerts.active('b')?.id ?? '');
    alerts.raise('c', 'crit', 'escalated', 'b', null, 'server');
    clock.t += 30 * MIN;
    notifier.flush();
    expect(sent.map((p) => p.title)).toEqual(['first', 'escalated']);
  });

  it('entries waiting when quiet hours start move into the morning digest', () => {
    const { alerts, clock, sent, notifier } = setup();
    clock.t = fromLocal(2026, 11, 26, 22, 40);
    alerts.raise('a', 'warn', 'first', 'b', null, 'server');
    clock.t += MIN;
    alerts.raise('b', 'warn', 'second', 'b', null, 'server');
    clock.t = fromLocal(2026, 11, 26, 23, 15);
    notifier.flush();
    expect(sent.map((p) => p.title)).toEqual(['first']);
    expect(notifier.queued).toBe(0);
    expect(notifier.deferred).toBe(1);
  });

  it('OK of a warn is bundled, OK of a crit is immediate', () => {
    const { alerts, clock, sent } = setup();
    alerts.raise('w', 'warn', 'langsam', 'b', null, 'check');
    alerts.raise('c', 'crit', 'down', 'b', null, 'check');
    clock.t += MIN;
    alerts.resolve('w', { title: 'wieder schnell', body: 'b' });
    alerts.resolve('c', { title: 'wieder erreichbar', body: 'b' });
    expect(sent.map((p) => p.title)).toEqual(['langsam', 'down', 'wieder erreichbar']);
  });
});

describe('Notifier: quiet hours digest', () => {
  it('collects warn/info at night and sends one digest at the end of the quiet hours', () => {
    const { alerts, clock, sent, sentTo, notifier } = setup();
    clock.t = NIGHT;
    alerts.raise('a', 'warn', 'Disk auf heimserver bei 86 %', 'b', null, 'server');
    clock.t += MIN;
    alerts.raise('b', 'warn', 'shop antwortet langsam (192.0.2.10:443)', 'b', null, 'check');
    alerts.log('c', 'info', 'Gameserver mc automatisch gestoppt', 'b', null, 'game');
    alerts.raise('d', 'crit', 'shop ist nicht erreichbar', 'b', null, 'check');
    // crit stays immediate, nothing else goes out at night.
    expect(sent.map((p) => p.title)).toEqual(['shop ist nicht erreichbar']);
    expect(notifier.deferred).toBe(3);
    clock.t = fromLocal(2026, 11, 27, 6, 59);
    notifier.flushDigest();
    expect(sentTo).toHaveLength(0);
    clock.t = fromLocal(2026, 11, 27, 7, 0);
    notifier.flushDigest();
    expect(sentTo).toHaveLength(1);
    expect(sentTo[0]?.ids).toEqual(['dev-a', 'dev-b']);
    expect(sentTo[0]?.payload).toEqual({
      title: 'Über Nacht: 3 Meldungen',
      body: 'Disk auf heimserver bei 86 %\nshop antwortet langsam (…)\nGameserver mc automatisch gestoppt',
      level: 'warn',
      url: '/alerts',
      tag: 'night-digest',
    });
    expect(notifier.deferred).toBe(0);
    notifier.flushDigest();
    expect(sentTo).toHaveLength(1);
  });

  it('sends nothing when nothing was held back', () => {
    const { clock, sentTo, notifier } = setup();
    clock.t = fromLocal(2026, 11, 27, 7, 0);
    notifier.flushDigest();
    expect(sentTo).toEqual([]);
  });

  it('only devices that existed when the push was held back get the digest', () => {
    const { alerts, clock, sentTo, devices, notifier } = setup();
    devices.ids = [];
    clock.t = NIGHT;
    alerts.raise('a', 'warn', 'before any device', 'b', null, 'server');
    expect(notifier.deferred).toBe(0);
    devices.ids = ['dev-a'];
    alerts.raise('b', 'warn', 'only a', 'b', null, 'server');
    devices.ids = ['dev-a', 'dev-new'];
    clock.t = fromLocal(2026, 11, 27, 8, 0);
    notifier.flushDigest();
    expect(sentTo.map((x) => x.ids)).toEqual([['dev-a']]);
    expect(sentTo[0]?.payload.title).toBe('Über Nacht: 1 Meldung');
    expect(sentTo[0]?.payload.level).toBe('warn');
  });

  it('survives a restart (persisted) and lists at most 5 titles', () => {
    const first = setup();
    first.clock.t = NIGHT;
    for (let i = 0; i < 7; i++) {
      first.alerts.log(`k${i}`, 'info', `Meldung ${i}`, 'b', null, 'game');
    }
    // A new notifier on the same database (core restarted).
    const again = setup({}, first.h);
    again.clock.t = fromLocal(2026, 11, 27, 7, 1);
    again.notifier.flushDigest();
    expect(again.sentTo[0]?.payload).toMatchObject({
      title: 'Über Nacht: 7 Meldungen',
      level: 'info',
      body: 'Meldung 0\nMeldung 1\nMeldung 2\nMeldung 3\nMeldung 4\n… und 2 weitere',
    });
  });
});

describe('weekly report', () => {
  it('summarizes open alerts, check uptime over 7 days and offline servers', () => {
    expect(
      weeklyReportText({
        openAlerts: 2,
        checks: [
          { name: 'shop', uptime: 99.5 },
          { name: 'blog', uptime: 100 },
          { name: 'neu', uptime: null },
        ],
        serversOffline: 1,
        serversTotal: 4,
      }),
    ).toEqual({
      title: 'Wochenbericht',
      body: '2 offene Meldungen. Websites und Ports in 7 Tagen: 99,75 % erreichbar (2 Checks). Am schwächsten: shop mit 99,5 %. 1 von 4 Servern offline.',
    });
    expect(
      weeklyReportText({ openAlerts: 0, checks: [], serversOffline: 0, serversTotal: 2 }).body,
    ).toBe('Keine offenen Meldungen. Keine Checks mit Messwerten. Alle 2 Server online.');
  });

  it('is sent as an info push on Sunday 19:00 and can be switched off', async () => {
    mock = new MockPushService();
    await mock.start();
    t = await makeApp({ pushTransport: mock.transport });
    const admin = await completeSetup(t);
    const device = makeDevice('/report');
    await t.app.inject({
      method: 'POST',
      url: '/api/push/subscriptions',
      headers: authHeaders(admin.cookie),
      payload: { subscription: device.subscription },
    });
    const core = t.app.hzCore;
    const due = core.scheduler.nextRunOf('report.weekly') ?? 0;
    expect(new Date(due).toISOString()).toBe('2026-11-29T18:00:00.000Z');
    t.clock.t = due;
    await core.scheduler.tick();
    await core.push.idle();
    expect(mock.hits).toHaveLength(1);
    expect(device.decrypt(mock.hits[0]?.body ?? Buffer.alloc(0))).toMatchObject({
      level: 'info',
      title: 'Wochenbericht',
    });
    const entry = core.alerts.list({ state: 'all', limit: 5, source: 'system' })[0];
    expect(entry).toMatchObject({ level: 'info', state: 'resolved', title: 'Wochenbericht' });

    const off = await t.app.inject({
      method: 'PATCH',
      url: '/api/settings/notify',
      headers: authHeaders(admin.cookie),
      payload: { weeklyReport: false },
    });
    expect(off.statusCode).toBe(200);
    t.clock.t = core.scheduler.nextRunOf('report.weekly') ?? 0;
    await core.scheduler.tick();
    await core.push.idle();
    expect(mock.hits).toHaveLength(1);
  });
});
