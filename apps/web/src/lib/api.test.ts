import { okResponseSchema } from '@hz/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, configureApi } from './api.js';
import { errorText } from './errors.js';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function mockFetch(...responses: Array<Response | Error>) {
  const fn = vi.fn<typeof fetch>();
  for (const r of responses) {
    if (r instanceof Error) fn.mockRejectedValueOnce(r);
    else fn.mockResolvedValueOnce(r);
  }
  vi.stubGlobal('fetch', fn);
  return fn;
}

let reset: (() => void) | undefined;
afterEach(() => {
  reset?.();
  reset = undefined;
  vi.unstubAllGlobals();
});

describe('api', () => {
  it('sends JSON with same-origin credentials and validates the answer', async () => {
    const fetchMock = mockFetch(json(200, { ok: true }));
    await expect(
      api('/api/x', { method: 'POST', body: { a: 1 }, schema: okResponseSchema }),
    ).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/x');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.body).toBe('{"a":1}');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
  });

  it('does not send a JSON content type without a body', async () => {
    const fetchMock = mockFetch(json(200, { ok: true }));
    await api('/api/x', { method: 'POST', schema: okResponseSchema });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).has('Content-Type')).toBe(false);
  });

  it('refuses paths outside /api', async () => {
    await expect(api('https://evil.example/api/x', { schema: okResponseSchema })).rejects.toThrow();
  });

  it('turns error envelopes into typed ApiErrors', async () => {
    mockFetch(json(429, { ok: false, error: 'rate_limited', retryAfter: 125 }));
    const err = await api('/api/x', { schema: okResponseSchema }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 429, error: 'rate_limited', retryAfter: 125 });
    expect(errorText(err)).toBe('Zu viele Versuche. Wieder möglich in 3 Min.');
  });

  it('falls back to the status code and the Retry-After header', async () => {
    mockFetch(new Response('nope', { status: 429, headers: { 'Retry-After': '60' } }));
    await expect(api('/api/x', { schema: okResponseSchema })).rejects.toMatchObject({
      error: 'rate_limited',
      retryAfter: 60,
    });
  });

  it('reports invalid answers and network errors', async () => {
    mockFetch(json(200, { ok: 'yes' }), new TypeError('Failed to fetch'));
    await expect(api('/api/x', { schema: okResponseSchema })).rejects.toMatchObject({
      error: 'bad_response',
    });
    await expect(api('/api/x', { schema: okResponseSchema })).rejects.toMatchObject({
      status: 0,
      error: 'network',
    });
  });

  it('calls the 401 handler unless the request is quiet', async () => {
    const onUnauthorized = vi.fn();
    reset = configureApi({ onUnauthorized });
    mockFetch(
      json(401, { ok: false, error: 'unauthorized' }),
      json(401, { ok: false, error: 'unauthorized' }),
      json(401, { ok: false, error: 'invalid_credentials' }),
    );
    await expect(api('/api/x', { schema: okResponseSchema })).rejects.toMatchObject({
      error: 'unauthorized',
    });
    await expect(
      api('/api/x', { schema: okResponseSchema, quiet401: true }),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(api('/api/x', { schema: okResponseSchema })).rejects.toMatchObject({
      error: 'invalid_credentials',
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('asks for step-up and repeats the request once', async () => {
    const onStepUp = vi.fn(() => Promise.resolve(true));
    reset = configureApi({ onStepUp });
    const fetchMock = mockFetch(
      json(403, { ok: false, error: 'step_up_required' }),
      json(200, { ok: true }),
    );
    await expect(api('/api/x', { method: 'POST', schema: okResponseSchema })).resolves.toEqual({
      ok: true,
    });
    expect(onStepUp).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up when step-up is cancelled or fails again', async () => {
    reset = configureApi({ onStepUp: () => Promise.resolve(false) });
    mockFetch(json(403, { ok: false, error: 'step_up_required' }));
    await expect(api('/api/x', { schema: okResponseSchema })).rejects.toMatchObject({
      error: 'step_up_required',
    });

    reset();
    const onStepUp = vi.fn(() => Promise.resolve(true));
    reset = configureApi({ onStepUp });
    const fetchMock = mockFetch(
      json(403, { ok: false, error: 'step_up_required' }),
      json(403, { ok: false, error: 'step_up_required' }),
    );
    await expect(api('/api/x', { schema: okResponseSchema })).rejects.toMatchObject({
      error: 'step_up_required',
    });
    expect(onStepUp).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares one step-up prompt between parallel requests', async () => {
    let resolve: (v: boolean) => void = () => undefined;
    const onStepUp = vi.fn(() => new Promise<boolean>((r) => (resolve = r)));
    reset = configureApi({ onStepUp });
    mockFetch(
      json(403, { ok: false, error: 'step_up_required' }),
      json(403, { ok: false, error: 'step_up_required' }),
      json(200, { ok: true }),
      json(200, { ok: true }),
    );
    const a = api('/api/a', { schema: okResponseSchema });
    const b = api('/api/b', { schema: okResponseSchema });
    await vi.waitFor(() => expect(onStepUp).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    resolve(true);
    await expect(Promise.all([a, b])).resolves.toHaveLength(2);
    expect(onStepUp).toHaveBeenCalledTimes(1);
  });
});
