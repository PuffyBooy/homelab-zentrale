import { describe, expect, it } from 'vitest';
import { containerLimitDataSchema, cpusSchema, parseRpc } from '../agent-protocol.js';
import { errorCodeSchema, errorResponseSchema } from './auth.js';
import { containerSummarySchema } from './containers.js';
import { shareErrorCodeSchema } from './share.js';
import {
  containerPriorityRequestSchema,
  containerThrottleRequestSchema,
  containerUnthrottleRequestSchema,
  defaultThrottleSettings,
  gamePriorityRequestSchema,
  insufficientRamDetailsSchema,
  MAX_SCHEDULE_WINDOWS,
  prioritySchema,
  scheduleWindowSchema,
  serverThrottleUpdateRequestSchema,
  throttleAuditActionSchema,
  throttleSettingsPatchSchema,
  topConsumersResponseSchema,
  type ScheduleWindow,
  type TopConsumer,
} from './throttle.js';

const BAD_CPUS: unknown[] = [
  0,
  0.09,
  -1,
  64.01,
  65,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  '1',
  '1.5',
  true,
  null,
  undefined,
  {},
];

const limit = (params: unknown) =>
  parseRpc({ type: 'rpc', id: 'rpc-00000001', action: 'container.limit', params });

describe('cpus bounds', () => {
  it('accepts 0.1..64 and rounds to 2 decimals', () => {
    expect(cpusSchema.parse(0.1)).toBe(0.1);
    expect(cpusSchema.parse(64)).toBe(64);
    expect(cpusSchema.parse(1.234)).toBe(1.23);
    expect(cpusSchema.parse(1.235 + 1e-9)).toBe(1.24);
    expect(cpusSchema.parse(0.1 + 0.2)).toBe(0.3);
  });

  it('rejects NaN, Infinity, negatives, zero, out of range and strings', () => {
    for (const bad of BAD_CPUS) expect(cpusSchema.safeParse(bad).success, String(bad)).toBe(false);
  });
});

describe('agent action container.limit', () => {
  it('is on the allowlist with a cpus value or null', () => {
    const ok = limit({ id: 'minecraft', cpus: 1.5 });
    expect(ok.ok).toBe(true);
    if (ok.ok && ok.request.action === 'container.limit') {
      expect(ok.request.params).toEqual({ id: 'minecraft', cpus: 1.5 });
    }
    const off = limit({ id: 'a'.repeat(12), cpus: null });
    expect(off.ok).toBe(true);
  });

  it('rejects bad cpus, missing cpus, bad ids and extra keys', () => {
    for (const cpus of BAD_CPUS.filter((v) => v !== null)) {
      expect(limit({ id: 'minecraft', cpus }).ok, String(cpus)).toBe(false);
    }
    expect(limit({ id: 'minecraft' }).ok).toBe(false);
    for (const id of ['', '-x', '../etc', 'a b', 'x'.repeat(129), 'a;rm -rf /']) {
      expect(limit({ id, cpus: 1 }).ok, id).toBe(false);
    }
    // Only --cpus: no memory or other docker update flags.
    expect(limit({ id: 'minecraft', cpus: 1, memory: '1g' }).ok).toBe(false);
    expect(limit({ id: 'minecraft', cpus: 1, args: ['--privileged'] }).ok).toBe(false);
  });

  it('result is the limit in effect', () => {
    expect(containerLimitDataSchema.safeParse({ cpus: 1 }).success).toBe(true);
    expect(containerLimitDataSchema.safeParse({ cpus: null }).success).toBe(true);
    expect(containerLimitDataSchema.safeParse({ cpus: -1 }).success).toBe(false);
  });
});

describe('priority requests', () => {
  it('knows the three German priorities only', () => {
    for (const p of ['wichtig', 'normal', 'niedrig'])
      expect(prioritySchema.safeParse(p).success).toBe(true);
    for (const p of ['high', 'low', 'Wichtig', ''])
      expect(prioritySchema.safeParse(p).success).toBe(false);
  });

  it('allowStop only with niedrig, defaults to false', () => {
    expect(containerPriorityRequestSchema.parse({ priority: 'wichtig' })).toEqual({
      priority: 'wichtig',
      allowStop: false,
    });
    expect(
      containerPriorityRequestSchema.safeParse({ priority: 'niedrig', allowStop: true }).success,
    ).toBe(true);
    expect(
      containerPriorityRequestSchema.safeParse({ priority: 'normal', allowStop: true }).success,
    ).toBe(false);
    expect(
      containerPriorityRequestSchema.safeParse({ priority: 'niedrig', allowStopWithPlayers: true })
        .success,
    ).toBe(false);
    expect(containerPriorityRequestSchema.safeParse({ priority: 'niedrig', x: 1 }).success).toBe(
      false,
    );
  });

  it('game: allowStopWithPlayers needs allowStop', () => {
    expect(
      gamePriorityRequestSchema.safeParse({
        priority: 'niedrig',
        allowStop: true,
        allowStopWithPlayers: true,
      }).success,
    ).toBe(true);
    expect(
      gamePriorityRequestSchema.safeParse({ priority: 'niedrig', allowStopWithPlayers: true })
        .success,
    ).toBe(false);
    expect(
      gamePriorityRequestSchema.safeParse({ priority: 'wichtig', allowStop: true }).success,
    ).toBe(false);
  });
});

describe('manual throttle routes', () => {
  it('throttle body is bounded like container.limit', () => {
    expect(containerThrottleRequestSchema.parse({ cpus: 2 })).toEqual({ cpus: 2 });
    for (const cpus of BAD_CPUS) {
      expect(containerThrottleRequestSchema.safeParse({ cpus }).success, String(cpus)).toBe(false);
    }
    expect(containerThrottleRequestSchema.safeParse({ cpus: 1, id: 'x' }).success).toBe(false);
    expect(containerUnthrottleRequestSchema.safeParse({}).success).toBe(true);
    expect(containerUnthrottleRequestSchema.safeParse({ cpus: 1 }).success).toBe(false);
  });
});

describe('server throttle settings', () => {
  it('has the SPEC defaults', () => {
    expect(defaultThrottleSettings).toEqual({
      enabled: true,
      cpuPct: 90,
      ramPct: 90,
      forMinutes: 2,
      stopAfterMinutes: 5,
      recoverMinutes: 10,
      recoverMarginPct: 10,
      throttleCpus: 1,
      ramReserveMb: 0,
    });
  });

  it('patch keeps unsent keys unset and enforces bounds', () => {
    expect(throttleSettingsPatchSchema.parse({ cpuPct: 80 })).toEqual({ cpuPct: 80 });
    const bad: Record<string, unknown>[] = [
      { cpuPct: 49 },
      { cpuPct: 100 },
      { ramPct: 99.5 },
      { forMinutes: 0 },
      { stopAfterMinutes: 121 },
      { recoverMinutes: 1.5 },
      { recoverMarginPct: 0 },
      { recoverMarginPct: 41 },
      { throttleCpus: 0 },
      { throttleCpus: 65 },
      { throttleCpus: '1' },
      { ramReserveMb: -1 },
      { ramReserveMb: 1_048_577 },
      { enabled: 'yes' },
      { unknown: 1 },
    ];
    for (const b of bad)
      expect(throttleSettingsPatchSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
  });
});

describe('schedule windows', () => {
  const w = (over: Partial<ScheduleWindow> = {}): unknown => ({
    tier: 'niedrig',
    days: ['mo', 'di', 'mi', 'do', 'fr'],
    from: '18:00',
    to: '23:00',
    mode: 'no_throttle',
    ...over,
  });

  it('accepts normal and over-midnight windows', () => {
    expect(scheduleWindowSchema.safeParse(w()).success).toBe(true);
    expect(scheduleWindowSchema.safeParse(w({ from: '22:00', to: '06:00' })).success).toBe(true);
    expect(
      scheduleWindowSchema.safeParse(w({ tier: 'normal', mode: 'cpus', cpus: 2 })).success,
    ).toBe(true);
  });

  it('rejects bad times, days, tiers and cpus combinations', () => {
    const bad = [
      w({ from: '24:00' }),
      w({ to: '7:00' }),
      w({ from: '18:00', to: '18:00' }),
      w({ days: [] }),
      w({ days: ['mo', 'mo'] }),
      { ...(w() as object), days: ['mon'] },
      { ...(w() as object), tier: 'wichtig' },
      w({ mode: 'cpus' }),
      w({ mode: 'no_throttle', cpus: 2 }),
      w({ mode: 'cpus', cpus: 0 }),
      { ...(w() as object), extra: true },
    ];
    for (const b of bad)
      expect(scheduleWindowSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
  });

  it('at most 20 windows per server', () => {
    const list = (n: number) => Array.from({ length: n }, () => w());
    expect(
      serverThrottleUpdateRequestSchema.safeParse({ schedules: list(MAX_SCHEDULE_WINDOWS) })
        .success,
    ).toBe(true);
    expect(
      serverThrottleUpdateRequestSchema.safeParse({ schedules: list(MAX_SCHEDULE_WINDOWS + 1) })
        .success,
    ).toBe(false);
  });
});

describe('top consumers', () => {
  const tc: TopConsumer = {
    containerId: 'AbCdEfGhIjKlMnOpQrStUv',
    containerName: 'minecraft',
    serverId: 'srv-home0001',
    serverName: 'heimserver',
    cpuPct: 96,
    memBytes: 6 * 1024 ** 3,
    priority: 'niedrig',
    protected: false,
    throttled: null,
    isGame: true,
    gameId: 'game-000001',
  };

  it('at most 3 per list', () => {
    const ok = { byCpu: [tc, tc, tc], byRam: [], updatedAt: '2026-11-26T10:00:00.000Z' };
    expect(topConsumersResponseSchema.safeParse(ok).success).toBe(true);
    expect(topConsumersResponseSchema.safeParse({ ...ok, byRam: [tc, tc, tc, tc] }).success).toBe(
      false,
    );
  });
});

describe('insufficient_ram error', () => {
  it('is an API and share error code; details only for the admin API', () => {
    expect(errorCodeSchema.safeParse('insufficient_ram').success).toBe(true);
    expect(shareErrorCodeSchema.safeParse('insufficient_ram').success).toBe(true);
    const details = { freeBytes: 2e9, reserveBytes: 1e9, neededBytes: 4e9 };
    expect(
      errorResponseSchema.safeParse({ ok: false, error: 'insufficient_ram', details }).success,
    ).toBe(true);
    expect(insufficientRamDetailsSchema.safeParse({ ...details, freeBytes: -1 }).success).toBe(
      false,
    );
    expect(insufficientRamDetailsSchema.safeParse({ ...details, x: 1 }).success).toBe(false);
  });

  it('ram_unknown is an API code only (share links answer it as unavailable)', () => {
    expect(errorCodeSchema.safeParse('ram_unknown').success).toBe(true);
    expect(shareErrorCodeSchema.safeParse('ram_unknown').success).toBe(false);
  });
});

describe('summaries and audit actions', () => {
  it('container summaries carry priority and throttle state', () => {
    const shape = containerSummarySchema.shape;
    for (const k of ['priority', 'allowStop', 'protected', 'gameId', 'throttled', 'autoStopped']) {
      expect(Object.hasOwn(shape, k), k).toBe(true);
    }
  });

  it('lists the rule set audit actions', () => {
    for (const a of [
      'throttle.applied',
      'throttle.removed',
      'container.auto_stopped',
      'container.auto_restarted',
      'container.restart_failed',
    ]) {
      expect(throttleAuditActionSchema.safeParse(a).success, a).toBe(true);
    }
  });
});
