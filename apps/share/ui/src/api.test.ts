import { describe, expect, it } from 'vitest';
import { request, type Fetch } from './api.js';
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
