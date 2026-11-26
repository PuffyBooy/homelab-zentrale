import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IntegrationError,
  IntegrationHttp,
  isLinkLocalAddress,
  requestUrl,
} from '../src/integrations/http.js';
import { FakeServer } from './integrations-helpers.js';

const fakes: FakeServer[] = [];
const tls: https.Server[] = [];
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.stop();
  for (const s of tls.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

async function fake(handler: FakeServer['handler']): Promise<FakeServer> {
  const f = new FakeServer();
  fakes.push(f);
  return f.start(handler);
}

async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof IntegrationError) return err.text;
    throw err;
  }
  throw new Error('expected a failure');
}

describe('link-local detection', () => {
  it('covers IPv4, IPv6 and IPv4-mapped forms', () => {
    for (const a of [
      '169.254.169.254',
      'fe80::1',
      'FEBF::1',
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
      '0:0:0:0:0:ffff:a9fe:1',
    ]) {
      expect(isLinkLocalAddress(a), a).toBe(true);
    }
    for (const a of [
      '127.0.0.1',
      '192.168.1.1',
      '10.0.0.1',
      '::1',
      'fd00::1',
      '::ffff:192.168.1.1',
      'fec0::1',
    ]) {
      expect(isLinkLocalAddress(a), a).toBe(false);
    }
  });
});

describe('request URL', () => {
  it('joins base path and path, refuses leaving the origin', () => {
    expect(requestUrl({ base: 'http://pi.lan/admin/', path: '/api/auth' }).href).toBe(
      'http://pi.lan/admin/api/auth',
    );
    expect(requestUrl({ base: 'http://box:49000', path: '/x?sid=1', fromOrigin: true }).href).toBe(
      'http://box:49000/x?sid=1',
    );
    for (const path of ['//evil.example/x', 'x', '/\\evil']) {
      expect(() => requestUrl({ base: 'http://box:49000', path })).toThrow(IntegrationError);
    }
    expect(() => requestUrl({ base: 'http://169.254.169.254', path: '/' })).toThrow(
      IntegrationError,
    );
    expect(() => requestUrl({ base: 'http://u:p@box', path: '/' })).toThrow(IntegrationError);
  });
});

describe('IntegrationHttp', () => {
  it('a host name that resolves to a link-local address is refused before connecting', async () => {
    const f = await fake((_q, r) => r.end('ok'));
    let asked = '';
    const client = new IntegrationHttp({
      lookup: async (h) => {
        asked = h;
        return [
          { address: '127.0.0.1', family: 4 },
          { address: '169.254.169.254', family: 4 },
        ];
      },
    });
    expect(
      await failure(client.request({ base: `http://metadata.test:${f.port}`, path: '/' })),
    ).toBe('Nicht erreichbar');
    expect(asked).toBe('metadata.test');
    expect(f.requests).toHaveLength(0);
  });

  it('connects to the checked address, Host header stays the name', async () => {
    const f = await fake((_q, r) => r.end('ok'));
    const client = new IntegrationHttp({
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    const res = await client.request({ base: `http://pve.test:${f.port}`, path: '/x' });
    expect(res).toMatchObject({ status: 200, body: 'ok' });
    expect(f.requests[0]?.headers.host).toBe(`pve.test:${f.port}`);
  });

  it('never follows redirects', async () => {
    const target = await fake((_q, r) => r.end('ok'));
    const f = await fake((_q, r) => {
      r.statusCode = 302;
      r.setHeader('location', `${target.url}/`);
      r.end();
    });
    const client = new IntegrationHttp();
    expect(await failure(client.request({ base: f.url, path: '/' }))).toBe(
      'Weiterleitung nicht erlaubt',
    );
    expect(target.requests).toHaveLength(0);
  });

  it('aborts oversized responses (declared and streamed)', async () => {
    const big = 'x'.repeat(64 * 1024);
    const declared = await fake((_q, r) => {
      r.setHeader('content-length', String(10 * 1024 * 1024));
      r.write(big);
    });
    const streamed = await fake((_q, r) => {
      for (let i = 0; i < 80; i++) r.write(big);
      r.end();
    });
    const client = new IntegrationHttp();
    expect(await failure(client.request({ base: declared.url, path: '/' }))).toBe(
      'Antwort zu groß',
    );
    expect(await failure(client.request({ base: streamed.url, path: '/' }))).toBe(
      'Antwort zu groß',
    );
  });

  it('hard timeout', async () => {
    const f = await fake(() => {
      // Never answers.
    });
    const client = new IntegrationHttp({ timeoutMs: 200 });
    const started = Date.now();
    expect(await failure(client.request({ base: f.url, path: '/' }))).toBe('Zeitüberschreitung');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('unreachable host', async () => {
    const f = await fake((_q, r) => r.end());
    const port = f.port;
    await f.stop();
    expect(
      await failure(new IntegrationHttp().request({ base: `http://127.0.0.1:${port}`, path: '/' })),
    ).toBe('Nicht erreichbar');
  });

  let hasOpenssl = true;
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
  } catch {
    hasOpenssl = false;
  }
  it.skipIf(!hasOpenssl)(
    'self-signed: TLS error without CA, works with the pasted certificate',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hz-int-tls-'));
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
          join(dir, 'k.pem'),
          '-out',
          join(dir, 'c.pem'),
          '-days',
          '3',
          '-subj',
          '/CN=127.0.0.1',
          '-addext',
          'subjectAltName=IP:127.0.0.1',
        ],
        { stdio: 'ignore' },
      );
      const cert = readFileSync(join(dir, 'c.pem'), 'utf8');
      const server = https.createServer({ key: readFileSync(join(dir, 'k.pem')), cert }, (_q, r) =>
        r.end('pve'),
      );
      tls.push(server);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const client = new IntegrationHttp();
      expect(await failure(client.request({ base, path: '/' }))).toBe(
        'TLS-Fehler (Zertifikat prüfen)',
      );
      const res = await client.request({ base, path: '/', ca: cert });
      expect(res.body).toBe('pve');
      const bogus = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';
      expect(await failure(client.request({ base, path: '/', ca: bogus }))).toBe(
        'TLS-Fehler (Zertifikat prüfen)',
      );
    },
  );
});
