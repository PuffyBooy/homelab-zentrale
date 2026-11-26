import { z } from 'zod';

/**
 * M15 game relay (docs/ROADMAP.md, SPEC 6.6).
 *
 * Any server with a public IP can be an "ingress" (Eingang). Its agent
 * (HZ_AGENT_ALLOW_RELAY=1) listens on the game ports of the games assigned to it
 * and forwards them through Tailscale to the server the game runs on right now.
 * Moving a game to another server only changes the relay target, so friends keep
 * address and port and no router needs a port forward. A game's relay uses the
 * same port numbers on the ingress as on its host.
 *
 * Optional DNS: per game a name (e.g. "mc.example.org") that the core points to
 * the ingress's public IPv4 (Cloudflare or DuckDNS, token stored encrypted).
 * All routes need an admin session; changes marked step-up need a fresh TOTP.
 */

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

/** Public IPv4 of an ingress (DNS A record target). */
export const publicIpv4Schema = z
  .string()
  .regex(/^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/)
  .refine(
    (ip) => {
      const [a, b] = ip.split('.').map(Number) as [number, number];
      // no private, loopback, link-local, CGNAT/Tailscale, multicast or reserved ranges
      return !(
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        // IETF protocol assignments, benchmarking (documentation ranges stay
        // allowed: the demo and tests use them)
        (a === 192 && b === 0 && ip.split('.')[2] === '0') ||
        (a === 198 && (b === 18 || b === 19)) ||
        a >= 224
      );
    },
    { message: 'Keine öffentliche IPv4-Adresse' },
  );

/** Lower-case DNS name with at least two labels, no wildcard. */
export const dnsNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/, {
    message: 'Ungültiger DNS-Name',
  });

// ---- ingress (per server) -------------------------------------------------------------

export const ingressSchema = z.strictObject({
  serverId: idSchema,
  serverName: z.string(),
  enabled: z.boolean(),
  /** IPv4 friends connect to (default: the server's public IP from the inventory). */
  publicIp: z.string().nullable(),
  /** Ports the admin opened in the provider firewall; game ports must fall inside. */
  portFrom: z.number().int(),
  portTo: z.number().int(),
  /** Agent connected and reports relay capability (HZ_AGENT_ALLOW_RELAY=1). */
  capable: z.boolean(),
  connected: z.boolean(),
  /** Games currently relayed through this ingress. */
  games: z.array(z.strictObject({ id: idSchema, name: z.string() })),
  /** German, e.g. "Firewall des Anbieters: 25565–25600 TCP und UDP öffnen". */
  firewallHint: z.string(),
});
export type Ingress = z.infer<typeof ingressSchema>;

// GET /api/relay/ingresses -> every server (enabled or not) with its ingress state
export const ingressListResponseSchema = z.strictObject({ ingresses: z.array(ingressSchema) });

// PUT /api/servers/:id/ingress (step-up) -> { ingress }
// Disabling an ingress that still relays games -> 409 (move them first).
export const ingressUpdateRequestSchema = z
  .strictObject({
    enabled: z.boolean(),
    /** null: take the public IP from the inventory. */
    publicIp: publicIpv4Schema.nullable(),
    portFrom: z.number().int().min(1024).max(65535),
    portTo: z.number().int().min(1024).max(65535),
  })
  .refine((v) => v.portFrom <= v.portTo && v.portTo - v.portFrom <= 5000, {
    message: 'Portbereich ungültig (höchstens 5000 Ports)',
  });
export const ingressResponseSchema = z.strictObject({ ingress: ingressSchema });

// ---- relay per game -------------------------------------------------------------------

export const gameRelayStateSchema = z.enum([
  /** Relay listens on the ingress and forwards to the current host. */
  'ok',
  /** Waiting for the ingress agent (offline) or a relay.set answer. */
  'pending',
  /** relay.set reported an error for at least one port (see error). */
  'error',
]);

export const gameRelaySchema = z.strictObject({
  ingressServerId: idSchema,
  ingressName: z.string(),
  dnsName: z.string().nullable(),
  /** What friends use: "<dnsName or publicIp>:<first public port>". */
  address: z.string().nullable(),
  state: gameRelayStateSchema,
  error: z.string().nullable(),
  /** DNS record points to the ingress (null: no DNS name or no provider). */
  dnsOk: z.boolean().nullable(),
});
export type GameRelay = z.infer<typeof gameRelaySchema>;

// GET /api/games/:id/relay -> { relay: GameRelay | null }
export const gameRelayResponseSchema = z.strictObject({ relay: gameRelaySchema.nullable() });
// PUT /api/games/:id/relay (step-up) { ingressServerId: null } removes the relay.
// Checks: ingress enabled and capable, the game's public ports inside its range and
// not used by another relayed game or by a game running on the ingress itself (409),
// the game does not run on the ingress itself (400, no relay needed).
export const gameRelayRequestSchema = z.strictObject({
  ingressServerId: idSchema.nullable(),
  dnsName: dnsNameSchema.nullable().optional(),
});

// ---- DNS provider (settings) -------------------------------------------------------------

export const dnsProviderSchema = z.enum(['none', 'cloudflare', 'duckdns']);

// GET /api/settings/dns -> never the token
export const dnsSettingsSchema = z.strictObject({
  provider: dnsProviderSchema,
  tokenSet: z.boolean(),
  /** Cloudflare zone id (32 hex), null otherwise. */
  zoneId: z.string().nullable(),
  lastError: z.string().nullable(),
  lastUpdateAt: z.iso.datetime().nullable(),
});
// PUT /api/settings/dns (step-up). token undefined keeps it; provider none deletes it.
// Cloudflare: API token with Zone.DNS edit, A records only, proxied false, TTL 60.
// DuckDNS: names must be <sub>.duckdns.org; only https://www.duckdns.org/update.
export const dnsSettingsRequestSchema = z.strictObject({
  provider: dnsProviderSchema,
  token: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{20,100}$/)
    .optional(),
  zoneId: z
    .string()
    .regex(/^[0-9a-f]{32}$/)
    .nullable()
    .optional(),
});
