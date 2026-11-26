import type { VulnScanResult } from '@hz/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, configureApi } from './api.js';
import {
  discordInviteUrl,
  highlightSegments,
  logSearchBody,
  logSearchErrorText,
  saveDiscordBinding,
  saveDiscordBot,
  saveVoiceGame,
  searchLogs,
  shownError,
  unbanIp,
  vulnStatus,
} from './ops.js';

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

let reset: (() => void) | undefined;
afterEach(() => {
  reset?.();
  reset = undefined;
  vi.unstubAllGlobals();
});

const draft = {
  query: 'timeout',
  sinceMinutes: 60,
  serverIds: [],
  container: '',
  caseSensitive: false,
};

const botState = {
  tokenSet: true,
  applicationId: '111111111111111111',
  guildId: '222222222222222222',
  status: 'online' as const,
  statusText: 'Verbunden als Zentrale#1234',
  bindings: [],
};

function scan(over: Partial<VulnScanResult['scan']>): VulnScanResult {
  return {
    serverId: 'srv-000001',
    serverName: 'heimserver',
    containerName: 'nginx',
    scan: {
      image: 'nginx:1.27',
      digest: null,
      scannable: true,
      reason: null,
      counts: { critical: 0, high: 0 },
      vulns: [],
      scannedAt: '2026-11-26T03:30:00.000Z',
      ...over,
    },
  };
}

describe('log search', () => {
  it('needs at least 2 characters and a valid container filter', () => {
    expect(logSearchBody({ ...draft, query: ' a ' })).toEqual({
      ok: false,
      field: 'query',
      error: 'Mindestens 2 Zeichen.',
    });
    expect(logSearchBody({ ...draft, container: 'ng inx' })).toMatchObject({
      ok: false,
      field: 'container',
    });
    expect(logSearchBody({ ...draft, query: 'a\u0007b' })).toMatchObject({ ok: false });
  });

  it('leaves serverIds and container out for "Alle"', () => {
    expect(logSearchBody(draft)).toEqual({
      ok: true,
      body: { query: 'timeout', caseSensitive: false, sinceMinutes: 60, maxMatches: 200 },
    });
    const picked = logSearchBody({ ...draft, serverIds: ['srv-000001'], container: 'nginx' });
    expect(picked).toMatchObject({
      ok: true,
      body: { serverIds: ['srv-000001'], container: 'nginx' },
    });
  });

  it('marks every match, case-insensitive by default, never as regex', () => {
    expect(highlightSegments('Error: error', 'error', false)).toEqual([
      { text: 'Error', match: true },
      { text: ': ', match: false },
      { text: 'error', match: true },
    ]);
    expect(highlightSegments('Error: error', 'error', true)).toEqual([
      { text: 'Error: ', match: false },
      { text: 'error', match: true },
    ]);
    // Regex characters are plain text.
    expect(highlightSegments('a.b axb', 'a.b', false)).toEqual([
      { text: 'a.b', match: true },
      { text: ' axb', match: false },
    ]);
    expect(highlightSegments('nothing', 'zz', false)).toEqual([{ text: 'nothing', match: false }]);
  });

  it('says "Zu viele Suchen" on 429', async () => {
    mockFetch(json(429, { ok: false, error: 'rate_limited', retryAfter: 30 }));
    const err = await searchLogs({
      query: 'xx',
      caseSensitive: false,
      sinceMinutes: 60,
      maxMatches: 200,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(logSearchErrorText(err)).toBe('Zu viele Suchen, kurz warten.');
  });
});

describe('vulnerability status', () => {
  it('crit with critical, warn with high, ok without', () => {
    expect(vulnStatus(scan({ counts: { critical: 2, high: 5 } }))).toEqual({
      status: 'crit',
      label: 'CRIT',
    });
    expect(vulnStatus(scan({ counts: { critical: 0, high: 1 } }))).toEqual({
      status: 'warn',
      label: 'HIGH',
    });
    expect(vulnStatus(scan({}))).toEqual({ status: 'ok', label: 'OK' });
  });

  it('local images are not scannable, failed scans say so', () => {
    expect(vulnStatus(scan({ scannable: false, reason: 'local_image' })).label).toBe(
      'nicht prüfbar (lokal gebaut)',
    );
    expect(vulnStatus(scan({ scannable: false, reason: 'scan_failed' })).label).toBe(
      'Scan fehlgeschlagen',
    );
  });
});

describe('fail2ban', () => {
  it('posts exactly server, jail and ip', async () => {
    const fn = mockFetch(
      json(200, {
        serverId: 'srv-000001',
        name: 'heimserver',
        state: 'ok',
        jails: [],
        fetchedAt: '2026-11-26T22:04:00.000Z',
      }),
    );
    await unbanIp({ serverId: 'srv-000001', jail: 'sshd', ip: '203.0.113.7' });
    const [url, init] = fn.mock.calls[0] ?? [];
    expect(url).toBe('/api/fail2ban/unban');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      serverId: 'srv-000001',
      jail: 'sshd',
      ip: '203.0.113.7',
    });
  });
});

describe('discord bot', () => {
  it('builds the invite link only from a valid application id', () => {
    expect(discordInviteUrl('111111111111111111')).toBe(
      'https://discord.com/oauth2/authorize?client_id=111111111111111111&scope=bot%20applications.commands',
    );
    expect(discordInviteUrl('12345')).toBeNull();
    expect(discordInviteUrl('111111111111111111&x=1')).toBeNull();
  });

  it('asks for step-up and repeats the save once', async () => {
    const onStepUp = vi.fn(() => Promise.resolve(true));
    reset = configureApi({ onStepUp });
    const fn = mockFetch(json(403, { ok: false, error: 'step_up_required' }), json(200, botState));
    const body = { applicationId: botState.applicationId, guildId: botState.guildId };
    await expect(saveDiscordBot(body)).resolves.toEqual(botState);
    expect(onStepUp).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(2);
    for (const [url, init] of fn.mock.calls) {
      expect(url).toBe('/api/discord-bot');
      expect(init?.method).toBe('PUT');
      // Token missing: the core keeps the stored one.
      expect(JSON.parse(String(init?.body))).toEqual(body);
    }
  });

  it('shows no error line when the step-up dialog was closed', async () => {
    reset = configureApi({ onStepUp: () => Promise.resolve(false) });
    mockFetch(json(403, { ok: false, error: 'step_up_required' }));
    const err = await saveDiscordBot({ applicationId: null, guildId: null }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(shownError(err)).toBeNull();
    expect(shownError(new ApiError(500, 'internal'))).toBeTruthy();
  });

  it('binds a Discord user id through step-up and repeats the same PUT', async () => {
    const onStepUp = vi.fn(() => Promise.resolve(true));
    reset = configureApi({ onStepUp });
    const fn = mockFetch(json(403, { ok: false, error: 'step_up_required' }), json(200, botState));
    await expect(saveDiscordBinding('shr-0001', '111111111111111111')).resolves.toEqual(botState);
    expect(onStepUp).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(2);
    for (const [url, init] of fn.mock.calls) {
      expect(url).toBe('/api/discord-bot/bindings/shr-0001');
      expect(init?.method).toBe('PUT');
      expect(JSON.parse(String(init?.body))).toEqual({ discordUserId: '111111111111111111' });
    }
  });

  it('unbinds without step-up; a closed step-up dialog shows no error line', async () => {
    const onStepUp = vi.fn(() => Promise.resolve(false));
    reset = configureApi({ onStepUp });
    const fn = mockFetch(json(200, botState), json(403, { ok: false, error: 'step_up_required' }));
    await expect(saveDiscordBinding('shr-0001', null)).resolves.toEqual(botState);
    expect(JSON.parse(String(fn.mock.calls[0]?.[1]?.body))).toEqual({ discordUserId: null });
    expect(onStepUp).not.toHaveBeenCalled();
    const err = await saveDiscordBinding('shr-0001', '111111111111111111').catch((e: unknown) => e);
    expect(onStepUp).toHaveBeenCalledTimes(1);
    expect(shownError(err)).toBeNull();
  });
});

describe('voice', () => {
  it('handles step-up on a changed switch entity', async () => {
    const onStepUp = vi.fn(() => Promise.resolve(true));
    reset = configureApi({ onStepUp });
    const state = { haReady: true, games: [] };
    const fn = mockFetch(json(403, { ok: false, error: 'step_up_required' }), json(200, state));
    await expect(
      saveVoiceGame('game-0001', {
        switchEntity: 'input_boolean.minecraft',
        statusEntity: null,
        allowStop: false,
      }),
    ).resolves.toEqual(state);
    expect(onStepUp).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[1]?.[0]).toBe('/api/voice/games/game-0001');
  });

  it('handles step-up on a new status entity', async () => {
    const onStepUp = vi.fn(() => Promise.resolve(true));
    reset = configureApi({ onStepUp });
    const state = { haReady: true, games: [] };
    const body = {
      switchEntity: 'input_boolean.minecraft',
      statusEntity: 'input_text.minecraft_status',
      allowStop: false,
    };
    const fn = mockFetch(json(403, { ok: false, error: 'step_up_required' }), json(200, state));
    await expect(saveVoiceGame('game-0001', body)).resolves.toEqual(state);
    expect(onStepUp).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fn.mock.calls[1]?.[1]?.body))).toEqual(body);
  });
});
