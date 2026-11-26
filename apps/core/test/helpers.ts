import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp, type AppDeps } from '../src/app.js';
import { totpCode } from '../src/auth/totp.js';
import { loadConfig } from '../src/config.js';
import type { Modules } from '@hz/shared';
import { openDatabase, type DbHandle } from '../src/db/index.js';
import { writeSetting } from '../src/db/settings.js';
import { MODULES_SETTING } from '../src/modules/service.js';

export const KEY = Buffer.alloc(32, 1).toString('base64');
export const SETUP_TOKEN = 'test-setup-token-0123456789abcdef';
export const USERNAME = 'admin';
export const PASSWORD = 'correct horse battery staple';
export const HOST = 'hz.test';
/** Headers a same-origin browser request carries. */
export const SAME_ORIGIN = { host: HOST, origin: `https://${HOST}` } as const;
/** Start on a TOTP step boundary so +30 s is always the next step. */
export const T0 = Date.UTC(2026, 10, 25, 12, 0, 0);

export interface TestClock {
  t: number;
  advance(ms: number): void;
}

export interface TestApp {
  app: FastifyInstance;
  db: DbHandle;
  clock: TestClock;
  logs: string[];
}

export function emptyDir(): string {
  return mkdtempSync(join(tmpdir(), 'hz-test-'));
}

export async function makeApp(
  opts: {
    env?: Record<string, string>;
    captureLogs?: boolean;
    db?: DbHandle;
    agentOptions?: AppDeps['agentOptions'];
    liveOptions?: AppDeps['liveOptions'];
    pushTransport?: AppDeps['pushTransport'];
    rdapFetch?: AppDeps['rdapFetch'];
    githubFetch?: AppDeps['githubFetch'];
    haOptions?: AppDeps['haOptions'];
    consoleOptions?: AppDeps['consoleOptions'];
    /**
     * Optional modules. Tests default to all on (most suites test a module);
     * `'fresh'` keeps the state of a fresh install (games on, github/ha off).
     */
    modules?: Partial<Modules> | 'fresh';
  } = {},
): Promise<TestApp> {
  const clock: TestClock = {
    t: T0,
    advance(ms) {
      this.t += ms;
    },
  };
  const logs: string[] = [];
  const db = opts.db ?? openDatabase(':memory:');
  if (opts.modules !== 'fresh') {
    const current = { github: true, homeassistant: true, games: true, ...opts.modules };
    writeSetting(db.db, MODULES_SETTING, current, clock.t);
  }
  const config = loadConfig({
    HZ_SECRET_KEY: KEY,
    NODE_ENV: 'test',
    HZ_WEB_DIR: emptyDir(),
    HZ_SETUP_TOKEN: SETUP_TOKEN,
    ...opts.env,
  });
  const app = await buildApp(config, {
    db,
    now: () => clock.t,
    // Tests move the fake clock and call hzCore.scheduler.tick() themselves.
    startScheduler: false,
    ...(opts.agentOptions ? { agentOptions: opts.agentOptions } : {}),
    ...(opts.liveOptions ? { liveOptions: opts.liveOptions } : {}),
    ...(opts.haOptions ? { haOptions: opts.haOptions } : {}),
    ...(opts.consoleOptions ? { consoleOptions: opts.consoleOptions } : {}),
    // Never reach the network from tests: RDAP fails unless a test injects one.
    rdapFetch: opts.rdapFetch ?? (() => Promise.reject(new Error('no network in tests'))),
    githubFetch: opts.githubFetch ?? (() => Promise.reject(new Error('no network in tests'))),
    pushTransport: opts.pushTransport ?? {
      send: () => Promise.reject(new Error('no network in tests')),
    },
    ...(opts.captureLogs
      ? {
          logStream: new Writable({
            write(chunk: Buffer, _enc, cb) {
              logs.push(chunk.toString('utf8'));
              cb();
            },
          }),
        }
      : {}),
  });
  await app.ready();
  return { app, db, clock, logs };
}

export function sessionCookie(res: LightMyRequestResponse): string {
  const c = res.cookies.find((x) => x.name === 'hz_session');
  if (!c) throw new Error('no session cookie');
  return c.value;
}

export function authHeaders(cookie: string): Record<string, string> {
  return { ...SAME_ORIGIN, cookie: `hz_session=${cookie}` };
}

export interface SetupResult {
  secret: string;
  cookie: string;
  recoveryCodes: string[];
}

/** Runs the whole setup. Afterwards the clock is on the next TOTP step. */
export async function completeSetup(t: TestApp): Promise<SetupResult> {
  const start = await t.app.inject({
    method: 'POST',
    url: '/api/setup/start',
    headers: SAME_ORIGIN,
    payload: { setupToken: SETUP_TOKEN, username: USERNAME, password: PASSWORD },
  });
  if (start.statusCode !== 200) throw new Error(`setup/start ${start.statusCode}`);
  const { secret } = start.json<{ secret: string }>();
  const confirm = await t.app.inject({
    method: 'POST',
    url: '/api/setup/confirm',
    headers: SAME_ORIGIN,
    payload: { setupToken: SETUP_TOKEN, code: totpCode(secret, t.clock.t) },
  });
  if (confirm.statusCode !== 200) throw new Error(`setup/confirm ${confirm.statusCode}`);
  t.clock.advance(30_000);
  return {
    secret,
    cookie: sessionCookie(confirm),
    recoveryCodes: confirm.json<{ recoveryCodes: string[] }>().recoveryCodes,
  };
}

export function login(
  t: TestApp,
  code: string,
  opts: { password?: string; ip?: string; username?: string } = {},
): Promise<LightMyRequestResponse> {
  return t.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { ...SAME_ORIGIN, ...(opts.ip ? { 'x-forwarded-for': opts.ip } : {}) },
    payload: {
      username: opts.username ?? USERNAME,
      password: opts.password ?? PASSWORD,
      code,
    },
  });
}

export { totpCode };
