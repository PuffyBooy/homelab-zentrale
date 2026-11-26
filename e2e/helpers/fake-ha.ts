import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

/**
 * Minimal Home Assistant for e2e: an HTTP server whose `/api/websocket` speaks the
 * HA WebSocket API as far as the core uses it (auth_required/auth_ok, get_states,
 * subscribe_events state_changed, area/device/entity registries, call_service and
 * ping). `call_service` for light/switch/fan/input_boolean, lock.open|unlock and
 * button.press changes the state and fires state_changed like HA does.
 * It listens on 127.0.0.1 only and runs in the Playwright process.
 */

// Looks like a HA long-lived token (JWT), split so secret scanners stay quiet.
export const FAKE_HA_TOKEN = `eyJhbGciOiJIUzI1NiJ9.${'eyJpc3MiOiJoei1lMmUifQ'}.${'ZTJlLWZha2UtaGEtc2lnbmF0dXJlLTAxMjM0NQ'}`;

export interface FakeHaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

export interface FakeHaCall {
  domain: string;
  service: string;
  entityIds: string[];
}

interface Req {
  id?: unknown;
  type?: unknown;
  access_token?: unknown;
  domain?: unknown;
  service?: unknown;
  target?: { entity_id?: unknown };
  service_data?: { entity_id?: unknown };
}

const VERSION = '2026.11.2';

export class FakeHa {
  readonly states = new Map<string, FakeHaState>();
  readonly calls: FakeHaCall[] = [];
  private readonly areas = new Map<string, string>([
    ['wohnzimmer', 'Wohnzimmer'],
    ['kueche', 'Küche'],
    ['vorraum', 'Vorraum'],
  ]);
  private readonly entityArea = new Map<string, string>();
  private readonly subs = new Map<WebSocket, Set<number>>();
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  port = 0;

  constructor() {
    this.put('light.wohnzimmer', 'off', { friendly_name: 'Licht Wohnzimmer' }, 'wohnzimmer');
    this.put('light.stehlampe', 'on', { friendly_name: 'Stehlampe' }, 'wohnzimmer');
    this.put('switch.kaffeemaschine', 'off', { friendly_name: 'Kaffeemaschine' }, 'kueche');
    this.put(
      'sensor.wohnzimmer_temperatur',
      '21.4',
      {
        friendly_name: 'Temperatur Wohnzimmer',
        unit_of_measurement: '°C',
        device_class: 'temperature',
      },
      'wohnzimmer',
    );
    this.put(
      'sensor.wohnzimmer_luftfeuchte',
      '48',
      { friendly_name: 'Luftfeuchte', unit_of_measurement: '%', device_class: 'humidity' },
      'wohnzimmer',
    );
    this.put(
      'sensor.wohnzimmer_co2',
      '612',
      { friendly_name: 'CO₂', unit_of_measurement: 'ppm', device_class: 'carbon_dioxide' },
      'wohnzimmer',
    );
    this.put('sensor.strom_leistung', '412', {
      friendly_name: 'Strom Leistung',
      unit_of_measurement: 'W',
      device_class: 'power',
      state_class: 'measurement',
    });
    this.put('sensor.strom_zaehler', '1000.5', {
      friendly_name: 'Stromzähler',
      unit_of_measurement: 'kWh',
      device_class: 'energy',
      state_class: 'total_increasing',
    });
    this.put(
      'lock.haustuer',
      'locked',
      { friendly_name: 'Haustür', supported_features: 1 },
      'vorraum',
    );
    this.put('automation.nacht', 'on', { friendly_name: 'Nacht' });
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  put(id: string, state: string, attributes: Record<string, unknown>, area?: string): void {
    const now = new Date().toISOString();
    this.states.set(id, {
      entity_id: id,
      state,
      attributes,
      last_changed: now,
      last_updated: now,
    });
    if (area) this.entityArea.set(id, area);
  }

  /** Changes a state like a device would and fires state_changed. */
  setState(id: string, state: string): void {
    const old = this.states.get(id);
    if (!old) throw new Error(`unknown entity ${id}`);
    const now = new Date().toISOString();
    const next: FakeHaState = {
      ...old,
      state,
      last_changed: old.state === state ? old.last_changed : now,
      last_updated: now,
    };
    this.states.set(id, next);
    this.fire(id, old, next);
  }

  callsFor(domain: string, service: string): FakeHaCall[] {
    return this.calls.filter((c) => c.domain === domain && c.service === service);
  }

  async start(): Promise<void> {
    this.http = createServer((_req, res) => {
      res.writeHead(404).end();
    });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    this.http.on('upgrade', (req, socket, head) => {
      if (req.url !== '/api/websocket') {
        socket.destroy();
        return;
      }
      this.wss?.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
    });
    await new Promise<void>((resolve) => this.http?.listen(0, '127.0.0.1', resolve));
    this.port = (this.http.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const ws of this.subs.keys()) ws.terminate();
    this.subs.clear();
    this.wss?.close();
    await new Promise<void>((resolve) =>
      this.http ? this.http.close(() => resolve()) : resolve(),
    );
  }

  private accept(ws: WebSocket): void {
    let authed = false;
    this.subs.set(ws, new Set());
    ws.on('close', () => this.subs.delete(ws));
    this.send(ws, { type: 'auth_required', ha_version: VERSION });
    ws.on('message', (data) => {
      let msg: Req;
      try {
        msg = JSON.parse(String(data)) as Req;
      } catch {
        return;
      }
      if (!authed) {
        if (msg.type === 'auth' && msg.access_token === FAKE_HA_TOKEN) {
          authed = true;
          this.send(ws, { type: 'auth_ok', ha_version: VERSION });
        } else {
          this.send(ws, { type: 'auth_invalid', message: 'Invalid access token' });
          ws.close();
        }
        return;
      }
      if (typeof msg.id !== 'number') return;
      this.handle(ws, msg.id, msg);
    });
  }

  private handle(ws: WebSocket, id: number, msg: Req): void {
    const ok = (result: unknown): void =>
      this.send(ws, { id, type: 'result', success: true, result });
    switch (msg.type) {
      case 'ping':
        return this.send(ws, { id, type: 'pong' });
      case 'subscribe_events':
        this.subs.get(ws)?.add(id);
        return ok(null);
      case 'get_states':
        return ok([...this.states.values()]);
      case 'config/area_registry/list':
        return ok([...this.areas].map(([area_id, name]) => ({ area_id, name })));
      case 'config/device_registry/list':
        return ok([]);
      case 'config/entity_registry/list_for_display':
        return ok({
          entity_categories: {},
          entities: [...this.states.keys()].map((ei) => ({ ei, ai: this.entityArea.get(ei) })),
        });
      case 'config/entity_registry/list':
        return ok(
          [...this.states.keys()].map((entity_id) => ({
            entity_id,
            area_id: this.entityArea.get(entity_id) ?? null,
            device_id: null,
          })),
        );
      case 'call_service':
        return this.callService(ws, id, msg);
      default:
        return this.send(ws, {
          id,
          type: 'result',
          success: false,
          error: { code: 'unknown_command', message: 'Unknown command.' },
        });
    }
  }

  private callService(ws: WebSocket, id: number, msg: Req): void {
    const domain = String(msg.domain ?? '');
    const service = String(msg.service ?? '');
    const raw = msg.target?.entity_id ?? msg.service_data?.entity_id;
    const entityIds = (Array.isArray(raw) ? raw : [raw]).filter(
      (x): x is string => typeof x === 'string',
    );
    this.calls.push({ domain, service, entityIds });
    this.send(ws, {
      id,
      type: 'result',
      success: true,
      result: { context: { id: `ctx${id}`, parent_id: null, user_id: null } },
    });
    // HA reports the new state a moment after the call returns.
    setTimeout(() => {
      for (const e of entityIds) {
        if (!this.states.has(e)) continue;
        if (service === 'turn_on') this.setState(e, 'on');
        else if (service === 'turn_off') this.setState(e, 'off');
        else if (service === 'toggle')
          this.setState(e, this.states.get(e)?.state === 'on' ? 'off' : 'on');
        else if (domain === 'lock' && (service === 'open' || service === 'unlock'))
          this.setState(e, service === 'open' ? 'open' : 'unlocked');
        else if (domain === 'button' && service === 'press')
          this.setState(e, new Date().toISOString());
      }
    }, 150);
  }

  private fire(entityId: string, oldState: FakeHaState, newState: FakeHaState): void {
    for (const [ws, ids] of this.subs) {
      for (const sub of ids) {
        this.send(ws, {
          id: sub,
          type: 'event',
          event: {
            event_type: 'state_changed',
            data: { entity_id: entityId, old_state: oldState, new_state: newState },
            origin: 'LOCAL',
            time_fired: newState.last_updated,
          },
        });
      }
    }
  }

  private send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }
}
