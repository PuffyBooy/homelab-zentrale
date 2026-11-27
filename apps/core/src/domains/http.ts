import type { FetchLike } from '../checks/rdap.js';

/**
 * Outgoing HTTP of the domains module (DNS providers, ACME). Every request is
 * checked here, also URLs that came from a response (ACME Location, authz,
 * finalize, certificate): https only, default port, no user info, host in the
 * allowlist. Redirects are never followed (redirect: 'manual' -> error), each
 * request has a timeout and a response size limit. Errors carry a fixed German
 * reason only, never the URL (the DuckDNS token is part of the query) or a header.
 */

export const DOMAINS_TIMEOUT_MS = 10_000;
export const DOMAINS_MAX_BYTES = 1024 * 1024;

export type DomainsHttpErrorKind = 'host' | 'redirect' | 'timeout' | 'network' | 'too_large';

const REASONS: Record<DomainsHttpErrorKind, string> = {
  host: 'Ziel-Host ist nicht erlaubt',
  redirect: 'Weiterleitung abgelehnt',
  timeout: 'Zeitüberschreitung',
  network: 'Anbieter nicht erreichbar',
  too_large: 'Antwort zu groß',
};

export class DomainsHttpError extends Error {
  readonly reason: string;
  constructor(public readonly kind: DomainsHttpErrorKind) {
    super(`domains_http_${kind}`);
    this.name = 'DomainsHttpError';
    this.reason = REASONS[kind];
  }
}

export interface HttpResult {
  status: number;
  headers: Headers;
  text: string;
}

export interface HttpRequest {
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
}

/** Throws DomainsHttpError('host') unless the URL is an allowed https URL. */
export function checkUrl(url: string, allowedHosts: ReadonlySet<string>): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new DomainsHttpError('host');
  }
  if (
    u.protocol !== 'https:' ||
    u.username !== '' ||
    u.password !== '' ||
    u.port !== '' ||
    !allowedHosts.has(u.hostname.toLowerCase())
  ) {
    throw new DomainsHttpError('host');
  }
  return u;
}

async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new DomainsHttpError('too_large');
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new DomainsHttpError('too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class DomainsHttp {
  constructor(
    private readonly opts: {
      fetch: FetchLike;
      allowedHosts: ReadonlySet<string>;
      timeoutMs?: number;
      maxBytes?: number;
      /** Aborted when the module stops. */
      signal?: AbortSignal;
    },
  ) {}

  get allowedHosts(): ReadonlySet<string> {
    return this.opts.allowedHosts;
  }

  async request(url: string, req: HttpRequest): Promise<HttpResult> {
    const u = checkUrl(url, this.opts.allowedHosts);
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? DOMAINS_TIMEOUT_MS);
    const signal = this.opts.signal ? AbortSignal.any([timeout, this.opts.signal]) : timeout;
    let res: Response;
    try {
      res = await this.opts.fetch(u.toString(), {
        method: req.method,
        redirect: 'manual',
        headers: { 'user-agent': 'homelab-zentrale', ...req.headers },
        ...(req.body !== undefined ? { body: req.body } : {}),
        signal,
      });
    } catch {
      throw new DomainsHttpError(timeout.aborted ? 'timeout' : 'network');
    }
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      await res.body?.cancel().catch(() => undefined);
      throw new DomainsHttpError('redirect');
    }
    try {
      if (req.method === 'HEAD') {
        await res.body?.cancel().catch(() => undefined);
        return { status: res.status, headers: res.headers, text: '' };
      }
      const text = await readCapped(res, this.opts.maxBytes ?? DOMAINS_MAX_BYTES);
      return { status: res.status, headers: res.headers, text };
    } catch (err) {
      if (err instanceof DomainsHttpError) throw err;
      throw new DomainsHttpError(timeout.aborted ? 'timeout' : 'network');
    }
  }
}
