import { z } from 'zod';
import {
  shareActionRequestSchema,
  shareCommandRequestSchema,
  shareCommandResponseSchema,
  shareConsoleQuerySchema,
  shareConsoleResponseSchema,
  shareErrorResponseSchema,
  sharePinSchema,
  shareStatusResponseSchema,
  shareTokenSchema,
  shareWhitelistAskSchema,
  shareWhitelistRequestSchema,
  WORLD_DOWNLOAD_MAX_BYTES,
} from '@hz/shared';

export type ShareErrorBody = z.infer<typeof shareErrorResponseSchema>;

/** The only API routes of the gateway. Each maps to `${core}/api/share-gateway/<name>`. */
export interface ApiRoute {
  method: 'GET' | 'POST';
  name: 'status' | 'action' | 'console' | 'whitelist' | 'whitelist-request' | 'world';
  request?: z.ZodType;
  query?: z.ZodType;
  response: z.ZodType;
  /** Free-text fields (game output) get tailnet addresses masked instead of refused. */
  freeText: boolean;
  /** GET console polls have their own, larger budget. */
  budget: 'api' | 'poll';
  /** M12: the answer is a file (world download), streamed through, never buffered. */
  download?: true;
}

export const API_ROUTES: readonly ApiRoute[] = [
  {
    method: 'GET',
    name: 'status',
    query: z.strictObject({}),
    response: shareStatusResponseSchema,
    freeText: false,
    budget: 'api',
  },
  {
    method: 'POST',
    name: 'action',
    request: shareActionRequestSchema,
    response: shareStatusResponseSchema,
    freeText: false,
    budget: 'api',
  },
  {
    method: 'GET',
    name: 'console',
    query: shareConsoleQuerySchema,
    response: shareConsoleResponseSchema,
    freeText: true,
    budget: 'poll',
  },
  {
    method: 'POST',
    name: 'console',
    request: shareCommandRequestSchema,
    response: shareCommandResponseSchema,
    freeText: true,
    budget: 'api',
  },
  {
    method: 'POST',
    name: 'whitelist',
    request: shareWhitelistRequestSchema,
    response: shareCommandResponseSchema,
    freeText: true,
    budget: 'api',
  },
  {
    method: 'POST',
    name: 'whitelist-request',
    request: shareWhitelistAskSchema,
    response: shareStatusResponseSchema,
    freeText: false,
    budget: 'api',
  },
  {
    method: 'GET',
    name: 'world',
    query: z.strictObject({}),
    // Only errors are JSON; a 200 is checked by checkDownloadHeaders.
    response: z.never(),
    freeText: false,
    budget: 'api',
    download: true,
  },
];

/** "<game name>-welt.tar.zst", nothing else may name the file. */
const DISPOSITION = /^attachment; filename="[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])-welt\.tar\.zst"$/;

/**
 * Headers of a world download from the core: exactly application/zstd, a size
 * within WORLD_DOWNLOAD_MAX_BYTES and our fixed file name. Null when anything
 * else comes back (then the gateway answers 502 and sends no byte).
 */
export function checkDownloadHeaders(h: {
  type: string | null;
  length: string | null;
  disposition: string | null;
}): { length: number; disposition: string } | null {
  if (h.type !== 'application/zstd') return null;
  if (h.length === null || !/^\d{1,15}$/.test(h.length)) return null;
  const length = Number(h.length);
  if (length < 1 || length > WORLD_DOWNLOAD_MAX_BYTES) return null;
  if (h.disposition === null || !DISPOSITION.test(h.disposition)) return null;
  return { length, disposition: h.disposition };
}

export function findRoute(method: string, pathname: string): ApiRoute | undefined {
  return API_ROUTES.find((r) => r.method === method && `/s/api/${r.name}` === pathname);
}

const AUTH = /^Share ([A-Za-z0-9_-]{43})$/;

/** Friend token from `Authorization: Share <token>`; null when missing or malformed. */
export function shareTokenFrom(header: string | undefined): string | null {
  const m = header === undefined ? null : AUTH.exec(header);
  const token = m?.[1];
  return token !== undefined && shareTokenSchema.safeParse(token).success ? token : null;
}

/** `X-Share-Pin`: undefined when absent, null when malformed. */
export function sharePinFrom(header: string | string[] | undefined): string | null | undefined {
  if (header === undefined) return undefined;
  if (typeof header !== 'string') return null;
  return sharePinSchema.safeParse(header).success ? header : null;
}

// ---- internal data guard --------------------------------------------------------

/** Tailscale IPv4 (100.64.0.0/10), Tailscale IPv6 ULA, MagicDNS names. */
const INTERNAL = [
  /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g,
  /\bfd7a:115c:a1e0:[0-9a-f:]*/gi,
  /\b[a-z0-9.-]*\.ts\.net\b/gi,
];
export const INTERNAL_MASK = '[intern]';

export function containsInternal(s: string): boolean {
  return INTERNAL.some((re) => {
    re.lastIndex = 0;
    return re.test(s);
  });
}

function maskInternal(value: unknown): unknown {
  if (typeof value === 'string') {
    return INTERNAL.reduce((s, re) => s.replace(re, INTERNAL_MASK), value);
  }
  if (Array.isArray(value)) return value.map(maskInternal);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskInternal(v)]));
  }
  return value;
}

/** Statuses the core may answer with; anything else becomes 502. */
const ERROR_STATUS = new Set([400, 401, 403, 404, 409, 410, 423, 429, 503]);

export type CoreOutcome =
  | { kind: 'ok'; status: 200; body: unknown }
  | { kind: 'error'; status: number; body: ShareErrorBody }
  | { kind: 'bad' };

/**
 * Checks a core answer against the strict shared schemas. Strict objects refuse any
 * extra field (serverId, containerId ...). Structured answers (status) that contain a
 * tailnet address are refused; game output (console, command output) gets such
 * addresses masked, because game logs are free text.
 */
export function checkCoreAnswer(route: ApiRoute, status: number, json: unknown): CoreOutcome {
  if (status === 200) {
    const parsed = route.response.safeParse(json);
    if (!parsed.success) return { kind: 'bad' };
    if (route.freeText) return { kind: 'ok', status: 200, body: maskInternal(parsed.data) };
    if (containsInternal(JSON.stringify(parsed.data))) return { kind: 'bad' };
    return { kind: 'ok', status: 200, body: parsed.data };
  }
  if (!ERROR_STATUS.has(status)) return { kind: 'bad' };
  const parsed = shareErrorResponseSchema.safeParse(json);
  if (!parsed.success) return { kind: 'bad' };
  return { kind: 'error', status, body: parsed.data };
}
