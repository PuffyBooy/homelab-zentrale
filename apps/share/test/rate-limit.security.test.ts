import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientIp, isLoopbackAddress, rateLimitKey } from '../src/client-ip.js';
import { RateLimiter } from '../src/rate-limit.js';
import { LIMITS } from '../src/server.js';
import { SHARE_TOKEN, okStatus, raw, shareHeaders, startHarness } from './helpers.js';
import type { Harness } from './helpers.js';

describe('client IP (trusted proxy = loopback only)', () => {
  it('uses the rightmost X-Forwarded-For entry from loopback (Caddy)', () => {
    expect(clientIp('127.0.0.1', '198.51.100.7')).toBe('198.51.100.7');
    expect(clientIp('::1', '1.1.1.1, 198.51.100.7')).toBe('198.51.100.7');
    expect(clientIp('::ffff:127.0.0.1', ['6.6.6.6', '198.51.100.7'])).toBe('198.51.100.7');
    expect(clientIp('127.0.0.1', '2001:db8::1')).toBe('2001:db8::1');
  });

  it('ignores X-Forwarded-For from anyone else (spoofing)', () => {
    expect(clientIp('203.0.113.9', '127.0.0.1')).toBe('203.0.113.9');
    expect(clientIp('203.0.113.9', '198.51.100.7')).toBe('203.0.113.9');
    expect(clientIp('::ffff:203.0.113.9', '1.2.3.4')).toBe('203.0.113.9');
    expect(clientIp('100.64.0.5', '1.2.3.4')).toBe('100.64.0.5');
    expect(clientIp('10.0.0.2', '1.2.3.4')).toBe('10.0.0.2');
  });

  it('falls back to the socket address for garbage headers', () => {
    expect(clientIp('127.0.0.1', '1.2.3.4, not-an-ip')).toBe('127.0.0.1');
    expect(clientIp('127.0.0.1', '')).toBe('127.0.0.1');
    expect(clientIp(undefined, '1.2.3.4')).toBe('unknown');
  });

  it('loopback detection', () => {
    expect(isLoopbackAddress('127.8.9.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('128.0.0.1')).toBe(false);
    expect(isLoopbackAddress('::2')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it('IPv6 clients are limited per /64', () => {
    expect(rateLimitKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(rateLimitKey('2001:db8:1:2:bbbb:cccc:dddd:eeee')).toBe('2001:db8:1:2::/64');
    expect(rateLimitKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateLimitKey('198.51.100.7')).toBe('198.51.100.7');
  });
});

describe('RateLimiter', () => {
  it('allows `limit` hits per window, then reports Retry-After', () => {
    const rl = new RateLimiter(3, 60_000);
    expect(rl.hit('a', 0).ok).toBe(true);
    expect(rl.hit('a', 1).ok).toBe(true);
    expect(rl.hit('a', 2).ok).toBe(true);
    expect(rl.hit('a', 30_000)).toEqual({ ok: false, retryAfter: 30 });
    expect(rl.hit('b', 30_000).ok).toBe(true);
    expect(rl.hit('a', 60_000).ok).toBe(true);
  });

  it('memory is bounded (LRU cap)', () => {
    const rl = new RateLimiter(1, 60_000, 100);
    for (let i = 0; i < 10_000; i++) rl.hit(`ip${i}`, 0);
    expect(rl.size).toBe(100);
  });
});

describe('gateway rate limits', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
    h.setCore((req) =>
      req.url.startsWith('/api/share-gateway/console')
        ? { body: { lines: [] } }
        : { body: okStatus },
    );
  });
  afterAll(() => h.close());

  it(`${LIMITS.api} API requests per minute and IP, then 429 with Retry-After`, async () => {
    const ip = { 'x-forwarded-for': '198.51.100.20' };
    for (let i = 0; i < LIMITS.api; i++) {
      const r = await raw(h.url, '/s/api/status', { headers: shareHeaders(ip) });
      expect(r.status).toBe(200);
    }
    const before = h.coreRequests.length;
    const r = await raw(h.url, '/s/api/status', { headers: shareHeaders(ip) });
    expect(r.status).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(JSON.parse(r.body)).toMatchObject({ ok: false, error: 'rate_limited' });
    expect(h.coreRequests.length).toBe(before);
    // Unknown /s/api paths and bad tokens count too (no free probing).
    const bad = await raw(h.url, '/s/api/nope', { headers: ip });
    expect(bad.status).toBe(429);
    // Another client is not affected.
    const other = await raw(h.url, '/s/api/status', {
      headers: shareHeaders({ 'x-forwarded-for': '198.51.100.21' }),
    });
    expect(other.status).toBe(200);
  });

  it(`console polls have their own budget of ${LIMITS.poll}/min`, async () => {
    const ip = { 'x-forwarded-for': '198.51.100.30' };
    for (let i = 0; i < LIMITS.api; i++) {
      await raw(h.url, '/s/api/status', { headers: shareHeaders(ip) });
    }
    for (let i = 0; i < LIMITS.poll; i++) {
      const r = await raw(h.url, '/s/api/console', { headers: shareHeaders(ip) });
      expect(r.status).toBe(200);
    }
    const r = await raw(h.url, '/s/api/console', { headers: shareHeaders(ip) });
    expect(r.status).toBe(429);
  });

  it('a spoofed X-Forwarded-For cannot reset the budget behind Caddy (rightmost wins)', async () => {
    const real = '198.51.100.40';
    for (let i = 0; i < LIMITS.api; i++) {
      await raw(h.url, '/s/api/status', {
        headers: shareHeaders({ 'x-forwarded-for': `10.0.0.${i}, ${real}` }),
      });
    }
    const r = await raw(h.url, '/s/api/status', {
      headers: shareHeaders({ 'x-forwarded-for': `1.2.3.4, ${real}` }),
    });
    expect(r.status).toBe(429);
  });

  it('page requests have a separate, larger budget', async () => {
    const ip = { 'x-forwarded-for': '198.51.100.50' };
    for (let i = 0; i < LIMITS.page; i++) {
      const r = await raw(h.url, `/s/${SHARE_TOKEN}`, { headers: ip });
      expect(r.status).toBe(200);
    }
    const r = await raw(h.url, `/s/${SHARE_TOKEN}`, { headers: ip });
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBeDefined();
  });
});
