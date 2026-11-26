import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import WebSocket, { WebSocketServer } from 'ws';
import { installAuthGuard } from '../src/auth/guard.js';
import { createSecretBox, type SecretBox } from '../src/crypto.js';
import type { WsFactory } from '../src/discord/gateway.js';
import { DISCORD_API } from '../src/discord/rest.js';
import { errorHandler } from '../src/http/errors.js';
import { KEY, type TestApp } from './helpers.js';

export const APP_ID = '111111111111111111';
export const GUILD_ID = '222222222222222222';
export const OTHER_GUILD = '333333333333333333';
export const FRIEND_ID = '444444444444444444';
export const STRANGER_ID = '555555555555555555';
/** Looks like a bot token, assembled at runtime (secret scanners stay quiet). */
export const BOT_TOKEN = ['MTExMTExMTExMTExMTExMTEx', 'GzAbCd', 'x'.repeat(27) + 'TESTONLY'].join(
  '.',
);
export const OTHER_BOT_TOKEN = [
  'MjIyMjIyMjIyMjIyMjIyMjIy',
  'HyEfGh',
  'y'.repeat(27) + 'TESTONLY',
].join('.');

export const box = (): SecretBox => createSecretBox(Buffer.from(KEY, 'base64'));

/**
 * In-process Discord Gateway: HELLO, IDENTIFY (token check, 4004), READY,
 * RESUME -> RESUMED, heartbeat ACKs (switchable), interactions on demand.
 */
export class FakeGateway {
  readonly tokens = new Set([BOT_TOKEN]);
  readonly frames: { op: number; d: unknown }[] = [];
  readonly sockets = new Set<WebSocket>();
  /** URLs the client asked the factory for (before the test redirect). */
  readonly requested: string[] = [];
  heartbeatInterval = 200;
  ackHeartbeats = true;
  connections = 0;
  seq = 1;
  sessionId = 'session-1';
  resumeUrl = 'wss://gateway-us-east1-b.discord.gg';
  userName = 'Zentrale';
  applicationId = APP_ID;
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  port = 0;

  async start(): Promise<void> {
    const http = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    const wss = new WebSocketServer({ server: http });
    wss.on('connection', (ws) => this.accept(ws));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    this.port = (http.address() as AddressInfo).port;
    this.http = http;
    this.wss = wss;
  }

  async stop(): Promise<void> {
    for (const ws of this.sockets) ws.terminate();
    this.sockets.clear();
    this.wss?.close();
    const http = this.http;
    this.http = null;
    if (http) {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  }

  /** Connects to this fake instead of Discord; records the URL the client wanted. */
  factory: WsFactory = (url, opts) => {
    this.requested.push(url);
    const u = new URL(url);
    return new WebSocket(`ws://127.0.0.1:${this.port}/${u.search}`, opts);
  };

  ofOp(op: number): { op: number; d: unknown }[] {
    return this.frames.filter((f) => f.op === op);
  }

  send(payload: unknown): void {
    for (const ws of this.sockets) ws.send(JSON.stringify(payload));
  }

  dispatch(t: string, d: unknown): void {
    this.seq += 1;
    this.send({ op: 0, t, s: this.seq, d });
  }

  closeAll(code: number): void {
    for (const ws of this.sockets) ws.close(code);
  }

  private accept(ws: WebSocket): void {
    this.connections += 1;
    this.sockets.add(ws);
    ws.on('close', () => this.sockets.delete(ws));
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: this.heartbeatInterval } }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { op: number; d: Record<string, unknown> };
      this.frames.push(msg);
      if (msg.op === 1) {
        if (this.ackHeartbeats) ws.send(JSON.stringify({ op: 11 }));
      } else if (msg.op === 2) {
        if (!this.tokens.has(String(msg.d.token))) {
          ws.close(4004, 'Authentication failed.');
          return;
        }
        ws.send(
          JSON.stringify({
            op: 0,
            t: 'READY',
            s: this.seq,
            d: {
              v: 10,
              session_id: this.sessionId,
              resume_gateway_url: this.resumeUrl,
              user: { id: '999999999999999999', username: this.userName, discriminator: '0' },
              application: { id: this.applicationId, flags: 0 },
              guilds: [],
            },
          }),
        );
      } else if (msg.op === 6) {
        if (!this.tokens.has(String(msg.d.token))) {
          ws.close(4004, 'Authentication failed.');
          return;
        }
        this.seq += 1;
        ws.send(JSON.stringify({ op: 0, t: 'RESUMED', s: this.seq, d: {} }));
      }
    });
  }
}

export interface RestCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  redirect: RequestInit['redirect'];
}

/** Fake Discord REST: /gateway/bot, command registration, callbacks, edits. */
export class FakeRest {
  readonly calls: RestCall[] = [];
  gatewayUrl = 'wss://gateway.discord.gg';
  commandsStatus = 200;

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    this.calls.push({ method: init.method ?? 'GET', url, headers, body, redirect: init.redirect });
    const path = url.startsWith(DISCORD_API) ? url.slice(DISCORD_API.length) : null;
    const json = (status: number, v: unknown) =>
      new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (path === null) return json(404, {});
    const auth = headers.authorization;
    if (path === '/gateway/bot') {
      if (auth !== `Bot ${BOT_TOKEN}`) return json(401, { message: '401: Unauthorized' });
      return json(200, { url: this.gatewayUrl, shards: 1 });
    }
    if (/^\/applications\/\d+\/guilds\/\d+\/commands$/.test(path)) {
      return json(this.commandsStatus, []);
    }
    if (/^\/interactions\/\d+\/[^/]+\/callback$/.test(path))
      return new Response(null, { status: 204 });
    if (/^\/webhooks\/\d+\/[^/]+\/messages\/@original$/.test(path)) return json(200, {});
    return json(404, {});
  };

  callbacks(): {
    type: number;
    data: { content?: string; flags?: number; allowed_mentions?: unknown };
  }[] {
    return this.calls
      .filter((c) => c.url.endsWith('/callback'))
      .map((c) => c.body as { type: number; data: { content?: string; flags?: number } });
  }

  edits(): { content: string; allowed_mentions?: unknown }[] {
    return this.calls
      .filter((c) => c.method === 'PATCH')
      .map((c) => c.body as { content: string; allowed_mentions?: unknown });
  }

  /** Text of every reply (immediate callbacks and edits of deferred ones). */
  texts(): string[] {
    return [
      ...this.callbacks()
        .filter((c) => c.type === 4)
        .map((c) => c.data.content ?? ''),
      ...this.edits().map((e) => e.content),
    ];
  }
}

let interactionSeq = 0;
/** An INTERACTION_CREATE payload for a slash command. */
export function interaction(
  command: string,
  opts: { user?: string; guild?: string | null; spiel?: string; app?: string; type?: number } = {},
): Record<string, unknown> {
  interactionSeq += 1;
  const id = String(700000000000000000n + BigInt(interactionSeq));
  return {
    id,
    application_id: opts.app ?? APP_ID,
    type: opts.type ?? 2,
    token: ['aW50ZXJhY3Rpb246', String(interactionSeq), 'OnRlc3QtdG9rZW4tZm9yLXRlc3Rz'].join(''),
    ...(opts.guild === null ? {} : { guild_id: opts.guild ?? GUILD_ID }),
    member: { user: { id: opts.user ?? FRIEND_ID, username: 'friend' } },
    data: {
      id: '888888888888888888',
      name: command,
      type: 1,
      ...(opts.spiel !== undefined
        ? { options: [{ name: 'spiel', type: 3, value: opts.spiel }] }
        : {}),
    },
  };
}

export interface SideApp {
  app: FastifyInstance;
  logs: string[];
}

/**
 * A small Fastify instance with the real global guard of the test app (same
 * session store, so the admin cookie and step-up work) for routes that are not
 * wired into app.ts yet.
 */
export async function sideApp(
  t: TestApp,
  register: (app: FastifyInstance) => Promise<void>,
): Promise<SideApp> {
  const logs: string[] = [];
  const app = Fastify({
    logger: {
      level: 'debug',
      stream: new Writable({
        write(chunk: Buffer, _enc, cb) {
          logs.push(chunk.toString('utf8'));
          cb();
        },
      }),
    },
  });
  await app.register(fastifyCookie);
  installAuthGuard(app, {
    sessions: t.app.hzAuth.sessions,
    baseUrl: undefined,
    wallDevices: () => null,
  });
  app.setErrorHandler(errorHandler);
  await register(app);
  await app.ready();
  return { app, logs };
}
