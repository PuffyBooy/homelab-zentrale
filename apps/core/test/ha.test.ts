import { afterEach, describe, expect, it } from 'vitest';
import {
  haAvailableResponseSchema,
  haItemResponseSchema,
  haSettingsSchema,
  haStateSchema,
  liveHaTopicItemSchema,
  type HaState,
} from '@hz/shared';
import { listen, stepUp, until, WsClient } from './agent-helpers.js';
import {
  closeHa,
  FakeHa,
  haRequest,
  HA_TOKEN,
  OTHER_HA_TOKEN,
  withHa,
  type HaSetup,
} from './ha-helpers.js';
import { HA_ALERT_AFTER_MS, HA_PENDING_MS } from '../src/homeassistant/service.js';
import {
  CONFIRM_AFTER_MS,
  EnergyStore,
  MAX_JUMP_KWH,
  MAX_POWER_KW,
  toKwh,
  toWatts,
  viennaMonth,
} from '../src/homeassistant/energy.js';
import { haWebSocketUrl } from '../src/homeassistant/protocol.js';
import { openDatabase } from '../src/db/index.js';
import { auditLog } from '../src/db/schema.js';
import { makeApp, completeSetup, type TestApp } from './helpers.js';

let s: HaSetup | undefined;
let plain: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await closeHa(s);
  s = undefined;
  await plain?.app.close();
  plain = undefined;
});

const state = async (x: HaSetup): Promise<HaState> =>
  haStateSchema.parse((await haRequest(x, 'GET', '/api/ha/state')).json());
const item = (st: HaState, id: string) => {
  const i = st.items.find((x) => x.entityId === id);
  if (!i) throw new Error(`no item ${id}`);
  return i;
};

describe('ha connection and settings', () => {
  it('is off without URL and token', async () => {
    plain = await makeApp();
    const { cookie } = await completeSetup(plain);
    const res = await plain.app.inject({
      method: 'GET',
      url: '/api/ha/settings',
      headers: { host: 'hz.test', origin: 'https://hz.test', cookie: `hz_session=${cookie}` },
    });
    expect(haSettingsSchema.parse(res.json())).toMatchObject({
      url: null,
      tokenSet: false,
      status: 'off',
      error: null,
      pricePerKwh: 0.25,
    });
  });

  it('connects with the token and reports version and time', async () => {
    s = await withHa();
    const st = haSettingsSchema.parse((await haRequest(s, 'GET', '/api/ha/settings')).json());
    expect(st).toMatchObject({
      url: s.ha.url,
      tokenSet: true,
      status: 'connected',
      error: null,
      haVersion: '2026.11.3',
      energyEntityId: 'sensor.energy',
      powerEntityId: 'sensor.power',
    });
    expect(st.lastConnectedAt).not.toBeNull();
    const auth = s.ha.frames.find((f) => (f as { type?: string }).type === 'auth');
    expect(auth).toEqual({ type: 'auth', access_token: HA_TOKEN });
  });

  it('a wrong token is "Token ungültig" in the PUT answer', async () => {
    s = await withHa({ connect: false });
    await stepUp(s.t, s.secret, s.cookie);
    const res = await haRequest(s, 'PUT', '/api/ha/settings', {
      url: s.ha.url,
      token: OTHER_HA_TOKEN,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'unreachable', error: 'Token ungültig' });
  });

  it('an address without HA is "Nicht erreichbar"', async () => {
    s = await withHa({ connect: false });
    const port = s.ha.port;
    await s.ha.stop();
    await stepUp(s.t, s.secret, s.cookie);
    const res = await haRequest(s, 'PUT', '/api/ha/settings', {
      url: `http://127.0.0.1:${port}`,
      token: HA_TOKEN,
    });
    expect(res.json()).toMatchObject({ status: 'unreachable', error: 'Nicht erreichbar' });
  });

  it('price and sensors change without step-up', async () => {
    s = await withHa();
    const res = await haRequest(s, 'PUT', '/api/ha/settings', {
      pricePerKwh: 0.3,
      powerEntityId: null,
      url: s.ha.url,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      pricePerKwh: 0.3,
      powerEntityId: null,
      status: 'connected',
    });
  });

  it('builds the websocket URL from http/https and keeps a path prefix', () => {
    expect(haWebSocketUrl('http://192.168.1.20:8123')).toBe('ws://192.168.1.20:8123/api/websocket');
    expect(haWebSocketUrl('https://ha.example.ts.net/')).toBe(
      'wss://ha.example.ts.net/api/websocket',
    );
    expect(haWebSocketUrl('https://x.example/ha/')).toBe('wss://x.example/ha/api/websocket');
  });
});

describe('ha entities and state', () => {
  it('lists the entities HA knows with kinds and area names', async () => {
    s = await withHa();
    const res = await haRequest(s, 'GET', '/api/ha/available');
    const { entities } = haAvailableResponseSchema.parse(res.json());
    const by = new Map(entities.map((e) => [e.entityId, e]));
    expect(by.get('light.bed_light')).toMatchObject({
      name: 'Bettlicht',
      area: 'Schlafzimmer',
      kinds: ['toggle'],
    });
    expect(by.get('light.kitchen')?.area).toBe('Küche');
    expect(by.get('switch.decorative_lights')?.kinds).toEqual(['toggle', 'button']);
    expect(by.get('lock.front_door')?.kinds).toEqual(['button']);
    expect(by.get('sensor.outside_temperature')).toMatchObject({
      unit: '°C',
      deviceClass: 'temperature',
      kinds: ['metric'],
    });
    expect(by.has('automation.night')).toBe(false);
  });

  it('config round-trips; unknown rooms are refused, unknown entities shown unavailable', async () => {
    s = await withHa();
    const cfg = await haRequest(s, 'GET', '/api/ha/config');
    expect(cfg.json().entities).toHaveLength(8);
    const bad = await haRequest(s, 'PUT', '/api/ha/config', {
      rooms: [],
      entities: [
        { entityId: 'light.a', kind: 'toggle', roomId: 'nope', label: null, overview: false },
      ],
    });
    expect(bad.statusCode).toBe(400);
    const st = await state(s);
    expect(item(st, 'light.not_in_ha')).toMatchObject({ available: false, state: 'unavailable' });
    expect(item(st, 'light.bed_light')).toMatchObject({
      state: 'off',
      available: true,
      label: 'Bettlicht',
      roomId: 'schlafzimmer',
      pending: false,
      lastChanged: '2026-11-25T11:00:00.123Z',
    });
    expect(item(st, 'switch.decorative_lights').label).toBe('Deko');
    expect(item(st, 'sensor.outside_temperature')).toMatchObject({ value: 15.6, unit: '°C' });
    expect(item(st, 'climate.hvac')).toMatchObject({ state: 'heat', value: 21.5, unit: '°C' });
    expect(item(st, 'button.intercom')).toMatchObject({ state: 'unknown', available: true });
    expect(st.rooms.map((r) => r.id)).toEqual(['schlafzimmer', 'wohnzimmer']);
    expect(st.energy).toEqual({ powerW: 412, monthKwh: 0, monthEur: 0, pricePerKwh: 0.25 });
    const audit = s.t.db.db.select().from(auditLog).all();
    expect(audit.some((a) => a.action === 'ha.config')).toBe(true);
  });

  it('pushes the state on topic ha: snapshot, then full-state upserts', async () => {
    s = await withHa();
    const url = await listen(s.t);
    const live = await WsClient.connect(`${url}/live`, {
      cookie: `hz_session=${s.cookie}`,
      origin: url.replace('ws://', 'http://'),
    });
    clients.push(live);
    live.send({ type: 'subscribe', topics: ['ha'] });
    const snap = await live.nextOfType('snapshot');
    const first = liveHaTopicItemSchema.parse(snap.data);
    expect(item(first, 'sensor.outside_temperature').value).toBe(15.6);

    s.ha.put('sensor.outside_temperature', '16.1');
    const up = await live.next(
      (m) =>
        m.type === 'update' &&
        m.topic === 'ha' &&
        item(liveHaTopicItemSchema.parse((m.upsert as unknown[])[0]), 'sensor.outside_temperature')
          .value === 16.1,
    );
    expect(up.upsert).toHaveLength(1);

    // A light switched in HA itself shows up live, too.
    s.ha.put('light.bed_light', 'on');
    await live.next(
      (m) =>
        m.type === 'update' &&
        item(liveHaTopicItemSchema.parse((m.upsert as unknown[])[0]), 'light.bed_light').state ===
          'on',
    );
  });
});

describe('ha actions', () => {
  it('toggle calls <domain>.turn_on/turn_off for exactly that entity', async () => {
    s = await withHa();
    const on = await haRequest(s, 'POST', '/api/ha/entities/light.bed_light/toggle', { on: true });
    expect(on.statusCode).toBe(200);
    haItemResponseSchema.parse(on.json());
    expect(s.ha.calls).toEqual([
      {
        domain: 'light',
        service: 'turn_on',
        target: { entity_id: 'light.bed_light' },
        serviceData: undefined,
      },
    ]);
    await until(() => s?.t.app.hzCore.ha.state().items[0]?.state === 'on');
    expect(item(await state(s), 'light.bed_light')).toMatchObject({ state: 'on', pending: false });
    expect(s.ha.states.get('light.bed_light')?.state).toBe('on');

    await haRequest(s, 'POST', '/api/ha/entities/switch.decorative_lights/toggle', { on: false });
    expect(s.ha.calls[1]).toMatchObject({ domain: 'switch', service: 'turn_off' });
    const audit = s.t.db.db.select().from(auditLog).all();
    expect(audit.filter((a) => a.action === 'ha.toggle').map((a) => a.target)).toEqual([
      'light.bed_light',
      'switch.decorative_lights',
    ]);
  });

  it('pending stays until HA reports the change, at most 10 s', async () => {
    s = await withHa();
    s.ha.silentCalls = true;
    const res = await haRequest(s, 'POST', '/api/ha/entities/light.bed_light/toggle', { on: true });
    expect(haItemResponseSchema.parse(res.json()).item.pending).toBe(true);
    s.t.clock.advance(HA_PENDING_MS - 1000);
    s.t.app.hzCore.ha.tick();
    expect(item(await state(s), 'light.bed_light').pending).toBe(true);
    s.t.clock.advance(1000);
    s.t.app.hzCore.ha.tick();
    expect(item(await state(s), 'light.bed_light')).toMatchObject({ pending: false, state: 'off' });
  });

  it('a refused service call is a fixed 502 without HA internals', async () => {
    s = await withHa();
    s.ha.failing.add('light.turn_on');
    const res = await haRequest(s, 'POST', '/api/ha/entities/light.bed_light/toggle', { on: true });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      ok: false,
      error: 'ha_error',
      message: 'Home Assistant hat die Aktion abgelehnt',
    });
    expect(item(await state(s), 'light.bed_light').pending).toBe(false);
  });

  it('a configured entity HA does not know is 409', async () => {
    s = await withHa();
    const res = await haRequest(s, 'POST', '/api/ha/entities/light.not_in_ha/toggle', { on: true });
    expect(res.statusCode).toBe(409);
    expect(s.ha.calls).toEqual([]);
  });

  it('press maps lock (open) and button, with step-up', async () => {
    s = await withHa();
    await stepUp(s.t, s.secret, s.cookie);
    for (const id of ['lock.front_door', 'button.intercom']) {
      const res = await haRequest(s, 'POST', `/api/ha/entities/${id}/press`, { confirm: true });
      expect(res.statusCode, id).toBe(200);
    }
    expect(s.ha.calls.map((c) => `${c.domain}.${c.service}`)).toEqual([
      'lock.open',
      'button.press',
    ]);
    const audit = s.t.db.db.select().from(auditLog).all();
    expect(
      audit.filter((a) => a.action === 'ha.press').map((a) => [a.target, a.detailsJson]),
    ).toEqual([
      ['lock.front_door', '{"service":"lock.open"}'],
      ['button.intercom', '{"service":"button.press"}'],
    ]);
  });

  it('a lock without the OPEN feature is refused (409), never unlocked instead', async () => {
    s = await withHa();
    await stepUp(s.t, s.secret, s.cookie);
    const res = await haRequest(s, 'POST', '/api/ha/entities/lock.cellar/press', { confirm: true });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      ok: false,
      error: 'conflict',
      message: 'Schloss kann nur auf-/zusperren',
    });
    expect(s.ha.calls).toEqual([]);
    expect(
      s.t.db.db
        .select()
        .from(auditLog)
        .all()
        .some((a) => a.action === 'ha.press'),
    ).toBe(false);
  });
});

describe('ha reconnect and alerts', () => {
  it('reconnects after an HA restart and keeps receiving changes', async () => {
    s = await withHa();
    const ha = s.t.app.hzCore.ha;
    await s.ha.restart(150);
    await until(() => s?.ha.connections === 2 && ha.settings().status === 'connected', 5000);
    s.ha.put('sensor.outside_temperature', '9.5');
    await until(() => ha.state().items.find((i) => i.entityId.startsWith('sensor'))?.value === 9.5);
  });

  it('drops a connection without pong and connects again', async () => {
    s = await withHa();
    s.ha.answerPings = false;
    await until(() => (s?.ha.connections ?? 0) >= 2, 5000);
    s.ha.answerPings = true;
    await until(() => s?.t.app.hzCore.ha.settings().status === 'connected', 5000);
  });

  it('HA down for more than 2 min: warn alert, OK alert after recovery', async () => {
    s = await withHa();
    const ha = s.t.app.hzCore.ha;
    const alerts = s.t.app.hzCore.alerts;
    const port = s.ha.port;
    await s.ha.stop();
    await until(() => ha.settings().status === 'unreachable', 5000);
    expect(ha.state().items.every((i) => !i.available)).toBe(true);
    expect(ha.state()).toMatchObject({ status: 'unreachable', error: 'Nicht erreichbar' });
    s.t.clock.advance(HA_ALERT_AFTER_MS - 1000);
    ha.tick();
    expect(alerts.active('ha:unreachable')).toBeNull();
    s.t.clock.advance(2000);
    ha.tick();
    ha.tick();
    const open = alerts.list({ state: 'active', limit: 10 });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      level: 'warn',
      title: 'Home Assistant nicht erreichbar',
      source: 'ha',
      key: 'ha:unreachable',
    });
    await s.ha.start(port);
    await until(() => ha.settings().status === 'connected', 5000);
    expect(alerts.active('ha:unreachable')).toBeNull();
    const ok = alerts.list({ state: 'all', limit: 10 }).filter((a) => a.level === 'ok');
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({
      title: 'Home Assistant wieder erreichbar',
      key: 'ha:unreachable',
    });
  });

  it('a short drop (HA restart) shows connecting, not unreachable', async () => {
    s = await withHa({ haOptions: { backoffBaseMs: 2_000, requestTimeoutMs: 1_000 } });
    const ha = s.t.app.hzCore.ha;
    for (const ws of s.ha.sockets) ws.terminate();
    await until(() => ha.settings().status === 'connecting');
    expect(ha.settings().error).toBeNull();
  });
});

describe('ha energy', () => {
  it('monthKwh = meter now - meter at the start of the month, € rounded to cents', async () => {
    s = await withHa();
    s.ha.put('sensor.energy', '1012.345');
    await until(() => s?.t.app.hzCore.ha.state().energy?.monthKwh === 11.845);
    expect((await state(s)).energy).toEqual({
      powerW: 412,
      monthKwh: 11.845,
      monthEur: 2.96,
      pricePerKwh: 0.25,
    });
    s.ha.put('sensor.power', '1.5', { unit_of_measurement: 'kW' });
    await until(() => s?.t.app.hzCore.ha.state().energy?.powerW === 1500);
  });

  it('unit conversion', () => {
    expect(toKwh('1500', 'Wh')).toBe(1.5);
    expect(toKwh('2', 'MWh')).toBe(2000);
    expect(toKwh('unavailable', 'kWh')).toBeNull();
    expect(toKwh('', 'kWh')).toBeNull();
    expect(toWatts('0.4', 'kW')).toBe(400);
    expect(toWatts('400', 'W')).toBe(400);
    // Unknown unit: no value instead of guessing kWh / W.
    expect(toKwh('12', null)).toBeNull();
    expect(toKwh('12', 'm³')).toBeNull();
    expect(toKwh('12', 'kwh')).toBeNull();
    expect(toWatts('12', null)).toBeNull();
    expect(toWatts('12', 'VA')).toBeNull();
  });

  it('baseline per Vienna month, rollover and meter reset', () => {
    const h = openDatabase(':memory:');
    try {
      const e = new EnergyStore(h.db);
      // 30 Nov 23:30 UTC is already 1 Dec 00:30 in Vienna.
      const nov = Date.UTC(2026, 10, 30, 22, 0);
      const dec = Date.UTC(2026, 10, 30, 23, 30);
      expect(viennaMonth(nov)).toBe('2026-11');
      expect(viennaMonth(dec)).toBe('2026-12');

      e.record('sensor.energy', 100, nov);
      expect(e.monthKwh('sensor.energy', nov)).toBe(0);
      e.record('sensor.energy', 130, nov + 1000);
      expect(e.monthKwh('sensor.energy', nov)).toBe(30);
      // New month: starts at the last reading of November.
      expect(e.monthKwh('sensor.energy', dec)).toBeNull();
      e.record('sensor.energy', 135, dec);
      expect(e.monthKwh('sensor.energy', dec)).toBe(5);
      // A small dip is noise.
      e.record('sensor.energy', 134.9, dec + 500);
      expect(e.monthKwh('sensor.energy', dec)).toBe(5);
      // Meter reset (to 0, now at 2): a suspect until the next reading confirms it,
      // then the 5 kWh stay and the 4 count.
      e.record('sensor.energy', 2, dec + 1000);
      expect(e.monthKwh('sensor.energy', dec)).toBe(5);
      expect(e.hasSuspect('sensor.energy')).toBe(true);
      e.record('sensor.energy', 4, dec + 2000);
      expect(e.monthKwh('sensor.energy', dec)).toBe(9);
      expect(e.hasSuspect('sensor.energy')).toBe(false);
      e.record('sensor.energy', 5, dec + 3000);
      expect(e.monthKwh('sensor.energy', dec)).toBe(10);
      // Another sensor: new baseline.
      e.record('sensor.other', 500, dec + 4000);
      expect(e.monthKwh('sensor.other', dec)).toBe(0);
      expect(e.monthKwh('sensor.energy', dec)).toBeNull();
      expect(EnergyStore.euro(9.005, 0.25)).toBe(2.25);
      expect(EnergyStore.euro(null, 0.25)).toBeNull();
    } finally {
      h.close();
    }
  });

  it('a brief 0 (meter reboot) and back is a glitch: the month keeps its baseline', () => {
    const h = openDatabase(':memory:');
    try {
      const e = new EnergyStore(h.db);
      const t0 = Date.UTC(2026, 10, 10, 12, 0);
      e.record('sensor.energy', 1000, t0);
      e.record('sensor.energy', 1010, t0 + 60_000);
      e.record('sensor.energy', 0, t0 + 120_000);
      expect(e.monthKwh('sensor.energy', t0)).toBe(10);
      e.record('sensor.energy', 1010.5, t0 + 180_000);
      expect(e.monthKwh('sensor.energy', t0)).toBe(10.5);
      expect(e.hasSuspect('sensor.energy')).toBe(false);
      // Two zeros in a row with the same value: confirmed only after 5 min.
      e.record('sensor.energy', 0, t0 + 240_000);
      e.record('sensor.energy', 0, t0 + 250_000);
      expect(e.monthKwh('sensor.energy', t0)).toBe(10.5);
      e.record('sensor.energy', 0, t0 + 240_000 + CONFIRM_AFTER_MS);
      expect(e.monthKwh('sensor.energy', t0)).toBe(10.5);
      e.record('sensor.energy', 0.5, t0 + 250_000 + CONFIRM_AFTER_MS);
      expect(e.monthKwh('sensor.energy', t0)).toBe(11);
    } finally {
      h.close();
    }
  });

  it(`a single implausible jump (> ${MAX_JUMP_KWH} kWh + ${MAX_POWER_KW} kW × time) is ignored`, () => {
    const h = openDatabase(':memory:');
    try {
      const e = new EnergyStore(h.db);
      const t0 = Date.UTC(2026, 10, 10, 12, 0);
      e.record('sensor.energy', 1000, t0);
      // Unit flip for one reading (Wh reported as kWh): ignored.
      e.record('sensor.energy', 1_000_500, t0 + 60_000);
      expect(e.monthKwh('sensor.energy', t0)).toBe(0);
      e.record('sensor.energy', 1001, t0 + 120_000);
      expect(e.monthKwh('sensor.energy', t0)).toBe(1);
      // 60 kWh in a minute is within the 100 kWh allowance (rare reporting).
      e.record('sensor.energy', 1061, t0 + 180_000);
      expect(e.monthKwh('sensor.energy', t0)).toBe(61);
      // 10 h without a reading: 100 + 500 kWh are plausible.
      e.record('sensor.energy', 1561, t0 + 180_000 + 10 * 3_600_000);
      expect(e.monthKwh('sensor.energy', t0)).toBe(561);
      // A new meter that stays high: confirmed, counting goes on from there.
      const t1 = t0 + 11 * 3_600_000;
      e.record('sensor.energy', 50_000, t1);
      expect(e.monthKwh('sensor.energy', t1)).toBe(561);
      e.record('sensor.energy', 50_002, t1 + 60_000);
      expect(e.monthKwh('sensor.energy', t1)).toBe(563);
    } finally {
      h.close();
    }
  });

  it('energy sensors need a matching unit; unknown sensors are accepted', async () => {
    s = await withHa();
    s.ha.put('sensor.water', '12', { unit_of_measurement: 'm³' });
    s.ha.put('sensor.no_unit', '12', {});
    await until(
      () => s?.t.app.hzCore.ha.available().some((a) => a.entityId === 'sensor.no_unit') === true,
    );
    for (const [payload, msg] of [
      [{ energyEntityId: 'sensor.water' }, 'Energiesensor braucht die Einheit Wh, kWh oder MWh'],
      [{ energyEntityId: 'sensor.no_unit' }, 'Energiesensor braucht die Einheit Wh, kWh oder MWh'],
      [{ energyEntityId: 'sensor.power' }, 'Energiesensor braucht die Einheit Wh, kWh oder MWh'],
      [{ powerEntityId: 'sensor.energy' }, 'Leistungssensor braucht die Einheit W oder kW'],
    ] as const) {
      const res = await haRequest(s, 'PUT', '/api/ha/settings', payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json()).toMatchObject({ ok: false, error: 'invalid_input', message: msg });
    }
    expect(s.t.app.hzCore.ha.settings()).toMatchObject({
      energyEntityId: 'sensor.energy',
      powerEntityId: 'sensor.power',
    });
    const ok = await haRequest(s, 'PUT', '/api/ha/settings', {
      energyEntityId: 'sensor.not_yet_in_ha',
      powerEntityId: 'sensor.power',
    });
    expect(ok.statusCode).toBe(200);
    // A sensor whose unit is unknown shows no value instead of assuming kWh.
    s.ha.put('sensor.power', '300', { unit_of_measurement: 'VA' });
    await until(() => s?.t.app.hzCore.ha.state().energy?.powerW === null);
  });

  it('a new month starts on the tick even without a new reading', async () => {
    s = await withHa();
    s.ha.put('sensor.energy', '1010.5');
    await until(() => s?.t.app.hzCore.ha.state().energy?.monthKwh === 10);
    // T0 is 25 Nov; move to 1 Dec 00:00:05 Vienna.
    s.t.clock.t = Date.UTC(2026, 10, 30, 23, 0, 5);
    const ha = s.t.app.hzCore.ha;
    expect(ha.state().energy?.monthKwh).toBeNull();
    ha.tick();
    expect(ha.state().energy).toMatchObject({ monthKwh: 0, monthEur: 0 });
  });
});

describe('fake HA sanity', () => {
  it('serves the demo entities', () => {
    const ha = new FakeHa();
    expect(ha.states.get('light.bed_light')?.state).toBe('off');
  });
});
