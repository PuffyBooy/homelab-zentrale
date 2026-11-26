import { afterEach, describe, expect, it } from 'vitest';
import { HttpError } from '../src/http/errors.js';
import { stepUp, until, type WsClient } from './agent-helpers.js';
import { createGame } from './games-helpers.js';
import { SAME_ORIGIN } from './helpers.js';
import {
  closeVoice,
  configure,
  putGame,
  settle,
  setupVoiceTest,
  STATUS,
  SWITCH,
  triggers,
  ups,
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

const body = { switchEntity: SWITCH, statusEntity: STATUS, allowStop: false };
const dropStepUp = (v: VoiceSetup) =>
  v.s.t.db.sqlite.prepare('UPDATE sessions SET step_up_until = NULL').run();

describe('voice: auth and step-up', () => {
  it('routes need the admin session', async () => {
    const v = await setup();
    expect((await v.side.app.inject({ method: 'GET', url: '/api/voice' })).statusCode).toBe(401);
    const res = await v.side.app.inject({
      method: 'PUT',
      url: `/api/voice/games/${v.game.id}`,
      headers: SAME_ORIGIN,
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it('a new switch entity needs step-up', async () => {
    const v = await setup();
    dropStepUp(v);
    const res = await putGame(v, v.game.id, body);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'step_up_required' });
    expect((await putGame(v, v.game.id, { ...body, switchEntity: null })).statusCode).toBe(200);
  });

  it('turning allowStop on needs step-up, a status entity alone does not', async () => {
    const v = await setup();
    await stepUp(v.s.t, v.s.secret, v.s.cookie);
    expect((await putGame(v, v.game.id, body)).statusCode).toBe(200);
    dropStepUp(v);
    expect((await putGame(v, v.game.id, { ...body, allowStop: true })).statusCode).toBe(403);
    expect(
      (await putGame(v, v.game.id, { ...body, statusEntity: 'input_text.other' })).statusCode,
    ).toBe(200);
    // Another switch entity: step-up again.
    expect(
      (await putGame(v, v.game.id, { ...body, switchEntity: 'input_boolean.other' })).statusCode,
    ).toBe(403);
    await stepUp(v.s.t, v.s.secret, v.s.cookie);
    expect((await putGame(v, v.game.id, { ...body, allowStop: true })).statusCode).toBe(200);
    dropStepUp(v);
    // Turning it off again is always allowed.
    expect((await putGame(v, v.game.id, body)).statusCode).toBe(200);
  });

  it('one switch belongs to one game (409)', async () => {
    const v = await setup();
    const res = await createGame(v.s, { name: 'creative' });
    expect(res.statusCode).toBe(202);
    const other = (res.json() as { game: { id: string } }).game.id;
    await stepUp(v.s.t, v.s.secret, v.s.cookie);
    expect((await putGame(v, v.game.id, body)).statusCode).toBe(200);
    expect((await putGame(v, other, { ...body, statusEntity: null })).statusCode).toBe(409);
    expect(
      (await putGame(v, other, { ...body, switchEntity: 'input_boolean.creative' })).statusCode,
    ).toBe(409);
  });
});

describe('voice: limits of the control from outside', () => {
  it('a start through the switch honours the RAM reserve (unknown RAM is refused)', async () => {
    const v = await setup();
    await configure(v, { allowStop: true });
    await until(() => v.ha.states.get(SWITCH)?.state === 'on');
    await settle(v);
    v.ha.put(SWITCH, 'off');
    await settle(v);
    // Metrics get stale (no metrics for more than 60 s): a voice start is refused.
    v.s.t.clock.advance(2 * 60_000);
    await v.s.keepAlive();
    const u0 = ups(v);
    v.ha.put(SWITCH, 'on');
    await settle(v);
    expect(ups(v)).toBe(u0);
    expect(triggers(v).at(-1)).toMatchObject({ to: 'on', result: 'failed', error: 'ram_unknown' });
    // The switch shows the truth again.
    await until(() => v.ha.states.get(SWITCH)?.state === 'off');
  });

  it('the hub only ever calls helper services on configured helper entities', async () => {
    const v = await setup();
    await configure(v, { allowStop: true });
    await until(() => v.ha.states.get(SWITCH)?.state === 'on');
    await settle(v);
    for (const c of v.ha.calls) {
      const target = (c.target as { entity_id: string }).entity_id;
      expect([SWITCH, STATUS]).toContain(target);
      expect(['input_boolean.turn_on', 'input_boolean.turn_off', 'input_text.set_value']).toContain(
        `${c.domain}.${c.service}`,
      );
    }
    const ha = v.s.t.app.hzCore.ha;
    await expect(ha.setHelper('lock.front_door', true)).rejects.toBeInstanceOf(HttpError);
    await expect(ha.setHelper('input_boolean.x', 'text')).rejects.toBeInstanceOf(HttpError);
    await expect(ha.setHelper('input_text.x', true)).rejects.toBeInstanceOf(HttpError);
  });

  it('status texts are friend-safe and at most 100 characters', async () => {
    const v = await setup();
    await configure(v);
    await until(() => v.ha.calls.some((c) => c.service === 'set_value'));
    for (const c of v.ha.calls.filter((x) => x.service === 'set_value')) {
      const value = (c.serviceData as { value: string }).value;
      expect(value.length).toBeLessThanOrEqual(100);
      expect(value).not.toMatch(/100\.\d+|ts\.net|heimserver|steve|mia/);
    }
  });
});
