import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { json, mockFetch, bodyOf, settings } from '../test-m14.js';
import { configureApi } from './api.js';
import { setDisplayTimeZone } from './format.js';
import {
  buildIntegrationPatch,
  integrationStatusText,
  integrationTileStatus,
  integrationToForm,
  isIntegrationConfigured,
  lastOkText,
  saveIntegrationSettings,
  secretLabel,
  usernameLabel,
} from './integrations.js';

const NOW = new Date('2026-11-26T22:08:00.000Z');
let reset: (() => void) | undefined;
beforeAll(() => setDisplayTimeZone('Europe/Vienna'));
afterEach(() => {
  reset?.();
  reset = undefined;
  vi.unstubAllGlobals();
});

describe('integration settings', () => {
  it('names the fields per integration', () => {
    expect(usernameLabel('proxmox', null)).toBe('API-Token-ID (benutzer@realm!name)');
    expect(usernameLabel('fritzbox', null)).toBe('Benutzer');
    expect(usernameLabel('dnsfilter', 'adguard')).toBe('Benutzer');
    expect(usernameLabel('dnsfilter', 'pihole')).toBeNull();
    expect(usernameLabel('uptimekuma', null)).toBeNull();
    expect(secretLabel('uptimekuma', null)).toBe('API-Key');
    expect(secretLabel('dnsfilter', 'pihole')).toBe('App-Passwort');
  });

  it('shows status first: OK, Fehler: text, nicht eingerichtet', () => {
    expect(integrationStatusText(settings())).toBe('OK');
    expect(integrationTileStatus(settings())).toBe('ok');
    const bad = settings({ status: 'error', error: 'Zeitüberschreitung' });
    expect(integrationStatusText(bad)).toBe('Fehler: Zeitüberschreitung');
    expect(integrationTileStatus(bad)).toBe('warn');
    const off = settings({ status: 'off', url: null, secretSet: false, lastOkAt: null });
    expect(integrationStatusText(off)).toBe('nicht eingerichtet');
    expect(lastOkText(off, NOW)).toBe('noch nie');
    expect(lastOkText(settings(), NOW)).toBe('23:04 · vor 4 Min');
  });

  it('treats URL + secret (+ user where needed) as set up, even before the first answer', () => {
    const fresh = settings({ status: 'off', lastOkAt: null });
    expect(isIntegrationConfigured('proxmox', fresh)).toBe(true);
    expect(integrationStatusText(fresh)).toBe('noch nicht geprüft');
    expect(isIntegrationConfigured('proxmox', settings({ username: null }))).toBe(false);
    expect(isIntegrationConfigured('fritzbox', settings({ username: null }))).toBe(true);
    expect(isIntegrationConfigured('uptimekuma', settings({ secretSet: false }))).toBe(false);
    expect(
      isIntegrationConfigured('dnsfilter', settings({ variant: 'adguard', username: null })),
    ).toBe(false);
  });

  it('FRITZ!Box: the user name is optional, Proxmox needs the token id', () => {
    const f = settings({ username: 'hz' });
    expect(
      buildIntegrationPatch('fritzbox', f, { ...integrationToForm(f), username: '' }).patch,
    ).toEqual({ username: null });
    const p = settings({ username: null });
    expect(buildIntegrationPatch('proxmox', p, integrationToForm(p)).errors.username).toBe(
      'API-Token-ID fehlt.',
    );
  });

  it('never prefills the secret and sends only changed fields', () => {
    const s = settings();
    const f = integrationToForm(s);
    expect(f.secret).toBe('');
    expect(buildIntegrationPatch('proxmox', s, f)).toEqual({ patch: {}, errors: {} });
    expect(buildIntegrationPatch('proxmox', s, { ...f, username: 'root@pam!hz' }).patch).toEqual({
      username: 'root@pam!hz',
    });
  });

  it('checks the Proxmox token id format', () => {
    const s = settings();
    const r = buildIntegrationPatch('proxmox', s, { ...integrationToForm(s), username: 'root' });
    expect(r.errors.username).toMatch(/benutzer@realm!tokenname/);
  });

  it('asks for the secret again when the URL origin changes', () => {
    const s = settings();
    const f = { ...integrationToForm(s), url: 'https://pve2.lan:8006' };
    expect(buildIntegrationPatch('proxmox', s, f).errors.secret).toBe(
      'Neue Adresse: Zugangsdaten neu eintragen.',
    );
    // Same origin, other path: the secret stays.
    const same = { ...integrationToForm(s), url: 'https://pve.lan:8006/' };
    expect(buildIntegrationPatch('proxmox', s, same).errors).toEqual({});
    const ok = buildIntegrationPatch('proxmox', s, { ...f, secret: 'abcd-1234' });
    expect(ok).toEqual({
      patch: { url: 'https://pve2.lan:8006', secret: 'abcd-1234' },
      errors: {},
    });
  });

  it('rejects link-local and URLs with user info', () => {
    const s = settings({ url: null, secretSet: false, status: 'off' });
    for (const url of ['http://169.254.169.254', 'https://a:b@pve.lan', 'ftp://pve.lan']) {
      const r = buildIntegrationPatch('proxmox', s, { ...integrationToForm(s), url, secret: 'x1' });
      expect(r.errors.url).toBeDefined();
    }
  });

  it('needs URL and secret for a new integration', () => {
    const s = settings({ url: null, username: null, secretSet: false, status: 'off' });
    const r = buildIntegrationPatch('uptimekuma', s, {
      ...integrationToForm(s),
      url: 'http://kuma.lan:3001',
    });
    expect(r.errors.secret).toBe('API-Key fehlt.');
    const r2 = buildIntegrationPatch('uptimekuma', s, {
      ...integrationToForm(s),
      secret: 'uk1_abc',
    });
    expect(r2.errors.url).toMatch(/Adresse fehlt/);
  });

  it('switching the DNS filter to Pi-hole drops the user name', () => {
    const s = settings({ url: 'http://192.168.1.2', username: 'admin', variant: 'adguard' });
    const r = buildIntegrationPatch('dnsfilter', s, { ...integrationToForm(s), variant: 'pihole' });
    expect(r.patch).toEqual({ variant: 'pihole', username: null });
  });

  it('validates the CA certificate and can remove it', () => {
    const s = settings({ caSet: true });
    const bad = buildIntegrationPatch('proxmox', s, { ...integrationToForm(s), caCert: 'hello' });
    expect(bad.errors.caCert).toMatch(/PEM/);
    const pem = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\n-----END CERTIFICATE-----';
    expect(
      buildIntegrationPatch('proxmox', s, { ...integrationToForm(s), caCert: pem }).patch,
    ).toEqual({ caCert: pem });
    expect(
      buildIntegrationPatch('proxmox', s, { ...integrationToForm(s), removeCa: true }).patch,
    ).toEqual({ caCert: null });
  });

  it('asks for the code on 403 step_up_required and retries the same body once', async () => {
    const onStepUp = vi.fn(() => Promise.resolve(true));
    reset = configureApi({ onStepUp });
    const fetchMock = mockFetch(
      json(403, { ok: false, error: 'step_up_required' }),
      json(200, settings({ url: 'https://pve2.lan:8006' })),
    );
    const next = await saveIntegrationSettings('proxmox', {
      url: 'https://pve2.lan:8006',
      secret: 's3cret',
    });
    expect(next.url).toBe('https://pve2.lan:8006');
    expect(onStepUp).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      '/api/proxmox/settings',
      '/api/proxmox/settings',
    ]);
    expect(bodyOf(fetchMock, 1)).toEqual({ url: 'https://pve2.lan:8006', secret: 's3cret' });
  });

  it('rejects answers that do not match the schema (secret never comes back)', async () => {
    mockFetch(json(200, { ...settings(), secret: 'leak' }));
    await expect(saveIntegrationSettings('proxmox', {})).rejects.toMatchObject({
      error: 'bad_response',
    });
  });
});
