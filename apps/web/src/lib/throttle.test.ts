import { defaultThrottleSettings, type ServerThrottleResponse } from '@hz/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gameErrorText } from '../pages/games/useGameAction.js';
import { api, ApiError, isApiError } from './api.js';
import { errorText } from './errors.js';
import { setDisplayTimeZone } from './format.js';
import { gameAction } from './games.js';
import {
  changedSettings,
  consumerActions,
  daysText,
  fetchServerThrottle,
  fetchTopConsumers,
  formatCores,
  formatGb,
  insufficientRamText,
  newWindowDraft,
  parseCpus,
  parseSettings,
  parseWindows,
  phaseStatus,
  phaseText,
  priorityBody,
  priorityText,
  ramStatusText,
  saveContainerPriority,
  saveGamePriority,
  settingsDraft,
  throttleBadge,
  throttleContainer,
  throttleDetail,
  autostopTarget,
  parseAutostopKey,
  suggestRamText,
  toggleDay,
  unthrottleContainer,
  updateServerThrottle,
  windowText,
} from './throttle.js';

const GB = 1024 ** 3;

const reply = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function mockFetch(...responses: Response[]) {
  const fn = vi.fn<typeof fetch>();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  vi.stubGlobal('fetch', fn);
  return fn;
}

function sent(
  fn: ReturnType<typeof mockFetch>,
  i = 0,
): { url: string; method: string; body: unknown } {
  const call = fn.mock.calls[i];
  const init = call?.[1];
  return {
    url: String(call?.[0]),
    method: String(init?.method),
    body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('cores and cpus input', () => {
  it('formats cores in de-AT', () => {
    expect(formatCores(1)).toBe('1 Kern');
    expect(formatCores(0.5)).toBe('0,5 Kerne');
    expect(formatCores(2)).toBe('2 Kerne');
    expect(throttleBadge({ cpus: 1 })).toBe('gedrosselt (1 Kern)');
    expect(throttleBadge({ cpus: 1.5 })).toBe('gedrosselt (1,5 Kerne)');
  });

  it('accepts 0,1 to 64 with comma or dot, rounded to 2 decimals', () => {
    expect(parseCpus('1')).toEqual({ ok: true, value: 1 });
    expect(parseCpus('0,5')).toEqual({ ok: true, value: 0.5 });
    expect(parseCpus(' 1.25 ')).toEqual({ ok: true, value: 1.25 });
    expect(parseCpus('0,1')).toEqual({ ok: true, value: 0.1 });
    expect(parseCpus('64')).toEqual({ ok: true, value: 64 });
    expect(parseCpus('1,234')).toEqual({ ok: true, value: 1.23 });
  });

  it('rejects out of range and junk', () => {
    for (const bad of ['0', '0,09', '64,5', '65', '-1', '', 'abc', '1e3', '1,2,3']) {
      const r = parseCpus(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error).toBe('Zahl von 0,1 bis 64.');
    }
  });

  it('describes a throttle with time, source and reason', () => {
    setDisplayTimeZone('Europe/Vienna');
    expect(
      throttleDetail({
        cpus: 1,
        since: '2026-11-26T22:04:00.000Z',
        by: 'auto',
        reason: 'heimserver CPU 96 % seit 2 Min',
      }),
    ).toBe('gedrosselt auf 1 Kern seit 23:04 · heimserver CPU 96 % seit 2 Min');
    setDisplayTimeZone(undefined);
  });
});

describe('priority', () => {
  it('allows "darf gestoppt werden" only with niedrig and players only with stop', () => {
    expect(priorityBody('normal', true, true)).toEqual({
      priority: 'normal',
      allowStop: false,
      allowStopWithPlayers: false,
    });
    expect(priorityBody('niedrig', false, true)).toEqual({
      priority: 'niedrig',
      allowStop: false,
      allowStopWithPlayers: false,
    });
    expect(priorityBody('niedrig', true, true)).toEqual({
      priority: 'niedrig',
      allowStop: true,
      allowStopWithPlayers: true,
    });
  });

  it('has one text line, protected containers are always wichtig', () => {
    expect(priorityText({ priority: 'normal', allowStop: false })).toBe('normal');
    expect(priorityText({ priority: 'niedrig', allowStop: true })).toBe(
      'niedrig · darf gestoppt werden',
    );
    expect(priorityText({ priority: 'normal', allowStop: false, protected: true })).toBe(
      'Zentrale/Agent: immer wichtig',
    );
  });

  it('PUTs the container and game priority', async () => {
    const fn = mockFetch(
      reply(200, {
        containerId: 'ctr-000001',
        serverId: 'srv-1',
        containerName: 'minecraft',
        priority: 'niedrig',
        allowStop: true,
        protected: false,
        gameId: null,
      }),
      reply(200, {
        gameId: 'game-000001',
        priority: 'niedrig',
        allowStop: true,
        allowStopWithPlayers: false,
      }),
    );
    await saveContainerPriority('ctr-000001', { priority: 'niedrig', allowStop: true });
    expect(sent(fn, 0)).toEqual({
      url: '/api/containers/ctr-000001/priority',
      method: 'PUT',
      body: { priority: 'niedrig', allowStop: true },
    });
    await saveGamePriority('game-000001', priorityBody('niedrig', true, false));
    expect(sent(fn, 1)).toEqual({
      url: '/api/games/game-000001/priority',
      method: 'PUT',
      body: { priority: 'niedrig', allowStop: true, allowStopWithPlayers: false },
    });
  });
});

describe('throttle routes', () => {
  it('POSTs throttle with cpus and unthrottle with an empty body', async () => {
    const fn = mockFetch(
      reply(200, { ok: true, container: null }),
      reply(200, { ok: true, container: null }),
    );
    await throttleContainer('ctr-000001', 0.5);
    expect(sent(fn, 0)).toEqual({
      url: '/api/containers/ctr-000001/throttle',
      method: 'POST',
      body: { cpus: 0.5 },
    });
    await unthrottleContainer('ctr-000001');
    expect(sent(fn, 1)).toEqual({
      url: '/api/containers/ctr-000001/unthrottle',
      method: 'POST',
      body: {},
    });
  });

  it('refuses a protected container with the core text', async () => {
    mockFetch(reply(403, { ok: false, error: 'forbidden' }));
    const err = await throttleContainer('ctr-000001', 1).catch((e: unknown) => e);
    expect(isApiError(err, 'forbidden')).toBe(true);
    expect(errorText(err)).toBe('Anfrage abgelehnt.');
  });
});

describe('insufficient_ram', () => {
  it('shows free RAM minus reserve in GB, never below 0', () => {
    expect(
      insufficientRamText({ freeBytes: 7.8 * GB, reserveBytes: 2 * GB, neededBytes: 8 * GB }),
    ).toBe('Zu wenig RAM, 5,8 GB frei');
    expect(insufficientRamText({ freeBytes: 1 * GB, reserveBytes: 3 * GB, neededBytes: GB })).toBe(
      'Zu wenig RAM, 0 GB frei',
    );
    expect(insufficientRamText(undefined)).toBe('Zu wenig RAM auf dem Server.');
    expect(formatGb(0.25 * GB)).toBe('0,3 GB');
  });

  it('reads details from the 409 and wins over the core hint on game start', async () => {
    mockFetch(
      reply(409, {
        ok: false,
        error: 'insufficient_ram',
        message: 'Zu wenig RAM.',
        details: { freeBytes: 6.5 * GB, reserveBytes: 2 * GB, neededBytes: 8 * GB },
      }),
    );
    const err = await gameAction('game-000001', 'start').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(isApiError(err) && err.details?.freeBytes).toBe(6.5 * GB);
    expect(gameErrorText(err)).toBe('Zu wenig RAM, 4,5 GB frei');
    expect(errorText(err)).toBe('Zu wenig RAM, 4,5 GB frei');
  });

  it('works without details (as share links get it)', async () => {
    mockFetch(reply(409, { ok: false, error: 'insufficient_ram' }));
    const err = await api('/api/games/x/start', {
      method: 'POST',
      body: {},
      schema: { parse: (d: unknown) => d },
    }).catch((e: unknown) => e);
    expect(gameErrorText(err)).toBe('Zu wenig RAM auf dem Server.');
  });
});

describe('top consumers', () => {
  const entry = {
    containerId: 'ctr-000001',
    containerName: 'minecraft',
    serverId: 'srv-1',
    serverName: 'heimserver',
    cpuPct: 96,
    memBytes: 5.8 * GB,
    priority: 'niedrig' as const,
    protected: false,
    throttled: null,
    isGame: true,
    gameId: 'game-000001',
  };

  it('offers no buttons for protected containers', () => {
    expect(consumerActions({ protected: true, throttled: null })).toEqual({
      throttle: false,
      unthrottle: false,
      stop: false,
    });
    expect(consumerActions(entry)).toEqual({ throttle: true, unthrottle: false, stop: true });
    expect(
      consumerActions({
        ...entry,
        throttled: { cpus: 1, since: '2026-11-26T22:04:00.000Z', by: 'admin', reason: '' },
      }),
    ).toEqual({ throttle: false, unthrottle: true, stop: true });
  });

  it('fetches the route for all servers or one server', async () => {
    const res = {
      byCpu: [entry, { ...entry, containerId: 'ctr-000002', serverId: 'srv-2' }],
      byRam: [entry],
      updatedAt: '2026-11-26T22:04:00.000Z',
    };
    const fn = mockFetch(reply(200, res));
    await expect(fetchTopConsumers()).resolves.toEqual(res);
    expect(sent(fn).url).toBe('/api/overview/top-consumers');
    const one = mockFetch(reply(200, res));
    await expect(fetchTopConsumers('srv-2')).resolves.toEqual(res);
    expect(sent(one).url).toBe('/api/overview/top-consumers?serverId=srv-2');
  });
});

describe('server settings (Automatik)', () => {
  const data: ServerThrottleResponse = {
    serverId: 'srv-1',
    settings: defaultThrottleSettings,
    schedules: [
      {
        tier: 'niedrig',
        days: ['mo', 'di', 'mi', 'do', 'fr'],
        from: '18:00',
        to: '23:00',
        mode: 'no_throttle',
      },
    ],
    status: {
      phase: 'over',
      since: '2026-11-26T22:04:00.000Z',
      ramReserveBytes: 2 * GB,
      freeRamBytes: 7.8 * GB,
      activeWindows: [],
    },
  };

  it('round-trips the defaults and sends only changed keys', () => {
    const d = settingsDraft(defaultThrottleSettings);
    expect(d.throttleCpus).toBe('1');
    expect(d.ramReserveMb).toBe('0');
    const p = parseSettings(d);
    expect(p).toEqual({ ok: true, value: defaultThrottleSettings });
    const next = parseSettings({ ...d, enabled: false, cpuPct: '95', ramReserveMb: '1,5' });
    expect(next.ok).toBe(true);
    if (next.ok) {
      expect(changedSettings(defaultThrottleSettings, next.value)).toEqual({
        enabled: false,
        cpuPct: 95,
        ramReserveMb: 1536,
      });
    }
  });

  it('checks the bounds', () => {
    const d = settingsDraft(defaultThrottleSettings);
    const p = parseSettings({
      ...d,
      cpuPct: '49',
      forMinutes: '1,5',
      throttleCpus: '65',
      ramReserveMb: '-1',
    });
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.errors.cpuPct).toBe('Ganze Zahl von 50 bis 99.');
      expect(p.errors.forMinutes).toBe('Ganze Zahl von 1 bis 120.');
      expect(p.errors.throttleCpus).toBe('Zahl von 0,1 bis 64.');
      expect(p.errors.ramReserveMb).toBe('Zahl von 0 bis 1.024 GB.');
    }
  });

  it('says the phase status first, with shape', () => {
    setDisplayTimeZone('Europe/Vienna');
    expect(phaseText(data.status, data.settings)).toBe(
      'Über der Schwelle seit 23:04 · drosselt nach 2 Min',
    );
    expect(phaseText({ ...data.status, phase: 'disabled', since: null }, data.settings)).toBe(
      'Automatik aus. Nichts wird gedrosselt oder gestoppt.',
    );
    expect(phaseStatus('over')).toBe('warn');
    expect(phaseStatus('disabled')).toBe('off');
    expect(ramStatusText(data.status)).toBe('RAM frei 7,8 GB · Reserve 2 GB');
    expect(ramStatusText({ ...data.status, freeRamBytes: null })).toBe('RAM noch unbekannt');
    setDisplayTimeZone(undefined);
  });

  it('GETs and PUTs /api/servers/:id/throttle', async () => {
    const fn = mockFetch(reply(200, data), reply(200, data));
    await fetchServerThrottle('srv-1');
    expect(sent(fn, 0).url).toBe('/api/servers/srv-1/throttle');
    await updateServerThrottle('srv-1', { settings: { enabled: false }, schedules: [] });
    expect(sent(fn, 1)).toEqual({
      url: '/api/servers/srv-1/throttle',
      method: 'PUT',
      body: { settings: { enabled: false }, schedules: [] },
    });
  });
});

describe('schedules', () => {
  it('parses windows, pads 8:00 and needs cpus only for mode cpus', () => {
    const a = { ...newWindowDraft(), from: '8:00', to: '12:30' };
    const b = { ...newWindowDraft(), tier: 'normal' as const, mode: 'cpus' as const, cpus: '2,5' };
    expect(parseWindows([a, b])).toEqual({
      ok: true,
      value: [
        {
          tier: 'niedrig',
          days: ['mo', 'di', 'mi', 'do', 'fr'],
          from: '08:00',
          to: '12:30',
          mode: 'no_throttle',
        },
        {
          tier: 'normal',
          days: ['mo', 'di', 'mi', 'do', 'fr'],
          from: '18:00',
          to: '23:00',
          mode: 'cpus',
          cpus: 2.5,
        },
      ],
    });
  });

  it('reports errors per window', () => {
    const r = parseWindows([
      { ...newWindowDraft(), days: [], from: '25:00', to: '23:00' },
      { ...newWindowDraft(), from: '18:00', to: '18:00', mode: 'cpus', cpus: '0' },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]).toEqual({
        days: 'Mindestens einen Tag wählen.',
        from: 'Uhrzeit wie 18:00.',
      });
      expect(r.errors[1]).toEqual({
        to: 'Bis muss sich von Von unterscheiden.',
        cpus: 'Zahl von 0,1 bis 64.',
      });
    }
  });

  it('allows at most 20 windows', () => {
    const list = Array.from({ length: 21 }, () => newWindowDraft());
    expect(parseWindows(list).ok).toBe(false);
    expect(parseWindows(list.slice(0, 20)).ok).toBe(true);
  });

  it('keeps days in week order and writes them short', () => {
    expect(toggleDay(['fr', 'mo'], 'mi')).toEqual(['mo', 'mi', 'fr']);
    expect(toggleDay(['mo', 'mi'], 'mo')).toEqual(['mi']);
    expect(daysText(['mo', 'di', 'mi', 'do', 'fr'])).toBe('Mo–Fr');
    expect(daysText(['sa', 'so'])).toBe('Sa, So');
    expect(daysText(['mo', 'mi', 'do', 'fr'])).toBe('Mo, Mi–Fr');
    expect(daysText(['mo', 'di', 'mi', 'do', 'fr', 'sa', 'so'])).toBe('täglich');
    expect(
      windowText({
        tier: 'niedrig',
        days: ['sa', 'so'],
        from: '10:00',
        to: '02:00',
        mode: 'cpus',
        cpus: 2,
      }),
    ).toBe('niedrig Sa, So 10:00–02:00 mit 2 Kernen');
  });
});

describe('autostop alerts and the RAM line in game-new', () => {
  const list = [
    {
      id: 'ctr-1',
      serverId: 'srv-1',
      name: 'cruncher',
      gameId: null,
      autoStopped: true,
      state: 'exited' as const,
    },
    {
      id: 'ctr-2',
      serverId: 'srv-1',
      name: 'game-welt',
      gameId: 'game-1',
      autoStopped: true,
      state: 'exited' as const,
    },
    {
      id: 'ctr-3',
      serverId: 'srv-2',
      name: 'cruncher',
      gameId: null,
      autoStopped: false,
      state: 'running' as const,
    },
  ];

  it('reads the alert key', () => {
    expect(parseAutostopKey('autostop:srv-1:cruncher')).toEqual({
      serverId: 'srv-1',
      name: 'cruncher',
    });
    expect(parseAutostopKey('throttle:srv-1:cruncher')).toBeNull();
    expect(parseAutostopKey('autostop:srv-1:')).toBeNull();
  });

  it('starts games through the game route and skips running containers', () => {
    expect(autostopTarget('autostop:srv-1:cruncher', list)).toEqual({
      kind: 'container',
      id: 'ctr-1',
      name: 'cruncher',
    });
    expect(autostopTarget('autostop:srv-1:game-welt', list)).toEqual({
      kind: 'game',
      id: 'game-1',
      name: 'game-welt',
    });
    expect(autostopTarget('autostop:srv-2:cruncher', list)).toBeNull();
    expect(autostopTarget('autostop:srv-9:gone', list)).toBeNull();
  });

  it('names the reserve only when there is one', () => {
    expect(suggestRamText(8.2 * GB, 4 * GB, 6 * GB)).toBe(
      '8,2 GB RAM frei · davon 4 GB Reserve · empfohlen 6 GB',
    );
    expect(suggestRamText(8.2 * GB, 0, 6 * GB)).toBe('8,2 GB RAM frei · empfohlen 6 GB');
    expect(suggestRamText(8.2 * GB, undefined, 6 * GB)).toBe('8,2 GB RAM frei · empfohlen 6 GB');
  });
});
