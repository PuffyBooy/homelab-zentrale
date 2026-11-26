import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { integrationUrlSchema, type INTEGRATION_ERRORS } from '@hz/shared';

/**
 * The one outgoing HTTP client of the integrations (Proxmox, DNS filter,
 * FRITZ!Box, Uptime Kuma). Rules (packages/shared/src/api/integrations.ts):
 * - the base URL is checked with integrationUrlSchema before every request, the
 *   path stays on its origin;
 * - the host name is resolved here and refused if any address is link-local
 *   (DNS rebinding to cloud metadata); the socket connects to the checked
 *   addresses only, one after another (IPv4 first) while a connect fails;
 * - redirects are never followed (a 3xx is an error);
 * - hard total timeout and response cap;
 * - a pasted CA is passed as `ca`, verification is never switched off.
 * Failures become one of the fixed INTEGRATION_ERRORS; remote bodies, URLs and
 * credentials never reach an error or a log line.
 */

export type IntegrationErrorText = (typeof INTEGRATION_ERRORS)[number];

export class IntegrationError extends Error {
  constructor(readonly text: IntegrationErrorText) {
    super(text);
    this.name = 'IntegrationError';
  }
}

export const INTEGRATION_TIMEOUT_MS = 8_000;
export const INTEGRATION_MAX_BYTES = 4 * 1024 * 1024;

export interface LookupAddress {
  address: string;
  family: number;
}
/** Resolves a host name to all its addresses. */
export type LookupAll = (hostname: string) => Promise<LookupAddress[]>;

const defaultLookup: LookupAll = async (hostname) =>
  dns.promises.lookup(hostname, { all: true, verbatim: true });

export interface IntegrationHttpOptions {
  timeoutMs?: number;
  maxBytes?: number;
  lookup?: LookupAll;
}

export interface IntegrationRequest {
  /** Configured base URL (origin plus optional path prefix). */
  base: string;
  /** Path below the base (starts with "/"); with `fromOrigin` below the origin. */
  path: string;
  /** Resolve `path` against the origin instead of the base path (FRITZ!Box host list). */
  fromOrigin?: boolean;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  /** PEM of a CA or the self-signed server certificate. */
  ca?: string | null;
}

export interface IntegrationResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** IPv4 169.254/16, IPv6 fe80::/10, IPv4-mapped 169.254.x.x (both notations). */
export function isLinkLocalAddress(address: string): boolean {
  const a = address.toLowerCase();
  if (net.isIPv4(a)) return a.startsWith('169.254.');
  if (!net.isIPv6(a)) return false;
  if (/^fe[89ab][0-9a-f]?:/.test(a)) return true;
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(.+)$/.exec(a)?.[1];
  if (mapped === undefined) return false;
  if (net.isIPv4(mapped)) return mapped.startsWith('169.254.');
  return /^a9fe:/.test(mapped);
}

function errorCode(err: unknown): string {
  return typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : '';
}

const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'EPROTO',
]);

/** Socket/TLS error to a fixed text. The error message itself is never used. */
export function errorTextFor(err: unknown): IntegrationErrorText {
  if (err instanceof IntegrationError) return err.text;
  const code = errorCode(err);
  if (code === 'HZ_TIMEOUT' || code === 'ETIMEDOUT') return 'Zeitüberschreitung';
  if (code === 'HZ_TOO_LARGE') return 'Antwort zu groß';
  if (
    TLS_CODES.has(code) ||
    code.startsWith('ERR_TLS') ||
    code.startsWith('ERR_SSL') ||
    code.startsWith('ERR_OSSL')
  ) {
    return 'TLS-Fehler (Zertifikat prüfen)';
  }
  return 'Nicht erreichbar';
}

/** 2xx passes; 401/403 and everything else become fixed texts. */
export function requireOk(res: IntegrationResponse): IntegrationResponse {
  if (res.status >= 200 && res.status < 300) return res;
  if (res.status === 401) throw new IntegrationError('Zugangsdaten ungültig');
  if (res.status === 403) throw new IntegrationError('Keine Berechtigung');
  throw new IntegrationError('Unerwartete Antwort');
}

/** JSON body or "Unerwartete Antwort". */
export function jsonBody(res: IntegrationResponse): unknown {
  try {
    return JSON.parse(res.body) as unknown;
  } catch {
    throw new IntegrationError('Unerwartete Antwort');
  }
}

/** The full URL of a request, or an error if it would leave the configured origin. */
export function requestUrl(req: Pick<IntegrationRequest, 'base' | 'path' | 'fromOrigin'>): URL {
  if (!integrationUrlSchema.safeParse(req.base).success) {
    throw new IntegrationError('Nicht erreichbar');
  }
  const base = new URL(req.base);
  if (!req.path.startsWith('/') || req.path.startsWith('//') || req.path.includes('\\')) {
    throw new IntegrationError('Unerwartete Antwort');
  }
  const prefix = req.fromOrigin ? '' : base.pathname.replace(/\/+$/, '');
  const url = new URL(`${prefix}${req.path}`, base.origin);
  if (url.origin !== base.origin) throw new IntegrationError('Unerwartete Antwort');
  return url;
}

/** Socket errors before anything was sent: the next address may work. */
const CONNECT_CODES = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'EAFNOSUPPORT',
]);

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

export class IntegrationHttp {
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly lookup: LookupAll;

  constructor(opts: IntegrationHttpOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? INTEGRATION_TIMEOUT_MS;
    this.maxBytes = opts.maxBytes ?? INTEGRATION_MAX_BYTES;
    this.lookup = opts.lookup ?? defaultLookup;
  }

  /**
   * Checked addresses to connect to, IPv4 first (literal IPs pass through after
   * the check). One link-local answer refuses the whole name.
   */
  private async resolve(hostname: string): Promise<LookupAddress[]> {
    const host = hostname.replace(/^\[|\]$/g, '');
    const family = net.isIP(host);
    let addrs: LookupAddress[];
    if (family !== 0) {
      addrs = [{ address: host, family }];
    } else {
      try {
        addrs = await this.lookup(host);
      } catch {
        throw new IntegrationError('Nicht erreichbar');
      }
    }
    if (addrs.length === 0 || addrs.some((a) => isLinkLocalAddress(a.address))) {
      throw new IntegrationError('Nicht erreichbar');
    }
    // Stable sort: IPv4 before IPv6, otherwise the resolver's order.
    return [...addrs].sort((a, b) => (a.family === 4 ? 0 : 1) - (b.family === 4 ? 0 : 1));
  }

  /**
   * One request. Any status except 3xx is returned (callers decide, e.g. digest
   * auth needs the 401 challenge); a 3xx is "Weiterleitung nicht erlaubt".
   */
  async request(req: IntegrationRequest): Promise<IntegrationResponse> {
    const url = requestUrl(req);
    const deadline = AbortSignal.timeout(this.timeoutMs);
    let targets: LookupAddress[];
    try {
      targets = await Promise.race([
        this.resolve(url.hostname),
        new Promise<never>((_r, reject) =>
          deadline.addEventListener('abort', () => reject(codedError('HZ_TIMEOUT')), {
            once: true,
          }),
        ),
      ]);
    } catch (err) {
      throw new IntegrationError(errorTextFor(err));
    }
    let last: unknown = codedError('HZ_FAILED');
    for (const target of targets) {
      try {
        return await this.send(url, target, req, deadline);
      } catch (err) {
        last = err;
        // Only a failed connect moves on (nothing was sent); still only checked addresses.
        if (deadline.aborted || !CONNECT_CODES.has(errorCode(err))) break;
      }
    }
    throw new IntegrationError(errorTextFor(last));
  }

  private send(
    url: URL,
    target: LookupAddress,
    req: IntegrationRequest,
    deadline: AbortSignal,
  ): Promise<IntegrationResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        clientReq.destroy();
        reject(err instanceof Error ? err : codedError('HZ_FAILED'));
      };
      const onAbort = (): void => fail(codedError('HZ_TIMEOUT'));
      const cleanup = (): void => deadline.removeEventListener('abort', onAbort);
      const isHttps = url.protocol === 'https:';
      const body = req.body === undefined ? undefined : Buffer.from(req.body, 'utf8');
      const headers: Record<string, string> = {
        'user-agent': 'homelab-zentrale/1',
        accept: '*/*',
        'accept-encoding': 'identity',
        ...req.headers,
      };
      if (body !== undefined) headers['content-length'] = String(body.length);
      else if (req.method === 'POST' || req.method === 'PUT') headers['content-length'] = '0';
      const lookup: net.LookupFunction = (_host, opts, cb) => {
        if (opts.all) cb(null, [{ address: target.address, family: target.family }]);
        else cb(null, target.address, target.family);
      };
      const options: https.RequestOptions = {
        method: req.method ?? 'GET',
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port === '' ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        headers,
        agent: false,
        lookup,
        ...(isHttps && req.ca ? { ca: req.ca } : {}),
      };
      const onResponse = (res: http.IncomingMessage): void => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          fail(new IntegrationError('Weiterleitung nicht erlaubt'));
          return;
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > this.maxBytes) {
          fail(codedError('HZ_TOO_LARGE'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > this.maxBytes) {
            fail(codedError('HZ_TOO_LARGE'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', fail);
        res.on('aborted', () => fail(codedError('ECONNRESET')));
      };
      let clientReq: http.ClientRequest;
      try {
        clientReq = isHttps
          ? https.request(options, onResponse)
          : http.request(options, onResponse);
      } catch (err) {
        // e.g. an unparsable CA: never surface the message.
        reject(codedError(isHttps ? 'ERR_TLS_SETUP' : errorCode(err)));
        return;
      }
      if (deadline.aborted) {
        fail(codedError('HZ_TIMEOUT'));
        return;
      }
      deadline.addEventListener('abort', onAbort, { once: true });
      clientReq.on('error', fail);
      clientReq.end(body);
    });
  }
}
