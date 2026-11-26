import { z } from 'zod';

export const checkKindSchema = z.enum(['http', 'tcp', 'ping']);
export type CheckKind = z.infer<typeof checkKindSchema>;
export const checkIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export const checkIdParamsSchema = z.strictObject({ id: checkIdSchema });

const DNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const ipv6 = z.ipv6();

/**
 * Host of a TCP/ping check: IPv4, IPv6 (optionally in brackets) or a DNS name.
 * Same rules as the agent's normalizeHost: no leading dash, valid labels, and no
 * numeric last label (would be read as an IP in another notation).
 */
export function isValidCheckHost(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  const inner = /^\[(.+)\]$/.exec(host)?.[1];
  if (inner !== undefined) return ipv6.safeParse(inner).success;
  if (IPV4.test(host)) return true;
  if (host.includes(':')) return ipv6.safeParse(host).success;
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  const labels = name.split('.');
  if (!labels.every((l) => DNS_LABEL.test(l))) return false;
  return !/^(?:\d+|0x[0-9a-f]+)$/i.test(labels.at(-1) ?? '');
}

const hostSchema = z.string().trim().max(253).refine(isValidCheckHost, { message: 'invalid host' });

/** Where a check runs: the core itself or one agent (e.g. oracle-a1 for "from outside"). */
export const checkRunFromSchema = z.union([
  z.literal('core'),
  z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
]);

/** True if the URL carries credentials (user:pass@host). Those never go into a check. */
export function urlHasUserinfo(value: string): boolean {
  try {
    const u = new URL(value);
    return u.username !== '' || u.password !== '';
  } catch {
    return false;
  }
}

const base = {
  name: z.string().trim().min(1).max(80),
  runFrom: checkRunFromSchema.default('core'),
  intervalS: z.number().int().min(30).max(3600).default(60),
  enabled: z.boolean().default(true),
  /** Optional link to a server, for the ServerSwitch filter and alert texts. */
  serverId: z.string().max(64).nullable().default(null),
};

export const httpCheckDefSchema = z.strictObject({
  kind: z.literal('http'),
  ...base,
  url: z
    .url({ protocol: /^https?$/ })
    .max(2048)
    .refine((u) => !urlHasUserinfo(u), 'URL darf keine Zugangsdaten enthalten'),
  expectStatusMin: z.number().int().min(100).max(599).default(200),
  expectStatusMax: z.number().int().min(100).max(599).default(399),
  contains: z.string().max(200).optional(),
  /** Check SSL expiry (https) and domain expiry via RDAP. */
  certCheck: z.boolean().default(true),
});
export const tcpCheckDefSchema = z.strictObject({
  kind: z.literal('tcp'),
  ...base,
  host: hostSchema,
  port: z.number().int().min(1).max(65535),
});
export const pingCheckDefSchema = z.strictObject({
  kind: z.literal('ping'),
  ...base,
  /** Ping always runs on an agent (ICMP). */
  runFrom: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  host: hostSchema,
});

/** POST /api/checks, PUT /api/checks/:id */
export const checkDefSchema = z.discriminatedUnion('kind', [
  httpCheckDefSchema,
  tcpCheckDefSchema,
  pingCheckDefSchema,
]);
export type CheckDef = z.infer<typeof checkDefSchema>;
export type CheckDefInput = z.input<typeof checkDefSchema>;

export const checkStatusSchema = z.enum(['ok', 'warn', 'crit', 'off', 'busy']);

export const checkSummarySchema = z.strictObject({
  id: checkIdSchema,
  def: checkDefSchema,
  /** UI status: crit only after 2 failures in a row; warn for slow (> 800 ms) or certs < 14 d. */
  status: checkStatusSchema,
  /** Short German reason, e.g. "HTTP 503", "Timeout nach 10 s", "SSL läuft in 4 Tagen ab". */
  reason: z.string().nullable(),
  lastCode: z.number().int().nullable(),
  lastMs: z.number().nullable(),
  lastCheckedAt: z.iso.datetime().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  sslExpiresAt: z.iso.datetime().nullable(),
  domainExpiresAt: z.iso.datetime().nullable(),
  /** Uptime in percent, null without data. */
  uptime24h: z.number().nullable(),
  uptime7d: z.number().nullable(),
  uptime30d: z.number().nullable(),
  /** Last 24 h of response times for the sparkline (oldest first). */
  spark: z.array(z.number()),
});
export type CheckSummary = z.infer<typeof checkSummarySchema>;

export const checkListResponseSchema = z.strictObject({ checks: z.array(checkSummarySchema) });
export const checkResponseSchema = z.strictObject({ check: checkSummarySchema });
// POST /api/checks/:id/run -> checkResponseSchema (runs now)
// DELETE /api/checks/:id -> ok

// GET /api/checks/:id/history?range=24h|7d|30d
export const checkHistoryQuerySchema = z.strictObject({
  range: z.enum(['24h', '7d', '30d']).default('24h'),
});
export const checkHistoryResponseSchema = z.strictObject({
  points: z.array(
    z.strictObject({
      ts: z.iso.datetime(),
      ok: z.boolean(),
      ms: z.number().nullable(),
      code: z.number().int().nullable(),
    }),
  ),
});
