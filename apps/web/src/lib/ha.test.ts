import { haStateSchema, type HaConfig, type HaItem, type HaState } from '@hz/shared';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  allowedKinds,
  configProblem,
  defaultKind,
  entityFromAvailable,
  formatEur,
  formatKwh,
  groupByRoom,
  haTileStatus,
  haSentence,
  haStateKey,
  isEnergySensor,
  isPowerSensor,
  matchesEntity,
  metricText,
  normalizeConfig,
  overviewItems,
  parsePrice,
  pressLabel,
  priceToText,
  removeRoom,
  roomIdFor,
  toggleHint,
  withPending,
  type HaAvailableEntity,
} from './ha.js';
import { PendingToggles, runToggle } from './haActions.js';
import { applyLiveMessage } from './live.js';

function item(over: Partial<HaItem> = {}): HaItem {
  return {
    entityId: 'light.wohnzimmer',
    kind: 'toggle',
    roomId: 'wohnzimmer',
    label: 'Licht Wohnzimmer',
    overview: false,
    state: 'off',
    value: null,
    unit: null,
    deviceClass: null,
    available: true,
    lastChanged: '2026-11-26T22:04:00.000Z',
    pending: false,
    ...over,
  };
}

function haState(items: HaItem[], over: Partial<HaState> = {}): HaState {
  return {
    status: 'connected',
    error: null,
    rooms: [
      { id: 'wohnzimmer', name: 'Wohnzimmer' },
      { id: 'kueche', name: 'Küche' },
      { id: 'bad', name: 'Bad' },
    ],
    items,
    energy: null,
    updatedAt: '2026-11-26T22:04:00.000Z',
    ...over,
  };
}

function avail(over: Partial<HaAvailableEntity> = {}): HaAvailableEntity {
  return {
    entityId: 'light.kueche',
    name: 'Küche',
    state: 'on',
    unit: null,
    deviceClass: null,
    area: null,
    kinds: ['toggle'],
    ...over,
  };
}

describe('metric formatting (Austrian format)', () => {
  const m = (over: Partial<HaItem>) => metricText(item({ kind: 'metric', ...over }));
  it('uses a comma and a space before the unit', () => {
    expect(m({ entityId: 'sensor.t', value: 21.43, unit: '°C', state: '21.43' })).toBe('21,4 °C');
    expect(m({ entityId: 'sensor.h', value: 48.6, unit: '%', state: '48.6' })).toBe('49 %');
    expect(m({ entityId: 'sensor.co2', value: 612.2, unit: 'ppm' })).toBe('612 ppm');
    expect(m({ entityId: 'sensor.p', value: 1240.4, unit: 'W' })).toBe('1240 W');
    expect(m({ entityId: 'sensor.e', value: 123.456, unit: 'kWh' })).toBe('123,5 kWh');
    expect(m({ entityId: 'climate.hvac', value: 21.5, unit: '°C', state: 'heat' })).toBe('21,5 °C');
  });
  it('shows a dash when unavailable and text for binary sensors', () => {
    expect(m({ entityId: 'sensor.t', available: false, value: 3, unit: '°C' })).toBe('—');
    // HA not connected: the last value stays.
    expect(
      metricText(
        item({
          entityId: 'sensor.t',
          kind: 'metric',
          available: false,
          value: 3,
          unit: '°C',
          state: '3',
        }),
        true,
      ),
    ).toBe('3 °C');
    expect(
      metricText(
        item({ entityId: 'sensor.t', kind: 'metric', available: false, state: 'unavailable' }),
        true,
      ),
    ).toBe('—');
    expect(m({ entityId: 'binary_sensor.tuer', deviceClass: 'door', state: 'on' })).toBe('offen');
    expect(m({ entityId: 'binary_sensor.tuer', deviceClass: 'door', state: 'off' })).toBe('zu');
    expect(m({ entityId: 'binary_sensor.x', state: 'on' })).toBe('an');
    expect(m({ entityId: 'sensor.mode', state: 'eco', value: null })).toBe('eco');
  });
  it('formats euros and prices', () => {
    expect(formatEur(12.4)).toBe('12,40 €');
    expect(formatEur(0.001)).toBe('0,00 €');
    expect(formatEur(1234.56)).toBe('1.234,56 €');
    expect(formatEur(1_234_567.8)).toBe('1.234.567,80 €');
    expect(formatKwh(123.45)).toBe('123,5');
    expect(formatKwh(1234.5)).toBe('1.234,5');
    expect(formatKwh(0.01)).toBe('0');
    expect(priceToText(0.25)).toBe('0,25');
    expect(priceToText(0.2345)).toBe('0,2345');
  });
  it('parses prices with comma or dot', () => {
    expect(parsePrice('0,25')).toBe(0.25);
    expect(parsePrice(' 0.31 ')).toBe(0.31);
    expect(parsePrice('0,25 €')).toBe(0.25);
    expect(parsePrice('6')).toBeNull();
    expect(parsePrice('abc')).toBeNull();
    expect(parsePrice('')).toBeNull();
    expect(parsePrice('-1')).toBeNull();
  });
});

describe('grouping and overview', () => {
  it('keeps room order, hides empty rooms and puts loose items last', () => {
    const s = haState([
      item({ entityId: 'light.a', roomId: 'kueche' }),
      item({ entityId: 'light.b', roomId: null }),
      item({ entityId: 'light.c', roomId: 'wohnzimmer' }),
      item({ entityId: 'light.d', roomId: 'gone' }),
    ]);
    const groups = groupByRoom(s);
    expect(groups.map((g) => g.name)).toEqual(['Wohnzimmer', 'Küche', 'Ohne Raum']);
    expect(groups[2]?.items.map((i) => i.entityId)).toEqual(['light.b', 'light.d']);
  });
  it('splits overview items into metrics and controls', () => {
    const s = haState([
      item({ entityId: 'light.a', overview: true }),
      item({ entityId: 'sensor.t', kind: 'metric', overview: true }),
      item({ entityId: 'lock.tuer', kind: 'button', overview: true }),
      item({ entityId: 'light.x' }),
    ]);
    const o = overviewItems(s);
    expect(o.metrics.map((i) => i.entityId)).toEqual(['sensor.t']);
    expect(o.controls.map((i) => i.entityId)).toEqual(['light.a', 'lock.tuer']);
  });
  it('builds the Statussatz, problems first', () => {
    expect(haSentence(haState([], { status: 'off' })).rest).toBe('Home Assistant nicht verbunden.');
    expect(haSentence(haState([], { status: 'unreachable' })).em).toBe(
      'Home Assistant nicht erreichbar',
    );
    const s = haState([
      item({ entityId: 'light.a', state: 'on' }),
      item({ entityId: 'light.b' }),
      item({ entityId: 'light.c', available: false }),
    ]);
    expect(haSentence(s)).toEqual({ em: '1 nicht verfügbar', rest: ' · 1 von 3 Schaltern an' });
    expect(haSentence(haState([item({ state: 'on' })]))).toEqual({
      em: null,
      rest: '1 von 1 Schalter an.',
    });
  });
  it('tile tone for unreachable matches the warn alert', () => {
    expect(haTileStatus({ status: 'unreachable' })).toBe('warn');
    expect(haTileStatus({ status: 'connected' })).toBe('ok');
  });

  it('hints pending, unreachable and unavailable toggles', () => {
    const s = haState([]);
    expect(toggleHint(s, item({ pending: true }))).toBe('schaltet …');
    expect(toggleHint({ ...s, status: 'unreachable' }, item())).toBe(
      'Home Assistant nicht erreichbar',
    );
    expect(toggleHint(s, item({ available: false }))).toBe('nicht verfügbar');
    expect(toggleHint(s, item())).toBeUndefined();
  });
});

describe('door buttons', () => {
  it('says "Tür öffnen" for locks and door openers', () => {
    expect(pressLabel({ entityId: 'lock.front_door', label: 'Haustür' })).toBe('Tür öffnen');
    expect(pressLabel({ entityId: 'switch.shelly_1', label: 'Türöffner' })).toBe('Tür öffnen');
    expect(pressLabel({ entityId: 'button.intercom', label: 'Gegensprechanlage' })).toBe(
      'Tür öffnen',
    );
    expect(pressLabel({ entityId: 'script.gute_nacht', label: 'Gute Nacht' })).toBe('Auslösen');
  });
});

describe('kind rules', () => {
  it('allows the kinds of the shared rule only', () => {
    expect(allowedKinds('light.x')).toEqual(['toggle']);
    expect(allowedKinds('switch.x')).toEqual(['toggle', 'button']);
    expect(allowedKinds('sensor.x')).toEqual(['metric']);
    expect(allowedKinds('climate.x')).toEqual(['metric']);
    expect(allowedKinds('lock.x')).toEqual(['button']);
    expect(allowedKinds('automation.x')).toEqual([]);
  });
  it('picks a safe default, never a toggle for a door opener', () => {
    expect(defaultKind({ entityId: 'light.x', name: 'Licht' })).toBe('toggle');
    expect(defaultKind({ entityId: 'switch.deko', name: 'Deko' })).toBe('toggle');
    expect(defaultKind({ entityId: 'switch.shelly', name: 'Türöffner' })).toBe('button');
    for (const [entityId, name] of [
      ['switch.shelly_2', 'Garagentor'],
      ['switch.garage', 'Garage'],
      ['switch.einfahrt_tor', 'Einfahrt'],
      ['switch.s1', 'Tor Hof'],
      ['switch.s2', 'Summer'],
      ['switch.s3', 'Haus Öffner'],
      ['switch.front_door', 'Front'],
      ['switch.gate', 'Gate'],
    ]) {
      expect(defaultKind({ entityId: entityId ?? '', name: name ?? '' }), name).toBe('button');
    }
    expect(defaultKind({ entityId: 'lock.front_door', name: 'Haustür' })).toBe('button');
    expect(defaultKind({ entityId: 'sensor.t', name: 'Temperatur' })).toBe('metric');
    expect(defaultKind({ entityId: 'automation.x', name: 'x' })).toBeNull();
  });
  it('flags a kind that is not allowed and duplicate room names', () => {
    const c: HaConfig = {
      rooms: [{ id: 'bad', name: 'Bad' }],
      entities: [
        { entityId: 'lock.tuer', kind: 'toggle', roomId: null, label: null, overview: false },
      ],
    };
    expect(configProblem(c)).toMatch(/lock\.tuer/);
    expect(
      configProblem({
        rooms: [
          { id: 'a', name: 'Bad' },
          { id: 'b', name: 'bad' },
        ],
        entities: [],
      }),
    ).toMatch(/zweimal/);
    expect(configProblem({ rooms: [{ id: 'a', name: '  ' }], entities: [] })).toMatch(/Namen/);
    expect(configProblem({ rooms: [], entities: [] })).toBeNull();
  });
  it('makes room ids from names', () => {
    expect(roomIdFor('Wohnzimmer', [])).toBe('wohnzimmer');
    expect(roomIdFor('Küche', [])).toBe('kueche');
    expect(roomIdFor('Büro & Gang', [])).toBe('buero-gang');
    expect(roomIdFor('Bad', ['bad', 'bad-2'])).toBe('bad-3');
    expect(roomIdFor('!!!', [])).toBe('raum');
    expect(roomIdFor('x'.repeat(80), []).length).toBeLessThanOrEqual(40);
  });
  it('moves entities of a removed room to "Ohne Raum"', () => {
    const c: HaConfig = {
      rooms: [{ id: 'bad', name: 'Bad' }],
      entities: [
        { entityId: 'light.bad', kind: 'toggle', roomId: 'bad', label: null, overview: false },
      ],
    };
    expect(removeRoom(c, 'bad')).toEqual({
      rooms: [],
      entities: [{ ...c.entities[0], roomId: null }],
    });
  });
  it('assigns the HA area to a room with the same name', () => {
    const c: HaConfig = { rooms: [{ id: 'kueche', name: 'Küche' }], entities: [] };
    expect(entityFromAvailable(c, avail({ area: 'küche' }))).toEqual({
      entityId: 'light.kueche',
      kind: 'toggle',
      roomId: 'kueche',
      label: null,
      overview: false,
    });
    expect(entityFromAvailable(c, avail({ entityId: 'automation.x', kinds: [] }))).toBeNull();
  });
  it('trims labels and drops empty ones', () => {
    const c: HaConfig = {
      rooms: [{ id: 'bad', name: ' Bad ' }],
      entities: [
        { entityId: 'light.a', kind: 'toggle', roomId: null, label: '  ', overview: false },
        { entityId: 'light.b', kind: 'toggle', roomId: null, label: ' Spiegel ', overview: false },
      ],
    };
    const n = normalizeConfig(c);
    expect(n.rooms[0]?.name).toBe('Bad');
    expect(n.entities.map((e) => e.label)).toEqual([null, 'Spiegel']);
  });
  it('filters sensors for the energy and power pickers and searches', () => {
    const e = avail({ entityId: 'sensor.energy', unit: 'kWh', kinds: ['metric'] });
    const p = avail({ entityId: 'sensor.power', deviceClass: 'power', kinds: ['metric'] });
    expect(isEnergySensor(e)).toBe(true);
    expect(isEnergySensor(p)).toBe(false);
    expect(isPowerSensor(p)).toBe(true);
    expect(isPowerSensor(avail({ unit: 'W' }))).toBe(false);
    expect(matchesEntity(avail({ area: 'Erdgeschoss' }), 'erdg')).toBe(true);
    expect(matchesEntity(avail(), 'KÜCHE')).toBe(true);
    expect(matchesEntity(avail(), 'bad')).toBe(false);
  });
});

describe('optimistic toggles', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('shows the target while in flight and the real state after', () => {
    const s = haState([item({ state: 'off' })]);
    const flight = withPending(s, new Map([['light.wohnzimmer', { on: true, inFlight: true }]]));
    expect(flight.items[0]).toMatchObject({ state: 'on', pending: true });
    // Done, but the core still waits for HA: keep showing the target.
    const waiting = withPending(
      haState([item({ state: 'off', pending: true })]),
      new Map([['light.wohnzimmer', { on: true, inFlight: false }]]),
    );
    expect(waiting.items[0]).toMatchObject({ state: 'on', pending: true });
    // Done and not pending: HA has the last word (e.g. it refused).
    const done = withPending(s, new Map([['light.wohnzimmer', { on: true, inFlight: false }]]));
    expect(done.items[0]).toMatchObject({ state: 'off', pending: false });
  });

  function respond(status: number, body: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status }))),
    );
  }

  it('writes the returned item into the cache on success', async () => {
    const qc = new QueryClient();
    qc.setQueryData(haStateKey, haState([item()]));
    const store = new PendingToggles();
    respond(200, { item: item({ state: 'off', pending: true }) });
    const p = runToggle(qc, 'light.wohnzimmer', true, store);
    expect(store.get('light.wohnzimmer')).toEqual({ on: true, inFlight: true });
    await p;
    expect(qc.getQueryData<HaState>(haStateKey)?.items[0]?.pending).toBe(true);
    expect(store.get('light.wohnzimmer')).toEqual({ on: true, inFlight: false });
  });

  it('reverts on error', async () => {
    const qc = new QueryClient();
    qc.setQueryData(haStateKey, haState([item()]));
    const store = new PendingToggles();
    respond(502, { ok: false, error: 'ha_error' });
    await expect(runToggle(qc, 'light.wohnzimmer', true, store)).rejects.toMatchObject({
      error: 'ha_error',
    });
    expect(store.get('light.wohnzimmer')).toBeUndefined();
    expect(qc.getQueryData<HaState>(haStateKey)?.items[0]?.state).toBe('off');
  });
});

describe('live topic ha', () => {
  it('stores the snapshot and every full-state update', () => {
    const qc = new QueryClient();
    const s = haState([item()]);
    expect(haStateSchema.safeParse(s).success).toBe(true);
    applyLiveMessage(qc, { type: 'snapshot', topic: 'ha', data: s });
    expect(qc.getQueryData(haStateKey)).toEqual(s);
    const next = haState([item({ state: 'on' })], { updatedAt: '2026-11-26T22:05:00.000Z' });
    applyLiveMessage(qc, { type: 'update', topic: 'ha', upsert: [next] });
    expect(qc.getQueryData<HaState>(haStateKey)?.items[0]?.state).toBe('on');
  });
  it('keeps the cache on an invalid payload and refetches', () => {
    const qc = new QueryClient();
    const s = haState([item()]);
    qc.setQueryData(haStateKey, s);
    const spy = vi.spyOn(qc, 'invalidateQueries');
    applyLiveMessage(qc, { type: 'update', topic: 'ha', upsert: [{ status: 'broken' }] });
    expect(qc.getQueryData(haStateKey)).toEqual(s);
    expect(spy).toHaveBeenCalled();
  });
});
