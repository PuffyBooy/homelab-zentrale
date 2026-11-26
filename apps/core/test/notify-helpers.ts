import { Writable } from 'node:stream';
import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { AgentHub } from '../src/agents/hub.js';
import { setupAuth } from '../src/auth/index.js';
import { loadConfig } from '../src/config.js';
import { createSecretBox, type SecretBox } from '../src/crypto.js';
import { openDatabase } from '../src/db/index.js';
import { errorHandler } from '../src/http/errors.js';
import { notifyRoutes } from '../src/notify/routes.js';
import { NotifyService } from '../src/notify/service.js';
import type { NotifyRequest, NotifyResponse, NotifyTransport } from '../src/notify/transport.js';
import { wolRoutes } from '../src/wol/routes.js';
import { WolService } from '../src/wol/service.js';
import type { UdpSender } from '../src/wol/packet.js';
import { stepUp } from './agent-helpers.js';
import { completeSetup, emptyDir, KEY, SETUP_TOKEN, T0, type TestApp } from './helpers.js';

/** Recording transport; answers `status` (default 204) or throws `fail`. */
export class FakeTransport implements NotifyTransport {
  readonly requests: NotifyRequest[] = [];
  status = 204;
  fail: Error | null = null;

  post(req: NotifyRequest): Promise<NotifyResponse> {
    this.requests.push(req);
    if (this.fail) return Promise.reject(this.fail);
    return Promise.resolve({ status: this.status });
  }
}

export class FakeUdp implements UdpSender {
  readonly sent: { packet: Buffer; port: number; address: string }[] = [];
  fail = false;

  send(packet: Buffer, port: number, address: string): Promise<void> {
    if (this.fail) return Promise.reject(new Error('EPERM'));
    this.sent.push({ packet: Buffer.from(packet), port, address });
    return Promise.resolve();
  }
}

export interface HubCall {
  serverId: string;
  action: string;
  params: unknown;
}

export interface PluginApp extends TestApp {
  box: SecretBox;
  notify: NotifyService;
  wol: WolService;
  transport: FakeTransport;
  udp: FakeUdp;
  servers: Map<string, { id: string; name: string }>;
  online: Set<string>;
  hubCalls: HubCall[];
  log: FastifyBaseLogger;
  secret: string;
  cookie: string;
}

/**
 * A small Fastify app with the real auth (setup, session guard, step-up) and the
 * notify + WoL plugins, independent of app.ts wiring. The fake clock starts at T0.
 */
export async function makePluginApp(
  opts: { transport?: NotifyTransport; captureLogs?: boolean } = {},
): Promise<PluginApp> {
  const clock = {
    t: T0,
    advance(ms: number) {
      this.t += ms;
    },
  };
  const now = () => clock.t;
  const logs: string[] = [];
  const db = openDatabase(':memory:');
  const config = loadConfig({
    HZ_SECRET_KEY: KEY,
    NODE_ENV: 'test',
    HZ_WEB_DIR: emptyDir(),
    HZ_SETUP_TOKEN: SETUP_TOKEN,
  });
  const app: FastifyInstance = Fastify({
    logger: {
      level: 'debug',
      stream: new Writable({
        write(chunk: Buffer, _enc, cb) {
          if (opts.captureLogs) logs.push(chunk.toString('utf8'));
          cb();
        },
      }),
    },
  });
  app.addHook('onClose', async () => db.close());
  app.setErrorHandler(errorHandler);
  await app.register(fastifyCookie);
  const box = createSecretBox(config.secretKey);
  await setupAuth(app, { db: db.db, box, now, config });

  const fake = new FakeTransport();
  const transport = opts.transport ?? fake;
  const notify = new NotifyService({ db: db.db, box, now, log: app.log, transport });
  const servers = new Map<string, { id: string; name: string }>();
  const online = new Set<string>();
  const hubCalls: HubCall[] = [];
  const hub: Pick<AgentHub, 'call' | 'isConnected'> = {
    isConnected: (id) => online.has(id),
    call: (serverId, action, params) => {
      hubCalls.push({ serverId, action, params });
      return Promise.resolve({ sent: true });
    },
  };
  const udp = new FakeUdp();
  const wol = new WolService({
    db: db.db,
    now,
    servers: { row: (id) => servers.get(id) },
    hub,
    log: app.log,
    udp,
  });
  await app.register(notifyRoutes, { prefix: '/api', db: db.db, now, notify });
  await app.register(wolRoutes, { prefix: '/api', db: db.db, now, wol });
  await app.ready();

  const base: TestApp = { app, db, clock, logs };
  const { secret, cookie } = await completeSetup(base);
  return {
    ...base,
    box,
    notify,
    wol,
    transport: fake,
    udp,
    servers,
    online,
    hubCalls,
    log: app.log,
    secret,
    cookie,
  };
}

export async function withStep(p: PluginApp): Promise<void> {
  await stepUp(p, p.secret, p.cookie);
}

// Secret-looking test values, split so secret scanners stay quiet.
export const WEBHOOK = `https://discord.com/api/webhooks/123456789012345678/${'SENTINELwebhook'}_${'abcdefghij0123456789'}`;
export const BOT_TOKEN = `123456789:${'SENTINELbotTOKEN'}${'abcdefghijklmnopqrst'}`;
export const CHAT_ID = '-1009876543210';
export const NTFY_TOPIC = 'sentinel-topic-hz-9f8e7d';
export const NTFY_TOKEN = `tk_${'SENTINELntfy'}${'TOKEN0123456789ab'}`;
export const SENTINELS = [
  WEBHOOK,
  'SENTINELwebhook',
  'SENTINELbotTOKEN',
  CHAT_ID,
  NTFY_TOPIC,
  'SENTINELntfy',
];
