import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bodyOf, dns, fritz, json, mockFetch } from '../test-m14.js';
import { configureApi } from './api.js';
import { setDisplayTimeZone } from './format.js';
import {
  blockingState,
  blockingText,
  filterDevices,
  formatBlockedPct,
  formatCount,
  formatMbit,
  internetState,
  networkSentence,
  rebootFritzBox,
  setDnsBlocking,
} from './network.js';

let reset: (() => void) | undefined;
beforeAll(() => setDisplayTimeZone('Europe/Vienna'));
afterEach(() => {
  reset?.();
  reset = undefined;
  vi.unstubAllGlobals();
});

describe('network', () => {
  it('formats line speeds in Mbit/s, Austrian format', () => {
    expect(formatMbit(250_000_000)).toBe('250 Mbit/s');
    expect(formatMbit(40_500_000)).toBe('40,5 Mbit/s');
    expect(formatMbit(1_000_000_000)).toBe('1.000 Mbit/s');
    expect(formatMbit(null)).toBe('—');
  });

  it('formats counts and the blocked share', () => {
    expect(formatCount(1_204_311)).toBe('1.204.311');
    expect(formatCount(null)).toBe('—');
    expect(formatBlockedPct(8.43)).toBe('8,4 %');
    expect(formatBlockedPct(23.6)).toBe('24 %');
  });

  it('knows the internet state, unknown while the box is unreachable', () => {
    expect(internetState(fritz())).toBe('up');
    const down = fritz();
    if (down.internet) down.internet.connected = false;
    expect(internetState(down)).toBe('down');
    expect(internetState(fritz({ error: 'Nicht erreichbar' }))).toBe('unknown');
  });

  it('lists active devices first and filters', () => {
    const f = fritz();
    expect(filterDevices(f.devices, 'all').map((d) => d.name)).toEqual([
      'heimserver',
      'pi-garage',
      'handy',
    ]);
    expect(filterDevices(f.devices, 'active')).toHaveLength(2);
  });

  it('shows "pausiert bis 23:04"', () => {
    const p = dns({ blocking: false, pausedUntil: '2026-11-26T22:04:00.000Z' });
    expect(blockingState(p)).toBe('paused');
    expect(blockingText(p)).toBe('pausiert bis 23:04');
    expect(blockingText(dns())).toBe('blockt');
    expect(blockingState(dns({ error: 'Zeitüberschreitung' }))).toBe('unknown');
  });

  it('names problems first in the Statussatz', () => {
    const down = fritz();
    if (down.internet) down.internet.connected = false;
    expect(networkSentence({ fritz: down, dns: dns(), fritzOn: true, dnsOn: true })).toEqual({
      em: 'Internet getrennt',
      rest: ' · 8,4 % blockiert heute',
    });
    expect(networkSentence({ fritz: fritz(), dns: dns(), fritzOn: true, dnsOn: true })).toEqual({
      em: null,
      rest: 'Internet verbunden · 8,4 % blockiert heute.',
    });
    const paused = dns({ blocking: false, pausedUntil: '2026-11-26T22:04:00.000Z' });
    expect(networkSentence({ dns: paused, fritzOn: false, dnsOn: true }).em).toBe(
      'DNS-Filter pausiert bis 23:04',
    );
  });

  it('pauses only with an end and turns blocking back on', async () => {
    const fetchMock = mockFetch(json(200, dns({ blocking: false })), json(200, dns()));
    await setDnsBlocking(15);
    await setDnsBlocking(null);
    expect(bodyOf(fetchMock, 0)).toEqual({ enabled: false, minutes: 15 });
    expect(bodyOf(fetchMock, 1)).toEqual({ enabled: true });
  });

  it('reboots the box with confirm and step-up', async () => {
    const onStepUp = vi.fn(() => Promise.resolve(true));
    reset = configureApi({ onStepUp });
    const fetchMock = mockFetch(
      json(403, { ok: false, error: 'step_up_required' }),
      json(200, { ok: true }),
    );
    await rebootFritzBox();
    expect(onStepUp).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/fritzbox/reboot');
    expect(bodyOf(fetchMock, 1)).toEqual({ confirm: true });
  });
});
