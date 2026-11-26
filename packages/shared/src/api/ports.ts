import { z } from 'zod';
import type { ListeningPort } from '../agent-protocol.js';

/**
 * M11: port audit (ROADMAP M11). Per server a list of allowed open ports.
 *
 * Source: inventory.listeningPorts (ListeningPort: proto, address, port,
 * process). Only "public" binds count (isPublicBindAddress): wildcard
 * 0.0.0.0 / :: / * and globally routable addresses. Loopback, RFC 1918,
 * CGNAT/Tailscale (100.64.0.0/10, fd7a:115c:a1e0::/48 inside fc00::/7),
 * link-local are ignored.
 *
 * Seeding: while a server has no list yet (`seeded: false`), the first
 * inventory that arrives copies all its public ports into the list (note
 * empty) and raises no alert. After that, on every inventory:
 *  - a public (proto, port) not in the list -> open alert
 *    key portAlertKey(serverId, proto, port), level warn, source server,
 *    title newPortAlertTitle(port, process), body newPortAlertBody(...);
 *  - a port that is allowed or no longer listening -> that alert resolved.
 * PUT or POST allow also count as seeding (seeded becomes true).
 *
 * Routes (admin session, no step-up; audit_log ports.update / ports.allow):
 * GET  /api/servers/:id/ports/allowed           -> PortAuditResponse
 * PUT  /api/servers/:id/ports/allowed  { ports } -> PortAuditResponse (replaces the list)
 * POST /api/servers/:id/ports/allow  { port, proto, note? } -> PortAuditResponse
 *      (idempotent, adds the entry and resolves the alert at once; the
 *      "Erlauben" button on the alert, see parsePortAlertKey)
 */

export const MAX_ALLOWED_PORTS = 200;
export const PORT_NOTE_MAX = 80;

export const portAuditProtoSchema = z.enum(['tcp', 'udp']);
export type PortAuditProto = z.infer<typeof portAuditProtoSchema>;

export const allowedPortSchema = z.strictObject({
  port: z.number().int().min(1).max(65535),
  proto: portAuditProtoSchema,
  note: z.string().trim().max(PORT_NOTE_MAX).optional(),
});
export type AllowedPort = z.infer<typeof allowedPortSchema>;

export const allowedPortListSchema = z
  .array(allowedPortSchema)
  .max(MAX_ALLOWED_PORTS)
  .refine((list) => new Set(list.map((p) => `${p.proto}/${p.port}`)).size === list.length, {
    message: 'duplicate port',
  });

// PUT /api/servers/:id/ports/allowed
export const allowedPortsUpdateRequestSchema = z.strictObject({ ports: allowedPortListSchema });
export type AllowedPortsUpdateRequest = z.infer<typeof allowedPortsUpdateRequestSchema>;

// POST /api/servers/:id/ports/allow
export const portAllowRequestSchema = allowedPortSchema;
export type PortAllowRequest = z.infer<typeof portAllowRequestSchema>;

/** A public listening port, grouped by (proto, port). */
export const openPortSchema = z.strictObject({
  proto: portAuditProtoSchema,
  port: z.number().int().min(1).max(65535),
  addresses: z.array(z.string().max(64)).max(16),
  process: z.string().max(64).nullable(),
  allowed: z.boolean(),
});
export type OpenPort = z.infer<typeof openPortSchema>;

export const portAuditResponseSchema = z.strictObject({
  /** false until the first inventory (or a PUT/POST) created the list. */
  seeded: z.boolean(),
  allowed: z.array(allowedPortSchema).max(MAX_ALLOWED_PORTS),
  /** Public listening ports from the latest inventory, sorted by port. */
  open: z.array(openPortSchema),
});
export type PortAuditResponse = z.infer<typeof portAuditResponseSchema>;

// ---------------------------------------------------------------------------
// Helpers (core and web use the same rules)

function parseIPv4(a: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

function isPublicIPv4([a = 0, b = 0]: number[]): boolean {
  if (a === 0 || a === 127 || a === 10) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}

/**
 * True for binds reachable from outside: 0.0.0.0, ::, *, and global addresses.
 * Unknown formats count as public (alerting is the safe side).
 */
export function isPublicBindAddress(address: string): boolean {
  const a = address
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
    .toLowerCase();
  if (a === '' || a === '*' || a === '0.0.0.0' || a === '::') return true;
  const v4 = parseIPv4(a.replace(/^::ffff:/, ''));
  if (v4) return isPublicIPv4(v4);
  if (a.includes(':')) {
    if (a === '::1') return false;
    if (/^fe[89ab]/.test(a)) return false;
    if (/^f[cd]/.test(a)) return false;
    return true;
  }
  return true;
}

/** Groups the public ports of an inventory by (proto, port), sorted by port. */
export function publicListeningPorts(
  ports: readonly ListeningPort[],
  allowed: readonly Pick<AllowedPort, 'port' | 'proto'>[] = [],
): OpenPort[] {
  const ok = new Set(allowed.map((p) => `${p.proto}/${p.port}`));
  const map = new Map<string, OpenPort>();
  for (const p of ports) {
    if (!isPublicBindAddress(p.address)) continue;
    const key = `${p.proto}/${p.port}`;
    const cur = map.get(key);
    if (cur) {
      if (!cur.addresses.includes(p.address) && cur.addresses.length < 16)
        cur.addresses.push(p.address);
      cur.process ??= p.process ?? null;
    } else {
      map.set(key, {
        proto: p.proto,
        port: p.port,
        addresses: [p.address],
        process: p.process ?? null,
        allowed: ok.has(key),
      });
    }
  }
  return [...map.values()].sort((x, y) => x.port - y.port || x.proto.localeCompare(y.proto));
}

const PORT_ALERT_RE = /^port:([A-Za-z0-9_-]{8,64}):(tcp|udp):(\d{1,5})$/;

/** Dedupe key of a "new open port" alert. */
export function portAlertKey(serverId: string, proto: PortAuditProto, port: number): string {
  return `port:${serverId}:${proto}:${port}`;
}

/** For the "Erlauben" button: null when the key is not a port alert. */
export function parsePortAlertKey(
  key: string,
): { serverId: string; proto: PortAuditProto; port: number } | null {
  const m = PORT_ALERT_RE.exec(key);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  const port = Number(m[3]);
  if (port < 1 || port > 65535) return null;
  return { serverId: m[1], proto: m[2] as PortAuditProto, port };
}

/** "Neuer offener Port 8081 (nginx)"; without a process name "(TCP)". */
export function newPortAlertTitle(
  port: number,
  proto: PortAuditProto,
  process?: string | null,
): string {
  return `Neuer offener Port ${port} (${process ? process : proto.toUpperCase()})`;
}

/** "heimserver: TCP 8081 lauscht auf 0.0.0.0. Erlauben, wenn das gewollt ist, sonst den Dienst prüfen." */
export function newPortAlertBody(
  serverName: string,
  p: Pick<OpenPort, 'proto' | 'port' | 'addresses'>,
): string {
  return `${serverName}: ${p.proto.toUpperCase()} ${p.port} lauscht auf ${p.addresses.join(', ')}. Erlauben, wenn das gewollt ist, sonst den Dienst prüfen.`;
}
