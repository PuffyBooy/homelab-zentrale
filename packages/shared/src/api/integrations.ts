import { z } from 'zod';
import { isAllowedWolBroadcast } from '../agent-protocol.js';
import { serverIdSchema } from './servers.js';

/**
 * M14: Anbindungen (SPEC 16). Optional modules that talk to systems in the LAN
 * or tailnet: Proxmox, Pi-hole/AdGuard Home ("dnsfilter"), FRITZ!Box (TR-064)
 * and Uptime Kuma. Plus Wake-on-LAN per server and extra alert channels
 * (Discord, Telegram, ntfy), which are part of the core and need no module.
 *
 * Rules for every outgoing request (core, `integrations/http.ts`):
 * - URL: http or https, no user info, query or anchor, never link-local
 *   (169.254.0.0/16, fe80::/10: cloud metadata). LAN and loopback stay allowed,
 *   these systems live there.
 * - Redirects are never followed (a 3xx is the error "Weiterleitung").
 * - Hard timeout (8 s), response at most 4 MB, then the request is aborted.
 * - Self-signed certificates only with a pasted CA certificate (`caCert`),
 *   never by switching verification off.
 * - Secrets (token, password, API key, webhook URL, bot token) are AES-256-GCM
 *   encrypted in `settings` (HZ_SECRET_KEY, AAD per key). The API only says
 *   `secretSet`. Error texts are fixed German strings, never the remote body.
 * - Changing url, username, secret or CA needs step-up. If the URL origin
 *   changes and no new secret comes in the same request, the stored secret is
 *   dropped: a token is never sent to a host it was not entered for.
 */

// ---- URLs ---------------------------------------------------------------------------

/** Same rule as haUrlIsLinkLocal: link-local IPv4/IPv6, also IPv4-mapped. */
export function urlIsLinkLocal(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (/^169\.254\.\d+\.\d+$/.test(host)) return true;
  if (host.startsWith('[') && host.endsWith(']')) {
    const v6 = host.slice(1, -1);
    if (/^fe[89ab][0-9a-f]:/.test(v6)) return true;
    if (v6.startsWith('::ffff:a9fe:')) return true;
  }
  return false;
}

/** "https://pve.lan:8006", "http://192.0.2.1", "https://pihole.example.ts.net/". */
export const integrationUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(200)
  .refine(
    (u) => {
      const p = new URL(u);
      return p.username === '' && p.password === '' && p.search === '' && p.hash === '';
    },
    { message: 'URL ohne Benutzer, Query oder Anker' },
  )
  .refine((u) => !urlIsLinkLocal(u), { message: 'Link-lokale Adressen sind nicht erlaubt' });

/** Origin of a URL ("https://pve.lan:8006"), for the "origin changed" rule. */
export function urlOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** PEM of a CA (or the self-signed server certificate), at most 3 certificates. */
export const caCertSchema = z
  .string()
  .trim()
  .max(12_000)
  .regex(
    /^(-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*){1,3}$/,
    { message: 'PEM-Zertifikat erwartet' },
  );

// ---- settings of an integration --------------------------------------------------------

export const INTEGRATIONS = ['proxmox', 'dnsfilter', 'fritzbox', 'uptimekuma'] as const;
export const integrationIdSchema = z.enum(INTEGRATIONS);
export type IntegrationId = z.infer<typeof integrationIdSchema>;

/** Pi-hole v6 (REST API /api) or AdGuard Home (/control). */
export const dnsFilterVariantSchema = z.enum(['pihole', 'adguard']);
export type DnsFilterVariant = z.infer<typeof dnsFilterVariantSchema>;

export const integrationStatusSchema = z.enum([
  /** URL or secret missing. */
  'off',
  'ok',
  /** Last request failed, see `error`. */
  'error',
]);

/** German error texts the core may report (fixed, never the remote body). */
export const INTEGRATION_ERRORS = [
  'Nicht erreichbar',
  'Zeitüberschreitung',
  'TLS-Fehler (Zertifikat prüfen)',
  'Zugangsdaten ungültig',
  'Keine Berechtigung',
  'Weiterleitung nicht erlaubt',
  'Antwort zu groß',
  'Unerwartete Antwort',
  'Zugangsdaten nicht lesbar, bitte neu eintragen',
  'Zu viele Anmeldungen am Pi-hole',
] as const;

// GET /api/<integration>/settings
export const integrationSettingsSchema = z.strictObject({
  url: z.string().nullable(),
  /**
   * proxmox: API token id "user@realm!name"; fritzbox: user name;
   * dnsfilter/adguard: user name; others null.
   */
  username: z.string().nullable(),
  secretSet: z.boolean(),
  caSet: z.boolean(),
  /** Only dnsfilter, otherwise null. */
  variant: dnsFilterVariantSchema.nullable(),
  status: integrationStatusSchema,
  error: z.string().max(100).nullable(),
  lastOkAt: z.iso.datetime().nullable(),
});
export type IntegrationSettings = z.infer<typeof integrationSettingsSchema>;

/** Proxmox API token id: "root@pam!hz", "hz@pve!zentrale". */
export const proxmoxTokenIdSchema = z
  .string()
  .trim()
  .max(120)
  .regex(/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+![A-Za-z0-9._-]+$/, {
    message: 'Format: benutzer@realm!tokenname',
  });
const plainUsernameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._@-]+$/);

/** Token, password or API key. Printable ASCII, no spaces at the ends. */
export const integrationSecretSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/, { message: 'Ungültige Zeichen' });

// PUT /api/<integration>/settings -> integrationSettingsSchema
// Step-up when url, username, secret or caCert is in the body (integrationUpdateNeedsStepUp).
export const integrationSettingsRequestSchema = z.strictObject({
  url: integrationUrlSchema.optional(),
  username: z.union([proxmoxTokenIdSchema, plainUsernameSchema]).nullable().optional(),
  secret: integrationSecretSchema.optional(),
  /** null removes the CA. */
  caCert: caCertSchema.nullable().optional(),
  variant: dnsFilterVariantSchema.optional(),
});
export type IntegrationSettingsRequest = z.infer<typeof integrationSettingsRequestSchema>;

export function integrationUpdateNeedsStepUp(body: IntegrationSettingsRequest): boolean {
  return (
    body.url !== undefined ||
    body.username !== undefined ||
    body.secret !== undefined ||
    body.caCert !== undefined ||
    body.variant !== undefined
  );
}
// DELETE /api/<integration>/settings (step-up): forget url, secret and CA.
// POST /api/<integration>/test -> integrationSettingsSchema (runs one request now)

// ---- Proxmox ----------------------------------------------------------------------------

export const proxmoxNodeSchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,62})$/);
export const proxmoxGuestTypeSchema = z.enum(['qemu', 'lxc']);
export const proxmoxVmidSchema = z.coerce.number().int().min(100).max(999_999_999);
export const proxmoxGuestStatusSchema = z.enum(['running', 'stopped', 'paused', 'unknown']);

export const proxmoxGuestSchema = z.strictObject({
  node: proxmoxNodeSchema,
  type: proxmoxGuestTypeSchema,
  vmid: z.number().int(),
  name: z.string().max(120),
  status: proxmoxGuestStatusSchema,
  /** 0..1 of `cpus`. */
  cpu: z.number().min(0).nullable(),
  cpus: z.number().int().min(0).nullable(),
  memBytes: z.number().min(0).nullable(),
  maxMemBytes: z.number().min(0).nullable(),
  uptimeS: z.number().int().min(0).nullable(),
  /** Templates are listed but cannot be started. */
  template: z.boolean(),
});
export type ProxmoxGuest = z.infer<typeof proxmoxGuestSchema>;

export const proxmoxNodeSummarySchema = z.strictObject({
  node: proxmoxNodeSchema,
  online: z.boolean(),
  cpu: z.number().min(0).nullable(),
  memBytes: z.number().min(0).nullable(),
  maxMemBytes: z.number().min(0).nullable(),
});

// GET /api/proxmox/guests
export const proxmoxGuestsResponseSchema = z.strictObject({
  nodes: z.array(proxmoxNodeSummarySchema).max(64),
  guests: z.array(proxmoxGuestSchema).max(2000),
  fetchedAt: z.iso.datetime().nullable(),
  /** Set when the last fetch failed (then the lists are the last good ones or empty). */
  error: z.string().max(100).nullable(),
});

export const PROXMOX_ACTIONS = ['start', 'shutdown', 'stop', 'reboot'] as const;
export const proxmoxActionSchema = z.enum(PROXMOX_ACTIONS);
export type ProxmoxAction = z.infer<typeof proxmoxActionSchema>;
/** Everything but start needs step-up and `confirm: true` (a running guest goes down). */
export const PROXMOX_STEP_UP_ACTIONS: readonly ProxmoxAction[] = ['shutdown', 'stop', 'reboot'];

// POST /api/proxmox/guests/:node/:type/:vmid/:action { confirm? } -> { ok, task }
export const proxmoxGuestActionParamsSchema = z.strictObject({
  node: proxmoxNodeSchema,
  type: proxmoxGuestTypeSchema,
  vmid: proxmoxVmidSchema,
  action: proxmoxActionSchema,
});
export const proxmoxGuestActionRequestSchema = z.strictObject({
  confirm: z.literal(true).optional(),
});
export const proxmoxGuestActionResponseSchema = z.strictObject({
  ok: z.literal(true),
  /** Proxmox task id (UPID), shown in the audit log. */
  task: z.string().max(200).nullable(),
});

// ---- DNS filter (Pi-hole / AdGuard Home) ------------------------------------------------------

// GET /api/dnsfilter/status
export const dnsFilterStatusSchema = z.strictObject({
  variant: dnsFilterVariantSchema.nullable(),
  blocking: z.boolean().nullable(),
  /** When a pause ends (blocking turns on again by itself). */
  pausedUntil: z.iso.datetime().nullable(),
  queriesToday: z.number().int().min(0).nullable(),
  blockedToday: z.number().int().min(0).nullable(),
  /** 0..100 */
  percentBlocked: z.number().min(0).max(100).nullable(),
  domainsOnLists: z.number().int().min(0).nullable(),
  fetchedAt: z.iso.datetime().nullable(),
  error: z.string().max(100).nullable(),
});
export type DnsFilterStatus = z.infer<typeof dnsFilterStatusSchema>;

/** Pause lengths offered; a pause without end is not possible. */
export const DNS_PAUSE_MINUTES = [5, 15, 30, 60] as const;

// POST /api/dnsfilter/blocking -> dnsFilterStatusSchema
export const dnsFilterBlockingRequestSchema = z.discriminatedUnion('enabled', [
  z.strictObject({ enabled: z.literal(true) }),
  z.strictObject({
    enabled: z.literal(false),
    minutes: z.union([z.literal(5), z.literal(15), z.literal(30), z.literal(60)]),
  }),
]);

// ---- FRITZ!Box (TR-064) ---------------------------------------------------------------------

export const fritzDeviceSchema = z.strictObject({
  name: z.string().max(120),
  ip: z.string().max(45).nullable(),
  mac: z.string().max(17).nullable(),
  active: z.boolean(),
  /** "Ethernet", "802.11", "" from the box, mapped. */
  interface: z.enum(['lan', 'wlan', 'other']),
});
export type FritzDevice = z.infer<typeof fritzDeviceSchema>;

// GET /api/fritzbox/status
export const fritzStatusSchema = z.strictObject({
  model: z.string().max(120).nullable(),
  firmware: z.string().max(60).nullable(),
  internet: z
    .strictObject({
      connected: z.boolean(),
      /** e.g. "Up", "Down", "Initializing". */
      linkStatus: z.string().max(40).nullable(),
      externalIp: z.string().max(45).nullable(),
      uptimeS: z.number().int().min(0).nullable(),
      maxDownBps: z.number().min(0).nullable(),
      maxUpBps: z.number().min(0).nullable(),
    })
    .nullable(),
  devices: z.array(fritzDeviceSchema).max(1000),
  fetchedAt: z.iso.datetime().nullable(),
  error: z.string().max(100).nullable(),
});
export type FritzStatus = z.infer<typeof fritzStatusSchema>;

// POST /api/fritzbox/reboot { confirm: true } (step-up) -> ok
export const fritzRebootRequestSchema = z.strictObject({ confirm: z.literal(true) });

// ---- Uptime Kuma ---------------------------------------------------------------------------

export const kumaMonitorStatusSchema = z.enum(['up', 'down', 'pending', 'maintenance', 'unknown']);

export const kumaMonitorSchema = z.strictObject({
  name: z.string().max(150),
  /** Kuma's type ("http", "keyword", "port", "ping", "docker", ...). */
  type: z.string().max(40),
  url: z.string().max(2048).nullable(),
  hostname: z.string().max(253).nullable(),
  port: z.number().int().min(1).max(65535).nullable(),
  status: kumaMonitorStatusSchema,
  responseMs: z.number().min(0).nullable(),
  certDaysRemaining: z.number().int().nullable(),
  /** http/keyword → http check, port → tcp check, ping → ping check (needs an agent). */
  importAs: z.enum(['http', 'tcp', 'ping']).nullable(),
  /** Id of the check created from this monitor, if any. */
  checkId: z.string().max(64).nullable(),
});
export type KumaMonitor = z.infer<typeof kumaMonitorSchema>;

// GET /api/uptimekuma/monitors (reads Kuma's /metrics with the API key)
export const kumaMonitorsResponseSchema = z.strictObject({
  monitors: z.array(kumaMonitorSchema).max(1000),
  fetchedAt: z.iso.datetime().nullable(),
  error: z.string().max(100).nullable(),
});

// POST /api/uptimekuma/import { names, pingFrom? } -> { created, skipped }
export const kumaImportRequestSchema = z.strictObject({
  names: z.array(z.string().min(1).max(150)).min(1).max(200),
  /** Agent that runs imported ping checks; without it ping monitors are skipped. */
  pingFrom: serverIdSchema.optional(),
});
export const kumaImportResponseSchema = z.strictObject({
  created: z.number().int().min(0),
  /** Name and German reason ("Schon übernommen", "Typ nicht unterstützt", ...). */
  skipped: z.array(z.strictObject({ name: z.string().max(150), reason: z.string().max(100) })),
});

// ---- Wake-on-LAN (core, no module) --------------------------------------------------------------

/** "AA:BB:CC:DD:EE:FF" (also "-" separated or lower case in the request; stored upper case with ":"). */
export const macSchema = z
  .string()
  .trim()
  .regex(/^[0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5}$/, {
    message: 'MAC-Adresse wie AA:BB:CC:DD:EE:FF',
  })
  .transform((m) => m.toUpperCase().replaceAll('-', ':'))
  .refine((m) => m !== '00:00:00:00:00:00' && m !== 'FF:FF:FF:FF:FF:FF', {
    message: 'Ungültige MAC-Adresse',
  })
  // Multicast/broadcast bit of the first octet.
  .refine((m) => (Number.parseInt(m.slice(0, 2), 16) & 1) === 0, {
    message: 'Ungültige MAC-Adresse',
  });

export const wolBroadcastSchema = z
  .string()
  .trim()
  .refine(isAllowedWolBroadcast, { message: '255.255.255.255 oder eine private IPv4-Adresse' });

/** Who sends the packet: the core (runs with host network) or the agent of another server in the same LAN. */
export const wolViaSchema = z.union([z.literal('core'), serverIdSchema]);

export const wolConfigSchema = z.strictObject({
  mac: z.string().nullable(),
  broadcast: z.string(),
  port: z.union([z.literal(7), z.literal(9)]),
  via: wolViaSchema,
});
export type WolConfig = z.infer<typeof wolConfigSchema>;
export const WOL_DEFAULTS = { broadcast: '255.255.255.255', port: 9, via: 'core' } as const;

// GET /api/servers/:id/wol -> wolConfigSchema (mac null: not set up)
// PUT /api/servers/:id/wol -> wolConfigSchema
export const wolConfigRequestSchema = z.strictObject({
  /** null removes Wake-on-LAN for this server. */
  mac: macSchema.nullable(),
  broadcast: wolBroadcastSchema.default(WOL_DEFAULTS.broadcast),
  port: z.union([z.literal(7), z.literal(9)]).default(WOL_DEFAULTS.port),
  via: wolViaSchema.default(WOL_DEFAULTS.via),
});
// POST /api/servers/:id/wake -> { ok, via } (at most 6 per minute and server)
export const wolWakeResponseSchema = z.strictObject({
  ok: z.literal(true),
  via: wolViaSchema,
});

// ---- Alert channels (core, no module) ------------------------------------------------------------

export const NOTIFY_CHANNELS = ['discord', 'telegram', 'ntfy'] as const;
export const notifyChannelIdSchema = z.enum(NOTIFY_CHANNELS);
export type NotifyChannelId = z.infer<typeof notifyChannelIdSchema>;
export const notifyChannelParamsSchema = z.strictObject({ id: notifyChannelIdSchema });

/** Lowest level that goes to the channel. Same push policy (quiet hours, warn bundle) as the phone. */
export const notifyMinLevelSchema = z.enum(['info', 'warn', 'crit']);

export const DISCORD_WEBHOOK_RE =
  /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,25}\/[A-Za-z0-9_-]{20,100}$/;
export const discordWebhookSchema = z
  .string()
  .trim()
  .max(300)
  .regex(DISCORD_WEBHOOK_RE, { message: 'Discord-Webhook-URL erwartet' });
/** Bot token from @BotFather ("123456:ABC..."). Sent only to api.telegram.org. */
export const telegramBotTokenSchema = z
  .string()
  .trim()
  .regex(/^\d{5,15}:[A-Za-z0-9_-]{30,60}$/, { message: 'Bot-Token erwartet' });
/** Numeric chat id (groups negative) or "@kanalname". */
export const telegramChatIdSchema = z
  .string()
  .trim()
  .regex(/^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/, { message: 'Chat-ID erwartet' });
export const ntfyTopicSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, { message: 'Thema aus Buchstaben, Ziffern, - und _' });
export const ntfyTokenSchema = z
  .string()
  .trim()
  .regex(/^tk_[A-Za-z0-9]{20,60}$/, { message: 'Zugriffstoken (tk_…) erwartet' });

export const notifyChannelSchema = z.strictObject({
  id: notifyChannelIdSchema,
  enabled: z.boolean(),
  minLevel: notifyMinLevelSchema,
  /** All secrets of the channel are set (discord: webhook; telegram: token + chat; ntfy: topic). */
  configured: z.boolean(),
  /** ntfy only: server URL (not a secret). Otherwise null. */
  server: z.string().nullable(),
  /** ntfy only: an access token is stored. */
  tokenSet: z.boolean(),
  lastSentAt: z.iso.datetime().nullable(),
  lastError: z.string().max(100).nullable(),
});
export type NotifyChannel = z.infer<typeof notifyChannelSchema>;

// GET /api/notify/channels
export const notifyChannelsResponseSchema = z.strictObject({
  channels: z.array(notifyChannelSchema),
});

// PUT /api/notify/channels/:id -> notifyChannelSchema
// Step-up when a secret (webhook, bot token, chat id, topic, token) or the ntfy server changes.
// Changing the ntfy server without a new topic/token in the same request drops topic and token.
export const notifyChannelUpdateRequestSchema = z.strictObject({
  enabled: z.boolean().optional(),
  minLevel: notifyMinLevelSchema.optional(),
  discordWebhook: discordWebhookSchema.optional(),
  telegramBotToken: telegramBotTokenSchema.optional(),
  telegramChatId: telegramChatIdSchema.optional(),
  /** Default https://ntfy.sh */
  ntfyServer: integrationUrlSchema.optional(),
  ntfyTopic: ntfyTopicSchema.optional(),
  /** null removes the token. */
  ntfyToken: ntfyTokenSchema.nullable().optional(),
});
export type NotifyChannelUpdateRequest = z.infer<typeof notifyChannelUpdateRequestSchema>;

export function notifyChannelUpdateNeedsStepUp(body: NotifyChannelUpdateRequest): boolean {
  return (
    body.discordWebhook !== undefined ||
    body.telegramBotToken !== undefined ||
    body.telegramChatId !== undefined ||
    body.ntfyServer !== undefined ||
    body.ntfyTopic !== undefined ||
    body.ntfyToken !== undefined
  );
}
// DELETE /api/notify/channels/:id (step-up): forget all secrets, disable.
// POST /api/notify/channels/:id/test -> { ok: true } or 502 { error: 'channel_failed', message }
