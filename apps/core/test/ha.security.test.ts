import type { HaConfig } from '@hz/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_API_ROUTES } from '../src/auth/guard.js';
import { HaCallError, HaClient, type HaSnapshot } from '../src/homeassistant/client.js';
import { HA_PRESS_PER_MIN, pressCall, toggleCall } from '../src/homeassistant/service.js';
import { auditLog, settings } from '../src/db/schema.js';
import { stepUp, until } from './agent-helpers.js';
import {
  closeHa,
  DEMO_CONFIG,
  FakeHa,
  FAST_HA,
  haRequest,
  HA_TOKEN,
  OTHER_HA_TOKEN,
  withHa,
  type HaSetup,
} from './ha-helpers.js';
import { HOST } from './helpers.js';

let s: HaSetup | undefined;
let extra: FakeHa | undefined;
let client: HaClient | undefined;
afterEach(async () => {
  client?.stop();
  client = undefined;
  await closeHa(s);
  s = undefined;
  await extra?.stop();
  extra = undefined;
});

const ROUTES = [
  ['GET', '/api/ha/settings'],
  ['PUT', '/api/ha/settings'],
  ['DELETE', '/api/ha/token'],
  ['GET', '/api/ha/available'],
  ['GET', '/api/ha/config'],
  ['PUT', '/api/ha/config'],
  ['GET', '/api/ha/state'],
  ['POST', '/api/ha/entities/:entityId/toggle'],
  ['POST', '/api/ha/entities/:entityId/press'],
] as const;

const ALLOWED_SERVICES = new Set([
  'light.turn_on',
  'light.turn_off',
  'switch.turn_on',
  'switch.turn_off',
  'fan.turn_on',
  'fan.turn_off',
  'input_boolean.turn_on',
  'input_boolean.turn_off',
  'button.press',
  'lock.open',
  'script.turn_on',
]);

describe('ha routes need a session', () => {
  it('registers exactly these routes and answers 401 without a session', async () => {
    s = await withHa({ connect: false });
    const registered = s.t.app.hzRoutes
      .filter((r) => r.url.startsWith('/api/ha/'))
      .map((r) => `${r.method} ${r.url}`)
      .filter((r) => !r.startsWith('HEAD '));
    expect(registered.sort()).toEqual(ROUTES.map(([m, u]) => `${m} ${u}`).sort());
    for (const [method, url] of ROUTES) {
      expect(PUBLIC_API_ROUTES).not.toContain(url);
      const res = await s.t.app.inject({
        method,
        url: url.replace(':entityId', 'light.bed_light'),
        headers: { host: HOST, origin: `https://${HOST}` },
        ...(method === 'GET' ? {} : { payload: {} }),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('mutating ha routes refuse a foreign Origin', async () => {
    s = await withHa();
    const res = await s.t.app.inject({
      method: 'POST',
      url: '/api/ha/entities/light.bed_light/toggle',
      headers: { host: HOST, origin: 'https://evil.example', cookie: `hz_session=${s.cookie}` },
      payload: { on: true },
    });
    expect(res.statusCode).toBe(403);
    expect(s.ha.calls).toEqual([]);
  });
});

describe('ha step-up', () => {
  it('URL or token change needs step-up; nothing is stored without it', async () => {
    s = await withHa({ connect: false });
    for (const payload of [{ url: s.ha.url }, { token: HA_TOKEN }]) {
      const res = await haRequest(s, 'PUT', '/api/ha/settings', payload);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ ok: false, error: 'step_up_required' });
    }
    expect(
      s.t.db.db
        .select()
        .from(settings)
        .all()
        .filter((r) => r.key.startsWith('ha.')),
    ).toEqual([]);
    expect(s.ha.connections).toBe(0);
  });

  it('a changed URL on a connected setup needs step-up again after it expired', async () => {
    s = await withHa();
    s.t.clock.advance(16 * 60_000);
    const res = await haRequest(s, 'PUT', '/api/ha/settings', { url: 'http://127.0.0.1:1' });
    expect(res.statusCode).toBe(403);
    expect(s.t.app.hzCore.ha.settings().url).toBe(s.ha.url);
  });

  it('DELETE /api/ha/token needs step-up, then disconnects and forgets the token', async () => {
    s = await withHa();
    s.t.clock.advance(16 * 60_000);
    expect((await haRequest(s, 'DELETE', '/api/ha/token')).statusCode).toBe(403);
    expect(s.t.app.hzCore.ha.settings().tokenSet).toBe(true);
    await stepUp(s.t, s.secret, s.cookie);
    expect((await haRequest(s, 'DELETE', '/api/ha/token')).statusCode).toBe(200);
    expect(s.t.app.hzCore.ha.settings()).toMatchObject({ tokenSet: false, status: 'off' });
    await until(() => s?.ha.sockets.size === 0);
    const audit = s.t.db.db.select().from(auditLog).all();
    expect(audit.some((a) => a.action === 'ha.token_cleared')).toBe(true);
  });

  it('press needs step-up and confirm: true; without them nothing reaches HA', async () => {
    s = await withHa();
    s.t.clock.advance(16 * 60_000);
    const url = '/api/ha/entities/lock.front_door/press';
    const noStep = await haRequest(s, 'POST', url, { confirm: true });
    expect(noStep.statusCode).toBe(403);
    expect(noStep.json()).toEqual({ ok: false, error: 'step_up_required' });
    await stepUp(s.t, s.secret, s.cookie);
    for (const payload of [{}, { confirm: false }, { confirm: 'true' }, { confirm: true, x: 1 }]) {
      expect((await haRequest(s, 'POST', url, payload)).statusCode, JSON.stringify(payload)).toBe(
        400,
      );
    }
    expect(s.ha.calls).toEqual([]);
    expect(
      s.t.db.db
        .select()
        .from(auditLog)
        .all()
        .some((a) => a.action === 'ha.press'),
    ).toBe(false);
    expect((await haRequest(s, 'POST', url, { confirm: true })).statusCode).toBe(200);
    expect(s.ha.calls.map((c) => `${c.domain}.${c.service}`)).toEqual(['lock.open']);
  });

  it(`press is rate limited (${HA_PRESS_PER_MIN} per minute)`, async () => {
    s = await withHa();
    await stepUp(s.t, s.secret, s.cookie);
    const url = '/api/ha/entities/button.intercom/press';
    for (let i = 0; i < HA_PRESS_PER_MIN; i++) {
      expect((await haRequest(s, 'POST', url, { confirm: true })).statusCode).toBe(200);
    }
    const limited = await haRequest(s, 'POST', url, { confirm: true });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ ok: false, error: 'rate_limited' });
    expect(s.ha.calls).toHaveLength(HA_PRESS_PER_MIN);
    s.t.clock.advance(61_000);
    expect((await haRequest(s, 'POST', url, { confirm: true })).statusCode).toBe(200);
  });
});

describe('ha config step-up (switch is toggle and door opener)', () => {
  const door = {
    entityId: 'switch.haustuer',
    kind: 'button' as const,
    roomId: null,
    label: 'Haustür',
    overview: true,
  };
  async function withDoor(): Promise<HaSetup> {
    const h = await withHa();
    h.ha.put('switch.haustuer', 'off', { friendly_name: 'Haustür' });
    await until(() => h.t.app.hzCore.ha.available().some((a) => a.entityId === door.entityId));
    await stepUp(h.t, h.secret, h.cookie);
    const res = await haRequest(h, 'PUT', '/api/ha/config', {
      ...DEMO_CONFIG,
      entities: [...DEMO_CONFIG.entities, door],
    });
    expect(res.statusCode).toBe(200);
    // Step-up expires; the session stays.
    h.t.clock.advance(16 * 60_000);
    return h;
  }
  const config = (s: HaSetup) => s.t.app.hzCore.ha.config();

  it('the attack: switch.haustuer button -> toggle without step-up is 403, nothing changes, toggle stays refused', async () => {
    s = await withDoor();
    const before = JSON.stringify(config(s));
    const res = await haRequest(s, 'PUT', '/api/ha/config', {
      ...DEMO_CONFIG,
      entities: [...DEMO_CONFIG.entities, { ...door, kind: 'toggle' }],
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ ok: false, error: 'step_up_required' });
    expect(JSON.stringify(config(s))).toBe(before);
    const t = await haRequest(s, 'POST', '/api/ha/entities/switch.haustuer/toggle', { on: true });
    expect(t.statusCode).toBe(400);
    expect(s.ha.calls).toEqual([]);
    expect(s.ha.states.get('switch.haustuer')?.state).toBe('off');
    const audit = s.t.db.db.select().from(auditLog).all();
    expect(audit.filter((a) => a.action === 'ha.config')).toHaveLength(2);
  });

  it('remove, then re-add as toggle: the re-add is a new switch and needs step-up', async () => {
    s = await withDoor();
    const removed = await haRequest(s, 'PUT', '/api/ha/config', DEMO_CONFIG);
    expect(removed.statusCode).toBe(200);
    const res = await haRequest(s, 'PUT', '/api/ha/config', {
      ...DEMO_CONFIG,
      entities: [...DEMO_CONFIG.entities, { ...door, kind: 'toggle' }],
    });
    expect(res.statusCode).toBe(403);
    expect(config(s).entities.some((e) => e.entityId === door.entityId)).toBe(false);
  });

  it('adding a switch as toggle or any button needs step-up; with step-up it works', async () => {
    s = await withHa();
    s.t.clock.advance(16 * 60_000);
    const withSwitch = {
      ...DEMO_CONFIG,
      entities: [...DEMO_CONFIG.entities, { ...door, kind: 'toggle' as const }],
    };
    expect((await haRequest(s, 'PUT', '/api/ha/config', withSwitch)).statusCode).toBe(403);
    const withButton = {
      ...DEMO_CONFIG,
      entities: [...DEMO_CONFIG.entities, { ...door, entityId: 'script.klingel' }],
    };
    expect((await haRequest(s, 'PUT', '/api/ha/config', withButton)).statusCode).toBe(403);
    expect(config(s)).toEqual(DEMO_CONFIG);
    await stepUp(s.t, s.secret, s.cookie);
    expect((await haRequest(s, 'PUT', '/api/ha/config', withSwitch)).statusCode).toBe(200);
    expect(config(s).entities.at(-1)).toMatchObject({ entityId: door.entityId, kind: 'toggle' });
  });

  it('renames, rooms, order, overview flags, removals and non-switch toggles need no step-up', async () => {
    s = await withDoor();
    const entities: HaConfig['entities'] = [...DEMO_CONFIG.entities, door]
      .filter((e) => e.entityId !== 'climate.hvac')
      .map((e) => ({
        ...e,
        label: `${e.entityId.split('.')[1] ?? 'x'}-neu`,
        overview: !e.overview,
      }))
      .reverse();
    entities.push({
      entityId: 'light.kitchen',
      kind: 'toggle',
      roomId: 'kueche',
      label: null,
      overview: false,
    });
    const res = await haRequest(s, 'PUT', '/api/ha/config', {
      rooms: [...DEMO_CONFIG.rooms, { id: 'kueche', name: 'Küche' }],
      entities,
    });
    expect(res.statusCode).toBe(200);
    expect(config(s).entities.find((e) => e.entityId === door.entityId)).toMatchObject({
      kind: 'button',
      label: 'haustuer-neu',
    });
  });

  it('an invalid config is 400 before the step-up check, without a session 401', async () => {
    s = await withDoor();
    const bad = await haRequest(s, 'PUT', '/api/ha/config', {
      rooms: [],
      entities: [{ ...door, kind: 'metric' }],
    });
    expect(bad.statusCode).toBe(400);
    const anon = await s.t.app.inject({
      method: 'PUT',
      url: '/api/ha/config',
      headers: { host: HOST, origin: `https://${HOST}`, 'content-type': 'application/json' },
      payload: DEMO_CONFIG,
    });
    expect(anon.statusCode).toBe(401);
  });
});

describe('ha allowlist', () => {
  it('entities that are not configured cannot be controlled', async () => {
    s = await withHa();
    await stepUp(s.t, s.secret, s.cookie);
    // light.kitchen exists in HA but was not selected.
    for (const id of ['light.kitchen', 'automation.night', 'homeassistant.restart']) {
      const t = await haRequest(s, 'POST', `/api/ha/entities/${id}/toggle`, { on: true });
      expect(t.statusCode, id).toBe(404);
      const p = await haRequest(s, 'POST', `/api/ha/entities/${id}/press`, { confirm: true });
      expect(p.statusCode, id).toBe(404);
    }
    expect(s.ha.calls).toEqual([]);
  });

  it('kind and domain must match: a door opener is never a toggle', async () => {
    s = await withHa();
    await stepUp(s.t, s.secret, s.cookie);
    const t = await haRequest(s, 'POST', '/api/ha/entities/lock.front_door/toggle', { on: true });
    expect(t.statusCode).toBe(400);
    const sensor = await haRequest(
      s,
      'POST',
      '/api/ha/entities/sensor.outside_temperature/toggle',
      {
        on: true,
      },
    );
    expect(sensor.statusCode).toBe(400);
    const p = await haRequest(s, 'POST', '/api/ha/entities/light.bed_light/press', {
      confirm: true,
    });
    expect(p.statusCode).toBe(400);
    // switch.decorative_lights is configured as toggle, so press is refused too.
    const sw = await haRequest(s, 'POST', '/api/ha/entities/switch.decorative_lights/press', {
      confirm: true,
    });
    expect(sw.statusCode).toBe(400);
    expect(s.ha.calls).toEqual([]);
  });

  it('a config with a wrong kind for the domain is refused', async () => {
    s = await withHa();
    const res = await haRequest(s, 'PUT', '/api/ha/config', {
      rooms: [],
      entities: [
        { entityId: 'lock.front_door', kind: 'toggle', roomId: null, label: null, overview: true },
      ],
    });
    expect(res.statusCode).toBe(400);
  });

  it('no arbitrary service: extra fields and odd ids are refused, only the fixed map is called', async () => {
    s = await withHa();
    await stepUp(s.t, s.secret, s.cookie);
    for (const payload of [
      { on: true, service: 'restart' },
      { on: true, domain: 'homeassistant' },
      { on: 'yes' },
      {},
    ]) {
      const res = await haRequest(s, 'POST', '/api/ha/entities/light.bed_light/toggle', payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    for (const id of ['light', 'Light.Bed', 'light.bed%20light', 'light.x%2F..%2Fy']) {
      const res = await haRequest(s, 'POST', `/api/ha/entities/${id}/toggle`, { on: true });
      expect(res.statusCode, id).toBe(400);
    }
    expect(s.ha.calls).toEqual([]);
    // Walk every configured entity through both actions; all calls are in the fixed map.
    for (const id of ['light.bed_light', 'switch.decorative_lights']) {
      await haRequest(s, 'POST', `/api/ha/entities/${id}/toggle`, { on: true });
      await haRequest(s, 'POST', `/api/ha/entities/${id}/toggle`, { on: false });
    }
    for (const id of ['lock.front_door', 'lock.cellar', 'button.intercom']) {
      await haRequest(s, 'POST', `/api/ha/entities/${id}/press`, { confirm: true });
    }
    expect(s.ha.calls.length).toBeGreaterThan(0);
    for (const c of s.ha.calls) {
      expect(ALLOWED_SERVICES.has(`${c.domain}.${c.service}`), `${c.domain}.${c.service}`).toBe(
        true,
      );
      expect(Object.keys(c.target as object)).toEqual(['entity_id']);
      expect(c.serviceData).toBeUndefined();
    }
  });

  it('the service maps cover only their domains', () => {
    expect(toggleCall('light.a', true)).toEqual({ domain: 'light', service: 'turn_on' });
    expect(toggleCall('input_boolean.a', false)).toEqual({
      domain: 'input_boolean',
      service: 'turn_off',
    });
    expect(toggleCall('lock.a', true)).toBeNull();
    expect(toggleCall('homeassistant.restart', true)).toBeNull();
    expect(pressCall('light.a', 0)).toBeNull();
    expect(pressCall('script.klingel', 0)).toEqual({ domain: 'script', service: 'turn_on' });
    expect(pressCall('switch.shelly', 0)).toEqual({ domain: 'switch', service: 'turn_on' });
    expect(pressCall('lock.a', 1)).toEqual({ domain: 'lock', service: 'open' });
    // No OPEN feature: no fallback to unlock.
    expect(pressCall('lock.a', 2)).toBeNull();
    expect(pressCall('lock.a', 0)).toBeNull();
  });
});

describe('ha token secrecy', () => {
  it('the token never shows up in logs, responses, audit or the database in plaintext', async () => {
    s = await withHa({ captureLogs: true });
    const bodies: string[] = [];
    for (const url of [
      '/api/ha/settings',
      '/api/ha/state',
      '/api/ha/available',
      '/api/ha/config',
    ]) {
      bodies.push((await haRequest(s, 'GET', url)).body);
    }
    await stepUp(s.t, s.secret, s.cookie);
    // A wrong token, then the right one again.
    bodies.push(
      (await haRequest(s, 'PUT', '/api/ha/settings', { url: s.ha.url, token: OTHER_HA_TOKEN }))
        .body,
    );
    bodies.push(
      (await haRequest(s, 'PUT', '/api/ha/settings', { url: s.ha.url, token: HA_TOKEN })).body,
    );
    await until(() => s?.t.app.hzCore.ha.settings().status === 'connected');
    bodies.push(
      (await haRequest(s, 'POST', '/api/ha/entities/light.bed_light/toggle', { on: true })).body,
    );
    // HA goes away: error texts are fixed.
    await s.ha.stop();
    await until(() => s?.t.app.hzCore.ha.settings().status === 'unreachable', 5000);
    bodies.push((await haRequest(s, 'GET', '/api/ha/settings')).body);
    bodies.push(
      (await haRequest(s, 'POST', '/api/ha/entities/light.bed_light/toggle', { on: false })).body,
    );

    const logs = s.t.logs.join('');
    const rows = JSON.stringify(s.t.db.db.select().from(settings).all());
    const audit = JSON.stringify(s.t.db.db.select().from(auditLog).all());
    for (const token of [HA_TOKEN, OTHER_HA_TOKEN]) {
      const parts = token.split('.');
      for (const hay of [logs, rows, audit, ...bodies]) {
        expect(hay).not.toContain(token);
        expect(hay).not.toContain(parts[2]);
      }
    }
    expect(logs).toContain('home assistant connected');
    // Stored encrypted (v1:<nonce>:<ct>), and the settings answer says only "set".
    const tokenRow = s.t.db.db
      .select()
      .from(settings)
      .all()
      .find((r) => r.key === 'ha.token');
    expect(JSON.parse(tokenRow?.valueJson ?? 'null')).toMatch(/^v1:/);
    expect(JSON.parse(bodies[0] ?? '{}')).toMatchObject({ tokenSet: true });
    expect(bodies[0]).not.toContain('token"');
  });
});

describe('ha client limits', () => {
  function events(onReady?: (snap: HaSnapshot) => void) {
    return {
      connecting: () => undefined,
      ready: (snap: HaSnapshot) => onReady?.(snap),
      stateChanged: () => undefined,
      down: () => undefined,
    };
  }

  it('bounded pending map and command timeouts', async () => {
    extra = new FakeHa();
    await extra.start();
    extra.ignoreCalls = true;
    let ready = false;
    client = new HaClient(
      extra.url,
      HA_TOKEN,
      events(() => {
        ready = true;
      }),
      { ...FAST_HA, maxPending: 2, requestTimeoutMs: 300, pingIntervalMs: 60_000 },
    );
    client.start();
    await until(() => ready);
    const a = client.callService('light', 'turn_on', 'light.bed_light');
    const b = client.callService('light', 'turn_on', 'light.bed_light');
    await expect(client.callService('light', 'turn_on', 'light.bed_light')).rejects.toMatchObject({
      kind: 'busy',
    });
    await expect(a).rejects.toBeInstanceOf(HaCallError);
    await expect(b).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('a frame above the size cap drops the connection ("Antwort zu groß")', async () => {
    s = await withHa({ connect: false, haOptions: { ...FAST_HA, maxPayloadBytes: 64 * 1024 } });
    s.ha.put('sensor.big', '1', { friendly_name: 'x'.repeat(100 * 1024) });
    await stepUp(s.t, s.secret, s.cookie);
    const res = await haRequest(s, 'PUT', '/api/ha/settings', { url: s.ha.url, token: HA_TOKEN });
    expect(res.json()).toMatchObject({ status: 'unreachable', error: 'Antwort zu groß' });
  });

  it('auth ok but get_states fails or is too large: the backoff still grows', async () => {
    for (const mode of ['error', 'oversize'] as const) {
      extra = new FakeHa();
      await extra.start();
      if (mode === 'error') extra.failGetStates = true;
      else extra.put('sensor.big', '1', { friendly_name: 'x'.repeat(100 * 1024) });
      const at: number[] = [];
      let ready = false;
      client = new HaClient(
        extra.url,
        HA_TOKEN,
        {
          ...events(() => {
            ready = true;
          }),
          connecting: () => at.push(Date.now()),
        },
        { ...FAST_HA, backoffBaseMs: 40, backoffMaxMs: 200, maxPayloadBytes: 64 * 1024 },
      );
      client.start();
      await until(() => at.length >= 5, 5000);
      client.stop();
      client = undefined;
      // Delays 40, 80, 160, 200: without the fix every retry waits 40 ms.
      const gaps = at.slice(1).map((t, i) => t - (at[i] ?? 0));
      expect(gaps[2], `${mode} ${gaps.join(',')}`).toBeGreaterThanOrEqual(150);
      expect(gaps[3], `${mode} ${gaps.join(',')}`).toBeGreaterThanOrEqual(190);
      expect(
        extra.frames.filter((f) => (f as { type?: string }).type === 'auth').length,
      ).toBeGreaterThanOrEqual(4);
      expect(ready).toBe(false);
      await extra.stop();
      extra = undefined;
    }
  });

  it('state changes during the initial sync are not lost; newer last_changed wins', async () => {
    extra = new FakeHa();
    await extra.start();
    const fake = extra;
    const old = '2026-11-25T10:00:00.000000+00:00';
    const newer = '2026-11-25T12:00:00.000000+00:00';
    fake.onCommand = (type) => {
      if (type === 'get_states') {
        // Before the snapshot: stale event (older) loses, newer event wins.
        fake.sendEvent({
          entity_id: 'light.kitchen',
          state: 'off',
          attributes: {},
          last_changed: old,
        });
        fake.sendEvent({
          entity_id: 'sensor.outside_temperature',
          state: '16.2',
          attributes: { unit_of_measurement: '°C' },
          last_changed: newer,
        });
      } else if (type === 'config/area_registry/list') {
        // After the snapshot, while the registries load: always newer.
        fake.put('light.bed_light', 'on');
        fake.sendEvent(null, 'automation.night');
      }
    };
    let snap: HaSnapshot | null = null;
    const changed: string[] = [];
    client = new HaClient(
      fake.url,
      HA_TOKEN,
      {
        ...events((x) => {
          snap = x;
        }),
        stateChanged: (id) => changed.push(id),
      },
      { ...FAST_HA, pingIntervalMs: 60_000 },
    );
    client.start();
    await until(() => snap !== null);
    const byId = new Map((snap as unknown as HaSnapshot).states.map((x) => [x.entityId, x.state]));
    expect(byId.get('light.bed_light')).toBe('on');
    expect(byId.get('light.kitchen')).toBe('on');
    expect(byId.get('sensor.outside_temperature')).toBe('16.2');
    expect(byId.has('automation.night')).toBe(false);
    // Buffered events are part of the snapshot, not replayed; later ones flow live.
    expect(changed).toEqual([]);
    fake.onCommand = null;
    fake.put('light.kitchen', 'off');
    await until(() => changed.includes('light.kitchen'));
  });

  it('HA URLs to link-local addresses (cloud metadata) are refused; loopback works', async () => {
    s = await withHa({ connect: false });
    await stepUp(s.t, s.secret, s.cookie);
    for (const url of ['http://169.254.169.254', 'http://[fe80::1]:8123']) {
      const res = await haRequest(s, 'PUT', '/api/ha/settings', { url, token: HA_TOKEN });
      expect(res.statusCode, url).toBe(400);
    }
    expect(s.t.app.hzCore.ha.settings()).toMatchObject({ url: null, tokenSet: false });
    const ok = await haRequest(s, 'PUT', '/api/ha/settings', { url: s.ha.url, token: HA_TOKEN });
    expect(ok.json()).toMatchObject({ status: 'connected' });
  });

  it('commands are refused while disconnected', async () => {
    client = new HaClient('http://127.0.0.1:1', HA_TOKEN, events(), FAST_HA);
    await expect(client.request('get_states')).rejects.toMatchObject({ kind: 'disconnected' });
  });
});
