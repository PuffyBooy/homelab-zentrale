import { afterEach, describe, expect, it } from 'vitest';
import { notifySettingsSchema, type NotifySettings, type PushPayload } from '@hz/shared';
import { AlertService } from '../src/alerts/service.js';
import { fromLocal } from '../src/calendar.js';
import { createSecretBox } from '../src/crypto.js';
import { openDatabase, type DbHandle } from '../src/db/index.js';
import { buildRequest, headerValue, statusError } from '../src/notify/channels.js';
import { ChannelFanoutSink, NotifyService } from '../src/notify/service.js';
import { Notifier, type FilterLevel } from '../src/push/notifier.js';
import { authHeaders, KEY } from './helpers.js';
import {
  BOT_TOKEN,
  CHAT_ID,
  FakeTransport,
  makePluginApp,
  NTFY_TOPIC,
  WEBHOOK,
  withStep,
  type PluginApp,
} from './notify-helpers.js';

let h: DbHandle | undefined;
let p: PluginApp | undefined;
afterEach(async () => {
  h?.close();
  h = undefined;
  await p?.app.close();
  p = undefined;
});

const DEFAULTS: NotifySettings = notifySettingsSchema.parse({});
const DAY_TIME = fromLocal(2026, 11, 26, 14, 0);
const NIGHT = fromLocal(2026, 11, 26, 23, 30);
const MORNING = fromLocal(2026, 11, 27, 7, 1);
const MIN = 60_000;

const silentLog = {
  warn: () => undefined,
  info: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as ConstructorParameters<typeof Notifier>[0]['log'];

/** Notifier with the channel fan-out around a fake phone sink (no phone by default). */
function setup(phones: string[] = []) {
  h = openDatabase(':memory:');
  const clock = { t: DAY_TIME };
  const now = () => clock.t;
  const alerts = new AlertService(h.db, now);
  const transport = new FakeTransport();
  const notify = new NotifyService({
    db: h.db,
    box: createSecretBox(Buffer.from(KEY, 'base64')),
    now,
    log: silentLog,
    transport,
  });
  const phoneSent: { ids: string[] | 'all'; payload: PushPayload; level?: FilterLevel }[] = [];
  const phone = {
    sendAll: (payload: PushPayload, level?: FilterLevel) => {
      phoneSent.push({ ids: 'all', payload, ...(level ? { level } : {}) });
      return Promise.resolve(phones.length);
    },
    sendTo: (ids: readonly string[], payload: PushPayload, level?: FilterLevel) => {
      phoneSent.push({ ids: [...ids], payload, ...(level ? { level } : {}) });
      return Promise.resolve(ids.length);
    },
    deviceIds: () => [...phones],
  };
  const sink = new ChannelFanoutSink(phone, notify);
  const notifier = new Notifier({
    alerts,
    db: h.db,
    push: sink,
    now,
    settings: () => DEFAULTS,
    log: silentLog,
  });
  const sentTo = () =>
    transport.requests.map((r) =>
      r.url.includes('discord') ? 'discord' : r.url.includes('telegram') ? 'telegram' : 'ntfy',
    );
  return { alerts, clock, transport, notify, notifier, phoneSent, sentTo };
}

function configureAll(
  notify: NotifyService,
  levels: {
    discord?: 'info' | 'warn' | 'crit';
    telegram?: 'info' | 'warn' | 'crit';
    ntfy?: 'info' | 'warn' | 'crit';
  },
) {
  if (levels.discord) {
    notify.update('discord', { discordWebhook: WEBHOOK, enabled: true, minLevel: levels.discord });
  }
  if (levels.telegram) {
    notify.update('telegram', {
      telegramBotToken: BOT_TOKEN,
      telegramChatId: CHAT_ID,
      enabled: true,
      minLevel: levels.telegram,
    });
  }
  if (levels.ntfy) {
    notify.update('ntfy', { ntfyTopic: NTFY_TOPIC, enabled: true, minLevel: levels.ntfy });
  }
}

describe('alert channels follow the push policy', () => {
  it('minLevel: crit to all, warn only to warn/info channels, info only to info channels', async () => {
    const s = setup();
    configureAll(s.notify, { discord: 'crit', telegram: 'warn', ntfy: 'info' });
    s.alerts.raise('c', 'crit', 'heimserver antwortet nicht', 'b', null, 'server');
    await s.notify.idle();
    expect(s.sentTo().sort()).toEqual(['discord', 'ntfy', 'telegram']);
    s.transport.requests.length = 0;
    s.alerts.raise('w', 'warn', 'Disk bei 86 %', 'b', null, 'server');
    await s.notify.idle();
    expect(s.sentTo().sort()).toEqual(['ntfy', 'telegram']);
    s.transport.requests.length = 0;
    s.alerts.log('report:weekly', 'info', 'Wochenbericht', 'b', null, 'system');
    await s.notify.idle();
    expect(s.sentTo()).toEqual(['ntfy']);
  });

  it('the OK of a recovered crit reaches crit channels, the OK of a warn does not', async () => {
    const s = setup();
    configureAll(s.notify, { discord: 'crit', telegram: 'warn' });
    s.alerts.raise('c', 'crit', 'shop down', 'b', null, 'check');
    s.alerts.raise('w', 'warn', 'shop langsam', 'b', null, 'check');
    await s.notify.idle();
    s.transport.requests.length = 0;
    s.alerts.resolve('c', { title: 'shop wieder erreichbar', body: 'b' });
    await s.notify.idle();
    expect(s.sentTo().sort()).toEqual(['discord', 'telegram']);
    s.transport.requests.length = 0;
    s.clock.t += 31 * MIN;
    s.alerts.resolve('w', { title: 'shop wieder schnell', body: 'b' });
    await s.notify.idle();
    expect(s.sentTo()).toEqual(['telegram']);
  });

  it('warn bundle: at most one message per window, also on the channels', async () => {
    const s = setup();
    configureAll(s.notify, { ntfy: 'warn' });
    s.alerts.raise('a', 'warn', 'eins', 'b', null, 'server');
    s.clock.t += 5 * MIN;
    s.alerts.raise('b', 'warn', 'zwei', 'b', null, 'server');
    s.alerts.raise('c', 'warn', 'drei', 'b', null, 'server');
    await s.notify.idle();
    expect(s.transport.requests).toHaveLength(1);
    s.clock.t += 26 * MIN;
    s.notifier.flush();
    await s.notify.idle();
    expect(s.transport.requests).toHaveLength(2);
    expect(s.transport.requests[1]?.headers.title).toBe('2 Meldungen');
  });

  it('quiet hours hold channel messages for the morning digest, also without a phone', async () => {
    const s = setup();
    configureAll(s.notify, { discord: 'warn', telegram: 'crit' });
    s.clock.t = NIGHT;
    s.alerts.raise('w', 'warn', 'Disk bei 86 % auf 10.0.0.5', 'b', null, 'server');
    s.alerts.log('info:x', 'info', 'Backup fertig', 'b', null, 'system');
    await s.notify.idle();
    expect(s.transport.requests).toEqual([]);
    expect(s.notifier.deferred).toBe(2);
    // crit still goes out at night.
    s.alerts.raise('c', 'crit', 'heimserver antwortet nicht', 'b', null, 'server');
    await s.notify.idle();
    expect(s.sentTo().sort()).toEqual(['discord', 'telegram']);
    s.transport.requests.length = 0;
    s.notifier.flushDigest();
    await s.notify.idle();
    expect(s.transport.requests).toEqual([]);
    s.clock.t = MORNING;
    s.notifier.flushDigest();
    await s.notify.idle();
    // The digest is a warn: the crit-only channel does not get it.
    expect(s.sentTo()).toEqual(['discord']);
    const content = (JSON.parse(s.transport.requests[0]?.body ?? '{}') as { content: string })
      .content;
    expect(content).toContain('Über Nacht: 2 Meldungen');
    expect(content).not.toContain('10.0.0.5');
    // No phone: the digest reached only the channel (the phone sink got no sendTo).
    expect(s.phoneSent.filter((x) => x.ids !== 'all')).toEqual([]);
    expect(s.notifier.deferred).toBe(0);
  });

  it('a channel switched off over night does not get the digest; phones still do', async () => {
    const s = setup(['dev-a']);
    configureAll(s.notify, { discord: 'info' });
    s.clock.t = NIGHT;
    s.alerts.raise('w', 'warn', 'Disk voll', 'b', null, 'server');
    s.notify.update('discord', { enabled: false });
    s.clock.t = MORNING;
    s.notifier.flushDigest();
    await s.notify.idle();
    expect(s.transport.requests).toEqual([]);
    expect(s.phoneSent.map((x) => x.ids)).toEqual([['dev-a']]);
    expect(s.phoneSent[0]?.level).toBe('warn');
  });

  it('a failing channel never throws into the notifier and records lastError', async () => {
    const s = setup(['dev-a']);
    configureAll(s.notify, { discord: 'info', ntfy: 'info' });
    s.transport.fail = new Error('boom');
    expect(() => s.alerts.raise('c', 'crit', 'x', 'b', null, 'server')).not.toThrow();
    await s.notify.idle();
    expect(s.notify.view('discord').lastError).toBe('Nicht erreichbar');
    expect(s.notify.view('discord').lastSentAt).toBeNull();
    expect(s.phoneSent).toHaveLength(1);
    s.transport.fail = null;
    s.alerts.raise('c2', 'crit', 'y', 'b', null, 'server');
    await s.notify.idle();
    expect(s.notify.view('discord')).toMatchObject({ lastError: null });
    expect(s.notify.view('discord').lastSentAt).toBe(new Date(DAY_TIME).toISOString());
  });

  it('switched-off or unconfigured channels get nothing', async () => {
    const s = setup();
    configureAll(s.notify, { discord: 'info' });
    s.notify.update('discord', { enabled: false });
    s.alerts.raise('c', 'crit', 'x', 'b', null, 'server');
    await s.notify.idle();
    expect(s.transport.requests).toEqual([]);
    expect(s.notify.activeIds()).toEqual([]);
  });
});

describe('message building', () => {
  const payload: PushPayload = {
    title: 'Titel\nmit Umbruch',
    body: 'Text',
    level: 'warn',
    url: '/alerts',
    tag: 't',
  };

  it('ntfy: priority per level, tags, title on one line', () => {
    const base = { enabled: true, minLevel: 'info' as const, server: null, secrets: {} };
    const req = buildRequest('ntfy', base, { topic: 'abc' }, payload, 'warn');
    expect(req.url).toBe('https://ntfy.sh/abc');
    expect(req.headers).toMatchObject({
      priority: '4',
      tags: 'homelab,warn',
      title: 'Titel mit Umbruch',
    });
    expect(req.headers).not.toHaveProperty('authorization');
    expect(
      buildRequest('ntfy', base, { topic: 'abc' }, { ...payload, level: 'crit' }, 'crit').headers
        .priority,
    ).toBe('5');
    expect(
      buildRequest('ntfy', base, { topic: 'abc' }, { ...payload, level: 'ok' }, 'crit').headers
        .priority,
    ).toBe('3');
  });

  it('non-ASCII header values are RFC 2047 encoded', () => {
    expect(headerValue('Über Nacht')).toBe(
      `=?UTF-8?B?${Buffer.from('Über Nacht').toString('base64')}?=`,
    );
    expect(headerValue('plain')).toBe('plain');
  });

  it('status mapping', () => {
    expect(statusError(204)).toBeNull();
    expect(statusError(301)).toBe('Weiterleitung nicht erlaubt');
    expect(statusError(401)).toBe('Zugangsdaten ungültig');
    expect(statusError(429)).toBe('Zu viele Nachrichten, später erneut');
    expect(statusError(500)).toBe('Unerwartete Antwort');
  });
});

describe('notify routes', () => {
  it('GET lists the three channels with defaults', async () => {
    p = await makePluginApp();
    const res = await p.app.inject({
      method: 'GET',
      url: '/api/notify/channels',
      headers: authHeaders(p.cookie),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      channels: [
        {
          id: 'discord',
          enabled: false,
          minLevel: 'warn',
          configured: false,
          server: null,
          tokenSet: false,
          lastSentAt: null,
          lastError: null,
        },
        {
          id: 'telegram',
          enabled: false,
          minLevel: 'warn',
          configured: false,
          server: null,
          tokenSet: false,
          lastSentAt: null,
          lastError: null,
        },
        {
          id: 'ntfy',
          enabled: false,
          minLevel: 'warn',
          configured: false,
          server: 'https://ntfy.sh',
          tokenSet: false,
          lastSentAt: null,
          lastError: null,
        },
      ],
    });
  });

  it('PUT validates input and audits without values', async () => {
    p = await makePluginApp();
    await withStep(p);
    const bad = [
      ['slack', { enabled: true }],
      ['discord', { minLevel: 'debug' }],
      ['discord', { extra: 1 }],
      ['ntfy', { ntfyTopic: 'has space' }],
      ['ntfy', { ntfyToken: 'not-a-token' }],
    ] as const;
    for (const [id, body] of bad) {
      const res = await p.app.inject({
        method: 'PUT',
        url: `/api/notify/channels/${id}`,
        headers: authHeaders(p.cookie),
        payload: body,
      });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    const ok = await p.app.inject({
      method: 'PUT',
      url: '/api/notify/channels/telegram',
      headers: authHeaders(p.cookie),
      payload: {
        telegramBotToken: BOT_TOKEN,
        telegramChatId: CHAT_ID,
        enabled: true,
        minLevel: 'crit',
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      id: 'telegram',
      enabled: true,
      minLevel: 'crit',
      configured: true,
    });
  });

  it('test: 409 when not configured, 200 when delivered', async () => {
    p = await makePluginApp();
    const res = await p.app.inject({
      method: 'POST',
      url: '/api/notify/channels/discord/test',
      headers: authHeaders(p.cookie),
    });
    expect(res.statusCode).toBe(409);
    await withStep(p);
    await p.app.inject({
      method: 'PUT',
      url: '/api/notify/channels/discord',
      headers: authHeaders(p.cookie),
      payload: { discordWebhook: WEBHOOK },
    });
    const ok = await p.app.inject({
      method: 'POST',
      url: '/api/notify/channels/discord/test',
      headers: authHeaders(p.cookie),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    // Test works while the channel is still off.
    expect(p.notify.view('discord')).toMatchObject({ enabled: false, lastError: null });
    expect(p.notify.view('discord').lastSentAt).not.toBeNull();
  });
});
