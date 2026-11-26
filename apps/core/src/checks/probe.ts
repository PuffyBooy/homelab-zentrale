import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { TLSSocket } from 'node:tls';
import { performance } from 'node:perf_hooks';

/**
 * Probes that run in the core (runFrom 'core'). They return a short German
 * reason on failure and never surface raw error messages, response bodies or
 * the URL (the admin's URL could carry a token in the query string).
 */
export interface ProbeResult {
  ok: boolean;
  code?: number;
  /** Response time (ms), null if there was no response. */
  ms: number | null;
  /** Short German reason (failures only). */
  error?: string;
  /** HTTPS: expiry of the server certificate (ms since epoch). */
  tlsExpiresAt?: number;
}

export const PROBE_TIMEOUT_MS = 10_000;
/** At most this much of a body is read (for `contains`). */
export const MAX_BODY_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;

export interface HttpProbeInput {
  url: string;
  expectStatusMin: number;
  expectStatusMax: number;
  contains?: string | undefined;
  timeoutMs?: number;
}

/** Maps a socket/TLS error to a fixed reason. The error message itself is never used. */
export function reasonForError(err: unknown, timeoutMs: number): string {
  const code =
    typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : 'unknown';
  switch (code) {
    case 'ETIMEDOUT':
    case 'HZ_TIMEOUT':
      return `Timeout nach ${Math.round(timeoutMs / 1000)} s`;
    case 'ECONNREFUSED':
      return 'Verbindung abgelehnt';
    case 'ECONNRESET':
    case 'EPIPE':
      return 'Verbindung abgebrochen';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EAI_FAIL':
    case 'EAI_NONAME':
      return 'Name nicht auflösbar';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EHOSTDOWN':
      return 'Host nicht erreichbar';
    case 'CERT_HAS_EXPIRED':
      return 'SSL-Zertifikat abgelaufen';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
    case 'CERT_NOT_YET_VALID':
    case 'CERT_REVOKED':
      return 'SSL-Zertifikat ungültig';
    default:
      return code.startsWith('ERR_SSL') || code.startsWith('ERR_TLS')
        ? 'SSL-Verbindung fehlgeschlagen'
        : 'Verbindung fehlgeschlagen';
  }
}

/**
 * German text for an error reported by the agent (Node codes or the agent's fixed
 * English texts). Unknown texts never reach alerts verbatim.
 */
export function reasonForAgentError(error: string, timeoutMs: number): string {
  switch (error) {
    case 'timeout':
      return `Timeout nach ${Math.round(timeoutMs / 1000)} s`;
    case 'text not found':
      return 'Text nicht gefunden';
    case 'no reply':
      return 'Keine Antwort auf Ping';
    case 'dns failed':
      return 'Name nicht auflösbar';
    case 'ping not permitted':
      return 'Ping auf dem Server nicht erlaubt';
    case 'ping failed':
      return 'Ping fehlgeschlagen';
    case 'too many redirects':
      return 'Zu viele Weiterleitungen';
    case 'invalid redirect':
    case 'redirect to unsupported scheme':
      return 'Weiterleitung auf ein nicht unterstütztes Ziel';
    default:
      return /^[A-Z0-9_]+$/.test(error)
        ? reasonForError({ code: error }, timeoutMs)
        : 'Verbindung fehlgeschlagen';
  }
}

function timeoutError(): Error & { code: string } {
  return Object.assign(new Error('timeout'), { code: 'HZ_TIMEOUT' });
}

interface Hop {
  status: number;
  location: string | undefined;
  tlsExpiresAt: number | undefined;
  body: string | null;
}

function requestOnce(url: URL, wantBody: boolean, signal: AbortSignal): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const options: https.RequestOptions = {
      method: 'GET',
      // Fresh socket per request so the certificate is always the current one.
      agent: false,
      headers: {
        'user-agent': 'homelab-zentrale-check/1',
        accept: '*/*',
        'accept-encoding': 'identity',
      },
      signal,
    };
    const onResponse = (res: http.IncomingMessage): void => {
      let tlsExpiresAt: number | undefined;
      if (isHttps) {
        const cert = (res.socket as TLSSocket).getPeerCertificate?.();
        const t = cert?.valid_to ? Date.parse(cert.valid_to) : Number.NaN;
        if (Number.isFinite(t)) tlsExpiresAt = t;
      }
      const status = res.statusCode ?? 0;
      const location = typeof res.headers.location === 'string' ? res.headers.location : undefined;
      if (!wantBody || (status >= 300 && status < 400 && location)) {
        res.resume();
        res.destroy();
        resolve({ status, location, tlsExpiresAt, body: null });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve({
          status,
          location,
          tlsExpiresAt,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      };
      res.on('data', (chunk: Buffer) => {
        if (done) return;
        const room = MAX_BODY_BYTES - size;
        chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        size += Math.min(chunk.length, room);
        if (size >= MAX_BODY_BYTES) {
          finish();
          res.destroy();
        }
      });
      res.on('end', finish);
      res.on('error', (err) => (done ? undefined : reject(err)));
      res.on('close', finish);
    };
    const req = isHttps
      ? https.request(url, options, onResponse)
      : http.request(url, options, onResponse);
    req.on('error', reject);
    req.end();
  });
}

/**
 * HTTP(S) check: GET with a hard overall timeout, status range, optional text,
 * response time and certificate expiry. Redirects are followed (at most 5),
 * only to http(s). The body is only read when `contains` is set, at most 1 MB.
 */
export async function httpProbe(input: HttpProbeInput): Promise<ProbeResult> {
  const timeoutMs = input.timeoutMs ?? PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(timeoutError()), timeoutMs);
  const started = performance.now();
  let tlsExpiresAt: number | undefined;
  try {
    let url = new URL(input.url);
    for (let hop = 0; ; hop++) {
      const res = await requestOnce(url, input.contains !== undefined, controller.signal);
      // The certificate that matters is the one of the configured host.
      if (hop === 0) tlsExpiresAt = res.tlsExpiresAt;
      const tls = tlsExpiresAt !== undefined ? { tlsExpiresAt } : {};
      if (res.status >= 300 && res.status < 400 && res.location !== undefined) {
        if (hop >= MAX_REDIRECTS) {
          return {
            ok: false,
            code: res.status,
            ms: null,
            error: 'Zu viele Weiterleitungen',
            ...tls,
          };
        }
        let next: URL;
        try {
          next = new URL(res.location, url);
        } catch {
          return {
            ok: false,
            code: res.status,
            ms: null,
            error: 'Ungültige Weiterleitung',
            ...tls,
          };
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          return {
            ok: false,
            code: res.status,
            ms: null,
            error: 'Ungültige Weiterleitung',
            ...tls,
          };
        }
        url = next;
        continue;
      }
      const ms = Math.round(performance.now() - started);
      if (res.status < input.expectStatusMin || res.status > input.expectStatusMax) {
        return { ok: false, code: res.status, ms, error: `HTTP ${res.status}`, ...tls };
      }
      if (input.contains !== undefined && !(res.body ?? '').includes(input.contains)) {
        return { ok: false, code: res.status, ms, error: 'Erwarteter Text fehlt', ...tls };
      }
      return { ok: true, code: res.status, ms, ...tls };
    }
  } catch (err) {
    const cause = controller.signal.aborted ? controller.signal.reason : err;
    return { ok: false, ms: null, error: reasonForError(cause, timeoutMs) };
  } finally {
    clearTimeout(timer);
  }
}

/** TCP check: connect within the timeout. */
export function tcpProbe(
  host: string,
  port: number,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = net.connect({ host: host.replace(/^\[|\]$/g, ''), port });
    let settled = false;
    const done = (r: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    const timer = setTimeout(
      () => done({ ok: false, ms: null, error: reasonForError(timeoutError(), timeoutMs) }),
      timeoutMs,
    );
    socket.once('connect', () => done({ ok: true, ms: Math.round(performance.now() - started) }));
    socket.once('error', (err) =>
      done({ ok: false, ms: null, error: reasonForError(err, timeoutMs) }),
    );
  });
}
