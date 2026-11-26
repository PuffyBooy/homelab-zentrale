import { describe, expect, it } from 'vitest';
import { download, request, type Fetch } from './api.js';
import { isOutputResponse, isShareStatus } from './logic.js';

const TOKEN = 'T'.repeat(43);

function recorder(res: Response): { fetch: Fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(res.clone());
    },
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

describe('share API client', () => {
  it('sends the token only in the Authorization header, no cookies, no referrer', async () => {
    const r = recorder(json(200, { output: 'ok' }));
    await request(
      { token: TOKEN, pin: null },
      {
        method: 'POST',
        path: '/s/api/console',
        body: { command: 'list' },
        guard: isOutputResponse,
      },
      r.fetch,
    );
    const call = r.calls[0];
    expect(call?.url).toBe('/s/api/console');
    expect(call?.url).not.toContain(TOKEN);
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Share ${TOKEN}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect('X-Share-Pin' in headers).toBe(false);
    expect(call?.init.credentials).toBe('omit');
    expect(call?.init.referrerPolicy).toBe('no-referrer');
    expect(call?.init.redirect).toBe('error');
    expect(call?.init.body).toBe('{"command":"list"}');
  });

  it('adds the PIN header only when there is a PIN', async () => {
    const r = recorder(json(401, { ok: false, error: 'pin_wrong', triesLeft: 4 }));
    const res = await request(
      { token: TOKEN, pin: '0420' },
      { path: '/s/api/status', guard: isShareStatus },
      r.fetch,
    );
    expect((r.calls[0]?.init.headers as Record<string, string>)['X-Share-Pin']).toBe('0420');
    expect(res).toEqual({
      ok: false,
      failure: { status: 401, error: 'pin_wrong', retryAfter: undefined, triesLeft: 4 },
    });
  });

  it('refuses any path outside /s/api/', async () => {
    const r = recorder(json(200, {}));
    for (const path of ['/api/games', 'https://evil.example/s/api/status', '/s/api//x']) {
      await expect(
        request({ token: TOKEN, pin: null }, { path, guard: isShareStatus }, r.fetch),
      ).rejects.toThrow();
    }
    expect(r.calls).toHaveLength(0);
  });

  it('reports network errors and malformed answers', async () => {
    const down: Fetch = () => Promise.reject(new TypeError('failed'));
    expect(
      await request(
        { token: TOKEN, pin: null },
        { path: '/s/api/status', guard: isShareStatus },
        down,
      ),
    ).toEqual({ ok: false, failure: { status: 0, error: 'network' } });
    const r = recorder(json(200, { person: 'Max' }));
    expect(
      await request(
        { token: TOKEN, pin: null },
        { path: '/s/api/status', guard: isShareStatus },
        r.fetch,
      ),
    ).toEqual({ ok: false, failure: { status: 200, error: 'bad_response' } });
  });
});

describe('world download', () => {
  it('sends the token only in headers and returns the file with progress', async () => {
    const bytes = new Uint8Array(1000).fill(7);
    const r = recorder(
      new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': 'application/zstd',
          'Content-Length': '1000',
          'Content-Disposition': 'attachment; filename="survival-welt.tar.zst"',
        },
      }),
    );
    const seen: [number, number | null][] = [];
    const res = await download(
      { token: TOKEN, pin: '0420' },
      '/s/api/world',
      (loaded, total) => seen.push([loaded, total]),
      r.fetch,
    );
    const call = r.calls[0];
    expect(call?.url).toBe('/s/api/world');
    expect(call?.url).not.toContain(TOKEN);
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Share ${TOKEN}`);
    expect(headers['X-Share-Pin']).toBe('0420');
    expect(call?.init.credentials).toBe('omit');
    expect(call?.init.redirect).toBe('error');
    expect(res.ok && res.data.blob.size).toBe(1000);
    expect(res.ok && res.data.disposition).toContain('survival-welt.tar.zst');
    expect(seen[seen.length - 1]).toEqual([1000, 1000]);
  });

  it('maps the hourly limit and refuses other paths', async () => {
    const r = recorder(json(429, { ok: false, error: 'rate_limited', retryAfter: 600 }));
    expect(await download({ token: TOKEN, pin: null }, '/s/api/world', () => {}, r.fetch)).toEqual({
      ok: false,
      failure: { status: 429, error: 'rate_limited', retryAfter: 600, triesLeft: undefined },
    });
    await expect(
      download({ token: TOKEN, pin: null }, '/api/games/x/backups', () => {}, r.fetch),
    ).rejects.toThrow();
  });
});
