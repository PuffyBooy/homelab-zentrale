import dns, { type LookupAddress, type LookupOptions } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { isLinkLocalAddress } from '../integrations/http.js';

/** Hard limit for one outgoing message (connect + send + status line). */
export const NOTIFY_TIMEOUT_MS = 8_000;
/** The response body is never used; at most this much is read before the socket is dropped. */
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface NotifyRequest {
  /** Absolute http(s) URL. Validated by the caller for the channel. */
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface NotifyResponse {
  status: number;
}

/** Why a request did not produce a status code. */
export type NotifyTransportFailure = 'timeout' | 'tls' | 'unreachable' | 'blocked';

export class NotifyTransportError extends Error {
  constructor(public readonly kind: NotifyTransportFailure) {
    super(`notify transport: ${kind}`);
    this.name = 'NotifyTransportError';
  }
}

/** Sends one POST. Never follows redirects (a 3xx is returned as status). */
export interface NotifyTransport {
  post(req: NotifyRequest): Promise<NotifyResponse>;
}

/** Resolves a host name to all its addresses (injectable for tests). */
export type NotifyLookup = (hostname: string, options: LookupOptions) => Promise<LookupAddress[]>;

const systemLookup: NotifyLookup = (hostname, options) =>
  dns.promises.lookup(hostname, { ...options, all: true });

/**
 * DNS lookup that refuses link-local answers (cloud metadata), so a host name
 * that resolves to 169.254.169.254 is treated like the literal address. Uses
 * the same check as the integrations (all IPv6 and IPv4-mapped notations).
 */
export function createGuardedLookup(resolve: NotifyLookup = systemLookup): LookupFunction {
  return (hostname, options, callback) => {
    const opts = options as LookupOptions;
    resolve(hostname, opts).then(
      (list) => {
        if (list.length === 0 || list.some((x) => isLinkLocalAddress(x.address))) {
          callback(new NotifyTransportError('blocked'), '', 0);
          return;
        }
        if (opts.all === true) {
          (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
          return;
        }
        const first = list[0] as LookupAddress;
        callback(null, first.address, first.family);
      },
      (err: unknown) => {
        callback(err as NodeJS.ErrnoException, '', 0);
      },
    );
  };
}

export const guardedLookup: LookupFunction = createGuardedLookup();

const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_UNTRUSTED',
  'EPROTO',
]);

function failureOf(err: unknown): NotifyTransportFailure {
  if (err instanceof NotifyTransportError) return err.kind;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && TLS_CODES.has(code)) return 'tls';
  return 'unreachable';
}

/**
 * Default transport: node http/https, certificate verification always on, no
 * proxy, no redirects, 8 s for the whole exchange. The response body is drained
 * up to 64 KiB and ignored; error details never leave this function (only the
 * failure kind).
 */
export function createHttpNotifyTransport(opts: { lookup?: NotifyLookup } = {}): NotifyTransport {
  const lookup = opts.lookup === undefined ? guardedLookup : createGuardedLookup(opts.lookup);
  return {
    post(req) {
      return new Promise<NotifyResponse>((resolve, reject) => {
        let url: URL;
        try {
          url = new URL(req.url);
        } catch {
          reject(new NotifyTransportError('blocked'));
          return;
        }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
          reject(new NotifyTransportError('blocked'));
          return;
        }
        const body = Buffer.from(req.body, 'utf8');
        const mod = url.protocol === 'https:' ? https : http;
        let settled = false;
        const done = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn();
        };
        const request = mod.request(
          url,
          {
            method: 'POST',
            headers: { ...req.headers, 'content-length': String(body.length) },
            lookup,
            agent: false,
          },
          (res) => {
            const status = res.statusCode ?? 0;
            let read = 0;
            res.on('data', (chunk: Buffer) => {
              read += chunk.length;
              if (read > MAX_RESPONSE_BYTES) res.destroy();
            });
            res.on('error', () => undefined);
            res.on('close', () => done(() => resolve({ status })));
            res.on('end', () => done(() => resolve({ status })));
          },
        );
        const timer = setTimeout(() => {
          done(() => reject(new NotifyTransportError('timeout')));
          request.destroy();
        }, NOTIFY_TIMEOUT_MS);
        request.on('error', (err) => done(() => reject(new NotifyTransportError(failureOf(err)))));
        request.end(body);
      });
    },
  };
}

export const httpNotifyTransport: NotifyTransport = createHttpNotifyTransport();
