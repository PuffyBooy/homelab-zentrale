import { SPEEDTEST_HOST, type RpcParams, type SpeedtestData } from '@hz/shared';
import { ActionError, type ActionContext } from './types.js';

/**
 * speedtest.run (M20): download, upload, latency and jitter against Cloudflare.
 *
 * - The only target is https://speed.cloudflare.com (SPEEDTEST_BASE). No URL, host or
 *   path comes from the wire; redirects are refused (`redirect: 'error'`, 3xx = failure).
 * - Latency: LATENCY_SAMPLES sequential `GET /__down?bytes=0`, median; jitter = mean
 *   absolute difference of consecutive samples.
 * - Download: PARALLEL workers with `GET /__down?bytes=N` (growing N), upload:
 *   `POST /__up` with N zero bytes. Every direction stops after maxSeconds (all
 *   requests aborted) or once maxBytes are used up: request sizes are reserved from
 *   the byte budget before a request starts, so a direction never transfers more.
 * - Colo from `GET /cdn-cgi/trace`, only the `colo=` line (^[A-Z]{3}$), else null.
 * - One test per agent at a time (`busy`).
 *
 * The base URL and fetch can be replaced only by tests (NODE_ENV=test, loopback only).
 */

export const SPEEDTEST_BASE = `https://${SPEEDTEST_HOST}`;
export const LATENCY_SAMPLES = 10;
export const PARALLEL = 4;
const REQUEST_TIMEOUT_MS = 5000;
const DOWN_CHUNK_START = 1024 * 1024;
const DOWN_CHUNK_MAX = 25 * 1024 * 1024;
const UP_CHUNK_START = 256 * 1024;
const UP_CHUNK_MAX = 8 * 1024 * 1024;
const TRACE_MAX_BYTES = 8 * 1024;
/** Failed requests per direction before it gives up. */
const MAX_FAILURES = 6;

type FetchFn = typeof fetch;

export interface SpeedtestDeps {
  /** Only in tests (NODE_ENV=test) and only loopback. */
  baseUrl?: string;
  fetch?: FetchFn;
  now?: () => number;
}

function resolveBase(deps: SpeedtestDeps): string {
  if (deps.baseUrl === undefined) return SPEEDTEST_BASE;
  const u = new URL(deps.baseUrl);
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (process.env.NODE_ENV !== 'test' || !loopback) {
    throw new Error('speed test base url is fixed');
  }
  return u.origin;
}

let running = false;

/** For tests: whether a speed test is running. */
export function speedtestRunning(): boolean {
  return running;
}

class Client {
  constructor(
    private readonly base: string,
    private readonly fetchFn: FetchFn,
  ) {}

  async request(pathAndQuery: string, init: RequestInit): Promise<Response> {
    const url = new URL(pathAndQuery, this.base);
    // Defense in depth: the URL can only point at the fixed origin.
    if (url.origin !== this.base) throw new Error('wrong origin');
    const res = await this.fetchFn(url, {
      ...init,
      redirect: 'error',
      credentials: 'omit',
    });
    if (res.status < 200 || res.status > 299 || res.redirected) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`status ${res.status}`);
    }
    return res;
  }
}

/** Reads a body, counting bytes; throws above `limit`. */
async function drain(
  res: Response,
  limit: number,
  onBytes: (n: number) => void = () => undefined,
): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  if (!res.body) return chunks;
  const reader = res.body.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error('response too large');
    }
    onBytes(value.length);
    chunks.push(value);
  }
  return chunks;
}

export function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export function jitter(values: readonly number[]): number {
  if (values.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < values.length; i++) {
    sum += Math.abs((values[i] as number) - (values[i - 1] as number));
  }
  return sum / (values.length - 1);
}

const round = (n: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

function mbps(bytes: number, ms: number): number {
  if (bytes <= 0 || ms <= 0) return 0;
  return round((bytes * 8) / (ms / 1000) / 1e6, 2);
}

interface DirectionResult {
  bytes: number;
  ms: number;
}

async function measure(
  dir: 'down' | 'up',
  client: Client,
  maxMs: number,
  maxBytes: number,
  now: () => number,
): Promise<DirectionResult> {
  const ctrl = new AbortController();
  const start = now();
  let stop = false;
  let reserved = 0;
  let bytes = 0;
  let failures = 0;
  const timer = setTimeout(() => {
    stop = true;
    ctrl.abort();
  }, maxMs);
  const zeros = dir === 'up' ? new Uint8Array(UP_CHUNK_MAX) : new Uint8Array(0);

  const worker = async () => {
    let size = dir === 'down' ? DOWN_CHUNK_START : UP_CHUNK_START;
    const maxChunk = dir === 'down' ? DOWN_CHUNK_MAX : UP_CHUNK_MAX;
    while (!stop) {
      const n = Math.min(size, maxBytes - reserved);
      if (n <= 0) break;
      reserved += n;
      try {
        if (dir === 'down') {
          const res = await client.request(`/__down?bytes=${n}`, { signal: ctrl.signal });
          await drain(res, n, (k) => (bytes += k));
        } else {
          const res = await client.request('/__up', {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: zeros.subarray(0, n),
            signal: ctrl.signal,
          });
          await drain(res, 64 * 1024);
          bytes += n;
        }
      } catch {
        if (stop) break;
        failures += 1;
        if (failures >= MAX_FAILURES) {
          stop = true;
          ctrl.abort();
          break;
        }
      }
      size = Math.min(size * 2, maxChunk);
    }
  };
  try {
    await Promise.all(Array.from({ length: PARALLEL }, () => worker()));
  } finally {
    clearTimeout(timer);
  }
  return { bytes, ms: Math.max(1, now() - start) };
}

async function latency(client: Client, now: () => number): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < LATENCY_SAMPLES; i++) {
    const t0 = now();
    try {
      const res = await client.request('/__down?bytes=0', {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      await drain(res, 1024);
      samples.push(now() - t0);
    } catch {
      // a lost sample; the median uses the others
    }
  }
  return samples;
}

async function colo(client: Client): Promise<string | null> {
  try {
    const res = await client.request('/cdn-cgi/trace', {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = Buffer.concat(await drain(res, TRACE_MAX_BYTES)).toString('utf8');
    const m = /^colo=([A-Z]{3})$/m.exec(text.replace(/\r/g, ''));
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Runs the speed test. Exported for tests (injected base URL / fetch). */
export async function runSpeedtest(
  p: RpcParams<'speedtest.run'>,
  deps: SpeedtestDeps = {},
): Promise<SpeedtestData> {
  const base = resolveBase(deps);
  if (running) throw new ActionError('busy', 'a speed test is already running', false);
  running = true;
  try {
    const now = deps.now ?? (() => performance.now());
    const client = new Client(base, deps.fetch ?? fetch);
    const started = now();
    const pings = await latency(client, now);
    if (pings.length === 0) {
      throw new ActionError('failed', `${SPEEDTEST_HOST} not reachable`, false);
    }
    const dc = await colo(client);
    const maxMs = p.maxSeconds * 1000;
    const down = await measure('down', client, maxMs, p.maxBytes, now);
    const up = await measure('up', client, maxMs, p.maxBytes, now);
    if (down.bytes === 0 && up.bytes === 0) {
      throw new ActionError('failed', 'speed test transferred no data', false);
    }
    return {
      downloadMbps: mbps(down.bytes, down.ms),
      uploadMbps: mbps(up.bytes, up.ms),
      latencyMs: round(median(pings), 1),
      jitterMs: round(jitter(pings), 1),
      downloadBytes: down.bytes,
      uploadBytes: up.bytes,
      durationMs: Math.max(0, Math.round(now() - started)),
      colo: dc,
    };
  } finally {
    running = false;
  }
}

export async function speedtestRun(
  p: RpcParams<'speedtest.run'>,
  ctx: ActionContext,
): Promise<SpeedtestData> {
  const r = await runSpeedtest(p);
  ctx.log.info('speed test finished', {
    downloadMbps: r.downloadMbps,
    uploadMbps: r.uploadMbps,
    latencyMs: r.latencyMs,
    durationMs: r.durationMs,
  });
  return r;
}
