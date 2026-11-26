/**
 * Transport for Web Push requests. The request (VAPID JWT, encrypted payload)
 * is built by web-push; sending is behind this interface so tests can point
 * it at a local mock push service.
 */
export interface PushRequest {
  endpoint: string;
  headers: Record<string, string>;
  body: Buffer | null;
}

export interface PushTransport {
  send(req: PushRequest): Promise<{ statusCode: number }>;
}

const SEND_TIMEOUT_MS = 10_000;

/** Production transport: one POST, no redirects, 10 s timeout, body discarded. */
export const fetchTransport: PushTransport = {
  async send(req) {
    const res = await fetch(req.endpoint, {
      method: 'POST',
      headers: req.headers,
      ...(req.body ? { body: req.body } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    await res.body?.cancel();
    return { statusCode: res.status };
  },
};
