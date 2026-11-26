import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkResultDataSchema } from '@hz/shared';
import {
  checkHttp,
  checkPing,
  checkTcp,
  createHttpChecker,
  parsePingAvg,
  pingArgs,
} from '../src/actions/checks.js';
import type { RunResult } from '../src/exec.js';

const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
});

function track(s: net.Server): void {
  closers.push(async () => {
    if ('closeAllConnections' in s) (s as http.Server).closeAllConnections();
    await new Promise((r) => s.close(r));
  });
}

const port = (s: net.Server) => (s.address() as AddressInfo).port;
const http0 = {
  method: 'GET' as const,
  expectStatusMin: 200,
  expectStatusMax: 399,
  timeoutMs: 3000,
};

describe('check.http', () => {
  let base = '';
  beforeAll(async () => {
    const s = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      if (u.pathname === '/status') {
        res.writeHead(Number(u.searchParams.get('c')));
        return res.end();
      }
      if (u.pathname === '/moved') {
        res.writeHead(301, { location: '/hello' });
        return res.end();
      }
      if (u.pathname === '/big') {
        res.writeHead(200);
        res.write(Buffer.alloc(1024 * 1024 - 5, 'a'));
        return res.end('needle-after-limit');
      }
      if (req.method === 'HEAD') {
        res.writeHead(200);
        return res.end();
      }
      res.end('Hallo Wien, grüß Gott');
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    track(s);
    base = `http://127.0.0.1:${port(s)}`;
  });

  it('reports status code and ms, valid against the protocol schema', async () => {
    const r = await checkHttp({ ...http0, url: `${base}/hello` });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(200);
    expect(typeof r.ms).toBe('number');
    expect(r.tlsExpiresAt).toBeUndefined();
    expect(checkResultDataSchema.safeParse(r).success).toBe(true);
  });

  it('applies the expected status range', async () => {
    expect(await checkHttp({ ...http0, url: `${base}/status?c=503` })).toMatchObject({
      ok: false,
      code: 503,
    });
    expect(
      await checkHttp({
        ...http0,
        url: `${base}/status?c=404`,
        expectStatusMin: 404,
        expectStatusMax: 404,
      }),
    ).toMatchObject({ ok: true, code: 404 });
  });

  it('finds text in the body (utf-8) and reports a miss', async () => {
    expect(await checkHttp({ ...http0, url: `${base}/`, contains: 'grüß' })).toMatchObject({
      ok: true,
    });
    expect(await checkHttp({ ...http0, url: `${base}/`, contains: 'Graz' })).toMatchObject({
      ok: false,
      code: 200,
      error: 'text not found',
    });
  });

  it('only searches the first 1 MiB', async () => {
    expect(await checkHttp({ ...http0, url: `${base}/big`, contains: 'needle' })).toMatchObject({
      ok: false,
      error: 'text not found',
    });
    expect(await checkHttp({ ...http0, url: `${base}/big`, contains: 'aaaa' })).toMatchObject({
      ok: true,
    });
  });

  it('HEAD ignores contains', async () => {
    expect(
      await checkHttp({ ...http0, method: 'HEAD', url: `${base}/`, contains: 'x' }),
    ).toMatchObject({ ok: true, code: 200 });
  });

  it('follows http redirects and reports the final response', async () => {
    expect(await checkHttp({ ...http0, url: `${base}/moved`, contains: 'Wien' })).toMatchObject({
      ok: true,
      code: 200,
    });
  });

  it('reports connection errors as codes', async () => {
    const s = net.createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const p = port(s);
    await new Promise((r) => s.close(r));
    expect(await checkHttp({ ...http0, url: `http://127.0.0.1:${p}/` })).toEqual({
      ok: false,
      ms: null,
      error: 'ECONNREFUSED',
    });
  });
});

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasOpenssl())('check.http over TLS', () => {
  let dir = '';
  let cert = '';
  let expires = '';
  let httpsBase = '';
  let requests = 0;
  let plainBase = '';

  beforeAll(async () => {
    // Generated per run, so no private key ever lands in the repo.
    dir = await mkdtemp(path.join(os.tmpdir(), 'hz-check-tls-'));
    const key = path.join(dir, 'key.pem');
    const crt = path.join(dir, 'crt.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        key,
        '-out',
        crt,
        '-days',
        '400',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-addext',
        'basicConstraints=critical,CA:TRUE',
      ],
      { stdio: 'ignore' },
    );
    cert = await readFile(crt, 'utf8');
    const end = execFileSync('openssl', ['x509', '-in', crt, '-noout', '-enddate'], {
      encoding: 'utf8',
    });
    expires = new Date(end.trim().replace(/^notAfter=/, '')).toISOString();

    const s = https.createServer({ key: await readFile(key), cert }, (_req, res) => {
      requests++;
      res.end('secure ok');
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    track(s);
    httpsBase = `https://localhost:${port(s)}`;

    const p = http.createServer((_req, res) => {
      res.writeHead(301, { location: `${httpsBase}/` });
      res.end();
    });
    await new Promise<void>((r) => p.listen(0, '127.0.0.1', r));
    track(p);
    plainBase = `http://localhost:${port(p)}`;
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports the certificate expiry for a trusted certificate', async () => {
    const check = createHttpChecker({ ca: cert });
    const r = await check({ ...http0, url: `${httpsBase}/`, contains: 'secure' });
    expect(r).toMatchObject({ ok: true, code: 200, tlsExpiresAt: expires });
    expect(checkResultDataSchema.safeParse(r).success).toBe(true);
  });

  it('takes the certificate from an http -> https redirect on the same host', async () => {
    const check = createHttpChecker({ ca: cert });
    expect(await check({ ...http0, url: `${plainBase}/` })).toMatchObject({
      ok: true,
      tlsExpiresAt: expires,
    });
  });

  it('fails an untrusted certificate, still reports its expiry, sends no request', async () => {
    requests = 0;
    const r = await checkHttp({ ...http0, url: `${httpsBase}/` });
    expect(r.ok).toBe(false);
    expect(r.ms).toBeNull();
    expect(r.error).toMatch(/SELF_SIGNED|CERT/);
    expect(r.tlsExpiresAt).toBe(expires);
    expect(requests).toBe(0);
  });
});

describe('check.tcp', () => {
  it('connects and reports ms', async () => {
    const s = net.createServer((c) => c.end());
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    track(s);
    const r = await checkTcp({ host: '127.0.0.1', port: port(s), timeoutMs: 2000 });
    expect(r.ok).toBe(true);
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it('reports a refused port', async () => {
    const s = net.createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const p = port(s);
    await new Promise((r) => s.close(r));
    expect(await checkTcp({ host: 'localhost', port: p, timeoutMs: 2000 })).toMatchObject({
      ok: false,
      ms: null,
    });
  });

  it('honors the connect timeout', async () => {
    // A socket that never connects.
    const spy = vi.spyOn(net, 'connect').mockImplementation(() => new net.Socket());
    try {
      const t0 = performance.now();
      const r = await checkTcp({ host: '10.255.255.1', port: 22, timeoutMs: 200 });
      expect(r).toEqual({ ok: false, ms: null, error: 'timeout' });
      expect(performance.now() - t0).toBeLessThan(1000);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('check.ping', () => {
  const fakeRun = (r: RunResult) => vi.fn(async () => r);

  it('parses iputils and busybox summaries', () => {
    expect(parsePingAvg('rtt min/avg/max/mdev = 0.031/0.042/0.051/0.008 ms')).toBe(0.042);
    expect(parsePingAvg('round-trip min/avg/max = 10.1/12.5/14.0 ms')).toBe(12.5);
    expect(parsePingAvg('3 packets transmitted, 0 received, 100% packet loss')).toBeNull();
  });

  it('returns the average rtt', async () => {
    const out = [
      'PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.',
      '',
      '--- 1.1.1.1 ping statistics ---',
      '3 packets transmitted, 3 received, 0% packet loss, time 402ms',
      'rtt min/avg/max/mdev = 11.204/12.345/13.876/1.100 ms',
    ].join('\n');
    const r = await checkPing(
      { host: '1.1.1.1', count: 3, timeoutMs: 5000 },
      { run: fakeRun({ code: 0, stdout: out, stderr: '' }) },
    );
    expect(r).toEqual({ ok: true, ms: 12.3 });
  });

  it('counts partial loss (exit 1 with a summary) as reachable', async () => {
    const out =
      '5 packets transmitted, 2 received, 60% packet loss\nrtt min/avg/max/mdev = 1.0/2.0/3.0/0.5 ms';
    expect(
      await checkPing(
        { host: 'pi', count: 5, timeoutMs: 2000 },
        { run: fakeRun({ code: 1, stdout: out, stderr: '' }) },
      ),
    ).toEqual({ ok: true, ms: 2 });
  });

  it('maps failures to fixed texts', async () => {
    const p = { host: 'example.com', count: 1, timeoutMs: 1000 };
    expect(
      await checkPing(p, {
        run: fakeRun({ code: 1, stdout: '1 packets transmitted, 0 received', stderr: '' }),
      }),
    ).toEqual({ ok: false, ms: null, error: 'no reply' });
    expect(
      await checkPing(p, {
        run: fakeRun({
          code: 2,
          stdout: '',
          stderr: 'ping: example.com: Name or service not known',
        }),
      }),
    ).toEqual({ ok: false, ms: null, error: 'dns failed' });
    expect(
      await checkPing(p, {
        run: fakeRun({ code: 2, stdout: '', stderr: 'ping: socket: Operation not permitted' }),
      }),
    ).toEqual({ ok: false, ms: null, error: 'ping not permitted' });
    await expect(
      checkPing(p, { run: fakeRun({ code: null, stdout: '', stderr: '', error: 'not_found' }) }),
    ).rejects.toMatchObject({ code: 'failed' });
  });

  it('builds fixed arguments', () => {
    expect(pingArgs('pi', 1, 500)).toEqual([
      '-n',
      '-q',
      '-c',
      '1',
      '-i',
      '0.2',
      '-W',
      '1',
      '-w',
      '1',
      '--',
      'pi',
    ]);
  });
});
