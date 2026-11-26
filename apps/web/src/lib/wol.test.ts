import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, mockFetch } from '../test-m14.js';
import { buildWolBody, wakeErrorText, wakeServer, wolToForm } from './wol.js';

afterEach(() => vi.unstubAllGlobals());

describe('wake-on-lan', () => {
  it('starts with the defaults', () => {
    expect(wolToForm(undefined)).toEqual({
      mac: '',
      broadcast: '255.255.255.255',
      port: '9',
      via: 'core',
    });
  });

  it('normalises the MAC and validates broadcast', () => {
    const r = buildWolBody({
      mac: 'aa-bb-cc-dd-ee-f0',
      broadcast: '192.168.1.255',
      port: '7',
      via: 'srv-pi000001',
    });
    expect(r.body).toEqual({
      mac: 'AA:BB:CC:DD:EE:F0',
      broadcast: '192.168.1.255',
      port: 7,
      via: 'srv-pi000001',
    });
    expect(
      buildWolBody({ mac: 'FF:FF:FF:FF:FF:FF', broadcast: '', port: '9', via: 'core' }).errors.mac,
    ).toBe('Ungültige MAC-Adresse');
    expect(
      buildWolBody({ mac: 'AA:BB', broadcast: '', port: '9', via: 'core' }).errors.mac,
    ).toMatch(/AA:BB:CC/);
    expect(
      buildWolBody({ mac: '', broadcast: '8.8.8.8', port: '9', via: 'core' }).errors.broadcast,
    ).toBeDefined();
    // Empty MAC removes Wake-on-LAN.
    expect(buildWolBody({ mac: '', broadcast: '', port: '9', via: 'core' }).body?.mac).toBeNull();
  });

  it('explains 429 and 409', async () => {
    mockFetch(
      json(429, { ok: false, error: 'rate_limited', retryAfter: 30 }),
      json(409, { ok: false, error: 'agent_offline' }),
    );
    const a = await wakeServer('srv-home0001').catch((e: unknown) => e);
    expect(wakeErrorText(a)).toBe('Zu oft, kurz warten.');
    const b = await wakeServer('srv-home0001').catch((e: unknown) => e);
    expect(wakeErrorText(b)).toMatch(/^Sender-Agent offline/);
  });
});
