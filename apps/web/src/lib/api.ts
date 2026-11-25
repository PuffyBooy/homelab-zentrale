import { errorResponseSchema, type ErrorCode } from '@hz/shared';

/** Anything with a zod-like `parse`. Keeps zod out of the web package's direct dependencies. */
export interface Schema<T> {
  parse(data: unknown): T;
}

/** Server error codes plus two client-side ones. */
export type ApiErrorCode = ErrorCode | 'network' | 'bad_response';

export class ApiError extends Error {
  readonly status: number;
  readonly error: ApiErrorCode;
  /** Seconds until a retry is allowed (rate limit). */
  readonly retryAfter: number | undefined;

  constructor(status: number, error: ApiErrorCode, retryAfter?: number) {
    super(`api ${status} ${error}`);
    this.name = 'ApiError';
    this.status = status;
    this.error = error;
    this.retryAfter = retryAfter;
  }
}

export function isApiError(err: unknown, code?: ApiErrorCode): err is ApiError {
  return err instanceof ApiError && (code === undefined || err.error === code);
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions<T> {
  method?: Method;
  body?: unknown;
  schema: Schema<T>;
  signal?: AbortSignal | undefined;
  /** Ask for TOTP and retry once on `step_up_required`. Default true. */
  stepUp?: boolean;
  /** Do not trigger the global 401 handler (login, setup, auth state). */
  quiet401?: boolean;
}

export interface ApiHandlers {
  /** Called on 401 `unauthorized`, e.g. to send the user to /login. */
  onUnauthorized?: () => void;
  /** Shows the step-up dialog. Resolves true once a fresh TOTP was accepted. */
  onStepUp?: () => Promise<boolean>;
}

let handlers: ApiHandlers = {};
let pendingStepUp: Promise<boolean> | null = null;

export function configureApi(next: ApiHandlers): () => void {
  handlers = next;
  return () => {
    if (handlers === next) handlers = {};
  };
}

/** Several requests may need step-up at once; ask only once. */
function askStepUp(): Promise<boolean> {
  const ask = handlers.onStepUp;
  if (!ask) return Promise.resolve(false);
  if (!pendingStepUp) {
    pendingStepUp = ask().finally(() => {
      pendingStepUp = null;
    });
  }
  return pendingStepUp;
}

function fallbackCode(status: number): ErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status === 400) return 'invalid_input';
  return 'internal';
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const n = Number(header);
  return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : undefined;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** JSON request to the core. Same origin only, cookies included, response validated. */
export async function api<T>(path: string, opts: RequestOptions<T>): Promise<T> {
  if (!path.startsWith('/api/')) throw new Error('api() only talks to /api/*');
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: string | null = null;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: opts.signal ?? null,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network');
  }

  const data = await readJson(res);

  if (!res.ok) {
    const parsed = errorResponseSchema.safeParse(data);
    const code = parsed.success ? parsed.data.error : fallbackCode(res.status);
    const retryAfter =
      (parsed.success ? parsed.data.retryAfter : undefined) ??
      parseRetryAfter(res.headers.get('Retry-After'));

    if (code === 'step_up_required' && opts.stepUp !== false) {
      if (await askStepUp()) return api(path, { ...opts, stepUp: false });
    }
    if (code === 'unauthorized' && !opts.quiet401) handlers.onUnauthorized?.();
    throw new ApiError(res.status, code, retryAfter);
  }

  try {
    return opts.schema.parse(data);
  } catch {
    throw new ApiError(res.status, 'bad_response');
  }
}
