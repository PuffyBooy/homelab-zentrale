import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LightMyRequestResponse } from 'fastify';
import type { IntegrationId } from '@hz/shared';
import { stepUp } from './agent-helpers.js';
import { authHeaders, completeSetup, makeApp, type TestApp } from './helpers.js';

/** Sentinel credential: must never show up in responses, errors or logs. */
export const SENTINEL = 'SENTINEL-s3cr3t-Value-0123456789';
export const OTHER_SECRET = 'other-secret-abcdefghijklmnop';
export const PVE_TOKEN_ID = 'hz@pve!zentrale';

export interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export type FakeHandler = (req: Recorded, res: ServerResponse) => void;

/** Local HTTP server on 127.0.0.1 that records every request. */
export class FakeServer {
  readonly requests: Recorded[] = [];
  handler: FakeHandler = (_q, r) => {
    r.statusCode = 404;
    r.end();
  };
  private server: Server | null = null;
  port = 0;

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(handler?: FakeHandler): Promise<this> {
    if (handler) this.handler = handler;
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const rec: Recorded = {
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        this.requests.push(rec);
        this.handler(rec, res);
      });
    });
    await new Promise<void>((r) => this.server?.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

export interface IntegrationSetup {
  t: TestApp;
  cookie: string;
  secret: string;
  req: (
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    url: string,
    payload?: unknown,
  ) => Promise<LightMyRequestResponse>;
  stepUp: () => Promise<void>;
  /** Drops the step-up of the setup session (16 min later). */
  expireStepUp: () => void;
  configure: (id: IntegrationId, body: Record<string, unknown>) => Promise<LightMyRequestResponse>;
}

export async function withIntegrations(
  opts: { captureLogs?: boolean; modules?: Partial<Record<IntegrationId, boolean>> } = {},
): Promise<IntegrationSetup> {
  const t = await makeApp({
    captureLogs: opts.captureLogs ?? false,
    modules: {
      proxmox: true,
      dnsfilter: true,
      fritzbox: true,
      uptimekuma: true,
      ...opts.modules,
    },
  });
  const { cookie, secret } = await completeSetup(t);
  const req: IntegrationSetup['req'] = (method, url, payload) =>
    t.app.inject({
      method,
      url,
      headers: authHeaders(cookie),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const s: IntegrationSetup = {
    t,
    cookie,
    secret,
    req,
    stepUp: () => stepUp(t, secret, cookie),
    expireStepUp: () => t.clock.advance(16 * 60_000),
    configure: async (id, body) => {
      await stepUp(t, secret, cookie);
      return req('PUT', `/api/${id}/settings`, body);
    },
  };
  return s;
}

/** Runs the scheduler tick and waits for background polls. */
export async function tickIntegrations(t: TestApp): Promise<void> {
  await t.app.hzCore.scheduler.tick();
  await t.app.hzCore.integrations.idle();
}
