import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.js';
import { gameRelay, ingress } from '../test-fixtures.js';
import {
  dnsOkText,
  dnsStatus,
  fetchGameRelay,
  fetchIngresses,
  gameRelayErrorText,
  ingressDirty,
  ingressDraft,
  ingressErrorText,
  ingressStatus,
  ingressSummary,
  parseDnsDraft,
  parseDnsName,
  parseIngressDraft,
  relayChoices,
  relayStatus,
  relayVia,
  saveDnsSettings,
  saveGameRelay,
  saveIngress,
} from './relay.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

const dns = {
  provider: 'cloudflare' as const,
  tokenSet: true,
  zoneId: '0123456789abcdef0123456789abcdef',
  lastError: null,
  lastUpdateAt: null,
};

describe('relay api', () => {
  it('uses the M15 routes and methods', async () => {
    const fn = vi.fn<typeof fetch>();
    fn.mockResolvedValueOnce(json(200, { ingresses: [ingress()] }));
    fn.mockResolvedValueOnce(json(200, { ingress: ingress() }));
    fn.mockResolvedValueOnce(json(200, { relay: gameRelay() }));
    fn.mockResolvedValueOnce(json(200, { relay: null }));
    fn.mockResolvedValueOnce(json(200, dns));
    vi.stubGlobal('fetch', fn);
    await expect(fetchIngresses()).resolves.toHaveLength(1);
    await saveIngress('srv-oracle1', {
      enabled: true,
      publicIp: null,
      portFrom: 25565,
      portTo: 25600,
    });
    await expect(fetchGameRelay('game-000001')).resolves.toMatchObject({ state: 'ok' });
    await expect(saveGameRelay('game-000001', { ingressServerId: null })).resolves.toBeNull();
    await saveDnsSettings({ provider: 'cloudflare', zoneId: dns.zoneId });
    expect(fn.mock.calls.map((c) => [c[0], c[1]?.method ?? 'GET'])).toEqual([
      ['/api/relay/ingresses', 'GET'],
      ['/api/servers/srv-oracle1/ingress', 'PUT'],
      ['/api/games/game-000001/relay', 'GET'],
      ['/api/games/game-000001/relay', 'PUT'],
      ['/api/settings/dns', 'PUT'],
    ]);
    // no token in the body when the field stays empty
    expect(JSON.parse(String(fn.mock.calls[4]?.[1]?.body))).toEqual({
      provider: 'cloudflare',
      zoneId: dns.zoneId,
    });
  });
});

describe('ingress', () => {
  it('status always has a text', () => {
    expect(ingressStatus(ingress({ enabled: false }))).toEqual({ status: 'off', label: 'Aus' });
    expect(ingressStatus(ingress({ connected: false }))).toEqual({
      status: 'crit',
      label: 'Getrennt',
    });
    expect(ingressStatus(ingress({ capable: false }))).toEqual({
      status: 'warn',
      label: 'Relay nicht erlaubt',
    });
    expect(ingressStatus(ingress())).toEqual({ status: 'ok', label: 'Bereit' });
  });

  it('summary for the tile head', () => {
    expect(ingressSummary([ingress({ enabled: false })]).label).toBe('KEINER');
    expect(ingressSummary([ingress(), ingress({ capable: false })]).label).toBe('1 PRÜFEN');
    expect(ingressSummary([ingress(), ingress({ enabled: false })]).label).toBe('1 BEREIT');
  });

  it('draft: empty IPv4 means inventory, defaults for a fresh server', () => {
    const fresh = ingress({ enabled: false, publicIp: null, portFrom: 0, portTo: 0 });
    const d = ingressDraft(fresh);
    expect(d).toEqual({ enabled: false, publicIp: '', portFrom: '25565', portTo: '25600' });
    expect(ingressDirty(fresh, d)).toBe(false);
    expect(ingressDirty(fresh, { ...d, enabled: true })).toBe(true);
    expect(parseIngressDraft({ ...d, enabled: true })).toEqual({
      ok: true,
      body: { enabled: true, publicIp: null, portFrom: 25565, portTo: 25600 },
    });
  });

  it('draft errors in German per field', () => {
    const base = { enabled: true, publicIp: '', portFrom: '25565', portTo: '25600' };
    const priv = parseIngressDraft({ ...base, publicIp: '192.168.1.5' });
    expect(priv.ok ? null : priv.errors.publicIp).toMatch(/Keine öffentliche IPv4/);
    const tailnet = parseIngressDraft({ ...base, publicIp: '100.64.1.2' });
    expect(tailnet.ok).toBe(false);
    const low = parseIngressDraft({ ...base, portFrom: '80' });
    expect(low.ok ? null : low.errors.portFrom).toBe('Port 1024 bis 65535.');
    const reversed = parseIngressDraft({ ...base, portFrom: '26000' });
    expect(reversed.ok ? null : reversed.errors.portTo).toMatch(/größer oder gleich/);
    const wide = parseIngressDraft({ ...base, portFrom: '20000', portTo: '25001' });
    expect(wide.ok ? null : wide.errors.portTo).toBe('Höchstens 5000 Ports.');
    expect(parseIngressDraft({ ...base, publicIp: ' 203.0.113.7 ' })).toMatchObject({
      ok: true,
      body: { publicIp: '203.0.113.7' },
    });
  });

  it('409 when disabling with games, hint from the core wins, step-up stays silent', () => {
    expect(ingressErrorText(new ApiError(409, 'conflict'))).toMatch(/laufen noch Spiele/);
    expect(ingressErrorText(new ApiError(409, 'conflict', undefined, 'Erst umstellen.'))).toBe(
      'Erst umstellen.',
    );
    expect(ingressErrorText(new ApiError(403, 'step_up_required'))).toBeNull();
    expect(gameRelayErrorText(new ApiError(409, 'conflict'))).toMatch(/schon belegt/);
  });
});

describe('relay per game', () => {
  it('choices: enabled, capable, not the own server, sorted', () => {
    const list = [
      ingress({ serverId: 'srv-zzzzzzzz', serverName: 'vps-b' }),
      ingress({ serverId: 'srv-aaaaaaaa', serverName: 'heimserver' }),
      ingress({ serverId: 'srv-bbbbbbbb', serverName: 'aus', enabled: false }),
      ingress({ serverId: 'srv-cccccccc', serverName: 'pi', capable: false }),
      ingress({ serverId: 'srv-oracle1', serverName: 'oracle-a1' }),
    ];
    expect(relayChoices(list, { serverId: 'srv-aaaaaaaa' }).map((i) => i.serverName)).toEqual([
      'oracle-a1',
      'vps-b',
    ]);
  });

  it('state and DNS texts', () => {
    expect(relayStatus(gameRelay())).toEqual({ status: 'ok', label: 'Weiterleitung aktiv' });
    expect(relayStatus(gameRelay({ state: 'pending' })).label).toBe('Wartet auf den Eingang');
    expect(relayStatus(gameRelay({ state: 'error' })).status).toBe('crit');
    expect(dnsOkText(gameRelay())).toBe('zeigt auf den Eingang');
    expect(dnsOkText(gameRelay({ dnsOk: false }))).toBe('zeigt noch nicht auf den Eingang');
    expect(dnsOkText(gameRelay({ dnsOk: null }))).toBe('kein DNS-Anbieter eingerichtet');
    expect(dnsOkText(gameRelay({ dnsName: null, dnsOk: null }))).toBe('kein Name');
    expect(relayVia(gameRelay())).toBe('über oracle-a1');
  });

  it('DNS name: optional, lower case, DuckDNS only <name>.duckdns.org', () => {
    expect(parseDnsName('  ', 'cloudflare')).toEqual({ ok: true, name: null });
    expect(parseDnsName('MC.Example.org', 'cloudflare')).toEqual({
      ok: true,
      name: 'mc.example.org',
    });
    expect(parseDnsName('*.example.org', 'cloudflare').ok).toBe(false);
    expect(parseDnsName('mc.example.org', 'duckdns').ok).toBe(false);
    expect(parseDnsName('meinspiel.duckdns.org', 'duckdns').ok).toBe(true);
  });
});

describe('DNS settings', () => {
  it('keeps a stored token, needs one for a new provider, checks the zone id', () => {
    expect(parseDnsDraft({ provider: 'none', token: '', zoneId: 'x' }, dns)).toEqual({
      ok: true,
      body: { provider: 'none', zoneId: null },
    });
    expect(
      parseDnsDraft({ provider: 'cloudflare', token: '', zoneId: dns.zoneId.toUpperCase() }, dns),
    ).toEqual({ ok: true, body: { provider: 'cloudflare', zoneId: dns.zoneId } });
    const switched = parseDnsDraft({ provider: 'duckdns', token: '', zoneId: '' }, dns);
    expect(switched.ok ? null : switched.errors.token).toBe('Token fehlt.');
    const bad = parseDnsDraft({ provider: 'cloudflare', token: 'kurz', zoneId: '123' }, dns);
    expect(bad.ok ? null : Object.keys(bad.errors).sort()).toEqual(['token', 'zoneId']);
    const token = 'a'.repeat(40);
    expect(parseDnsDraft({ provider: 'duckdns', token, zoneId: '' }, dns)).toEqual({
      ok: true,
      body: { provider: 'duckdns', zoneId: null, token },
    });
  });

  it('status of the tile head', () => {
    expect(dnsStatus({ ...dns, provider: 'none' }).label).toBe('AUS');
    expect(dnsStatus({ ...dns, tokenSet: false }).label).toBe('KEIN TOKEN');
    expect(dnsStatus({ ...dns, lastError: 'HTTP 403' }).status).toBe('crit');
    expect(dnsStatus(dns).label).toBe('CLOUDFLARE');
  });
});
