import { describe, expect, it } from 'vitest';
import {
  evaluate,
  formatMs,
  nextStreak,
  sparkline,
  uptimePercent,
  type StatusInput,
  type Streak,
} from '../src/checks/evaluate.js';
import { expiryFromRdap, lookupDomainExpiry, registrableDomain } from '../src/checks/rdap.js';
import { sanitizeReason } from '../src/checks/service.js';

const fresh: Streak = { consecutiveFailures: 0, consecutiveSlow: 0, downSince: null };
const base: StatusInput = {
  enabled: true,
  unavailable: null,
  pending: false,
  streak: fresh,
  lastError: null,
  lastMs: 120,
  sslDays: null,
  domainDays: null,
};

describe('uptime math', () => {
  it('is null without data and rounds down to 2 decimals', () => {
    expect(uptimePercent(0, 0)).toBeNull();
    expect(uptimePercent(10, 10)).toBe(100);
    expect(uptimePercent(1, 4)).toBe(25);
    // 9999/10000 would round to 100 %; one failure must never show 100.
    expect(uptimePercent(19_999, 20_000)).toBe(99.99);
    expect(uptimePercent(199_999, 200_000)).toBe(99.99);
    expect(uptimePercent(2, 3)).toBe(66.66);
    expect(uptimePercent(0, 5)).toBe(0);
  });

  it('sparkline: mean per bucket, oldest first, empty buckets skipped, failures without ms ignored', () => {
    const from = 0;
    const to = 4000;
    expect(
      sparkline(
        [
          { ts: 0, ms: 100 },
          { ts: 500, ms: 300 },
          { ts: 1500, ms: null },
          { ts: 3999, ms: 50 },
          { ts: 4000, ms: 9999 },
        ],
        from,
        to,
        4,
      ),
    ).toEqual([200, 50]);
  });
});

describe('2-failure rule and warn rules', () => {
  it('first failure warns, second is crit, success resets', () => {
    const t0 = 1_000;
    const s1 = nextStreak(fresh, { ok: false, ms: null }, t0);
    expect(s1).toEqual({ consecutiveFailures: 1, consecutiveSlow: 0, downSince: t0 });
    expect(evaluate({ ...base, streak: s1, lastError: 'HTTP 503' })).toMatchObject({
      status: 'warn',
      reason: 'HTTP 503 · wird erneut geprüft',
      down: false,
    });
    const s2 = nextStreak(s1, { ok: false, ms: null }, t0 + 60_000);
    expect(s2.downSince).toBe(t0);
    expect(evaluate({ ...base, streak: s2, lastError: 'HTTP 503' })).toMatchObject({
      status: 'crit',
      reason: 'HTTP 503',
      down: true,
    });
    expect(nextStreak(s2, { ok: true, ms: 80 }, t0 + 120_000)).toEqual(fresh);
  });

  it('slow > 800 ms warns only twice in a row', () => {
    const s1 = nextStreak(fresh, { ok: true, ms: 900 }, 0);
    expect(evaluate({ ...base, streak: s1, lastMs: 900 }).status).toBe('ok');
    const s2 = nextStreak(s1, { ok: true, ms: 1250 }, 0);
    expect(evaluate({ ...base, streak: s2, lastMs: 1250 })).toMatchObject({
      status: 'warn',
      reason: 'Langsam: 1,3 s',
      slow: true,
    });
    expect(nextStreak(s2, { ok: true, ms: 800 }, 0).consecutiveSlow).toBe(0);
  });

  it('certificate < 14 days warns, < 5 days is crit; domain < 30 days warns', () => {
    expect(evaluate({ ...base, sslDays: 20 }).status).toBe('ok');
    expect(evaluate({ ...base, sslDays: 13 })).toMatchObject({
      status: 'warn',
      reason: 'SSL läuft in 13 Tagen ab',
      ssl: 'warn',
    });
    expect(evaluate({ ...base, sslDays: 4 })).toMatchObject({ status: 'crit', ssl: 'crit' });
    expect(evaluate({ ...base, sslDays: 1 }).reason).toBe('SSL läuft in 1 Tag ab');
    expect(evaluate({ ...base, domainDays: 29 })).toMatchObject({
      status: 'warn',
      reason: 'Domain läuft in 29 Tagen ab',
      domain: 'warn',
    });
    expect(evaluate({ ...base, domainDays: 30 }).status).toBe('ok');
  });

  it('agent offline is off, not crit; disabled is off; never ran is busy', () => {
    const down = { consecutiveFailures: 3, consecutiveSlow: 0, downSince: 0 };
    expect(evaluate({ ...base, unavailable: 'Agent offline', streak: down })).toMatchObject({
      status: 'off',
      reason: 'Agent offline',
    });
    expect(evaluate({ ...base, enabled: false }).status).toBe('off');
    expect(evaluate({ ...base, pending: true }).status).toBe('busy');
  });

  it('formats times like the brand book', () => {
    expect(formatMs(950)).toBe('950 ms');
    expect(formatMs(1200)).toBe('1,2 s');
    expect(formatMs(10_000)).toBe('10 s');
  });
});

describe('RDAP', () => {
  it('registrable domain: skips IPs, tailnet and local names', () => {
    expect(registrableDomain('www.sc-ball.at')).toBe('sc-ball.at');
    expect(registrableDomain('shop.example.co.at')).toBe('example.co.at');
    expect(registrableDomain('a.b.example.com.')).toBe('example.com');
    for (const h of [
      '127.0.0.1',
      '[::1]',
      '100.64.0.5',
      'heimserver.tail1234.ts.net',
      'nas.local',
      'localhost',
      'router',
      'co.at',
      'printer.home.arpa',
    ]) {
      expect(registrableDomain(h), h).toBeNull();
    }
  });

  it('reads the expiration event and tolerates failures', async () => {
    const json = {
      events: [
        { eventAction: 'registration', eventDate: '2010-01-01T00:00:00Z' },
        { eventAction: 'expiration', eventDate: '2027-01-15T00:00:00Z' },
      ],
    };
    expect(expiryFromRdap(json)).toBe(Date.parse('2027-01-15T00:00:00Z'));
    expect(expiryFromRdap({ events: 'x' })).toBeNull();
    expect(expiryFromRdap(null)).toBeNull();

    const urls: string[] = [];
    const ok = await lookupDomainExpiry('sc-ball.at', (url) => {
      urls.push(url);
      if (url.startsWith('https://rdap.org/')) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: 'https://rdap.nic.at/domain/sc-ball.at' },
          }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify(json), { status: 200 }));
    });
    expect(ok).toBe(Date.parse('2027-01-15T00:00:00Z'));
    expect(urls).toEqual([
      'https://rdap.org/domain/sc-ball.at',
      'https://rdap.nic.at/domain/sc-ball.at',
    ]);

    // Redirect to plain http is not followed.
    expect(
      await lookupDomainExpiry('x.at', () =>
        Promise.resolve(new Response(null, { status: 302, headers: { location: 'http://evil/' } })),
      ),
    ).toBeNull();
    expect(await lookupDomainExpiry('x.at', () => Promise.reject(new Error('down')))).toBeNull();
    expect(
      await lookupDomainExpiry('x.at', () =>
        Promise.resolve(new Response('nope', { status: 404 })),
      ),
    ).toBeNull();
    expect(
      await lookupDomainExpiry('x.at', () =>
        Promise.resolve(new Response('{not json', { status: 200 })),
      ),
    ).toBeNull();
    // Bodies over 1 MB are not parsed.
    const huge = JSON.stringify({ ...json, pad: 'x'.repeat(1024 * 1024) });
    expect(
      await lookupDomainExpiry('x.at', () => Promise.resolve(new Response(huge, { status: 200 }))),
    ).toBeNull();
  });
});

describe('agent reasons', () => {
  it('strips credentials and newlines and shortens', () => {
    expect(sanitizeReason('GET https://user:pa55@host/x failed\nboom')).toBe(
      'GET https://host/x failed boom',
    );
    expect(sanitizeReason('x'.repeat(500)).length).toBe(160);
  });
});
