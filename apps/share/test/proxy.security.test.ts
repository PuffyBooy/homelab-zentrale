import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GATEWAY_TOKEN,
  SHARE_TOKEN,
  okStatus,
  raw,
  shareHeaders,
  startHarness,
} from './helpers.js';
import type { Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.close());
beforeEach(() => {
  h.setCore(() => ({ body: okStatus }));
});

const json = (extra: Record<string, string> = {}): Record<string, string> =>
  shareHeaders({ 'content-type': 'application/json', ...extra });

describe('token and PIN shape checks', () => {
  it.each([
    undefined,
    '',
    'Share',
    `Share ${SHARE_TOKEN.slice(1)}`,
    `Share ${SHARE_TOKEN}x`,
    `Share ${SHARE_TOKEN.slice(0, 42)}=`,
    `Share ${SHARE_TOKEN.slice(0, 42)}.`,
    `share ${SHARE_TOKEN}`,
    `Bearer ${SHARE_TOKEN}`,
    `Bearer ${GATEWAY_TOKEN}`,
    `Share  ${SHARE_TOKEN}`,
    `Share ${SHARE_TOKEN},Share ${SHARE_TOKEN}`,
  ])('Authorization %s -> 404 not_found, core not called', async (auth) => {
    const before = h.coreRequests.length;
    const r = await raw(h.url, '/s/api/status', {
      headers: auth === undefined ? {} : { authorization: auth },
    });
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body)).toEqual({ ok: false, error: 'not_found' });
    expect(h.coreRequests.length).toBe(before);
  });

  it.each(['', '123', '12345', 'abcd', '12 3', '1e34', '+123', '0x12'])(
    'X-Share-Pin %j -> 400, core not called',
    async (pin) => {
      const before = h.coreRequests.length;
      const r = await raw(h.url, '/s/api/status', {
        headers: shareHeaders({ 'x-share-pin': pin }),
      });
      expect(r.status).toBe(400);
      expect(JSON.parse(r.body)).toEqual({ ok: false, error: 'invalid_input' });
      expect(h.coreRequests.length).toBe(before);
    },
  );

  it('forwards a valid PIN', async () => {
    await raw(h.url, '/s/api/status', { headers: shareHeaders({ 'x-share-pin': '0420' }) });
    expect(h.coreRequests.at(-1)?.headers['x-share-pin']).toBe('0420');
  });
});

describe('request to the core', () => {
  it('sends only the gateway token, friend token, PIN, client IP and JSON headers', async () => {
    await raw(h.url, '/s/api/action', {
      method: 'POST',
      headers: json({
        'x-share-pin': '1234',
        'x-forwarded-for': '198.51.100.7',
        cookie: 'hz_session=admin',
        'x-share-client-ip': '10.0.0.1',
        'x-share-token': 'spoofed',
        'x-custom': 'nope',
        'user-agent': 'evil',
        origin: 'https://evil.example',
      }),
      body: '{"action":"restart"}',
    });
    const req = h.coreRequests.at(-1);
    expect(req?.headers.authorization).toBe(`Bearer ${GATEWAY_TOKEN}`);
    expect(req?.headers['x-share-token']).toBe(SHARE_TOKEN);
    expect(req?.headers['x-share-pin']).toBe('1234');
    expect(req?.headers['x-share-client-ip']).toBe('198.51.100.7');
    expect(req?.headers['content-type']).toBe('application/json');
    expect(req?.headers.cookie).toBeUndefined();
    expect(req?.headers['x-custom']).toBeUndefined();
    expect(req?.headers.origin).toBeUndefined();
    expect(req?.headers['x-forwarded-for']).toBeUndefined();
    expect(req?.headers['user-agent']).not.toBe('evil');
    expect(req?.body).toBe('{"action":"restart"}');
  });

  it.each([
    ['/s/api/action', '{"action":"delete"}'],
    ['/s/api/action', '{"action":"start","serverId":"x"}'],
    ['/s/api/action', '[]'],
    ['/s/api/action', 'not json'],
    ['/s/api/console', '{"command":"stop\\nop Max"}'],
    ['/s/api/console', '{"command":""}'],
    ['/s/api/console', `{"command":"${'a'.repeat(201)}"}`],
    ['/s/api/whitelist', '{"op":"add","player":"a;op"}'],
    ['/s/api/whitelist', '{"op":"op","player":"Steve"}'],
    ['/s/api/whitelist', '{"op":"add","player":"Steve","extra":1}'],
  ])('POST %s %s -> 400, core not called', async (p, body) => {
    const before = h.coreRequests.length;
    const r = await raw(h.url, p, { method: 'POST', headers: json(), body });
    expect(r.status).toBe(400);
    expect(h.coreRequests.length).toBe(before);
  });

  it('refuses non-JSON content types', async () => {
    const before = h.coreRequests.length;
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      const r = await raw(h.url, '/s/api/action', {
        method: 'POST',
        headers: shareHeaders({ 'content-type': type }),
        body: '{"action":"start"}',
      });
      expect(r.status).toBe(400);
    }
    expect(h.coreRequests.length).toBe(before);
  });

  it('refuses bodies over 4 KB', async () => {
    const before = h.coreRequests.length;
    const body = JSON.stringify({ command: 'a', pad: 'x'.repeat(5000) });
    const r = await raw(h.url, '/s/api/console', { method: 'POST', headers: json(), body });
    expect(r.status).toBe(413);
    expect(h.coreRequests.length).toBe(before);
  });

  it('forwards the re-serialized, validated body (trimmed command)', async () => {
    h.setCore(() => ({ body: { output: 'There are 0 players' } }));
    await raw(h.url, '/s/api/console', {
      method: 'POST',
      headers: json(),
      body: '{"command":"  list "}',
    });
    expect(h.coreRequests.at(-1)?.body).toBe('{"command":"list"}');
  });

  it('console query: only `after` passes, other params are refused', async () => {
    h.setCore(() => ({ body: { lines: [] } }));
    const before = h.coreRequests.length;
    for (const q of [
      '?after=1&x=2',
      '?serverId=1',
      '?after=1&after=2',
      `?after=${'a'.repeat(65)}`,
    ]) {
      const r = await raw(h.url, `/s/api/console${q}`, { headers: shareHeaders() });
      expect(r.status, q).toBe(400);
    }
    expect(h.coreRequests.length).toBe(before);
    const ok = await raw(h.url, '/s/api/console', { headers: shareHeaders() });
    expect(ok.status).toBe(200);
    expect(h.coreRequests.at(-1)?.url).toBe('/api/share-gateway/console');
  });

  it('status takes no query', async () => {
    const r = await raw(h.url, '/s/api/status?token=x', { headers: shareHeaders() });
    expect(r.status).toBe(400);
  });
});

describe('core answers: no internal data leaks', () => {
  const refused = { ok: false, error: 'unavailable' };

  it.each([
    ['extra top-level serverId', { ...okStatus, serverId: 'srv_12345678' }],
    [
      'extra containerId in game',
      { ...okStatus, game: { ...okStatus.game, containerId: 'abc123' } },
    ],
    [
      'tailscale IPv4 address',
      { ...okStatus, game: { ...okStatus.game, address: '100.64.1.2:25565' } },
    ],
    ['tailscale IPv4 high', { ...okStatus, game: { ...okStatus.game, address: '100.127.255.1' } }],
    [
      'tailscale IPv6',
      { ...okStatus, game: { ...okStatus.game, address: '[fd7a:115c:a1e0::1]:25565' } },
    ],
    [
      'MagicDNS name',
      { ...okStatus, game: { ...okStatus.game, statusText: 'heimserver.tail1234.ts.net' } },
    ],
    [
      'tailnet IP in player list',
      {
        ...okStatus,
        game: { ...okStatus.game, players: { online: 1, max: 2, names: ['100.100.1.1'] } },
      },
    ],
    ['missing field', { person: 'Max' }],
    ['not an object', 'hello'],
    ['admin game summary', { game: { id: 'g_12345678', serverId: 's_12345678', name: 'x' } }],
  ])('%s -> 502 generic', async (_name, body) => {
    h.setCore(() => ({ body }));
    const r = await raw(h.url, '/s/api/status', { headers: shareHeaders() });
    expect(r.status).toBe(502);
    expect(JSON.parse(r.body)).toEqual(refused);
    expect(r.body).not.toMatch(/100\.|serverId|containerId|ts\.net|fd7a/);
  });

  it('passes a valid status answer unchanged', async () => {
    const r = await raw(h.url, '/s/api/status', { headers: shareHeaders() });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual(okStatus);
  });

  it('a non-tailnet 100.x address is not refused', async () => {
    const body = { ...okStatus, game: { ...okStatus.game, address: '100.200.1.2:25565' } };
    h.setCore(() => ({ body }));
    const r = await raw(h.url, '/s/api/status', { headers: shareHeaders() });
    expect(r.status).toBe(200);
  });

  it('masks tailnet addresses in console output instead of refusing', async () => {
    h.setCore(() => ({
      body: {
        lines: [
          {
            id: '1',
            text: 'Steve[/100.101.2.3:51234] logged in',
            kind: 'out',
            ts: '2026-11-26T10:00:00.000Z',
          },
          {
            id: '2',
            text: 'core at heimserver.tail1.ts.net',
            kind: 'out',
            ts: '2026-11-26T10:00:01.000Z',
          },
        ],
      },
    }));
    const r = await raw(h.url, '/s/api/console', { headers: shareHeaders() });
    expect(r.status).toBe(200);
    expect(r.body).not.toContain('100.101');
    expect(r.body).not.toContain('ts.net');
    expect(JSON.parse(r.body).lines[0].text).toBe('Steve[/[intern]:51234] logged in');
  });

  it('refuses extra fields on console lines', async () => {
    h.setCore(() => ({
      body: {
        lines: [
          { id: '1', text: 'x', kind: 'out', ts: '2026-11-26T10:00:00.000Z', containerId: 'c' },
        ],
      },
    }));
    const r = await raw(h.url, '/s/api/console', { headers: shareHeaders() });
    expect(r.status).toBe(502);
  });

  it('passes shared error answers with Retry-After', async () => {
    h.setCore(() => ({ status: 423, body: { ok: false, error: 'locked', retryAfter: 900 } }));
    const r = await raw(h.url, '/s/api/status', { headers: shareHeaders() });
    expect(r.status).toBe(423);
    expect(r.headers['retry-after']).toBe('900');
    expect(JSON.parse(r.body)).toEqual({ ok: false, error: 'locked', retryAfter: 900 });

    h.setCore(() => ({ status: 401, body: { ok: false, error: 'pin_wrong', triesLeft: 3 } }));
    const p = await raw(h.url, '/s/api/status', {
      headers: shareHeaders({ 'x-share-pin': '0000' }),
    });
    expect(p.status).toBe(401);
    expect(JSON.parse(p.body)).toEqual({ ok: false, error: 'pin_wrong', triesLeft: 3 });
  });

  it.each([
    [
      'error with extra message',
      400,
      { ok: false, error: 'invalid_input', message: 'srv 100.64.0.1' },
    ],
    ['admin-style error', 401, { error: 'unauthorized' }],
    ['unexpected status', 500, { ok: false, error: 'unavailable' }],
    ['redirect', 302, { ok: false, error: 'not_found' }],
    ['201 instead of 200', 201, okStatus],
  ])('%s -> 502', async (_n, status, body) => {
    h.setCore(() => ({
      status,
      body,
      headers: status === 302 ? { location: 'http://evil/' } : {},
    }));
    const r = await raw(h.url, '/s/api/status', { headers: shareHeaders() });
    expect(r.status).toBe(502);
    expect(JSON.parse(r.body)).toEqual(refused);
  });

  it('non-JSON or broken core answers -> 502', async () => {
    h.setCore(() => ({ raw: '<html>internal</html>', headers: { 'content-type': 'text/html' } }));
    expect((await raw(h.url, '/s/api/status', { headers: shareHeaders() })).status).toBe(502);
    h.setCore(() => ({ raw: '{"person":' }));
    expect((await raw(h.url, '/s/api/status', { headers: shareHeaders() })).status).toBe(502);
  });
});
