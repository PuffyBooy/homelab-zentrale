import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { createGateway } from '../src/server.js';
import { loadUi } from '../src/static.js';

export const GATEWAY_TOKEN = 'G'.repeat(20) + 'a'.repeat(23);
export const SHARE_TOKEN = 'Ab3_-' + 'x'.repeat(38);
export const INDEX_HTML =
  '<!doctype html><title>Share</title><script src="/s/assets/app.js"></script>';

export interface CoreRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export type CoreHandler = (req: CoreRequest) => {
  status?: number;
  body?: unknown;
  raw?: string;
  headers?: Record<string, string>;
  delayMs?: number;
};

export interface Harness {
  url: string;
  coreRequests: CoreRequest[];
  logs: string[];
  setCore(handler: CoreHandler): void;
  close(): Promise<void>;
  uiDir: string;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

export function makeUiDir(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-share-'));
  const ui = path.join(base, 'ui');
  fs.mkdirSync(path.join(ui, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(ui, 'index.html'), INDEX_HTML);
  fs.writeFileSync(path.join(ui, 'assets', 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(ui, 'assets', 'app.css'), 'body{}');
  fs.writeFileSync(path.join(ui, 'assets', 'app.js.map'), '{}');
  fs.writeFileSync(path.join(ui, 'assets', '.hidden.js'), 'secret');
  fs.mkdirSync(path.join(ui, 'assets', 'sub'));
  fs.writeFileSync(path.join(ui, 'assets', 'sub', 'x.js'), 'nested');
  fs.writeFileSync(path.join(base, 'secret.txt'), 'TOP-SECRET');
  fs.writeFileSync(path.join(base, 'outside.js'), 'TOP-SECRET');
  fs.symlinkSync(path.join(base, 'outside.js'), path.join(ui, 'assets', 'link.js'));
  return ui;
}

export async function startHarness(): Promise<Harness> {
  const coreRequests: CoreRequest[] = [];
  let handler: CoreHandler = () => ({ status: 500, body: {} });
  const core = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const r: CoreRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      coreRequests.push(r);
      const out = handler(r);
      const reply = (): void => {
        res.writeHead(out.status ?? 200, {
          'content-type': 'application/json',
          ...(out.headers ?? {}),
        });
        res.end(out.raw ?? JSON.stringify(out.body ?? {}));
      };
      if (out.delayMs) setTimeout(reply, out.delayMs);
      else reply();
    });
  });
  const corePort = await listen(core);
  const uiDir = makeUiDir();
  const logs: string[] = [];
  const config: Config = {
    coreUrl: `http://127.0.0.1:${corePort}`,
    gatewayToken: GATEWAY_TOKEN,
    port: 0,
    host: '127.0.0.1',
    uiDir,
    logLevel: 'debug',
  };
  const logger = createLogger('debug', (l) => logs.push(l));
  const gateway = createGateway({ config, logger, ui: loadUi(uiDir) });
  const port = await listen(gateway);
  return {
    url: `http://127.0.0.1:${port}`,
    coreRequests,
    logs,
    uiDir,
    setCore: (h) => {
      handler = h;
    },
    close: async () => {
      gateway.closeAllConnections();
      core.closeAllConnections();
      await Promise.all([new Promise((r) => gateway.close(r)), new Promise((r) => core.close(r))]);
    },
  };
}

let ipCounter = 0;
/** A fresh client IP per call so rate limits of one test do not affect another. */
export function freshIp(): string {
  ipCounter += 1;
  return `198.18.${Math.floor(ipCounter / 256) % 256}.${ipCounter % 256}`;
}

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Plain HTTP request with the path sent exactly as given (fetch would normalize it). */
export function raw(
  base: string,
  pathname: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: pathname,
        method: opts.method ?? 'GET',
        headers: {
          'x-forwarded-for': freshIp(),
          ...(opts.body !== undefined ? { 'content-length': Buffer.byteLength(opts.body) } : {}),
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

export const okStatus = {
  person: 'Max',
  perms: ['power', 'console_read'],
  expiresAt: null,
  game: {
    name: 'survival',
    game: 'Minecraft Java',
    version: '1.21.4',
    status: 'ok',
    statusText: 'Läuft',
    address: 'mc.example.at:25565',
    players: { online: 1, max: 10, names: ['Steve'] },
    whitelist: true,
    sleeping: false,
  },
  whitelistRequests: [],
};

export function shareHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Share ${SHARE_TOKEN}`, ...extra };
}
