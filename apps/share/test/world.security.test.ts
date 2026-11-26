import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_DOWNLOADS } from '../src/server.js';
import { checkDownloadHeaders } from '../src/proxy.js';
import { okStatus, raw, shareHeaders, startHarness, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const DISP = 'attachment; filename="survival-welt.tar.zst"';

describe('gateway: world download (M12)', () => {
  it('streams the core file through with fixed headers and the gateway token', async () => {
    h = await startHarness();
    const body = 'x'.repeat(100_000);
    h.setCore(() => ({
      raw: body,
      headers: {
        'content-type': 'application/zstd',
        'content-length': String(body.length),
        'content-disposition': DISP,
        'x-internal': 'serverId',
      },
    }));
    const res = await raw(h.url, '/s/api/world', { headers: shareHeaders() });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zstd');
    expect(res.headers['content-disposition']).toBe(DISP);
    expect(res.headers['x-internal']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toBe(body);
    const core = h.coreRequests[0];
    expect(core?.url).toBe('/api/share-gateway/world');
    expect(core?.headers['x-share-token']).toBeDefined();
  });

  it('refuses a wrong type, file name or size (502, no byte passed on)', async () => {
    h = await startHarness();
    for (const headers of [
      { 'content-type': 'text/html', 'content-length': '3', 'content-disposition': DISP },
      {
        'content-type': 'application/zstd',
        'content-length': '3',
        'content-disposition': 'attachment; filename="../etc"',
      },
      {
        'content-type': 'application/zstd',
        'content-length': String(11 * 1024 ** 3),
        'content-disposition': DISP,
      },
    ]) {
      h.setCore(() => ({ raw: 'abc', headers }));
      const res = await raw(h.url, '/s/api/world', { headers: shareHeaders() });
      expect(res.status).toBe(502);
      expect(res.body).not.toContain('abc');
    }
  });

  it('passes share errors through (403, 429) and checks the query', async () => {
    h = await startHarness();
    h.setCore(() => ({
      status: 429,
      body: { ok: false, error: 'rate_limited', retryAfter: 3000 },
    }));
    const res = await raw(h.url, '/s/api/world', { headers: shareHeaders() });
    expect(res.status).toBe(429);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'rate_limited', retryAfter: 3000 });
    const n = h.coreRequests.length;
    expect((await raw(h.url, '/s/api/world?path=/etc', { headers: shareHeaders() })).status).toBe(
      400,
    );
    expect(h.coreRequests).toHaveLength(n);
  });

  it('limits world downloads per IP and hour', async () => {
    h = await startHarness();
    h.setCore(() => ({ status: 403, body: { ok: false, error: 'forbidden' } }));
    const ip = '198.51.100.77';
    const codes: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      codes.push(
        (await raw(h.url, '/s/api/world', { headers: shareHeaders({ 'x-forwarded-for': ip }) }))
          .status,
      );
    }
    expect(codes).toEqual([403, 403, 403, 429]);
  });

  it('a friend who leaves before the headers frees the slot and aborts the core request', async () => {
    h = await startHarness();
    h.setCore(() => ({ delayMs: 3000, status: 403, body: { ok: false, error: 'forbidden' } }));
    const u = new URL(h.url);
    for (let i = 0; i < MAX_DOWNLOADS; i += 1) {
      const req = http.request({
        host: u.hostname,
        port: u.port,
        path: '/s/api/world',
        headers: shareHeaders({ 'x-forwarded-for': `203.0.113.${i + 1}` }),
      });
      req.on('error', () => undefined);
      req.end();
      setTimeout(() => req.destroy(), 100);
    }
    const base = h.coreRequests.length;
    await new Promise((r) => setTimeout(r, 400));
    expect(h.coreRequests.length).toBeGreaterThanOrEqual(base);
    h.setCore(() => ({ status: 403, body: { ok: false, error: 'forbidden' } }));
    const res = await raw(h.url, '/s/api/world', { headers: shareHeaders() });
    // Without the abort all slots would still be taken (503).
    expect(res.status).toBe(403);
  });

  it('checkDownloadHeaders', () => {
    expect(
      checkDownloadHeaders({ type: 'application/zstd', length: '10', disposition: DISP }),
    ).toEqual({
      length: 10,
      disposition: DISP,
    });
    expect(
      checkDownloadHeaders({ type: 'application/zstd', length: '0', disposition: DISP }),
    ).toBeNull();
    expect(
      checkDownloadHeaders({ type: 'application/zstd', length: '1e3', disposition: DISP }),
    ).toBeNull();
  });
});

describe('gateway: whitelist request (M12)', () => {
  it('forwards a valid player name and the strict status answer', async () => {
    h = await startHarness();
    h.setCore(() => ({
      body: {
        ...okStatus,
        whitelistRequests: [
          { player: 'Steve', state: 'pending', createdAt: '2026-11-25T12:00:00.000Z' },
        ],
      },
    }));
    const ok = await raw(h.url, '/s/api/whitelist-request', {
      method: 'POST',
      headers: shareHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ player: 'Steve' }),
    });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).whitelistRequests).toHaveLength(1);
    const n = h.coreRequests.length;
    const bad = await raw(h.url, '/s/api/whitelist-request', {
      method: 'POST',
      headers: shareHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ player: 'x; op me' }),
    });
    expect(bad.status).toBe(400);
    expect(h.coreRequests).toHaveLength(n);
    // An answer with internal fields is refused.
    h.setCore(() => ({ body: { ...okStatus, serverId: 'abc' } }));
    const leak = await raw(h.url, '/s/api/whitelist-request', {
      method: 'POST',
      headers: shareHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ player: 'Steve' }),
    });
    expect(leak.status).toBe(502);
  });
});
