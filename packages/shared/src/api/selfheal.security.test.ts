import { describe, expect, it } from 'vitest';
import {
  defaultSelfhealSettings,
  selfhealAlertKey,
  selfhealEventSchema,
  selfhealResponseSchema,
  selfhealRuleParamsSchema,
  selfhealRuleRequestSchema,
  selfhealSettingsSchema,
  selfhealStateSchema,
  SELFHEAL_MODE_LABELS,
} from './selfheal.js';

const SERVER = 'abcdefgh12345678';

describe('selfheal schema: settings', () => {
  it('the defaults are valid (3 restarts in 30 min, as in the roadmap)', () => {
    expect(selfhealSettingsSchema.parse(defaultSelfhealSettings)).toEqual(defaultSelfhealSettings);
    expect(defaultSelfhealSettings).toMatchObject({ maxRestarts: 3, windowMinutes: 30 });
  });

  it.each([
    ['maxRestarts', 0],
    ['maxRestarts', 11],
    ['maxRestarts', 2.5],
    ['windowMinutes', 9],
    ['windowMinutes', 1441],
    ['minGapSeconds', 29],
    ['minGapSeconds', 3601],
    ['unhealthyGraceSeconds', 29],
    ['unhealthyGraceSeconds', 1801],
    ['checkDownMinutes', 0],
    ['checkDownMinutes', 61],
    ['defaultMode', 'always'],
    ['maxRestarts', '3'],
  ])('rejects %s = %j', (key, value) => {
    expect(
      selfhealSettingsSchema.safeParse({ ...defaultSelfhealSettings, [key]: value }).success,
    ).toBe(false);
  });

  it('is strict and complete', () => {
    expect(selfhealSettingsSchema.safeParse({ ...defaultSelfhealSettings, extra: 1 }).success).toBe(
      false,
    );
    expect(selfhealSettingsSchema.safeParse({ defaultMode: 'off' }).success).toBe(false);
  });
});

describe('selfheal schema: rules and params', () => {
  it('rule request: mode + optional check id (default null)', () => {
    expect(selfhealRuleRequestSchema.parse({ mode: 'off' })).toEqual({
      mode: 'off',
      checkId: null,
    });
    expect(
      selfhealRuleRequestSchema.safeParse({ mode: 'unhealthy', checkId: 'abcdefgh' }).success,
    ).toBe(true);
    for (const bad of [
      { mode: 'restart' },
      { mode: 'off', checkId: 'x' },
      { mode: 'off', checkId: '../../etc' },
      { mode: 'off', container: 'x' },
      {},
    ]) {
      expect(selfhealRuleRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(Object.keys(SELFHEAL_MODE_LABELS).sort()).toEqual(
      ['default', 'off', 'unhealthy', 'unhealthy_or_exited'].sort(),
    );
  });

  it('params: server id and container ref', () => {
    expect(
      selfhealRuleParamsSchema.safeParse({ serverId: SERVER, container: 'web_app-1.x' }).success,
    ).toBe(true);
    for (const container of ['../x', '/x', '.x', '', 'a'.repeat(129), 'a b']) {
      expect(
        selfhealRuleParamsSchema.safeParse({ serverId: SERVER, container }).success,
        container,
      ).toBe(false);
    }
    expect(selfhealRuleParamsSchema.safeParse({ serverId: 'x/y', container: 'a' }).success).toBe(
      false,
    );
  });
});

describe('selfheal schema: responses', () => {
  it('state and events are strict, enums closed', () => {
    const st = {
      serverId: SERVER,
      serverName: 'heimserver',
      container: 'webapp',
      phase: 'gave_up',
      attempts: 3,
      lastReason: 'unhealthy',
      lastRestartAt: 1,
    };
    expect(selfhealStateSchema.safeParse(st).success).toBe(true);
    expect(selfhealStateSchema.safeParse({ ...st, phase: 'dead' }).success).toBe(false);
    expect(selfhealStateSchema.safeParse({ ...st, attempts: -1 }).success).toBe(false);
    const ev = {
      id: 1,
      at: 1,
      serverId: SERVER,
      serverName: 'heimserver',
      container: 'webapp',
      reason: 'check_down',
      action: 'restart',
      attempt: 1,
    };
    expect(selfhealEventSchema.safeParse(ev).success).toBe(true);
    expect(selfhealEventSchema.safeParse({ ...ev, action: 'stop' }).success).toBe(false);
    expect(selfhealEventSchema.safeParse({ ...ev, reason: 'oom' }).success).toBe(false);
    expect(
      selfhealResponseSchema.safeParse({
        settings: defaultSelfhealSettings,
        rules: [],
        state: [st],
        events: [ev],
      }).success,
    ).toBe(true);
  });

  it('alert key per server and container', () => {
    expect(selfhealAlertKey(SERVER, 'webapp')).toBe(`selfheal:${SERVER}:webapp`);
  });
});
