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

export async function request<T>(
  cred: Credentials,
  spec: RequestSpec<T>,
  fetchImpl: Fetch = (input, init) => fetch(input, init),
): Promise<Result<T>> {
  if (!spec.path.startsWith(API_PREFIX) || spec.path.includes('//')) {
    throw new Error('share page only talks to /s/api/*');
  }
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Share ${cred.token}`,
  };
  if (cred.pin) headers['X-Share-Pin'] = cred.pin;
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
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
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
