import { afterEach, describe, expect, it } from 'vitest';
import {
  checkListResponseSchema,
  kumaImportResponseSchema,
  kumaMonitorsResponseSchema,
} from '@hz/shared';
import { auditLog } from '../src/db/schema.js';
import { parseKumaMetrics, parsePrometheus } from '../src/integrations/uptimekuma.js';
import {
  FakeServer,
  SENTINEL,
  withIntegrations,
  type IntegrationSetup,
} from './integrations-helpers.js';

let s: IntegrationSetup | undefined;
const fakes: FakeServer[] = [];
afterEach(async () => {
  await s?.t.app.close();
  s = undefined;
  for (const f of fakes.splice(0)) await f.stop();
});

const L = (name: string, type: string, url: string, host: string, port: string) =>
  `monitor_name="${name}",monitor_type="${type}",monitor_url="${url}",monitor_hostname="${host}",monitor_port="${port}"`;

const METRICS = [
  '# HELP monitor_status Monitor Status (1 = UP, 0= DOWN, 2= PENDING, 3= MAINTENANCE)',
  '# TYPE monitor_status gauge',
  `monitor_status{${L('Shop', 'http', 'https://shop.example.at/', 'null', 'null')}} 1`,
  `monitor_status{${L('Say \\"hi\\" \\\\ back', 'keyword', 'https://example.org/k', 'null', 'null')}} 0`,
  `monitor_status{${L('SSH', 'port', 'https://', 'pi.lan', '22')}} 2`,
  `monitor_status{${L('Router', 'ping', 'https://', '192.168.1.1', 'null')}} 3`,
  `monitor_status{${L('Docker', 'docker', 'https://', 'null', 'null')}} 1`,
  `monitor_status{${L('Bad URL', 'http', 'not a url', 'null', 'null')}} 1`,
  `monitor_response_time{${L('Shop', 'http', 'https://shop.example.at/', 'null', 'null')}} 123`,
  `monitor_cert_days_remaining{${L('Shop', 'http', 'https://shop.example.at/', 'null', 'null')}} 42`,
  'garbage line {',
  '',
].join('\n');

function fakeKuma(): FakeServer {
  const f = new FakeServer();
  fakes.push(f);
  const expected = `Basic ${Buffer.from(`:${SENTINEL}`).toString('base64')}`;
  f.handler = (q, r) => {
    if (q.url !== '/metrics') {
      r.statusCode = 404;
      r.end();
      return;
    }
    if (q.headers.authorization !== expected) {
      r.statusCode = 401;
      r.end('Unauthorized');
      return;
    }
    r.setHeader('content-type', 'text/plain; version=0.0.4');
    r.end(METRICS);
  };
  return f;
}

describe('prometheus parsing', () => {
  it('handles escaped quotes and backslashes in label values', () => {
    const p = parsePrometheus(
      'a{x="q\\"u\\\\o\\nte",y="2"} 3.5 1700000000\nb 1\n',
      new Set(['a', 'b']),
    );
    expect(p).toEqual([
      { name: 'a', labels: { x: 'q"u\\o\nte', y: '2' }, value: 3.5 },
      { name: 'b', labels: {}, value: 1 },
    ]);
    expect(parsePrometheus('a{x="unterminated} 1', new Set(['a']))).toEqual([]);
  });

  it('maps Kuma monitors', () => {
    const m = parseKumaMetrics(METRICS);
    expect(m.map((x) => [x.name, x.status, x.importAs])).toEqual([
      ['Shop', 'up', 'http'],
      ['Say "hi" \\ back', 'down', 'http'],
      ['SSH', 'pending', 'tcp'],
      ['Router', 'maintenance', 'ping'],
      ['Docker', 'up', null],
      ['Bad URL', 'up', 'http'],
    ]);
    expect(m[0]).toMatchObject({
      responseMs: 123,
      certDaysRemaining: 42,
      hostname: null,
      port: null,
    });
    expect(m[2]).toMatchObject({ hostname: 'pi.lan', port: 22 });
  });
});

describe('Uptime Kuma', () => {
  it('lists monitors with the API key and imports them as checks', async () => {
    const kuma = await fakeKuma().start();
    s = await withIntegrations();
    const put = await s.configure('uptimekuma', { url: kuma.url, secret: SENTINEL });
    expect(put.json()).toMatchObject({ status: 'ok' });
    const list = kumaMonitorsResponseSchema.parse(
      (await s.req('GET', '/api/uptimekuma/monitors')).json(),
    );
    expect(list.monitors).toHaveLength(6);
    expect(list.monitors.every((m) => m.checkId === null)).toBe(true);

    s.expireStepUp();
    const res = await s.req('POST', '/api/uptimekuma/import', {
      names: ['Shop', 'Say "hi" \\ back', 'SSH', 'Router', 'Docker', 'Bad URL', 'Missing'],
    });
    expect(res.statusCode).toBe(200);
    const r = kumaImportResponseSchema.parse(res.json());
    expect(r.created).toBe(3);
    expect(r.skipped).toEqual([
      { name: 'Router', reason: 'Ping braucht einen Server mit Agent' },
      { name: 'Docker', reason: 'Typ nicht unterstützt' },
      { name: 'Bad URL', reason: 'Adresse ungültig' },
      { name: 'Missing', reason: 'Monitor nicht gefunden' },
    ]);
    const checks = checkListResponseSchema.parse((await s.req('GET', '/api/checks')).json()).checks;
    expect(checks.map((c) => [c.def.kind, c.def.name]).sort()).toEqual([
      ['http', 'Say "hi" \\ back'],
      ['http', 'Shop'],
      ['tcp', 'SSH'],
    ]);
    const shop = checks.find((c) => c.def.name === 'Shop');
    expect(shop?.def).toMatchObject({
      kind: 'http',
      url: 'https://shop.example.at/',
      runFrom: 'core',
    });

    const again = kumaMonitorsResponseSchema.parse(
      (await s.req('GET', '/api/uptimekuma/monitors')).json(),
    );
    expect(again.monitors.find((m) => m.name === 'Shop')?.checkId).toBe(shop?.id);
    const second = kumaImportResponseSchema.parse(
      (await s.req('POST', '/api/uptimekuma/import', { names: ['Shop'] })).json(),
    );
    expect(second).toEqual({ created: 0, skipped: [{ name: 'Shop', reason: 'Schon übernommen' }] });

    // A deleted check can be imported again.
    expect((await s.req('DELETE', `/api/checks/${shop?.id ?? ''}`)).statusCode).toBe(200);
    const third = kumaImportResponseSchema.parse(
      (await s.req('POST', '/api/uptimekuma/import', { names: ['Shop'] })).json(),
    );
    expect(third.created).toBe(1);

    const audits = s.t.db.db.select().from(auditLog).all();
    expect(audits.filter((a) => a.action === 'uptimekuma.import')).toHaveLength(3);
    expect(audits.filter((a) => a.action === 'check.created')).toHaveLength(4);
  });

  it('ping monitors need an existing server', async () => {
    const kuma = await fakeKuma().start();
    s = await withIntegrations();
    await s.configure('uptimekuma', { url: kuma.url, secret: SENTINEL });
    const r = kumaImportResponseSchema.parse(
      (
        await s.req('POST', '/api/uptimekuma/import', {
          names: ['Router'],
          pingFrom: 'AAAAAAAAAAAAAAAA',
        })
      ).json(),
    );
    expect(r).toEqual({ created: 0, skipped: [{ name: 'Router', reason: 'Server unbekannt' }] });
  });

  it('invalid import requests are refused', async () => {
    const kuma = await fakeKuma().start();
    s = await withIntegrations();
    await s.configure('uptimekuma', { url: kuma.url, secret: SENTINEL });
    for (const body of [
      {},
      { names: [] },
      { names: [''] },
      { names: ['x'], pingFrom: '../x' },
      { names: ['x'], extra: 1 },
    ]) {
      expect(
        (await s.req('POST', '/api/uptimekuma/import', body)).statusCode,
        JSON.stringify(body),
      ).toBe(400);
    }
  });

  it('wrong API key: error, import 502 with fixed text', async () => {
    const kuma = await fakeKuma().start();
    s = await withIntegrations();
    const put = await s.configure('uptimekuma', { url: kuma.url, secret: 'wrong-api-key-value' });
    expect(put.json()).toMatchObject({ status: 'error', error: 'Zugangsdaten ungültig' });
    const res = await s.req('POST', '/api/uptimekuma/import', { names: ['Shop'] });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ message: 'Uptime Kuma: Zugangsdaten ungültig' });
    expect(res.body).not.toContain('Unauthorized');
  });
});
