import { failureOf, type Failure } from './logic.js';

/**
 * The only network code of the share page. Requests go to same-origin `/s/api/*` only.
 * The token travels in `Authorization: Share <token>` and never in a URL; no cookies,
 * no referrer (the page URL contains the token), no redirects.
 */

export interface Credentials {
  token: string;
  /** Kept in memory only; a reload asks again. */
  pin: string | null;
}

export type Result<T> = { ok: true; data: T } | { ok: false; failure: Failure };

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface RequestSpec<T> {
  method?: 'GET' | 'POST';
  path: string;
  body?: unknown;
  guard: (x: unknown) => x is T;
}

const API_PREFIX = '/s/api/';

function checkPath(path: string): void {
  if (!path.startsWith(API_PREFIX) || path.includes('//')) {
    throw new Error('share page only talks to /s/api/*');
  }
}

function authHeaders(cred: Credentials, accept: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: accept, Authorization: `Share ${cred.token}` };
  if (cred.pin) headers['X-Share-Pin'] = cred.pin;
  return headers;
}

const FETCH_OPTS = {
  credentials: 'omit',
  cache: 'no-store',
  redirect: 'error',
  referrerPolicy: 'no-referrer',
} as const satisfies RequestInit;

export async function request<T>(
  cred: Credentials,
  spec: RequestSpec<T>,
  fetchImpl: Fetch = (input, init) => fetch(input, init),
): Promise<Result<T>> {
  checkPath(spec.path);
  const headers = authHeaders(cred, 'application/json');
  let body: string | null = null;
  if (spec.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(spec.body);
  }

  let res: Response;
  try {
    res = await fetchImpl(spec.path, {
      method: spec.method ?? 'GET',
      headers,
      body,
      ...FETCH_OPTS,
    });
  } catch {
    return { ok: false, failure: { status: 0, error: 'network' } };
  }

  let data: unknown;
  try {
    const text = await res.text();
    data = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    data = undefined;
  }

  if (!res.ok) {
    return { ok: false, failure: failureOf(res.status, data, res.headers.get('Retry-After')) };
  }
  if (!spec.guard(data))
    return { ok: false, failure: { status: res.status, error: 'bad_response' } };
  return { ok: true, data };
}

export interface Download {
  blob: Blob;
  /** Raw Content-Disposition header (the caller picks a safe file name from it). */
  disposition: string | null;
}

/**
 * M12 world download: a GET with the same headers as every request (the token never
 * goes into a URL, so no plain link), read as a stream for the progress line and
 * returned as a Blob the page saves. `onProgress(loaded, total)`; total from
 * Content-Length, null when unknown.
 */
export async function download(
  cred: Credentials,
  path: string,
  onProgress: (loaded: number, total: number | null) => void,
  fetchImpl: Fetch = (input, init) => fetch(input, init),
): Promise<Result<Download>> {
  checkPath(path);
  let res: Response;
  try {
    res = await fetchImpl(path, {
      method: 'GET',
      headers: authHeaders(cred, 'application/zstd, application/octet-stream'),
      ...FETCH_OPTS,
    });
  } catch {
    return { ok: false, failure: { status: 0, error: 'network' } };
  }
  if (!res.ok) {
    let data: unknown;
    try {
      const text = await res.text();
      data = text ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      data = undefined;
    }
    return { ok: false, failure: failureOf(res.status, data, res.headers.get('Retry-After')) };
  }
  const len = Number(res.headers.get('Content-Length'));
  const total = Number.isFinite(len) && len > 0 ? len : null;
  const chunks: BlobPart[] = [];
  let loaded = 0;
  try {
    const reader = res.body?.getReader();
    if (!reader) {
      const blob = await res.blob();
      onProgress(blob.size, total);
      return { ok: true, data: { blob, disposition: res.headers.get('Content-Disposition') } };
    }
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onProgress(loaded, total);
    }
  } catch {
    return { ok: false, failure: { status: 0, error: 'network' } };
  }
  return {
    ok: true,
    data: {
      blob: new Blob(chunks, { type: 'application/zstd' }),
      disposition: res.headers.get('Content-Disposition'),
    },
  };
}
