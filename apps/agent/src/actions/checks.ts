import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { CheckResultData, RpcParams } from '@hz/shared';
import { ActionError, type ActionContext } from './types.js';

/**
 * check.http / check.tcp / check.ping, run from this agent ("von außen").
 *
 * Security rules (docs/SECURITY.md):
 * - Hosts are validated again here with a strict hostname/IP check, before any
 *   socket or program is touched. The shared schema is the first line, this is
 *   the second.
 * - ping runs through ctx.run (exec.ts: execFile, argument array, no shell)
 *   with fixed arguments and a `--` separator before the host.
 * - Response bodies are never logged or returned; only `contains` true/false.
 * - URLs are logged only through redactUrl (no credentials, no query).
 * - Error strings are fixed texts or Node error codes, never server output.
 */

/** At most this many body bytes are read for `contains`. */
export const MAX_BODY = 1024 * 1024;
export const MAX_REDIRECTS = 5;
const USER_AGENT = 'homelab-agent-check';

// Hosts ---------------------------------------------------------------------

const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * Returns the host without IPv6 brackets if it is a plain DNS name, an IPv4 or
 * an IPv6 address; null otherwise. Rejects everything that could be read as an
 * option or shell syntax (leading '-', spaces, '$', ';', '%', '/', ...).
 */
export function normalizeHost(input: unknown): string | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > 253) return null;
  const bracketed = /^\[([0-9A-Fa-f:.]+)\]$/.exec(input);
  if (bracketed?.[1] !== undefined) return net.isIPv6(bracketed[1]) ? bracketed[1] : null;
  if (net.isIPv4(input)) return input;
  if (/^[0-9A-Fa-f:.]+$/.test(input) && input.includes(':')) {
    return net.isIPv6(input) ? input : null;
  }
  const name = input.endsWith('.') ? input.slice(0, -1) : input;
  const labels = name.split('.');
  if (labels.length === 0 || !labels.every((l) => LABEL.test(l))) return null;
  // A numeric last label is never a real TLD; such strings (1234, 999.1.1.1,
  // 0x7f.1) would be read as an IP address in another notation.
  if (/^(?:\d+|0x[0-9a-f]+)$/i.test(labels.at(-1) ?? '')) return null;
  return name;
}

function requireHost(input: unknown): string {
  const host = normalizeHost(input);
  if (host === null) throw new ActionError('invalid_params', 'invalid host');
  return host;
}

/** URL for logs: scheme, host, port and path. No credentials, no query, no fragment. */
export function redactUrl(input: string | URL): string {
  try {
    const u = new URL(String(input));
    return `${u.protocol}//${u.host}${u.pathname}`.slice(0, 300);
  } catch {
    return '[invalid url]';
  }
}

/** Only Node error codes like ECONNREFUSED or CERT_HAS_EXPIRED leave the agent. */
function errorCode(err: unknown, fallback: string): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : fallback;
}

const elapsed = (started: number) => Math.round(performance.now() - started);

// check.tcp -----------------------------------------------------------------

export function checkTcp(p: RpcParams<'check.tcp'>): Promise<CheckResultData> {
  const host = requireHost(p.host);
  if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) {
    throw new ActionError('invalid_params', 'invalid port');
  }
  const started = performance.now();
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect({ host, port: p.port });
    const done = (r: CheckResultData) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    // Hard deadline: covers DNS lookup and connect.
    const timer = setTimeout(() => done({ ok: false, ms: null, error: 'timeout' }), p.timeoutMs);
    socket.once('connect', () => done({ ok: true, ms: elapsed(started) }));
    socket.once('error', (err) =>
      done({ ok: false, ms: null, error: errorCode(err, 'connect failed') }),
    );
  });
}

// check.http ----------------------------------------------------------------

function parseCheckUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ActionError('invalid_params', 'invalid url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ActionError('invalid_params', 'only http and https');
  }
  if (normalizeHost(url.hostname) === null) throw new ActionError('invalid_params', 'invalid host');
  return url;
}

function certExpiry(socket: unknown): string | undefined {
  const s = socket as Partial<TLSSocket> | null;
  if (!s || typeof s.getPeerCertificate !== 'function') return undefined;
  const cert = s.getPeerCertificate();
  const exp = cert?.valid_to ? new Date(cert.valid_to) : null;
  return exp && !Number.isNaN(exp.getTime()) ? exp.toISOString() : undefined;
}

interface Hop {
  code: number;
  /** Set for 301/302/303/307/308 with a Location header. */
  location?: string;
  /** performance.now() when the response headers arrived. */
  at: number;
  tlsExpiresAt?: string;
  body?: Buffer;
  bodyError?: string;
}

export interface HttpCheckOptions {
  /** Extra CA certificates (tests only; production uses the system store). */
  ca?: string | Buffer;
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

function hop(
  url: URL,
  method: 'GET' | 'HEAD',
  signal: AbortSignal,
  wantBody: boolean,
  opts: HttpCheckOptions,
): Promise<Hop> {
  const isHttps = url.protocol === 'https:';
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const requestOpts: https.RequestOptions = {
      method,
      agent: false,
      signal,
      headers: { 'user-agent': USER_AGENT, accept: '*/*', 'accept-encoding': 'identity' },
      ...(isHttps ? { rejectUnauthorized: true, ...(opts.ca ? { ca: opts.ca } : {}) } : {}),
    };
    const lib = isHttps ? https : http;
    /** Set once headers arrived; later request errors end the body read instead. */
    let bodyFailed: ((reason: string) => void) | undefined;
    const req = lib.request(url, requestOpts, (res) => {
      const at = performance.now();
      const code = res.statusCode ?? 0;
      const tlsExpiresAt = isHttps ? certExpiry(res.socket) : undefined;
      const base: Hop = { code, at, ...(tlsExpiresAt ? { tlsExpiresAt } : {}) };
      bodyFailed = () => settle(() => resolve(base));
      const location = res.headers.location;
      if (REDIRECT_CODES.has(code) && typeof location === 'string' && location.length > 0) {
        settle(() => resolve({ ...base, location: location.slice(0, 2048) }));
        req.destroy();
        return;
      }
      if (!wantBody || method === 'HEAD') {
        settle(() => resolve(base));
        req.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      const finish = (bodyError?: string) =>
        settle(() =>
          resolve({
            ...base,
            body: Buffer.concat(chunks, size),
            ...(bodyError ? { bodyError } : {}),
          }),
        );
      bodyFailed = (reason) => finish(reason);
      res.on('data', (chunk: Buffer) => {
        const room = MAX_BODY - size;
        if (room <= 0) return;
        const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
        chunks.push(part);
        size += part.length;
        if (size >= MAX_BODY) {
          // Enough read: stop downloading, search what we have.
          finish();
          req.destroy();
        }
      });
      res.once('end', () => finish());
      res.once('error', () => finish(signal.aborted ? 'timeout' : 'body read failed'));
      res.once('close', () =>
        finish(signal.aborted ? 'timeout' : res.complete ? undefined : 'body read failed'),
      );
    });
    req.once('error', (err) => {
      if (bodyFailed) bodyFailed(signal.aborted ? 'timeout' : 'body read failed');
      else settle(() => reject(err));
    });
    req.end();
  });
}

/**
 * Builds the check.http handler.
 * - One deadline (timeoutMs) for everything: DNS, connect, TLS, redirects, body.
 * - Redirects: at most MAX_REDIRECTS, only to http/https. Credentials from the
 *   URL are dropped when a redirect leaves the origin.
 * - `contains` searches the first MAX_BODY bytes of the final response.
 * - tlsExpiresAt: certificate of the configured host (first https hop on it).
 */
export function createHttpChecker(opts: HttpCheckOptions = {}) {
  return async function checkHttp(
    p: RpcParams<'check.http'>,
    ctx?: Pick<ActionContext, 'log'>,
  ): Promise<CheckResultData> {
    let url = parseCheckUrl(p.url);
    const configuredHost = url.hostname;
    const started = performance.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), p.timeoutMs);
    const wantBody = p.contains !== undefined && p.method !== 'HEAD';
    let tlsExpiresAt: string | undefined;
    const withTls = (r: CheckResultData): CheckResultData =>
      tlsExpiresAt ? { ...r, tlsExpiresAt } : r;
    ctx?.log.debug('check.http', { url: redactUrl(url), method: p.method });

    try {
      for (let redirects = 0; ; redirects++) {
        let h: Hop;
        try {
          h = await hop(url, p.method, ac.signal, wantBody, opts);
        } catch (err) {
          if (ac.signal.aborted) return withTls({ ok: false, ms: null, error: 'timeout' });
          // A failed verification (expired, self-signed) reports only its error code;
          // TLS verification is never switched off to read the date.
          const code = errorCode(err, 'request failed');
          return withTls({ ok: false, ms: null, error: code });
        }
        if (h.tlsExpiresAt && tlsExpiresAt === undefined && url.hostname === configuredHost) {
          tlsExpiresAt = h.tlsExpiresAt;
        }
        const ms = Math.round(h.at - started);

        if (h.location !== undefined) {
          if (redirects >= MAX_REDIRECTS) {
            return withTls({ ok: false, code: h.code, ms, error: 'too many redirects' });
          }
          let next: URL;
          try {
            next = new URL(h.location, url);
          } catch {
            return withTls({ ok: false, code: h.code, ms, error: 'invalid redirect' });
          }
          if (next.protocol !== 'http:' && next.protocol !== 'https:') {
            return withTls({
              ok: false,
              code: h.code,
              ms,
              error: 'redirect to unsupported scheme',
            });
          }
          if (normalizeHost(next.hostname) === null) {
            return withTls({ ok: false, code: h.code, ms, error: 'invalid redirect' });
          }
          if (next.origin !== url.origin) {
            next.username = '';
            next.password = '';
          } else if (!next.username && !next.password) {
            next.username = url.username;
            next.password = url.password;
          }
          url = next;
          continue;
        }

        const result: CheckResultData = {
          ok: h.code >= p.expectStatusMin && h.code <= p.expectStatusMax,
          code: h.code,
          ms,
        };
        if (wantBody && p.contains !== undefined) {
          const found = (h.body ?? Buffer.alloc(0)).includes(Buffer.from(p.contains, 'utf8'));
          if (!found) {
            result.ok = false;
            result.error = h.bodyError ?? 'text not found';
          }
        }
        return withTls(result);
      }
    } finally {
      clearTimeout(timer);
    }
  };
}

export const checkHttp = createHttpChecker();

// check.ping ----------------------------------------------------------------

/**
 * Average round trip from the summary line, in ms.
 *   iputils: "rtt min/avg/max/mdev = 0.031/0.042/0.051/0.008 ms"
 *   busybox: "round-trip min/avg/max = 0.031/0.042/0.051 ms"
 */
export function parsePingAvg(text: string): number | null {
  const m = /(?:rtt|round-trip) min\/avg\/max(?:\/[a-z]+)? = [\d.]+\/([\d.]+)\//.exec(text);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Fixed arguments; the host is always the last one, after `--`. */
/** ping's own deadline in whole seconds, leaving 0.5 s to exit before the hard kill. */
function pingDeadlineS(timeoutMs: number): number {
  return Math.max(1, Math.floor((timeoutMs - 500) / 1000));
}

export function pingArgs(host: string, count: number, timeoutMs: number): string[] {
  const deadlineS = pingDeadlineS(timeoutMs);
  return [
    '-n', // no reverse DNS
    '-q', // summary only
    '-c',
    String(count),
    '-i',
    '0.2', // smallest interval allowed without root; 5 probes fit into 1 s
    '-W',
    String(deadlineS),
    '-w',
    String(deadlineS),
    '--',
    host,
  ];
}

/**
 * Hard kill for the ping process: timeoutMs itself; only below 1.5 s (ping's
 * smallest deadline is 1 s) it is 1.5 s.
 */
export function pingKillAfterMs(timeoutMs: number): number {
  return Math.max(timeoutMs, pingDeadlineS(timeoutMs) * 1000 + 500);
}

function pingError(code: number | null, stderr: string): string {
  if (/not known|unknown host|name resolution|no address associated/i.test(stderr)) {
    return 'dns failed';
  }
  if (/not permitted|permission denied/i.test(stderr)) return 'ping not permitted';
  if (code === 1) return 'no reply';
  return 'ping failed';
}

export async function checkPing(
  p: RpcParams<'check.ping'>,
  ctx: Pick<ActionContext, 'run'>,
): Promise<CheckResultData> {
  const host = requireHost(p.host);
  const count = Number.isInteger(p.count) && p.count >= 1 && p.count <= 5 ? p.count : 1;
  const r = await ctx.run('ping', pingArgs(host, count, p.timeoutMs), {
    timeoutMs: pingKillAfterMs(p.timeoutMs),
    maxBuffer: 64 * 1024,
  });
  if (r.error === 'not_found') throw new ActionError('failed', 'ping not available');
  if (r.error === 'timeout') return { ok: false, ms: null, error: 'timeout' };
  const avg = parsePingAvg(r.stdout);
  // Exit 1 with a summary line means partial loss (fewer than `count` replies
  // before the deadline); at least one reply counts as reachable.
  if ((r.code === 0 || r.code === 1) && avg !== null) {
    return { ok: true, ms: Math.round(avg * 10) / 10 };
  }
  return { ok: false, ms: null, error: pingError(r.code, r.stderr) };
}
