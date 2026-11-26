import {
  defaultSpeedtestSettings,
  type Certificate,
  type DnsRecord,
  type DomainsResponse,
  type SpeedtestResponse,
} from '@hz/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { beforeAll, describe, expect, it } from 'vitest';
import { setDisplayTimeZone } from '../../lib/format.js';
import { server } from '../../test-fixtures.js';
import { CertForm, CertRow } from './CertTiles.js';
import { ProviderForm, ProviderRow, RecordForm, RecordRow } from './DnsTiles.js';
import {
  SpeedtestSettingsTile,
  SpeedtestSummaryTile,
  SpeedtestTableTile,
} from './SpeedtestTiles.js';

const NOW = new Date('2026-11-26T20:00:00.000Z');
const DAY = 86_400_000;
const noop = (): void => undefined;

function html(el: ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{el}</MemoryRouter>
    </QueryClientProvider>,
  ).replace(/<!-- -->/g, '');
}

beforeAll(() => setDisplayTimeZone('Europe/Vienna'));

const home = server({ id: 'srv-home0001', name: 'heimserver', publicIp: '203.0.113.7' });

const speed: SpeedtestResponse = {
  settings: { ...defaultSpeedtestSettings, serverId: home.id, minDownMbps: 50 },
  results: [
    {
      id: 1,
      at: NOW.getTime() - 6 * 3_600_000,
      serverId: home.id,
      trigger: 'schedule',
      ok: true,
      downloadMbps: 93.4,
      uploadMbps: 38.1,
      latencyMs: 12.4,
      jitterMs: 1.8,
      bytes: 180 * 1024 * 1024,
      colo: 'VIE',
      error: null,
    },
    {
      id: 2,
      at: NOW.getTime() - 3_600_000,
      serverId: home.id,
      trigger: 'manual',
      ok: true,
      downloadMbps: 12.3,
      uploadMbps: 30,
      latencyMs: 40,
      jitterMs: 9,
      bytes: 100 * 1024 * 1024,
      colo: 'VIE',
      error: null,
    },
    {
      id: 3,
      at: NOW.getTime() - 60_000,
      serverId: home.id,
      trigger: 'schedule',
      ok: false,
      downloadMbps: null,
      uploadMbps: null,
      latencyMs: null,
      jitterMs: null,
      bytes: 0,
      colo: null,
      error: 'Zeitüberschreitung',
    },
  ],
  summary: {
    count: 3,
    avgDownMbps: 52.85,
    avgUpMbps: 34.05,
    avgLatencyMs: 26.2,
    minDownMbps: 12.3,
    maxDownMbps: 93.4,
    slowShare: 0.5,
  },
  running: false,
  nextRunAt: NOW.getTime() + 5 * 3_600_000,
};

describe('speedtest', () => {
  it('summary: averages, history bars, Jetzt messen as main action', () => {
    const out = html(<SpeedtestSummaryTile data={speed} days={7} onDays={noop} now={NOW} />);
    expect(out).toContain('Ø Download');
    expect(out).toContain('52,9');
    expect(out).toContain('Mbit/s');
    expect(out).toContain('Ø Ping');
    expect(out).toContain('class="hz-spark hz-spark-info"');
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain('hz-btn-primary');
    expect(out).toContain('Jetzt messen');
    expect(out).toContain('nächste Messung 27.11. 02:00');
    expect(out).toContain('50 % der Messungen unter der Schwelle.');
  });

  it('settings show the traffic per test', () => {
    const out = html(<SpeedtestSettingsTile data={speed} servers={[home]} />);
    expect(out).toContain('Verbraucht Datenvolumen.');
    expect(out).toContain('bis zu 200 MB pro Messung · alle 6 Std bis zu 23,4 GB im Monat');
    expect(out).toContain('value="50"');
  });

  it('table: newest first, slow and failed with shape and text', () => {
    const out = html(<SpeedtestTableTile data={speed} now={NOW} />);
    const rows = out.split('data-testid="speedtest-row"').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('hz-status-crit');
    expect(rows[0]).toContain('FAIL');
    expect(rows[0]).toContain('Zeitüberschreitung');
    expect(rows[1]).toContain('hz-status-warn');
    expect(rows[1]).toContain('12,3 Mbit/s');
    expect(rows[2]).toContain('93,4 Mbit/s');
    expect(rows[2]).toContain('38,1 Mbit/s');
    expect(rows[2]).toContain('12 ms');
    expect(rows[2]).toContain('180 MB');
  });
});

const record = (over: Partial<DnsRecord> = {}): DnsRecord => ({
  id: 'rec-0000001',
  providerId: 'prov-000001',
  name: 'home.example.com',
  type: 'A',
  target: { kind: 'server', serverId: home.id },
  ttl: 300,
  proxied: false,
  owner: 'admin',
  value: '203.0.113.7',
  status: 'ok',
  lastSyncAt: NOW.getTime() - 60_000,
  lastError: null,
  ...over,
});

const cert = (over: Partial<Certificate> = {}): Certificate => ({
  id: 'cert-0000001',
  providerId: 'prov-000001',
  names: ['example.com', '*.example.com'],
  ca: 'letsencrypt-staging',
  status: 'valid',
  issuedAt: NOW.getTime() - 60 * DAY,
  notAfter: NOW.getTime() + 10 * DAY + 1000,
  autoRenew: true,
  deploy: [{ serverId: home.id, name: 'example-com', deployedAt: 1, lastError: null }],
  lastError: null,
  nextAttemptAt: null,
  ...over,
});

const domains: DomainsResponse = {
  settings: { acmeEmail: null },
  providers: [
    {
      id: 'prov-000001',
      kind: 'cloudflare',
      label: 'Cloudflare privat',
      tokenHint: 'x9Q2',
      zones: ['example.com'],
      createdAt: 1,
      lastOkAt: NOW.getTime() - 60_000,
      lastError: null,
    },
  ],
  records: [record()],
  certificates: [cert()],
};

describe('domains', () => {
  it('provider shows only the token hint', () => {
    const p = domains.providers[0];
    if (!p) throw new Error('fixture');
    const out = html(<ProviderRow p={p} now={NOW} />);
    expect(out).toContain('Cloudflare · Token …x9Q2 · example.com');
    expect(out).toContain('OK 20:59');
    expect(out).toContain('aria-label="Cloudflare privat testen"');
  });

  it('the token field is a password field and creating needs a code', () => {
    const out = html(<ProviderForm onClose={noop} />);
    expect(out).toMatch(/<input type="password"[^>]*autoComplete="off"/);
    expect(out).toContain('Mit Code anlegen');
    expect(out).toContain('Wird nie wieder angezeigt.');
  });

  it('record row: target, status, sync; relay records are read only', () => {
    const out = html(
      <RecordRow r={record()} data={domains} servers={[home]} now={NOW} onEdit={noop} />,
    );
    expect(out).toContain('A → öffentliche IP von heimserver · TTL 5 Min · Cloudflare privat');
    expect(out).toContain('aktuell · 203.0.113.7 · 20:59');
    expect(out).toContain('aria-label="home.example.com jetzt abgleichen"');
    const relay = html(
      <RecordRow
        r={record({ owner: 'relay', name: 'mc.example.com' })}
        data={domains}
        servers={[home]}
        now={NOW}
        onEdit={noop}
      />,
    );
    expect(relay).toContain('vom Game-Relay verwaltet');
    expect(relay).not.toContain('hz-row-actions');
    const bad = html(
      <RecordRow
        r={record({ status: 'error', lastError: 'Cloudflare: 403' })}
        data={domains}
        servers={[home]}
        now={NOW}
        onEdit={noop}
      />,
    );
    expect(bad).toContain('hz-status-crit');
    expect(bad).toContain('Cloudflare: 403');
  });

  it('record form offers server IP or a fixed value and the proxy only for Cloudflare', () => {
    const out = html(<RecordForm data={domains} servers={[home]} onClose={noop} />);
    expect(out).toContain('Öffentliche IP eines Servers');
    expect(out).toContain('heimserver · 203.0.113.7');
    expect(out).toContain('Cloudflare-Proxy');
    expect(out).toContain('Zonen: example.com');
  });

  it('certificate row: CA, deployment, expiry with warn shape, renew', () => {
    const out = html(
      <CertRow c={cert()} data={domains} servers={[home]} now={NOW} onDeploy={noop} />,
    );
    expect(out).toContain('example.com, *.example.com');
    expect(out).toContain(
      'Let’s Encrypt Staging (zum Testen) · Cloudflare privat · auf heimserver',
    );
    expect(out).toContain('läuft ab am 06.12.2026 21:00 · in 10 Tagen');
    expect(out).toContain('hz-status-warn');
    expect(out).toContain('aria-label="example.com jetzt erneuern"');
  });

  it('certificate form explains staging and the folder per server', () => {
    const out = html(<CertForm data={domains} servers={[home]} onClose={noop} />);
    expect(out).toContain('Erst mit Staging testen');
    expect(out).toContain('Verteilen auf');
    expect(out).toContain('aria-label="heimserver"');
    expect(out).toContain('Mit Code anlegen');
  });
});
