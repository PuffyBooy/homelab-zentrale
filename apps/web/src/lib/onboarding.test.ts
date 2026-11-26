import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelOnboarding,
  countdown,
  createOnboarding,
  effectiveState,
  fetchOnboarding,
  onboardingFinal,
  onboardingView,
} from './onboarding.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(...responses: Response[]) {
  const fn = vi.fn<typeof fetch>();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

const created = {
  id: 'onb_abcdefgh',
  name: 'pi-garage',
  code: 'ABCD-EFGH',
  expiresAt: '2026-11-26T22:19:00.000Z',
  oneLiner: 'curl -fsSL https://hub.tail1234.ts.net/install.sh | sudo sh -s -- ABCD-EFGH',
};

describe('onboarding api', () => {
  it('creates a code with name and location', async () => {
    const fn = mockFetch(json(201, created));
    await expect(createOnboarding({ name: 'pi-garage', location: 'Garage' })).resolves.toEqual(
      created,
    );
    const [url, init] = fn.mock.calls[0] ?? [];
    expect(url).toBe('/api/servers/onboarding');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"name":"pi-garage","location":"Garage"}');
  });

  it('refuses an answer with a code in the wrong form', async () => {
    mockFetch(json(201, { ...created, code: 'ABCDEFGH' }));
    await expect(createOnboarding({ name: 'pi-garage', location: '' })).rejects.toMatchObject({
      error: 'bad_response',
    });
  });

  it('polls the status and cancels with DELETE', async () => {
    const fn = mockFetch(
      json(200, {
        id: created.id,
        name: 'pi-garage',
        state: 'connected',
        expiresAt: created.expiresAt,
        serverId: 'srv-000123',
      }),
      json(200, { ok: true }),
    );
    await expect(fetchOnboarding(created.id)).resolves.toMatchObject({
      state: 'connected',
      serverId: 'srv-000123',
    });
    expect(fn.mock.calls[0]?.[0]).toBe('/api/servers/onboarding/onb_abcdefgh');
    await cancelOnboarding(created.id);
    expect(fn.mock.calls[1]?.[0]).toBe('/api/servers/onboarding/onb_abcdefgh');
    expect(fn.mock.calls[1]?.[1]?.method).toBe('DELETE');
  });
});

describe('onboarding helpers', () => {
  const now = new Date('2026-11-26T22:04:28.000Z');

  it('counts down in mm:ss and stops at 0:00', () => {
    expect(countdown('2026-11-26T22:19:00.000Z', now)).toBe('14:32');
    expect(countdown('2026-11-26T22:04:35.000Z', now)).toBe('0:07');
    expect(countdown('2026-11-26T22:00:00.000Z', now)).toBe('0:00');
  });

  it('a waiting code past its expiry is shown as expired', () => {
    expect(effectiveState('waiting', '2026-11-26T22:04:00.000Z', now)).toBe('expired');
    expect(effectiveState('waiting', '2026-11-26T22:19:00.000Z', now)).toBe('waiting');
    // Installing keeps its own expiry (the enrollment token); the core decides.
    expect(effectiveState('installing', '2026-11-26T22:04:00.000Z', now)).toBe('installing');
  });

  it('every state has a shape and a German text', () => {
    expect(onboardingView('waiting')).toEqual({ status: 'busy', label: 'Wartet auf den Server …' });
    expect(onboardingView('installing')).toEqual({ status: 'busy', label: 'Installiert …' });
    expect(onboardingView('connected')).toEqual({ status: 'ok', label: 'Verbunden' });
    expect(onboardingView('expired')).toEqual({ status: 'off', label: 'Abgelaufen' });
  });

  it('stops polling only when connected or expired', () => {
    expect(onboardingFinal('waiting')).toBe(false);
    expect(onboardingFinal('installing')).toBe(false);
    expect(onboardingFinal('connected')).toBe(true);
    expect(onboardingFinal('expired')).toBe(true);
  });
});
