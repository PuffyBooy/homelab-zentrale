import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { NotifyChannel } from '@hz/shared';
import { auditLog, settings } from '../src/db/schema.js';
import { writeSetting } from '../src/db/settings.js';
import { channelKey, secretAad, storedChannelSchema } from '../src/notify/channels.js';
import {
  createHttpNotifyTransport,
  httpNotifyTransport,
  NotifyTransportError,
  type NotifyLookup,
} from '../src/notify/transport.js';
import { authHeaders, SAME_ORIGIN } from './helpers.js';
import {
  BOT_TOKEN,
  CHAT_ID,
  makePluginApp,
  NTFY_TOKEN,
  NTFY_TOPIC,
  SENTINELS,
  WEBHOOK,
  withStep,
  type PluginApp,
} from './notify-helpers.js';

let p: PluginApp | undefined;
const servers: http.Server[] = [];
afterEach(async () => {
  await p?.app.close();
  p = undefined;
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  servers.length = 0;
});

async function put(t: PluginApp, id: string, payload: Record<string, unknown>) {
  return t.app.inject({
    method: 'PUT',
    url: `/api/notify/channels/${id}`,
    headers: authHeaders(t.cookie),
    payload,
  });
}

function expectNoSecret(text: string): void {
  for (const s of SENTINELS) expect(text).not.toContain(s);
}

async function setupAll(t: PluginApp): Promise<void> {
  await withStep(t);
  expect((await put(t, 'discord', { discordWebhook: WEBHOOK, enabled: true })).statusCode).toBe(
    200,
  );
  expect(
    (
      await put(t, 'telegram', {
        telegramBotToken: BOT_TOKEN,
        telegramChatId: CHAT_ID,
        enabled: true,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await put(t, 'ntfy', { ntfyTopic: NTFY_TOPIC, ntfyToken: NTFY_TOKEN, enabled: true }))
      .statusCode,
  ).toBe(200);
}

async function listen(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

describe('notify channels: authentication and step-up', () => {
  it('every route needs an admin session', async () => {
    p = await makePluginApp();
    for (const [method, url] of [
      ['GET', '/api/notify/channels'],
      ['PUT', '/api/notify/channels/discord'],
      ['DELETE', '/api/notify/channels/discord'],
      ['POST', '/api/notify/channels/discord/test'],
    ] as const) {
      const res = await p.app.inject({ method, url, headers: SAME_ORIGIN, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('a secret or the ntfy server needs step-up; nothing is stored without it', async () => {
    p = await makePluginApp();
    for (const [id, body] of [
      ['discord', { discordWebhook: WEBHOOK }],
      ['telegram', { telegramBotToken: BOT_TOKEN }],
      ['telegram', { telegramChatId: CHAT_ID }],
      ['ntfy', { ntfyTopic: NTFY_TOPIC }],
      ['ntfy', { ntfyServer: 'https://ntfy.example.org' }],
      ['ntfy', { ntfyToken: NTFY_TOKEN }],
      ['ntfy', { ntfyToken: null }],
    ] as const) {
      const res = await put(p, id, body);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ ok: false, error: 'step_up_required' });
    }
    const rows = p.db.db.select().from(settings).all();
    expect(rows.filter((r) => r.key.startsWith('notify.channel.'))).toEqual([]);
  });

  it('enabled and minLevel alone need no step-up', async () => {
    p = await makePluginApp();
    await withStep(p);
    await put(p, 'discord', { discordWebhook: WEBHOOK });
    p.clock.advance(16 * 60_000);
    const res = await put(p, 'discord', { enabled: true, minLevel: 'crit' });
    expect(res.statusCode).toBe(200);
    expect(res.json<NotifyChannel>()).toMatchObject({ enabled: true, minLevel: 'crit' });
  });

  it('DELETE needs step-up, then forgets every secret and disables the channel', async () => {
    p = await makePluginApp();
    await setupAll(p);
    p.clock.advance(16 * 60_000);
    const denied = await p.app.inject({
      method: 'DELETE',
      url: '/api/notify/channels/ntfy',
      headers: authHeaders(p.cookie),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ ok: false, error: 'step_up_required' });
    await withStep(p);
    const ok = await p.app.inject({
      method: 'DELETE',
      url: '/api/notify/channels/ntfy',
      headers: authHeaders(p.cookie),
    });
    expect(ok.statusCode).toBe(200);
    const ntfy = p.notify.view('ntfy');
    expect(ntfy).toMatchObject({ enabled: false, configured: false, tokenSet: false });
    const raw = p.db.db.select().from(settings).all();
    const stored = raw.find((r) => r.key === channelKey('ntfy'));
    expect(stored?.valueJson).not.toContain('v1:');
  });
});

describe('notify channels: secrets never leave the core', () => {
  it('not in responses, logs, audit log or plaintext in the database', async () => {
    p = await makePluginApp({ captureLogs: true });
    await setupAll(p);
    const texts: string[] = [];
    const list = await p.app.inject({
      method: 'GET',
      url: '/api/notify/channels',
      headers: authHeaders(p.cookie),
    });
    texts.push(list.body);
    const channels = list.json<{ channels: NotifyChannel[] }>().channels;
    expect(channels.map((c) => [c.id, c.configured, c.enabled])).toEqual([
      ['discord', true, true],
      ['telegram', true, true],
      ['ntfy', true, true],
    ]);
    expect(channels.find((c) => c.id === 'ntfy')?.tokenSet).toBe(true);
    // A failing test send: error carries only the fixed text.
    p.transport.status = 401;
    for (const id of ['discord', 'telegram', 'ntfy']) {
      const res = await p.app.inject({
        method: 'POST',
        url: `/api/notify/channels/${id}/test`,
        headers: authHeaders(p.cookie),
      });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({
        ok: false,
        error: 'channel_failed',
        message: 'Zugangsdaten ungültig',
      });
      texts.push(res.body);
    }
    p.transport.fail = new Error(`connect failed ${WEBHOOK} ${BOT_TOKEN}`);
    const thrown = await p.app.inject({
      method: 'POST',
      url: '/api/notify/channels/discord/test',
      headers: authHeaders(p.cookie),
    });
    expect(thrown.json()).toMatchObject({ error: 'channel_failed', message: 'Nicht erreichbar' });
    texts.push(thrown.body);
    // Delivery through the sink path logs failures, too.
    await p.notify.deliver(
      { title: 't', body: 'b', level: 'crit', url: '/alerts', tag: 'x' },
      'crit',
    );
    texts.push(...p.logs);
    texts.push(
      JSON.stringify(
        p.db.db
          .select()
          .from(auditLog)
          .all()
          .filter((a) => a.action.startsWith('notify.')),
      ),
    );
    const dbText = JSON.stringify(p.db.db.select().from(settings).all());
    texts.push(dbText);
    for (const t of texts) expectNoSecret(t);
    expect(p.logs.join('')).toContain('alert channel delivery failed');
  });

  it('secrets are bound to channel and field (AAD): a moved ciphertext is unreadable', async () => {
    p = await makePluginApp();
    await setupAll(p);
    const tg = storedChannelSchema.parse(
      JSON.parse(
        p.db.db
          .select()
          .from(settings)
          .all()
          .find((r) => r.key === channelKey('telegram'))?.valueJson ?? '{}',
      ),
    );
    // Swap token and chat id ciphertexts.
    writeSetting(
      p.db.db,
      channelKey('telegram'),
      { ...tg, secrets: { botToken: tg.secrets.chatId, chatId: tg.secrets.botToken } },
      p.clock.t,
    );
    const res = await p.app.inject({
      method: 'POST',
      url: '/api/notify/channels/telegram/test',
      headers: authHeaders(p.cookie),
    });
    expect(res.json()).toMatchObject({
      error: 'channel_failed',
      message: 'Zugangsdaten nicht lesbar, bitte neu eintragen',
    });
    expect(p.transport.requests).toEqual([]);
  });

  it('PUT with a field of another channel is refused', async () => {
    p = await makePluginApp();
    await withStep(p);
    const res = await put(p, 'ntfy', { discordWebhook: WEBHOOK });
    expect(res.statusCode).toBe(400);
    expectNoSecret(res.body);
  });
});

describe('notify channels: targets', () => {
  it('Discord: a webhook on another host is refused on input', async () => {
    p = await makePluginApp();
    await withStep(p);
    for (const url of [
      'https://evil.example/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz',
      'http://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz',
      'https://discord.com.evil.example/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz',
      'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz?x=1',
    ]) {
      expect((await put(p, 'discord', { discordWebhook: url })).statusCode, url).toBe(400);
    }
  });

  it('Discord: a stored webhook that no longer matches is not called at send time', async () => {
    p = await makePluginApp();
    const aad = secretAad('discord', 'webhook');
    writeSetting(
      p.db.db,
      channelKey('discord'),
      {
        enabled: true,
        minLevel: 'info',
        server: null,
        secrets: { webhook: p.box.encrypt('https://evil.example/api/webhooks/1/x', aad) },
      },
      p.clock.t,
    );
    const res = await p.app.inject({
      method: 'POST',
      url: '/api/notify/channels/discord/test',
      headers: authHeaders(p.cookie),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ message: 'Ziel nicht erlaubt' });
    expect(p.transport.requests).toEqual([]);
  });

  it('Discord: posts to the stored webhook only, mentions off', async () => {
    p = await makePluginApp();
    await setupAll(p);
    const res = await p.app.inject({
      method: 'POST',
      url: '/api/notify/channels/discord/test',
      headers: authHeaders(p.cookie),
    });
    expect(res.statusCode).toBe(200);
    const req = p.transport.requests[0];
    expect(req?.url).toBe(WEBHOOK);
    const body = JSON.parse(req?.body ?? '{}') as Record<string, unknown>;
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(typeof body.content).toBe('string');
  });

  it('Telegram: always https://api.telegram.org/bot<token>/sendMessage', async () => {
    p = await makePluginApp();
    await setupAll(p);
    await p.app.inject({
      method: 'POST',
      url: '/api/notify/channels/telegram/test',
      headers: authHeaders(p.cookie),
    });
    const req = p.transport.requests[0];
    const u = new URL(req?.url ?? '');
    expect(u.origin).toBe('https://api.telegram.org');
    expect(u.pathname).toBe(`/bot${BOT_TOKEN}/sendMessage`);
    const body = JSON.parse(req?.body ?? '{}') as Record<string, unknown>;
    expect(body.chat_id).toBe(CHAT_ID);
    expect(body).not.toHaveProperty('parse_mode');
  });

  it('Telegram: malformed bot tokens and chat ids are refused', async () => {
    p = await makePluginApp();
    await withStep(p);
    for (const body of [
      { telegramBotToken: 'abc:def' },
      { telegramBotToken: `${BOT_TOKEN}/../../evil` },
      { telegramBotToken: `${BOT_TOKEN}@evil.example` },
      { telegramChatId: '12; DROP' },
    ]) {
      expect((await put(p, 'telegram', body)).statusCode).toBe(400);
    }
  });

  it('ntfy: link-local, user info and non-http servers are refused', async () => {
    p = await makePluginApp();
    await withStep(p);
    for (const server of [
      'http://169.254.169.254',
      'http://[fe80::1]',
      'https://user:pw@ntfy.example.org',
      'ftp://ntfy.example.org',
      'https://ntfy.example.org/?x=1',
    ]) {
      expect((await put(p, 'ntfy', { ntfyServer: server })).statusCode, server).toBe(400);
    }
  });

  it('ntfy: changing the server without a new topic/token drops both', async () => {
    p = await makePluginApp();
    await setupAll(p);
    // The same server again (trailing slash) keeps everything.
    const same = await put(p, 'ntfy', { ntfyServer: 'https://ntfy.sh/' });
    expect(same.json<NotifyChannel>()).toMatchObject({ configured: true, tokenSet: true });
    const other = await put(p, 'ntfy', { ntfyServer: 'https://ntfy.example.org' });
    expect(other.json<NotifyChannel>()).toMatchObject({
      server: 'https://ntfy.example.org',
      configured: false,
      tokenSet: false,
      enabled: false,
    });
    // With a new topic in the same request only the token is dropped.
    await put(p, 'ntfy', { ntfyTopic: NTFY_TOPIC, ntfyToken: NTFY_TOKEN });
    const third = await put(p, 'ntfy', {
      ntfyServer: 'https://ntfy.other.example',
      ntfyTopic: 'new-topic',
    });
    expect(third.json<NotifyChannel>()).toMatchObject({ configured: true, tokenSet: false });
    const audit = p.db.db
      .select()
      .from(auditLog)
      .all()
      .filter((a) => a.action === 'notify.channel_updated');
    expect(audit.at(-1)?.detailsJson).toContain('"dropped":["token"]');
  });

  it('ntfy: enabling without a topic is a conflict', async () => {
    p = await makePluginApp();
    const res = await put(p, 'ntfy', { enabled: true });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'conflict' });
  });

  it('redirects are never followed (real transport)', async () => {
    const hits: string[] = [];
    const target = await listen((req, res) => {
      hits.push(req.url ?? '');
      res.end();
    });
    const redirector = await listen((req, res) => {
      req.resume();
      res.statusCode = 307;
      res.setHeader('location', `${target}/stolen`);
      res.end();
    });
    p = await makePluginApp({ transport: httpNotifyTransport });
    await withStep(p);
    await put(p, 'ntfy', { ntfyServer: redirector, ntfyTopic: NTFY_TOPIC, ntfyToken: NTFY_TOKEN });
    const res = await p.app.inject({
      method: 'POST',
      url: '/api/notify/channels/ntfy/test',
      headers: authHeaders(p.cookie),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ message: 'Weiterleitung nicht erlaubt' });
    expect(hits).toEqual([]);
    expect(p.notify.view('ntfy').lastError).toBe('Weiterleitung nicht erlaubt');
  });

  it('ntfy over the real transport: headers, bearer token, a large response is cut off', async () => {
    const got: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
    const server = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        got.push({
          url: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        res.statusCode = 200;
        res.write(Buffer.alloc(200 * 1024, 120));
        res.end();
      });
    });
    p = await makePluginApp({ transport: httpNotifyTransport });
    await withStep(p);
    await put(p, 'ntfy', { ntfyServer: server, ntfyTopic: NTFY_TOPIC, ntfyToken: NTFY_TOKEN });
    const res = await p.app.inject({
      method: 'POST',
      url: '/api/notify/channels/ntfy/test',
      headers: authHeaders(p.cookie),
    });
    expect(res.statusCode).toBe(200);
    expect(got[0]?.url).toBe(`/${NTFY_TOPIC}`);
    expect(got[0]?.headers.authorization).toBe(`Bearer ${NTFY_TOKEN}`);
    expect(got[0]?.headers.priority).toBe('3');
    expect(got[0]?.headers.title).toBe('Testnachricht der Homelab-Zentrale');
    expect(p.notify.view('ntfy').lastSentAt).not.toBeNull();
  });

  it('addresses are masked in every outgoing text', async () => {
    p = await makePluginApp();
    await setupAll(p);
    await p.notify.deliver(
      {
        title: 'heimserver (192.168.1.20) antwortet nicht',
        body: 'Seit 23:04 offline. Tailscale: 100.64.0.7, fd7a:115c:a1e0::1',
        level: 'crit',
        url: '/alerts',
        tag: 'k',
      },
      'crit',
    );
    expect(p.transport.requests).toHaveLength(3);
    for (const r of p.transport.requests) {
      // ntfy titles with non-ASCII characters are RFC 2047 encoded: decode before checking.
      const title = /^=\?UTF-8\?B\?(.*)\?=$/.exec(r.headers.title ?? '')?.[1];
      const all = JSON.stringify(r) + (title ? Buffer.from(title, 'base64').toString('utf8') : '');
      expect(all).not.toContain('192.168.1.20');
      expect(all).not.toContain('100.64.0.7');
      expect(all).not.toContain('fd7a:115c');
      expect(all).toContain('heimserver');
    }
  });

  it('test messages are rate limited (5 per minute)', async () => {
    p = await makePluginApp();
    await setupAll(p);
    for (let i = 0; i < 5; i++) {
      const ok = await p.app.inject({
        method: 'POST',
        url: '/api/notify/channels/discord/test',
        headers: authHeaders(p.cookie),
      });
      expect(ok.statusCode).toBe(200);
    }
    const limited = await p.app.inject({
      method: 'POST',
      url: '/api/notify/channels/telegram/test',
      headers: authHeaders(p.cookie),
    });
    expect(limited.statusCode).toBe(429);
    expect(p.transport.requests).toHaveLength(5);
    p.clock.advance(61_000);
    const again = await p.app.inject({
      method: 'POST',
      url: '/api/notify/channels/telegram/test',
      headers: authHeaders(p.cookie),
    });
    expect(again.statusCode).toBe(200);
  });
});

describe('notify transport: DNS answers', () => {
  async function kindOf(p: Promise<unknown>): Promise<string> {
    try {
      await p;
    } catch (err) {
      if (err instanceof NotifyTransportError) return err.kind;
      throw err;
    }
    return 'sent';
  }

  it('a host name that resolves to link-local (also IPv4-mapped) is refused before connecting', async () => {
    let hits = 0;
    const base = await listen((req, res) => {
      hits++;
      req.resume();
      res.end();
    });
    const port = new URL(base).port;
    const asked: string[] = [];
    const via = (address: string, family: number): NotifyLookup => {
      return async (hostname) => {
        asked.push(hostname);
        return [
          { address: '127.0.0.1', family: 4 },
          { address, family },
        ];
      };
    };
    for (const [address, family] of [
      ['169.254.169.254', 4],
      ['::ffff:169.254.169.254', 6],
      ['0:0:0:0:0:ffff:a9fe:a9fe', 6],
      ['fe80::1', 6],
    ] as const) {
      const t = createHttpNotifyTransport({ lookup: via(address, family) });
      const kind = await kindOf(
        t.post({ url: `http://ntfy.example.test:${port}/topic`, headers: {}, body: 'x' }),
      );
      expect(kind, address).toBe('blocked');
    }
    expect(asked.every((h) => h === 'ntfy.example.test')).toBe(true);
    expect(asked).toHaveLength(4);
    expect(hits).toBe(0);
    // The same name with a normal answer goes through.
    const ok = createHttpNotifyTransport({
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    expect(
      await ok.post({ url: `http://ntfy.example.test:${port}/topic`, headers: {}, body: 'x' }),
    ).toEqual({ status: 200 });
    expect(hits).toBe(1);
  });
});
