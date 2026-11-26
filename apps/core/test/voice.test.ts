import { afterEach, describe, expect, it } from 'vitest';
import { VOICE_COOLDOWN_MS, type GameSummary } from '@hz/shared';
import { desiredSwitch, voiceStatusText } from '../src/voice/service.js';
import { stepUp, until, type WsClient } from './agent-helpers.js';
import { gameRequest } from './games-helpers.js';
import {
  callsOf,
  closeVoice,
  configure,
  downs,
  freshMetrics,
  putGame,
  settle,
  setupVoiceTest,
  STATUS,
  SWITCH,
  triggers,
  ups,
  voiceState,
  type VoiceSetup,
} from './voice-helpers.js';

const clients: WsClient[] = [];
let current: VoiceSetup | undefined;
afterEach(async () => {
  await closeVoice(current);
  current = undefined;
  for (const c of clients.splice(0)) c.ws.terminate();
});

const setup = () =>
  setupVoiceTest(clients, (v) => {
    current = v;
  });

const actorOf = (v: VoiceSetup, action: string): string[] =>
  (
    v.s.t.db.sqlite
      .prepare('SELECT actor FROM audit_log WHERE action = ? ORDER BY id')
      .all(action) as { actor: string }[]
  ).map((r) => r.actor);

describe('voice: status texts and switch position', () => {
  const base = { status: 'ok', statusText: 'Läuft', players: null } as unknown as GameSummary;
  it('builds a short German status from the friend-safe texts', () => {
    expect(
      voiceStatusText({ ...base, players: { online: 3, max: 20, names: [] } }, 'running'),
    ).toBe('Läuft, 3 Spieler');
    expect(voiceStatusText({ ...base, status: 'off', statusText: 'Gestoppt' }, 'stopped')).toBe(
      'Gestoppt',
    );
    // Internal agent texts never reach HA.
    expect(
      voiceStatusText(
        { ...base, status: 'crit', statusText: 'Container abgestürzt auf 100.64.0.5' },
        'running',
      ),
    ).toBe('Gestört');
  });
  it('switch: on while running or starting, off while stopped or stopping', () => {
    expect(desiredSwitch(base, true)).toBe(true);
    expect(desiredSwitch({ ...base, status: 'busy', statusText: 'Startet' }, false)).toBe(true);
    expect(desiredSwitch({ ...base, status: 'busy', statusText: 'Wird gestoppt' }, true)).toBe(
      false,
    );
    expect(desiredSwitch({ ...base, status: 'busy', statusText: 'Backup läuft' }, true)).toBeNull();
    expect(desiredSwitch({ ...base, status: 'off', statusText: 'Schläft' }, false)).toBe(false);
  });
});

describe('voice: Home Assistant hook', () => {
  it('onEntityState sees every entity, not only configured tiles', async () => {
    const v = await setup();
    const seen: [string, string | null][] = [];
    const off = v.s.t.app.hzCore.ha.onEntityState((id, st) => seen.push([id, st]));
    v.ha.put('sensor.not_a_tile', '7');
    v.ha.put(SWITCH, 'on');
    await until(() => seen.length >= 2);
    off();
    expect(seen).toEqual([
      ['sensor.not_a_tile', '7'],
      [SWITCH, 'on'],
    ]);
    expect(v.s.t.app.hzCore.ha.entityState(SWITCH)).toBe('on');
    // The tiles state (topic ha) is unchanged: no configured entities, no items.
    expect(v.s.t.app.hzCore.ha.state().items).toEqual([]);
  });
});

describe('voice: Home Assistant helpers', () => {
  it('lists every game and reports haReady', async () => {
    const v = await setup();
    const st = await voiceState(v);
    expect(st.haReady).toBe(true);
    expect(st.games).toEqual([
      {
        gameId: v.game.id,
        gameName: 'survival',
        switchEntity: null,
        statusEntity: null,
        allowStop: false,
        lastTriggerAt: null,
      },
    ]);
  });

  it('mirrors the running game into the switch and the status; its own echo starts nothing', async () => {
    const v = await setup();
    const before = ups(v);
    await configure(v);
    await until(() => callsOf(v, 'turn_on', SWITCH).length === 1);
    await settle(v);
    const set = callsOf(v, 'set_value', STATUS);
    expect(set.at(-1)?.serviceData).toEqual({ value: 'Läuft, 2 Spieler' });
    expect(v.ha.states.get(SWITCH)?.state).toBe('on');
    // The off->on echo of our own call is not a toggle.
    expect(ups(v)).toBe(before);
    expect(triggers(v)).toEqual([]);
    // No second write while nothing changed.
    await settle(v);
    expect(callsOf(v, 'turn_on', SWITCH)).toHaveLength(1);
  });

  it('switch off stops only with allowStop; without, the switch is set back on', async () => {
    const v = await setup();
    await configure(v);
    await until(() => v.ha.states.get(SWITCH)?.state === 'on');
    await settle(v);
    const d0 = downs(v);
    v.ha.put(SWITCH, 'off');
    await settle(v);
    expect(downs(v)).toBe(d0);
    expect(triggers(v).at(-1)).toMatchObject({ to: 'off', result: 'stop_not_allowed' });
    await until(() => v.ha.states.get(SWITCH)?.state === 'on');
    expect(callsOf(v, 'turn_on', SWITCH)).toHaveLength(2);

    await configure(v, { allowStop: true });
    v.ha.put(SWITCH, 'off');
    await settle(v);
    expect(downs(v)).toBe(d0 + 1);
    expect(triggers(v).at(-1)).toMatchObject({ to: 'off', result: 'ok' });
    expect(actorOf(v, 'game.stop').at(-1)).toBe('voice:ha');
    expect(v.ha.states.get(SWITCH)?.state).toBe('off');
    const st = await voiceState(v);
    expect(st.games[0]?.lastTriggerAt).toBe(new Date(v.s.t.clock.t).toISOString());
  });

  it('switch on starts a stopped game (as voice:ha)', async () => {
    const v = await setup();
    await configure(v);
    await until(() => v.ha.states.get(SWITCH)?.state === 'on');
    expect((await gameRequest(v.s, 'POST', `/api/games/${v.game.id}/stop`)).statusCode).toBe(200);
    await settle(v);
    // The admin's stop is mirrored: switch off (no trigger, our own echo).
    await until(() => v.ha.states.get(SWITCH)?.state === 'off');
    await settle(v);
    expect(triggers(v)).toEqual([]);
    await freshMetrics(v.s);
    const u0 = ups(v);
    v.ha.put(SWITCH, 'on');
    await settle(v);
    expect(ups(v)).toBe(u0 + 1);
    expect(triggers(v).at(-1)).toMatchObject({ to: 'on', result: 'ok' });
    expect(actorOf(v, 'game.start').at(-1)).toBe('voice:ha');
    expect(v.ha.states.get(SWITCH)?.state).toBe('on');
  });

  it('cooldown: a toggle within VOICE_COOLDOWN_MS is ignored and set back', async () => {
    const v = await setup();
    await configure(v, { allowStop: true });
    await until(() => v.ha.states.get(SWITCH)?.state === 'on');
    await settle(v);
    v.ha.put(SWITCH, 'off');
    await settle(v);
    const u0 = ups(v);
    await freshMetrics(v.s);
    v.ha.put(SWITCH, 'on');
    await settle(v);
    expect(ups(v)).toBe(u0);
    expect(triggers(v).at(-1)).toMatchObject({ to: 'on', result: 'cooldown' });
    await until(() => v.ha.states.get(SWITCH)?.state === 'off');
    // After the cooldown the same toggle works.
    v.s.t.clock.advance(VOICE_COOLDOWN_MS + 1);
    await freshMetrics(v.s);
    v.ha.put(SWITCH, 'on');
    await settle(v);
    expect(ups(v)).toBe(u0 + 1);
  });

  it('unavailable/unknown -> on is no toggle', async () => {
    const v = await setup();
    await configure(v, { allowStop: true });
    await until(() => v.ha.states.get(SWITCH)?.state === 'on');
    await settle(v);
    const d0 = downs(v);
    v.ha.put(SWITCH, 'unavailable');
    await settle(v);
    v.ha.put(SWITCH, 'off');
    await settle(v);
    expect(downs(v)).toBe(d0);
    expect(triggers(v)).toEqual([]);
  });

  it('module off: nothing is triggered or written', async () => {
    const v = await setup();
    await configure(v, { allowStop: true });
    await until(() => v.ha.states.get(SWITCH)?.state === 'on');
    await settle(v);
    v.voice.setEnabled(false);
    const calls = v.ha.calls.length;
    const d0 = downs(v);
    v.ha.put(SWITCH, 'off');
    await settle(v);
    expect(downs(v)).toBe(d0);
    expect((await gameRequest(v.s, 'POST', `/api/games/${v.game.id}/restart`)).statusCode).toBe(
      200,
    );
    await settle(v);
    expect(v.ha.calls.length).toBe(calls);
  });

  it('Home Assistant module off: haReady false and no calls', async () => {
    const v = await setup();
    await configure(v);
    await until(() => v.ha.states.get(SWITCH)?.state === 'on');
    await settle(v);
    v.s.t.app.hzCore.ha.setEnabled(false);
    expect((await voiceState(v)).haReady).toBe(false);
    const calls = v.ha.calls.length;
    expect((await gameRequest(v.s, 'POST', `/api/games/${v.game.id}/stop`)).statusCode).toBe(200);
    await settle(v);
    expect(v.ha.calls.length).toBe(calls);
    // Back on: the mirror catches up (switch off for the stopped game).
    v.s.t.app.hzCore.ha.setEnabled(true);
    await until(() => v.ha.states.get(SWITCH)?.state === 'off', 5_000);
  });

  it('PUT validates the entities, 404 unknown game, 409 switch of another game', async () => {
    const v = await setup();
    await stepUp(v.s.t, v.s.secret, v.s.cookie);
    for (const bad of [
      { switchEntity: 'switch.kitchen', statusEntity: null, allowStop: false },
      { switchEntity: 'input_boolean.X', statusEntity: null, allowStop: false },
      { switchEntity: null, statusEntity: 'sensor.temp', allowStop: false },
      { switchEntity: null, statusEntity: null },
    ]) {
      expect((await putGame(v, v.game.id, bad)).statusCode).toBe(400);
    }
    expect(
      (
        await putGame(v, 'abcdefgh1234', {
          switchEntity: SWITCH,
          statusEntity: null,
          allowStop: false,
        })
      ).statusCode,
    ).toBe(404);
    // Removing everything works and clears the entry.
    expect(
      (await putGame(v, v.game.id, { switchEntity: null, statusEntity: null, allowStop: false }))
        .statusCode,
    ).toBe(200);
    expect(
      v.s.t.db.sqlite
        .prepare("SELECT value_json AS j FROM settings WHERE key = 'voice.games'")
        .get(),
    ).toEqual({ j: '{}' });
  });
});
