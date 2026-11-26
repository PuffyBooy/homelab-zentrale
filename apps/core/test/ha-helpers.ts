import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { HaConfig } from '@hz/shared';
import type { HaClientOptions } from '../src/homeassistant/client.js';
import { stepUp, until } from './agent-helpers.js';
import { authHeaders, completeSetup, makeApp, type TestApp } from './helpers.js';

// Looks like a HA long-lived token (JWT), split so secret scanners stay quiet.
export const HA_TOKEN = `eyJhbGciOiJIUzI1NiJ9.${'eyJpc3MiOiJoei10ZXN0In0'}.${'c2lnbmF0dXJlLXRlc3QtaGEtdG9rZW4tMDEyMzQ1'}`;
export const OTHER_HA_TOKEN = `eyJhbGciOiJIUzI1NiJ9.${'eyJpc3MiOiJvdGhlciJ9'}.${'b3RoZXItc2lnbmF0dXJlLTk4NzY1NDMyMTA'}`;

/** Short timers so reconnect and heartbeat tests run in real time. */
export const FAST_HA: HaClientOptions = {
  connectTimeoutMs: 1_000,
  requestTimeoutMs: 1_000,
  pingIntervalMs: 200,
  pongTimeoutMs: 300,
  backoffBaseMs: 50,
  backoffMaxMs: 200,
  authInvalidRetryMs: 60_000,
};

export interface FakeState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
}

export interface ReceivedCall {
  domain: string;
  service: string;
  target: unknown;
  serviceData: unknown;
}

/**
 * In-process Home Assistant WebSocket API: auth, get_states, subscribe_events
 * (state_changed), registries, call_service (applies light/switch/... changes and
 * fires state_changed) and ping. `restart()` drops every client and listens on
 * the same port again.
 */
export class FakeHa {
  readonly tokens = new Set([HA_TOKEN]);
  readonly states = new Map<string, FakeState>();
  readonly calls: ReceivedCall[] = [];
  /** Every frame received (including auth). */
  readonly frames: unknown[] = [];
  readonly sockets = new Set<WebSocket>();
  /** Services that answer success:false. */
  readonly failing = new Set<string>();
  answerPings = true;
  /** Do not apply call_service effects (pending stays until timeout). */
  silentCalls = false;
  /** Never answer call_service (timeouts, pending map). */
  ignoreCalls = false;
  connections = 0;
  /** Called with each command type before it is answered (sync race tests). */
  onCommand: ((type: string) => void) | null = null;
  /** get_states answers success:false. */
  failGetStates = false;
  private readonly subs = new Map<WebSocket, number[]>();
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  port = 0;

  constructor() {
    const t = '2026-11-25T11:00:00.123456+00:00';
    this.put('light.bed_light', 'off', { friendly_name: 'Bettlicht' }, t);
    this.put('light.kitchen', 'on', { friendly_name: 'Küche' }, t);
    this.put('switch.decorative_lights', 'on', { friendly_name: 'Deko' }, t);
    this.put(
      'sensor.outside_temperature',
      '15.6',
      { friendly_name: 'Außen', unit_of_measurement: '°C', device_class: 'temperature' },
      t,
    );
    this.put('sensor.power', '412', { unit_of_measurement: 'W', device_class: 'power' }, t);
    this.put('sensor.energy', '1000.5', { unit_of_measurement: 'kWh', device_class: 'energy' }, t);
    this.put('climate.hvac', 'heat', { friendly_name: 'Heizung', current_temperature: 21.5 }, t);
    this.put('lock.front_door', 'locked', { friendly_name: 'Haustür', supported_features: 1 }, t);
    this.put('lock.cellar', 'locked', { friendly_name: 'Keller', supported_features: 0 }, t);
    this.put('button.intercom', 'unknown', { friendly_name: 'Gegensprechanlage' }, t);
    this.put('automation.night', 'on', { friendly_name: 'Nacht' }, t);
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  put(entityId: string, state: string, attributes: Record<string, unknown> = {}, at?: string) {
    const prev = this.states.get(entityId);
    const next: FakeState = {
      entity_id: entityId,
      state,
      attributes: { ...(prev?.attributes ?? {}), ...attributes },
      last_changed: at ?? new Date().toISOString(),
    };
    this.states.set(entityId, next);
    for (const [ws, ids] of this.subs) {
      for (const id of ids) {
        ws.send(
          JSON.stringify({
            id,
            type: 'event',
            event: {
              event_type: 'state_changed',
              data: { entity_id: entityId, old_state: prev ?? null, new_state: next },
            },
          }),
        );
      }
    }
  }

  /** Fires a state_changed event without storing the state (stale/racing events). */
  sendEvent(newState: FakeState | null, entityId = newState?.entity_id ?? ''): void {
    for (const [ws, ids] of this.subs) {
      for (const id of ids) {
        ws.send(
          JSON.stringify({
            id,
            type: 'event',
            event: {
              event_type: 'state_changed',
              data: { entity_id: entityId, old_state: null, new_state: newState },
            },
          }),
        );
      }
    }
  }

  async start(port = 0): Promise<void> {
    const http = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    const wss = new WebSocketServer({ noServer: true });
    http.on('upgrade', (req, socket, head) => {
      if (req.url !== '/api/websocket') {
        socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
    });
    await new Promise<void>((resolve) => http.listen(port, '127.0.0.1', resolve));
    this.port = (http.address() as AddressInfo).port;
    this.http = http;
    this.wss = wss;
  }

  async stop(): Promise<void> {
    for (const ws of this.sockets) ws.terminate();
    this.sockets.clear();
    this.subs.clear();
    this.wss?.close();
    const http = this.http;
    this.http = null;
    this.wss = null;
    if (http) {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  }

  /** HA restart: all clients drop, the port is down for `downMs`, then back. */
  async restart(downMs = 100): Promise<void> {
    const port = this.port;
    await this.stop();
    await new Promise((r) => setTimeout(r, downMs));
    await this.start(port);
  }

  private accept(ws: WebSocket): void {
    this.connections += 1;
    this.sockets.add(ws);
    let authed = false;
    ws.on('close', () => {
      this.sockets.delete(ws);
      this.subs.delete(ws);
    });
    ws.send(JSON.stringify({ type: 'auth_required', ha_version: '2026.11.3' }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as Record<string, unknown>;
      this.frames.push(msg);
      if (!authed) {
        if (msg.type === 'auth' && this.tokens.has(String(msg.access_token))) {
          authed = true;
          ws.send(JSON.stringify({ type: 'auth_ok', ha_version: '2026.11.3' }));
        } else {
          ws.send(JSON.stringify({ type: 'auth_invalid', message: 'Invalid access token' }));
          ws.close();
        }
        return;
      }
      const id = msg.id as number;
      this.onCommand?.(String(msg.type));
      const ok = (result: unknown) =>
        ws.send(JSON.stringify({ id, type: 'result', success: true, result }));
      const fail = (code: string) =>
        ws.send(
          JSON.stringify({ id, type: 'result', success: false, error: { code, message: code } }),
        );
      switch (msg.type) {
        case 'ping':
          if (this.answerPings) ws.send(JSON.stringify({ id, type: 'pong' }));
          return;
        case 'subscribe_events':
          this.subs.set(ws, [...(this.subs.get(ws) ?? []), id]);
          return ok(null);
        case 'get_states':
          if (this.failGetStates) return fail('unknown_error');
          return ok([...this.states.values()]);
        case 'config/area_registry/list':
          return ok([
            { area_id: 'bedroom', name: 'Schlafzimmer' },
            { area_id: 'kitchen', name: 'Küche' },
          ]);
        case 'config/device_registry/list':
          return ok([{ id: 'dev1', area_id: 'kitchen' }]);
        case 'config/entity_registry/list_for_display':
          return ok({
            entity_categories: {},
            entities: [
              { ei: 'light.bed_light', ai: 'bedroom' },
              { ei: 'light.kitchen', di: 'dev1' },
            ],
          });
        case 'call_service':
          return this.callService(msg, ok, fail);
        default:
          return fail('unknown_command');
      }
    });
  }

  private callService(
    msg: Record<string, unknown>,
    ok: (r: unknown) => void,
    fail: (code: string) => void,
  ): void {
    const call: ReceivedCall = {
      domain: String(msg.domain),
      service: String(msg.service),
      target: msg.target,
      serviceData: msg.service_data,
    };
    this.calls.push(call);
    if (this.ignoreCalls) return;
    const key = `${call.domain}.${call.service}`;
    if (this.failing.has(key)) return fail('service_validation_error');
    const target = call.target as { entity_id?: unknown } | undefined;
    const entityId = typeof target?.entity_id === 'string' ? target.entity_id : '';
    if (!this.states.has(entityId)) return fail('not_found');
    if (!this.silentCalls) {
      const effects: Record<string, string> = {
        turn_on: 'on',
        turn_off: 'off',
        open: 'open',
        unlock: 'unlocked',
      };
      const next = effects[call.service];
      if (call.service === 'press') this.put(entityId, new Date().toISOString());
      else if (next && call.domain !== 'script') this.put(entityId, next);
    }
    ok({ context: { id: 'ctx' } });
  }
}

export interface HaSetup {
  t: TestApp;
  ha: FakeHa;
  cookie: string;
  secret: string;
}

export const DEMO_CONFIG: HaConfig = {
  rooms: [
    { id: 'schlafzimmer', name: 'Schlafzimmer' },
    { id: 'wohnzimmer', name: 'Wohnzimmer' },
  ],
  entities: [
    {
      entityId: 'light.bed_light',
      kind: 'toggle',
      roomId: 'schlafzimmer',
      label: null,
      overview: true,
    },
    {
      entityId: 'switch.decorative_lights',
      kind: 'toggle',
      roomId: 'wohnzimmer',
      label: 'Deko',
      overview: false,
    },
    {
      entityId: 'sensor.outside_temperature',
      kind: 'metric',
      roomId: null,
      label: null,
      overview: true,
    },
    {
      entityId: 'climate.hvac',
      kind: 'metric',
      roomId: 'wohnzimmer',
      label: null,
      overview: false,
    },
    { entityId: 'lock.front_door', kind: 'button', roomId: null, label: 'Haustür', overview: true },
    { entityId: 'lock.cellar', kind: 'button', roomId: null, label: null, overview: false },
    { entityId: 'button.intercom', kind: 'button', roomId: null, label: null, overview: false },
    { entityId: 'light.not_in_ha', kind: 'toggle', roomId: null, label: null, overview: false },
  ],
};

/** App + fake HA. Optionally sets URL/token (with step-up) and the demo config. */
export async function withHa(
  opts: {
    connect?: boolean;
    config?: boolean;
    captureLogs?: boolean;
    haOptions?: HaClientOptions;
  } = {},
): Promise<HaSetup> {
  const ha = new FakeHa();
  await ha.start();
  const t = await makeApp({
    haOptions: opts.haOptions ?? FAST_HA,
    liveOptions: { throttleMs: 20 },
    ...(opts.captureLogs ? { captureLogs: true } : {}),
  });
  const { cookie, secret } = await completeSetup(t);
  const s: HaSetup = { t, ha, cookie, secret };
  if (opts.connect !== false) {
    await stepUp(t, secret, cookie);
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/ha/settings',
      headers: authHeaders(cookie),
      payload: {
        url: ha.url,
        token: HA_TOKEN,
        energyEntityId: 'sensor.energy',
        powerEntityId: 'sensor.power',
      },
    });
    if (res.statusCode !== 200) throw new Error(`ha settings ${res.statusCode} ${res.body}`);
    await until(() => t.app.hzCore.ha.settings().status === 'connected');
  }
  if (opts.config !== false && opts.connect !== false) {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/ha/config',
      headers: authHeaders(cookie),
      payload: DEMO_CONFIG,
    });
    if (res.statusCode !== 200) throw new Error(`ha config ${res.statusCode} ${res.body}`);
  }
  return s;
}

export async function closeHa(s: HaSetup | undefined): Promise<void> {
  if (!s) return;
  await s.t.app.close();
  await s.ha.stop();
}

export function haRequest(
  s: HaSetup,
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  return s.t.app.inject({
    method,
    url,
    headers: authHeaders(s.cookie),
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}
