import {
  defaultSelfhealSettings,
  defaultSpeedtestSettings,
  type Certificate,
  type DomainsResponse,
  type SpeedtestResponse,
  type SpeedtestResult,
} from '@hz/shared';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { configureApi } from './api.js';
import {
  certStatus,
  createProvider,
  defaultCertName,
  deployAddsTarget,
  domainsSentence,
  expiryText,
  parseNames,
  targetText,
  ttlText,
  updateCertificate,
  zoneOf,
} from './domains.js';
import { setDisplayTimeZone } from './format.js';
import {
  attemptsText,
  draftToSettings,
  eventText,
  selfhealSentence,
  settingsToDraft,
  sortStates,
} from './selfheal.js';
import {
  downloadBars,
  formatMbps,
  formatMs,
  isSlow,
  mbpsParts,
  parseThreshold,
  speedtestSentence,
  trafficText,
} from './speedtest.js';

const NOW = new Date('2026-11-26T20:00:00.000Z');
const DAY = 86_400_000;

beforeAll(() => setDisplayTimeZone('Europe/Vienna'));
afterEach(() => vi.unstubAllGlobals());

describe('speedtest', () => {
  it('formats Mbit/s in the Austrian way', () => {
    expect(formatMbps(93.4)).toBe('93,4 Mbit/s');
    expect(formatMbps(12.34)).toBe('12,3 Mbit/s');
    expect(formatMbps(312.6)).toBe('313 Mbit/s');
    expect(formatMbps(1250)).toBe('1,25 Gbit/s');
    expect(formatMbps(null)).toBe('—');
    expect(mbpsParts(93.4)).toEqual({ value: '93,4', unit: 'Mbit/s' });
    expect(formatMs(4.24)).toBe('4,2 ms');
    expect(formatMs(18.7)).toBe('19 ms');
  });

  it('shows the traffic a test costs', () => {
    expect(trafficText({ maxMb: 100, intervalHours: 6 })).toBe(
      'bis zu 200 MB pro Messung · alle 6 Std bis zu 23,4 GB im Monat',
    );
    expect(trafficText({ maxMb: 10, intervalHours: 1 })).toBe(
      'bis zu 20 MB pro Messung · jede Stunde bis zu 14,1 GB im Monat',
    );
  });

  const result = (i: number, over: Partial<SpeedtestResult> = {}): SpeedtestResult => ({
    id: i,
    at: NOW.getTime() - (10 - i) * 3_600_000,
    serverId: 'srv-home0001',
    trigger: 'schedule',
    ok: true,
    downloadMbps: 90 + i,
    uploadMbps: 30,
    latencyMs: 12,
    jitterMs: 1.2,
    bytes: 150 * 1024 * 1024,
    colo: 'VIE',
    error: null,
    ...over,
  });

  it('builds at most N bars, failed results left out', () => {
    const list = [result(1), result(2, { ok: false, downloadMbps: null }), result(3)];
    expect(downloadBars(list)).toEqual([91, 93]);
    const many = Array.from({ length: 120 }, (_, i) => result(i, { downloadMbps: i }));
    const bars = downloadBars(many, (r) => r.downloadMbps, 60);
    expect(bars).toHaveLength(60);
    expect(bars[0]).toBe(0.5);
  });

  it('puts a slow or failed last result into the sentence', () => {
    const base: SpeedtestResponse = {
      settings: { ...defaultSpeedtestSettings, serverId: 'srv-home0001', minDownMbps: 50 },
      results: [result(1)],
      summary: {
        count: 1,
        avgDownMbps: 91,
        avgUpMbps: 30,
        avgLatencyMs: 12,
        minDownMbps: 91,
        maxDownMbps: 91,
        slowShare: 0,
      },
      running: false,
      nextRunAt: null,
    };
    expect(speedtestSentence(base)).toEqual({
      em: null,
      rest: '91 Mbit/s Download, 30 Mbit/s Upload.',
    });
    const slow = result(2, { downloadMbps: 12.3 });
    expect(isSlow(slow, base.settings)).toBe(true);
    expect(speedtestSentence({ ...base, results: [slow] }).em).toBe(
      'Internet langsam: 12,3 Mbit/s statt 50',
    );
    const failed = result(3, { ok: false, downloadMbps: null, error: 'Server offline' });
    expect(speedtestSentence({ ...base, results: [failed] })).toEqual({
      em: 'Letzte Messung fehlgeschlagen',
      rest: ' · Server offline',
    });
    expect(
      speedtestSentence({ ...base, settings: { ...base.settings, serverId: null } }).rest,
    ).toBe('Speedtest: kein Server gewählt.');
  });

  it('parses thresholds with a decimal comma', () => {
    expect(parseThreshold('')).toEqual({ ok: true, value: null });
    expect(parseThreshold('47,5')).toEqual({ ok: true, value: 47.5 });
    expect(parseThreshold('-1')).toEqual({ ok: false });
    expect(parseThreshold('viel')).toEqual({ ok: false });
  });
});

describe('selfheal', () => {
  it('texts for attempts and events', () => {
    expect(attemptsText(2, defaultSelfhealSettings)).toBe('2 von 3 Neustarts in 30 Min');
    expect(
      eventText({
        id: 1,
        at: 0,
        serverId: 's',
        serverName: 'heimserver',
        container: 'nextcloud',
        reason: 'unhealthy',
        action: 'restart',
        attempt: 2,
      }),
    ).toBe('neu gestartet (unhealthy) · Versuch 2');
    expect(
      eventText({
        id: 2,
        at: 0,
        serverId: 's',
        serverName: 'heimserver',
        container: 'nextcloud',
        reason: 'check_down',
        action: 'gave_up',
        attempt: 3,
      }),
    ).toBe('aufgegeben (Website DOWN)');
  });

  it('puts aufgegeben first and into the sentence', () => {
    const s = (container: string, phase: 'watching' | 'restarting' | 'gave_up') => ({
      serverId: 'srv-home0001',
      serverName: 'heimserver',
      container,
      phase,
      attempts: 1,
      lastReason: 'unhealthy' as const,
      lastRestartAt: null,
    });
    const state = [s('a', 'watching'), s('b', 'gave_up'), s('c', 'restarting')];
    expect(sortStates(state).map((x) => x.container)).toEqual(['b', 'c', 'a']);
    expect(selfhealSentence({ state })).toEqual({
      em: 'b auf heimserver aufgegeben',
      rest: '',
    });
    expect(selfhealSentence({ state: [] }).rest).toBe('Selbstheilung wacht.');
  });

  it('validates the settings form', () => {
    const d = settingsToDraft(defaultSelfhealSettings);
    expect(draftToSettings(d)).toEqual({ ok: true, settings: defaultSelfhealSettings });
    const bad = draftToSettings({ ...d, maxRestarts: '11', windowMinutes: '' });
    expect(bad).toEqual({
      ok: false,
      errors: { maxRestarts: '1 bis 10', windowMinutes: '10 bis 1440' },
    });
  });
});

describe('domains', () => {
  const cert = (over: Partial<Certificate> = {}): Certificate => ({
    id: 'cert-0000001',
    providerId: 'prov-000001',
    names: ['example.com', '*.example.com'],
    ca: 'letsencrypt',
    status: 'valid',
    issuedAt: NOW.getTime() - 60 * DAY,
    notAfter: NOW.getTime() + 30 * DAY,
    autoRenew: true,
    deploy: [],
    lastError: null,
    nextAttemptAt: null,
    ...over,
  });

  it('formats the expiry date', () => {
    expect(expiryText(new Date('2027-02-24T03:00:00Z').getTime(), NOW)).toBe(
      'läuft ab am 24.02.2027 04:00 · in 89 Tagen',
    );
    expect(expiryText(NOW.getTime() + DAY + 1000, NOW)).toBe(
      'läuft ab am 27.11.2026 21:00 · in 1 Tag',
    );
    expect(expiryText(NOW.getTime() - 3 * DAY, NOW)).toBe('abgelaufen am 23.11.2026 21:00');
    expect(expiryText(null, NOW)).toBe('noch nicht ausgestellt');
  });

  it('turns close expiry into warn and crit', () => {
    expect(certStatus(cert(), NOW)).toBe('ok');
    expect(certStatus(cert({ notAfter: NOW.getTime() + 10 * DAY }), NOW)).toBe('warn');
    expect(certStatus(cert({ notAfter: NOW.getTime() + 2 * DAY }), NOW)).toBe('crit');
    expect(certStatus(cert({ status: 'pending', notAfter: null }), NOW)).toBe('busy');
    expect(certStatus(cert({ status: 'error' }), NOW)).toBe('crit');
  });

  it('names, zones, targets', () => {
    expect(parseNames('Example.com, *.example.com example.com. bad_name')).toEqual({
      names: ['example.com', '*.example.com'],
      bad: ['bad_name'],
    });
    expect(defaultCertName(['*.example.com'])).toBe('example-com');
    expect(zoneOf('home.example.com', { zones: ['example.com'] })).toBe('example.com');
    expect(zoneOf('home.example.org', { zones: ['example.com'] })).toBeUndefined();
    expect(
      targetText({ target: { kind: 'server', serverId: 'srv-1' } }, [
        { id: 'srv-1', name: 'heimserver' },
      ]),
    ).toBe('öffentliche IP von heimserver');
    expect(targetText({ target: { kind: 'static', value: '203.0.113.7' } }, [])).toBe(
      'fest 203.0.113.7',
    );
    expect(ttlText(300)).toBe('TTL 5 Min');
    expect(ttlText(3600)).toBe('TTL 1 Std');
    expect(ttlText(90)).toBe('TTL 90 s');
  });

  it('puts an expiring certificate into the sentence', () => {
    const d: DomainsResponse = {
      settings: { acmeEmail: null },
      providers: [],
      records: [],
      certificates: [cert({ notAfter: NOW.getTime() + 10 * DAY + 1000 })],
    };
    expect(domainsSentence(d, NOW)).toEqual({
      em: 'Zertifikat example.com läuft in 10 Tagen ab',
      rest: '',
    });
    expect(domainsSentence({ ...d, certificates: [cert()] }, NOW).rest).toBe(
      '0 Einträge und 1 Zertifikat aktuell.',
    );
  });

  it('creating a provider goes through step-up and the token is only sent', async () => {
    const onStepUp = vi.fn(() => Promise.resolve(true));
    const reset = configureApi({ onStepUp });
    const provider = {
      id: 'prov-000001',
      kind: 'duckdns',
      label: 'DuckDNS',
      tokenHint: 'cdef',
      zones: ['meinheim.duckdns.org'],
      createdAt: 1,
      lastOkAt: null,
      lastError: null,
    };
    const json = (status: number, body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(403, { ok: false, error: 'step_up_required' }))
      .mockResolvedValueOnce(json(201, provider));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const p = await createProvider({
        kind: 'duckdns',
        label: 'DuckDNS',
        token: ['0123456789abcdef', '0123456789abcdef'].join(''),
        subdomains: ['meinheim'],
      });
      expect(p.tokenHint).toBe('cdef');
      expect(JSON.stringify(p)).not.toContain('0123456789abcdef');
    } finally {
      reset();
    }
    expect(onStepUp).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a new deploy target needs a code: step-up, then the same PUT again', async () => {
    const SRV = 'srv-00000001';
    const deployed = cert({
      deploy: [{ serverId: SRV, name: 'example-com', deployedAt: 1, lastError: null }],
    });
    expect(deployAddsTarget(deployed, [{ serverId: SRV, name: 'example-com' }])).toBe(false);
    expect(deployAddsTarget(deployed, [])).toBe(false);
    expect(deployAddsTarget(deployed, [{ serverId: SRV, name: 'other' }])).toBe(true);
    expect(deployAddsTarget(cert(), [{ serverId: SRV, name: 'example-com' }])).toBe(true);

    const onStepUp = vi.fn(() => Promise.resolve(true));
    const reset = configureApi({ onStepUp });
    const json = (status: number, body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(403, { ok: false, error: 'step_up_required' }))
      .mockResolvedValueOnce(json(200, deployed));
    vi.stubGlobal('fetch', fetchMock);
    const body = { deploy: [{ serverId: SRV, name: 'example-com' }], autoRenew: true };
    try {
      await expect(updateCertificate(deployed.id, body)).resolves.toEqual(deployed);
    } finally {
      reset();
    }
    expect(onStepUp).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toBe(`/api/domains/certificates/${deployed.id}`);
      expect(init?.method).toBe('PUT');
      expect(JSON.parse(String(init?.body))).toEqual(body);
    }
  });
});
