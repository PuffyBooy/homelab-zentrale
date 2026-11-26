import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { MAX_MESSAGE_BYTES } from '@hz/shared';
import { AgentHub, type HubOptions } from './agents/hub.js';
import { agentRoutes } from './agents/routes.js';
import { AgentTokens } from './agents/tokens.js';
import { alertRoutes } from './alerts/routes.js';
import { AlertService } from './alerts/service.js';
import { nextWeeklyReport, weeklyReportText } from './alerts/weekly-report.js';
import { setupAuth, type AuthService } from './auth/index.js';
import { isApiPath, requestPath } from './auth/guard.js';
import { checkRoutes } from './checks/routes.js';
import { CheckService } from './checks/service.js';
import type { FetchLike } from './checks/rdap.js';
import { systemClock, type Clock } from './clock.js';
import type { Config } from './config.js';
import { ContainerLogs } from './containers/logs.js';
import { containerRoutes } from './containers/routes.js';
import { ContainerService } from './containers/service.js';
import { createSecretBox } from './crypto.js';
import { openDatabase, type DbHandle } from './db/index.js';
import { seedDemo } from './demo/seed.js';
import { errorHandler, sendError } from './http/errors.js';
import { LiveHub, type LiveOptions } from './live/hub.js';
import { liveRoutes } from './live/routes.js';
import { DAY, HOUR, MetricsStore } from './metrics/store.js';
import { Notifier } from './push/notifier.js';
import { pushRoutes } from './push/routes.js';
import { fetchTransport, type PushTransport } from './push/sender.js';
import { PushService } from './push/service.js';
import { readNotifySettings } from './push/settings.js';
import { loadVapidKeys } from './push/vapid.js';
import { healthRoutes } from './routes/health.js';
import { Scheduler } from './scheduler.js';
import { serverRoutes } from './servers/routes.js';
import { ServerService } from './servers/service.js';

const here = dirname(fileURLToPath(import.meta.url));

/** apps/web/dist, seen from apps/core/src or apps/core/dist. */
export const defaultWebDir = resolve(here, '../../web/dist');

export interface AppDeps {
  /** Database. Defaults to `${dataDir}/hz.sqlite`. The app closes it on shutdown. */
  db?: DbHandle;
  /** Clock for sessions, step-up, TOTP and rate limits (tests move time). */
  now?: Clock;
  /** Capture logs (tests). Enables logging also with NODE_ENV=test. */
  logStream?: NodeJS.WritableStream;
  /** Start the scheduler on ready (default true). Tests call `hzCore.scheduler.tick()`. */
  startScheduler?: boolean;
  agentOptions?: HubOptions;
  liveOptions?: LiveOptions;
  /** Web Push transport (tests: a local mock push service). */
  pushTransport?: PushTransport;
  /** RDAP transport (tests: no network). */
  rdapFetch?: FetchLike;
}

/** Core services, decorated on the app as `hzCore` (routes, tests). */
export interface CoreServices {
  scheduler: Scheduler;
  tokens: AgentTokens;
  hub: AgentHub;
  metrics: MetricsStore;
  alerts: AlertService;
  servers: ServerService;
  containers: ContainerService;
  logs: ContainerLogs;
  live: LiveHub;
  checks: CheckService;
  push: PushService;
  notifier: Notifier;
  db: DbHandle;
}

export interface RouteInfo {
  method: string;
  url: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Every route registered, collected via onRoute (used by the 401 test). */
    hzRoutes: RouteInfo[];
    hzAuth: AuthService;
    hzCore: CoreServices;
  }
}

/** Keys that must never reach the log, wherever they appear. */
const REDACT = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  'headers.cookie',
  'headers.authorization',
  'headers["set-cookie"]',
  ...[
    'password',
    'currentPassword',
    'newPassword',
    'code',
    'token',
    'secret',
    'setupToken',
    'agentToken',
    'privateKey',
    'subscription',
    'keys',
  ].flatMap((k) => [k, `*.${k}`, `body.${k}`, `req.body.${k}`]),
];

function isLoopbackAddress(addr: string): boolean {
  return addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.');
}

function loggerOptions(config: Config, deps: AppDeps): NonNullable<FastifyServerOptions['logger']> {
  const level = config.env === 'development' ? 'debug' : 'info';
  if (deps.logStream) return { level: 'debug', stream: deps.logStream, redact: REDACT };
  if (config.env === 'test') return false;
  return { level, redact: REDACT };
}

/**
 * VAPID "sub" claim: HZ_VAPID_SUBJECT, else the https base URL (the tailnet
 * address), else a mailto placeholder. Push services use it only as contact.
 */
function vapidSubject(config: Config): string {
  if (config.vapidSubject) return config.vapidSubject;
  if (config.baseUrl?.startsWith('https://')) return config.baseUrl;
  return 'mailto:admin@homelab-zentrale.invalid';
}

export async function buildApp(config: Config, deps: AppDeps = {}): Promise<FastifyInstance> {
  const db = deps.db ?? openDatabase(join(config.dataDir, 'hz.sqlite'));
  const now = deps.now ?? systemClock;

  const app = Fastify({
    logger: loggerOptions(config, deps),
    // `tailscale serve` connects from loopback and appends X-Forwarded-For. Only
    // then do we take the client IP from that header (the last hop). Direct
    // connections from anywhere else use the socket address, so the header
    // cannot be spoofed to dodge the rate limit.
    trustProxy: (address: string, hop: number) => hop === 0 && isLoopbackAddress(address),
    bodyLimit: 1024 * 1024,
  });
  app.addHook('onClose', async () => db.close());

  const routes: RouteInfo[] = [];
  app.decorate('hzRoutes', routes);
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) routes.push({ method, url: r.url });
  });

  app.setErrorHandler(errorHandler);

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  });
  await app.register(fastifyCookie);

  const box = createSecretBox(config.secretKey);
  // Auth first: it installs the global /api guard that every later route inherits.
  const auth = await setupAuth(app, {
    db: db.db,
    box,
    now,
    config,
  });
  app.decorate('hzAuth', auth);

  await app.register(healthRoutes, { prefix: '/api' });

  // ---- M2: agents, servers, metrics, alerts, live ---------------------------
  const scheduler = new Scheduler(now, {
    onError: (job, err) =>
      app.log.error(
        { job, err: err instanceof Error ? { name: err.name, stack: err.stack } : 'error' },
        'scheduled job failed',
      ),
  });
  const metrics = new MetricsStore(db.sqlite, now);
  const alerts = new AlertService(db.db, now);
  const tokens = new AgentTokens(db.db, now);
  const servers = new ServerService({
    db: db.db,
    now,
    metrics,
    alerts,
    log: app.log.child({ mod: 'servers' }),
  });
  const hub = new AgentHub({
    tokens,
    sink: servers,
    now,
    log: app.log.child({ mod: 'agents' }),
    ...(deps.agentOptions ? { options: deps.agentOptions } : {}),
  });
  servers.setConnections(hub);
  const containers = new ContainerService({
    db: db.db,
    now,
    alerts,
    log: app.log.child({ mod: 'containers' }),
  });
  servers.setContainers(containers);
  const logs = new ContainerLogs({
    hub,
    containers,
    now,
    log: app.log.child({ mod: 'logs' }),
  });
  const live = new LiveHub({
    db: db.db,
    now,
    servers,
    alerts,
    log: app.log.child({ mod: 'live' }),
    ...(deps.liveOptions ? { options: deps.liveOptions } : {}),
  });
  live.addProvider({
    matches: (topic) => topic === 'containers',
    snapshot: () => containers.list(),
    item: (_topic, id) => containers.summary(id),
  });
  live.addProvider({
    matches: (topic) => logs.matches(topic),
    has: (topic) => logs.has(topic),
    snapshot: (topic) => logs.snapshot(topic),
    open: (topic) => logs.open(topic),
    close: (topic) => logs.close(topic),
  });
  logs.setPublisher(live);
  containers.onChange((id, deleted) => live.mark('containers', id, deleted ? 'remove' : 'upsert'));

  // ---- M4: checks, push, notifications ----------------------------------------
  const checks = new CheckService({
    db: db.db,
    now,
    scheduler,
    alerts,
    hub,
    log: app.log.child({ mod: 'checks' }),
    ...(deps.rdapFetch ? { rdapFetch: deps.rdapFetch } : {}),
  });
  live.addProvider({
    matches: (topic) => topic === 'checks',
    snapshot: () => checks.list(),
    item: (_topic, id) => checks.summary(id),
  });
  checks.onChange((id, deleted) => live.mark('checks', id, deleted ? 'remove' : 'upsert'));
  const vapid = loadVapidKeys(db.db, box, now(), config.vapid);
  app.log.info({ source: vapid.source }, 'web push keys ready');
  const push = new PushService({
    db: db.db,
    box,
    now,
    log: app.log.child({ mod: 'push' }),
    transport: deps.pushTransport ?? fetchTransport,
    vapid: vapid.keys,
    subject: vapidSubject(config),
  });
  const notifier = new Notifier({
    alerts,
    push,
    now,
    settings: () => readNotifySettings(db.db),
    log: app.log.child({ mod: 'notify' }),
  });

  app.decorate('hzCore', {
    scheduler,
    tokens,
    hub,
    metrics,
    alerts,
    servers,
    containers,
    logs,
    live,
    checks,
    push,
    notifier,
    db,
  });

  scheduler.every('servers.status', 5_000, () => servers.refreshAll());
  scheduler.every('live.sessions', 5_000, () => live.checkSessions());
  scheduler.every('agents.heartbeat', 30_000, () => hub.heartbeat());
  scheduler.every('metrics.rollup5m', 5 * 60_000, () => void metrics.rollup5m(), { align: true });
  scheduler.every('metrics.rollup1h', HOUR, () => void metrics.rollup1h(), { align: true });
  scheduler.every('metrics.prune', HOUR, () => void metrics.prune());
  checks.start();
  scheduler.every('push.warnBundle', 60_000, () => notifier.flush());
  scheduler.at('report.weekly', nextWeeklyReport, () => {
    if (!readNotifySettings(db.db).weeklyReport) return;
    const list = servers.list();
    const { title, body } = weeklyReportText({
      openAlerts: alerts.activeCount(),
      checks: checks.uptimes(7 * DAY),
      serversOffline: list.filter((s) => s.reasons.some((r) => r.code === 'offline')).length,
      serversTotal: list.length,
    });
    alerts.log('report:weekly', 'info', title, body, null, 'system');
  });
  if (config.demo) {
    seedDemo({ db: db.db, now, servers, metrics, scheduler, logs });
    app.log.warn('HZ_DEMO=1: demo servers with simulated metrics');
  }

  app.addHook('onReady', async () => {
    // Catch up after downtime: raw data lives 48 h, 5-min means 30 days.
    metrics.rollup5m(48 * HOUR);
    metrics.rollup1h(30 * DAY);
    if (deps.startScheduler !== false) scheduler.start();
  });
  app.addHook('preClose', async () => {
    scheduler.stop();
    // Let running checks and pushes finish before the database closes (bounded).
    await Promise.race([
      Promise.all([checks.idle(), push.idle()]),
      new Promise((r) => setTimeout(r, 3_000).unref()),
    ]);
    hub.shutdown();
    live.closeAll();
    logs.closeAll();
  });

  await app.register(fastifyWebsocket, {
    options: { maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false },
  });
  await app.register(agentRoutes, { hub });
  await app.register(liveRoutes, { auth, live, baseUrl: config.baseUrl });
  await app.register(serverRoutes, {
    prefix: '/api',
    db: db.db,
    now,
    config,
    servers,
    hub,
    tokens,
    metrics,
    alerts,
  });
  await app.register(alertRoutes, { prefix: '/api', db: db.db, now, alerts });
  await app.register(containerRoutes, { prefix: '/api', db: db.db, now, containers, servers, hub });
  await app.register(checkRoutes, { prefix: '/api', db: db.db, now, checks });
  await app.register(pushRoutes, { prefix: '/api', db: db.db, now, push });

  const webDir = resolve(config.webDir ?? defaultWebDir);
  const hasWeb = existsSync(resolve(webDir, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, { root: webDir, wildcard: false });
  }

  app.setNotFoundHandler((request, reply) => {
    if (hasWeb && request.method === 'GET' && !isApiPath(requestPath(request.url))) {
      return reply.type('text/html').sendFile('index.html');
    }
    return sendError(reply, 404, 'not_found');
  });

  return app;
}
