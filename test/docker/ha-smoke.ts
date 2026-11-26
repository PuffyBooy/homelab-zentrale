/**
 * Docker smoke test for M8 (docs/ROADMAP.md): core image + a real Home Assistant
 * with the demo integration.
 *
 *   docker build -f deploy/Dockerfile.core -t homelab-zentrale/core:local .
 *   pnpm exec tsx test/docker/ha-smoke.ts
 *
 * 1. starts Home Assistant (pinned image, HZ_SMOKE_HA_IMAGE) on 127.0.0.1:18123 with a
 *    minimal configuration.yaml (http, api, websocket_api, config, onboarding, demo),
 * 2. onboarding through the HTTP API: creates the owner user, exchanges the auth code
 *    for an access token, then creates a long-lived token over the WebSocket API,
 * 3. starts the core (NODE_ENV=test, fixed HZ_SETUP_TOKEN, HZ_DEMO off) on 127.0.0.1:18080,
 *    runs the setup (password + TOTP) and a step-up,
 * 4. PUT /api/ha/settings {url, token} -> connected, GET /api/ha/available lists the demo,
 * 5. PUT /api/ha/config with a demo light (toggle) and a demo sensor (metric),
 * 6. toggles the light through the core API and checks the state in HA (REST),
 * 7. toggles the light in HA directly and sees it on the core's live topic `ha`,
 * 8. sets the sensor in HA (REST) and sees the new value on topic `ha`,
 * 9. checks that the token appears neither in API answers nor in the core log.
 * Cleans up both containers in every case and prints their logs on failure.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import WebSocket from 'ws';
import {
  setupStartResponseSchema,
  stepUpResponseSchema,
} from '../../packages/shared/src/api/auth.js';
import {
  haAvailableResponseSchema,
  haItemResponseSchema,
  haSettingsSchema,
  haStateSchema,
  type HaConfig,
  type HaState,
} from '../../packages/shared/src/api/ha.js';
import {
  liveHaTopicItemSchema,
  liveServerMessageSchema,
  type LiveServerMessage,
} from '../../packages/shared/src/live.js';

const CORE_IMAGE = process.env.HZ_SMOKE_CORE_IMAGE ?? 'homelab-zentrale/core:local';
const HA_IMAGE = process.env.HZ_SMOKE_HA_IMAGE ?? 'ghcr.io/home-assistant/home-assistant:2026.11.3';
const PORT = Number(process.env.HZ_SMOKE_PORT ?? 18080);
const HA_PORT = Number(process.env.HZ_SMOKE_HA_PORT ?? 18123);
const BASE = `http://127.0.0.1:${PORT}`;
const HA = `http://127.0.0.1:${HA_PORT}`;
const CORE_NAME = 'hz-ha-smoke-core';
const HA_NAME = 'hz-ha-smoke-ha';
/** HA with the demo integration needs a while on a CI runner. */
const HA_READY_S = 240;

const HA_CONFIG = `# Minimal Home Assistant for the homelab-zentrale M8 smoke test.
homeassistant:
  name: hz-smoke
  time_zone: Europe/Vienna
  unit_system: metric
  currency: EUR
  country: AT
http:
  server_port: ${HA_PORT}
api:
websocket_api:
config:
onboarding:
person:
demo:
`;

const setupToken = randomBytes(24).toString('base64url');
const secretKey = randomBytes(32).toString('base64');
const password = randomBytes(18).toString('base64url');
const haPassword = randomBytes(18).toString('base64url');

let cookie = '';
let haAccess = '';
let haToken = '';

function log(msg: string): void {
  process.stdout.write(`[ha-smoke ${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}

/** docker CLI, argument array, no shell. */
function docker(args: string[], input?: Buffer): string {
  // nosemgrep
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    ...(input === undefined ? {} : { input }),
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** stdout + stderr of a container (the core logs to stdout, HA to stderr). */
function allLogs(name: string): string {
  // nosemgrep
  const r = spawnSync('docker', ['logs', name], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

class Fatal extends Error {}

async function waitFor<T>(
  what: string,
  timeoutS: number,
  fn: () => Promise<T | null>,
  intervalMs = 1000,
): Promise<T> {
  const end = Date.now() + timeoutS * 1000;
  let lastErr = '';
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v !== null) return v;
    } catch (err) {
      if (err instanceof Fatal) throw err;
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout (${timeoutS} s) waiting for ${what}${lastErr ? `: ${lastErr}` : ''}`);
}

async function api(method: string, p: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { origin: BASE };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${BASE}${p}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function json(res: Response, what: string): Promise<unknown> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as unknown;
}

/** HA REST with the onboarding access token. */
async function haRest(method: string, p: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${HA}${p}`, {
    method,
    headers: {
      authorization: `Bearer ${haAccess}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return json(res, `HA ${method} ${p}`);
}

async function haState(entityId: string): Promise<{ state: string; attributes: object }> {
  return (await haRest('GET', `/api/states/${entityId}`)) as { state: string; attributes: object };
}

// ---- Home Assistant -----------------------------------------------------------------

async function startHa(): Promise<void> {
  docker(['create', '--name', HA_NAME, '--network', 'host', '-e', 'TZ=Europe/Vienna', HA_IMAGE]);
  // Copy the config in before the first start (no bind mount: HA writes as root).
  docker(['cp', '-', `${HA_NAME}:/config`], tarOf('configuration.yaml', HA_CONFIG));
  docker(['start', HA_NAME]);
  await waitFor(
    'Home Assistant onboarding API',
    HA_READY_S,
    async () => {
      const r = await fetch(`${HA}/api/onboarding`);
      return r.ok ? true : null;
    },
    2000,
  );
  log('Home Assistant is up');
}

/** A one-file tar archive (ustar) for `docker cp -`. */
function tarOf(name: string, content: string): Buffer {
  const data = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512, 0);
  const put = (s: string, off: number, len: number) => header.write(s, off, len, 'ascii');
  put(name, 0, 100);
  put('0000644\0', 100, 8);
  put('0000000\0', 108, 8);
  put('0000000\0', 116, 8);
  put(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12);
  put(
    `${Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, '0')}\0`,
    136,
    12,
  );
  put('        ', 148, 8);
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const b of header) sum += b;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512, 0);
  return Buffer.concat([header, data, pad, Buffer.alloc(1024, 0)]);
}

async function onboardHa(): Promise<void> {
  const clientId = `${HA}/`;
  const user = (await json(
    await fetch(`${HA}/api/onboarding/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        name: 'Smoke',
        username: 'smoke',
        password: haPassword,
        language: 'de',
      }),
    }),
    'HA onboarding/users',
  )) as { auth_code?: string };
  if (!user.auth_code) throw new Error('HA onboarding gave no auth code');
  const tokens = (await json(
    await fetch(`${HA}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: user.auth_code,
        client_id: clientId,
      }).toString(),
    }),
    'HA auth/token',
  )) as { access_token?: string };
  if (!tokens.access_token) throw new Error('HA gave no access token');
  haAccess = tokens.access_token;
  haToken = await longLivedToken(haAccess);
  log(`HA user created, long-lived token (${haToken.length} chars)`);
}

function longLivedToken(access: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${HA_PORT}/api/websocket`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('HA long-lived token: timeout'));
    }, 30_000);
    ws.on('error', reject);
    ws.on('message', (raw: WebSocket.RawData) => {
      const m = JSON.parse(raw.toString()) as {
        type: string;
        id?: number;
        success?: boolean;
        result?: unknown;
      };
      if (m.type === 'auth_required')
        ws.send(JSON.stringify({ type: 'auth', access_token: access }));
      else if (m.type === 'auth_ok') {
        ws.send(
          JSON.stringify({
            id: 1,
            type: 'auth/long_lived_access_token',
            client_name: 'homelab-zentrale smoke',
            lifespan: 1,
          }),
        );
      } else if (m.type === 'auth_invalid') {
        clearTimeout(timer);
        ws.close();
        reject(new Error('HA rejected the access token'));
      } else if (m.type === 'result' && m.id === 1) {
        clearTimeout(timer);
        ws.close();
        if (m.success && typeof m.result === 'string') resolve(m.result);
        else reject(new Error('HA did not create a long-lived token'));
      }
    });
  });
}

// ---- core ----------------------------------------------------------------------------

async function startCore(): Promise<TOTP> {
  docker([
    'run',
    '-d',
    '--name',
    CORE_NAME,
    '--network',
    'host',
    '-e',
    'NODE_ENV=test',
    '-e',
    'HZ_DEMO=0',
    '-e',
    `HZ_SETUP_TOKEN=${setupToken}`,
    '-e',
    `HZ_SECRET_KEY=${secretKey}`,
    '-e',
    'HZ_HOST=127.0.0.1',
    '-e',
    `HZ_PORT=${PORT}`,
    CORE_IMAGE,
  ]);
  await waitFor('core /api/health', 60, async () => {
    const r = await fetch(`${BASE}/api/health`);
    return r.ok ? true : null;
  });
  const start = setupStartResponseSchema.parse(
    await json(
      await api('POST', '/api/setup/start', { setupToken, username: 'admin', password }),
      'setup/start',
    ),
  );
  const totp = new TOTP({ secret: Secret.fromBase32(start.secret), digits: 6, period: 30 });
  const usedStep = totp.counter();
  const confirm = await api('POST', '/api/setup/confirm', { setupToken, code: totp.generate() });
  await json(confirm, 'setup/confirm');
  const session = confirm.headers
    .getSetCookie()
    .map((c) => c.split(';')[0] ?? '')
    .find((c) => c.startsWith('hz_session='));
  if (!session) throw new Error('setup/confirm did not set the session cookie');
  cookie = session;
  // Step-up needs a TOTP step the core has not seen yet.
  await waitFor('next TOTP step', 35, async () => (totp.counter() > usedStep ? true : null));
  const up = stepUpResponseSchema.parse(
    await json(await api('POST', '/api/auth/step-up', { code: totp.generate() }), 'auth/step-up'),
  );
  log(`core ready, step-up until ${up.stepUpUntil}`);
  return totp;
}

function liveClient(topics: string[]) {
  const messages: LiveServerMessage[] = [];
  const waiters = new Set<() => void>();
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/live`, { headers: { cookie, origin: BASE } });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', topics }));
      resolve();
    });
    ws.once('error', reject);
  });
  ws.on('message', (raw: WebSocket.RawData) => {
    const parsed = liveServerMessageSchema.safeParse(JSON.parse(raw.toString()));
    if (!parsed.success) return;
    messages.push(parsed.data);
    for (const w of waiters) w();
  });
  return {
    opened,
    /** Resolves when a snapshot or update of `ha` satisfies `ok` (old messages count). */
    waitHa(what: string, timeoutS: number, ok: (s: HaState) => boolean): Promise<HaState> {
      return new Promise<HaState>((resolve, reject) => {
        let seen = 0;
        let wake: () => void = () => undefined;
        const timer = setTimeout(() => {
          waiters.delete(wake);
          reject(new Error(`timeout (${timeoutS} s) waiting for live ha: ${what}`));
        }, timeoutS * 1000);
        wake = () => {
          for (; seen < messages.length; seen += 1) {
            const m = messages[seen] as LiveServerMessage;
            if (m.type === 'error') {
              clearTimeout(timer);
              reject(new Error(`live error ${m.code}`));
              return;
            }
            if (m.type !== 'snapshot' && m.type !== 'update') continue;
            if (m.topic !== 'ha') continue;
            const raw = m.type === 'snapshot' ? m.data : m.upsert?.[0];
            const st = liveHaTopicItemSchema.parse(raw);
            if (ok(st)) {
              clearTimeout(timer);
              waiters.delete(wake);
              resolve(st);
              return;
            }
          }
        };
        waiters.add(wake);
        wake();
      });
    },
    close: () => ws.close(),
  };
}

const itemOf = (s: HaState, id: string) => s.items.find((i) => i.entityId === id);

async function main(): Promise<void> {
  log(`core ${CORE_IMAGE}, Home Assistant ${HA_IMAGE}`);
  await startHa();
  await onboardHa();
  await startCore();

  // 4. switch the Home Assistant module on (off on a fresh install, needs step-up), connect
  await json(
    await api('PUT', '/api/settings/modules', { homeassistant: true }),
    'settings/modules',
  );
  const settings = haSettingsSchema.parse(
    await json(await api('PUT', '/api/ha/settings', { url: HA, token: haToken }), 'ha/settings'),
  );
  log(`PUT settings: status=${settings.status} error=${settings.error ?? '-'}`);
  const connected = await waitFor('core connected to HA', 60, async () => {
    const s = haSettingsSchema.parse(await json(await api('GET', '/api/ha/settings'), 'settings'));
    if (s.error === 'Token ungültig') throw new Fatal('core says: Token ungültig');
    return s.status === 'connected' ? s : null;
  });
  log(`connected to HA ${connected.haVersion ?? '?'}`);

  // Demo entities appear (the demo platform may still be loading).
  const { light, sensor } = await waitFor('demo light and sensor', 90, async () => {
    const av = haAvailableResponseSchema.parse(
      await json(await api('GET', '/api/ha/available'), 'ha/available'),
    ).entities;
    const lights = av.filter((e) => e.entityId.startsWith('light.') && e.state !== 'unavailable');
    const sensors = av.filter(
      (e) =>
        e.entityId.startsWith('sensor.') &&
        e.unit !== null &&
        Number.isFinite(Number(e.state)) &&
        e.state.trim() !== '',
    );
    const l = lights.find((e) => e.entityId === 'light.bed_light') ?? lights[0];
    const s = sensors.find((e) => e.entityId === 'sensor.outside_temperature') ?? sensors[0];
    return l && s ? { light: l.entityId, sensor: s.entityId } : null;
  });
  log(`using ${light} and ${sensor}`);

  // 5. config
  const config: HaConfig = {
    rooms: [{ id: 'smoke', name: 'Smoke' }],
    entities: [
      { entityId: light, kind: 'toggle', roomId: 'smoke', label: null, overview: true },
      { entityId: sensor, kind: 'metric', roomId: 'smoke', label: null, overview: true },
    ],
  };
  await json(await api('PUT', '/api/ha/config', config), 'ha/config');
  const st = haStateSchema.parse(await json(await api('GET', '/api/ha/state'), 'ha/state'));
  const li = itemOf(st, light);
  const se = itemOf(st, sensor);
  if (!li?.available || !se?.available) throw new Error('configured entities are not available');
  if (se.value === null) throw new Error(`sensor ${sensor} has no value`);
  log(`state: ${light}=${li.state}, ${sensor}=${se.value} ${se.unit ?? ''}`);

  const live = liveClient(['ha']);
  await live.opened;
  await live.waitHa('snapshot', 15, (s) => itemOf(s, light) !== undefined);

  // 6. toggle through the core -> HA
  const before = (await haState(light)).state;
  const target = before !== 'on';
  const res = haItemResponseSchema.parse(
    await json(await api('POST', `/api/ha/entities/${light}/toggle`, { on: target }), 'ha/toggle'),
  );
  log(`toggle ${light} -> ${target ? 'on' : 'off'} (pending=${res.item.pending})`);
  await waitFor(`HA reports ${light} ${target ? 'on' : 'off'}`, 20, async () =>
    (await haState(light)).state === (target ? 'on' : 'off') ? true : null,
  );
  await live.waitHa(`${light} ${target ? 'on' : 'off'}, not pending`, 20, (s) => {
    const i = itemOf(s, light);
    return i?.state === (target ? 'on' : 'off') && !i.pending;
  });
  log('toggle via core: HA and live topic agree');

  // 7. toggle in HA directly -> live topic
  await haRest('POST', '/api/services/light/toggle', { entity_id: light });
  await live.waitHa(`${light} back to ${before}`, 20, (s) => itemOf(s, light)?.state === before);
  log(`toggle in HA: live topic shows ${light}=${before}`);

  // 8. a sensor update in HA -> live topic
  const sensorNow = await haState(sensor);
  const nextValue = (Math.round((Number(sensorNow.state) + 1.3) * 10) / 10).toString();
  await haRest('POST', `/api/states/${sensor}`, {
    state: nextValue,
    attributes: sensorNow.attributes,
  });
  await live.waitHa(
    `${sensor}=${nextValue}`,
    20,
    (s) => itemOf(s, sensor)?.value === Number(nextValue),
  );
  log(`sensor update: live topic shows ${sensor}=${nextValue}`);
  live.close();

  // 9. the token stays secret
  const answers = [
    await (await api('GET', '/api/ha/settings')).text(),
    await (await api('GET', '/api/ha/state')).text(),
    await (await api('GET', '/api/ha/config')).text(),
  ];
  const coreLog = allLogs(CORE_NAME);
  for (const hay of [...answers, coreLog]) {
    if (hay.includes(haToken)) throw new Error('the HA token leaked into an answer or the log');
  }
  log('token not in answers or core log');
  log('OK');
}

function cleanup(): void {
  for (const name of [CORE_NAME, HA_NAME]) {
    try {
      docker(['rm', '-f', '-v', name]);
    } catch {
      // not running
    }
  }
}

function dumpLogs(): void {
  for (const name of [CORE_NAME, HA_NAME]) {
    const text = allLogs(name)
      .split(haToken || '\u0000')
      .join('[token]')
      .split(haAccess || '\u0000')
      .join('[token]');
    process.stdout.write(`\n----- ${name} -----\n${text.slice(-20_000)}\n`);
  }
}

cleanup();
main()
  .then(() => {
    cleanup();
    process.exit(0);
  })
  .catch((err: unknown) => {
    process.stdout.write(
      `[ha-smoke] FAILED: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    dumpLogs();
    cleanup();
    process.exit(1);
  });
