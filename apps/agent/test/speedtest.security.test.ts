import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rpcParamsByAction, speedtestDataSchema, SPEEDTEST_MAX_BYTES } from '@hz/shared';
import {
  jitter,
  median,
  runSpeedtest,
  SPEEDTEST_BASE,
  speedtestRunning,
} from '../src/actions/speedtest.js';

interface Fake {
  base: string;
  hits: string[];
  downBytes: number;
  upBytes: number;
  close(): Promise<void>;
}

/** A fake speed.cloudflare.com on localhost. */
async function startFake(
  opts: { redirectTo?: string; trace?: string; slowDown?: boolean } = {},
): Promise<Fake> {
  const hits: string[] = [];
  const fake = { downBytes: 0, upBytes: 0 };
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    const url = new URL(req.url ?? '/', 'http://x');
    if (opts.redirectTo) {
      res.writeHead(302, { location: `${opts.redirectTo}${url.pathname}${url.search}` }).end();
      return;
    }
    if (url.pathname === '/__down') {
      const n = Number(url.searchParams.get('bytes') ?? '0');
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      if (opts.slowDown && n > 0) {
        // trickle: 1 KiB every 20 ms, never finishes on its own
        const t = setInterval(() => {
          if (res.destroyed) return clearInterval(t);
          fake.downBytes += 1024;
          res.write(Buffer.alloc(1024));
        }, 20);
        res.on('close', () => clearInterval(t));
        return;
      }
      fake.downBytes += n;
      res.end(Buffer.alloc(n));
      return;
    }
    if (url.pathname === '/__up' && req.method === 'POST') {
      req.on('data', (c: Buffer) => (fake.upBytes += c.length));
      req.on('end', () => res.writeHead(200).end('ok'));
      return;
    }
    if (url.pathname === '/cdn-cgi/trace') {
      res.writeHead(200).end(opts.trace ?? 'fl=1\nh=speed.cloudflare.com\ncolo=VIE\nloc=AT\n');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    hits,
    get downBytes() {
      return fake.downBytes;
    },
    get upBytes() {
      return fake.upBytes;
    },
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

let fake: Fake;
beforeAll(async () => {
  fake = await startFake();
});
afterAll(async () => {
  await fake.close();
});

const MiB = 1024 * 1024;

describe('speedtest.run', () => {
  it('the wire carries no URL: unknown params are refused', () => {
    const s = rpcParamsByAction['speedtest.run'];
    expect(s.safeParse({ url: 'https://evil.example' }).success).toBe(false);
    expect(s.safeParse({ host: 'evil.example' }).success).toBe(false);
    expect(s.safeParse({ maxSeconds: 21 }).success).toBe(false);
    expect(s.safeParse({ maxBytes: SPEEDTEST_MAX_BYTES + 1 }).success).toBe(false);
  });

  it('talks only to https://speed.cloudflare.com without following redirects', async () => {
    const seen: { url: string; redirect: RequestInit['redirect'] }[] = [];
    const spy: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), redirect: init?.redirect });
      const u = new URL(String(input));
      const n = u.pathname === '/__down' ? Number(u.searchParams.get('bytes')) : 0;
      return new Response(u.pathname === '/cdn-cgi/trace' ? 'colo=FRA\n' : new Uint8Array(n), {
        status: 200,
      });
    };
    const r = await runSpeedtest({ maxSeconds: 3, maxBytes: 4 * MiB }, { fetch: spy });
    expect(SPEEDTEST_BASE).toBe('https://speed.cloudflare.com');
    expect(seen.length).toBeGreaterThan(10);
    for (const s of seen) {
      expect(new URL(s.url).origin).toBe('https://speed.cloudflare.com');
      expect(s.redirect).toBe('error');
    }
    expect(r.colo).toBe('FRA');
  });

  it('refuses a non-loopback base url even in tests', async () => {
    await expect(
      runSpeedtest({ maxSeconds: 3, maxBytes: MiB }, { baseUrl: 'https://evil.example' }),
    ).rejects.toThrow();
  });

  it('measures latency, download, upload, colo; never more than maxBytes', async () => {
    const before = { down: fake.downBytes, up: fake.upBytes, hits: fake.hits.length };
    const maxBytes = 6 * MiB;
    const r = await runSpeedtest({ maxSeconds: 10, maxBytes }, { baseUrl: fake.base });
    expect(speedtestDataSchema.safeParse(r).success).toBe(true);
    expect(r.colo).toBe('VIE');
    expect(r.downloadBytes).toBe(maxBytes);
    expect(r.uploadBytes).toBe(maxBytes);
    expect(fake.downBytes - before.down).toBe(maxBytes);
    expect(fake.upBytes - before.up).toBe(maxBytes);
    expect(r.downloadMbps).toBeGreaterThan(0);
    expect(r.uploadMbps).toBeGreaterThan(0);
    const hits = fake.hits.slice(before.hits);
    expect(hits.filter((h) => h === 'GET /__down?bytes=0')).toHaveLength(10);
    expect(
      hits.every((h) => /^(GET \/__down\?bytes=\d+|POST \/__up|GET \/cdn-cgi\/trace)$/.test(h)),
    ).toBe(true);
  });

  it('stops a direction after maxSeconds', async () => {
    const slow = await startFake({ slowDown: true });
    try {
      const started = Date.now();
      const r = await runSpeedtest({ maxSeconds: 3, maxBytes: 100 * MiB }, { baseUrl: slow.base });
      const took = Date.now() - started;
      // two directions of at most 3 s each (+ latency samples)
      expect(took).toBeLessThan(9000);
      expect(r.downloadBytes).toBeLessThan(100 * MiB);
      expect(r.downloadBytes).toBeGreaterThan(0);
    } finally {
      await slow.close();
    }
  }, 15_000);

  it('a redirect is refused and the target is never contacted', async () => {
    const target = await startFake();
    const redirecting = await startFake({ redirectTo: target.base });
    try {
      await expect(
        runSpeedtest({ maxSeconds: 3, maxBytes: MiB }, { baseUrl: redirecting.base }),
      ).rejects.toMatchObject({ code: 'failed' });
      expect(redirecting.hits.length).toBeGreaterThan(0);
      expect(target.hits).toEqual([]);
    } finally {
      await target.close();
      await redirecting.close();
    }
  });

  it('ignores anything in /cdn-cgi/trace but a valid colo= line', async () => {
    const odd = await startFake({ trace: 'colo=<script>\nxcolo=ABC\n' });
    try {
      const r = await runSpeedtest({ maxSeconds: 3, maxBytes: MiB }, { baseUrl: odd.base });
      expect(r.colo).toBeNull();
    } finally {
      await odd.close();
    }
  });

  it('one test at a time (busy)', async () => {
    const a = runSpeedtest({ maxSeconds: 3, maxBytes: 2 * MiB }, { baseUrl: fake.base });
    expect(speedtestRunning()).toBe(true);
    await expect(
      runSpeedtest({ maxSeconds: 3, maxBytes: MiB }, { baseUrl: fake.base }),
    ).rejects.toMatchObject({ code: 'busy' });
    await a;
    expect(speedtestRunning()).toBe(false);
  });

  it('median and jitter', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(jitter([10, 12, 9, 9])).toBeCloseTo((2 + 3 + 0) / 3);
    expect(jitter([7])).toBe(0);
  });
});
