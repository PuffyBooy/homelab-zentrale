import { z } from 'zod';
import {
  DISCORD_WEBHOOK_RE,
  integrationUrlSchema,
  notifyMinLevelSchema,
  ntfyTokenSchema,
  ntfyTopicSchema,
  telegramBotTokenSchema,
  telegramChatIdSchema,
  type NotifyChannelId,
  type PushPayload,
} from '@hz/shared';
import type { FilterLevel } from '../push/notifier.js';
import type { NotifyRequest } from './transport.js';

export const DEFAULT_NTFY_SERVER = 'https://ntfy.sh';
export const TELEGRAM_API = 'https://api.telegram.org';

/** Secret fields per channel. All of `required` set = configured. */
export const SECRET_FIELDS = {
  discord: { all: ['webhook'], required: ['webhook'] },
  telegram: { all: ['botToken', 'chatId'], required: ['botToken', 'chatId'] },
  ntfy: { all: ['topic', 'token'], required: ['topic'] },
} as const satisfies Record<
  NotifyChannelId,
  { all: readonly string[]; required: readonly string[] }
>;

export type SecretField = 'webhook' | 'botToken' | 'chatId' | 'topic' | 'token';

/** settings key of the channel config (enabled, level, ntfy server, encrypted secrets). */
export const channelKey = (id: NotifyChannelId): string => `notify.channel.${id}`;
/** settings key of the delivery status (written after each send, separate from the config). */
export const statusKey = (id: NotifyChannelId): string => `notify.channel.${id}.status`;
/** AES-GCM AAD of one secret: binds the ciphertext to channel and field. */
export const secretAad = (id: NotifyChannelId, field: SecretField): string =>
  `settings:${channelKey(id)}:${field}`;

const encryptedSchema = z.string().startsWith('v1:').max(4000);

export const storedChannelSchema = z.object({
  enabled: z.boolean().default(false),
  minLevel: notifyMinLevelSchema.default('warn'),
  /** ntfy only; normalized without trailing slash. */
  server: z.string().max(200).nullable().default(null),
  secrets: z
    .object({
      webhook: encryptedSchema.optional(),
      botToken: encryptedSchema.optional(),
      chatId: encryptedSchema.optional(),
      topic: encryptedSchema.optional(),
      token: encryptedSchema.optional(),
    })
    .default({}),
});
export type StoredChannel = z.infer<typeof storedChannelSchema>;

export const storedStatusSchema = z.object({
  lastSentAt: z.number().int().nullable().default(null),
  lastError: z.string().max(100).nullable().default(null),
});
export type StoredStatus = z.infer<typeof storedStatusSchema>;

/** "https://ntfy.example.org/" -> "https://ntfy.example.org" (path kept, trailing slashes dropped). */
export function normalizeServer(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Fixed German error texts of a channel (never the remote body). */
export const CHANNEL_ERRORS = {
  unreachable: 'Nicht erreichbar',
  timeout: 'Zeitüberschreitung',
  tls: 'TLS-Fehler (Zertifikat prüfen)',
  credentials: 'Zugangsdaten ungültig',
  redirect: 'Weiterleitung nicht erlaubt',
  unexpected: 'Unerwartete Antwort',
  unreadable: 'Zugangsdaten nicht lesbar, bitte neu eintragen',
  blocked: 'Ziel nicht erlaubt',
  throttled: 'Zu viele Nachrichten, später erneut',
  notConfigured: 'Kanal ist nicht eingerichtet',
} as const;
export type ChannelErrorText = (typeof CHANNEL_ERRORS)[keyof typeof CHANNEL_ERRORS];

/** Thrown while building a request: the stored target fails the send-time check. */
export class ChannelTargetError extends Error {
  constructor(public readonly text: ChannelErrorText) {
    super('channel target refused');
    this.name = 'ChannelTargetError';
  }
}

export interface ChannelSecrets {
  webhook?: string;
  botToken?: string;
  chatId?: string;
  topic?: string;
  token?: string;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string): string => s.replace(/[\r\n\t]+/g, ' ').trim();

/** RFC 2047 encoded word for non-ASCII header values (ntfy decodes it). */
export function headerValue(s: string): string {
  const v = oneLine(s);
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  return `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

const NTFY_PRIORITY: Record<PushPayload['level'], string> = {
  crit: '5',
  warn: '4',
  info: '3',
  ok: '3',
};

/**
 * The HTTP request for one message. Validates the stored target again at send
 * time: Discord only to a Discord webhook URL, Telegram only to api.telegram.org
 * with a well-formed bot token, ntfy only to an allowed http(s) server.
 * Title and body are expected to be masked already.
 */
export function buildRequest(
  id: NotifyChannelId,
  stored: StoredChannel,
  secrets: ChannelSecrets,
  payload: PushPayload,
  level: FilterLevel,
): NotifyRequest {
  const title = oneLine(payload.title);
  switch (id) {
    case 'discord': {
      const url = secrets.webhook ?? '';
      if (!DISCORD_WEBHOOK_RE.test(url)) throw new ChannelTargetError(CHANNEL_ERRORS.blocked);
      return {
        url,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: clip(`**${title}**\n${payload.body}`, 2000),
          // Alert texts must never ping @everyone, roles or users.
          allowed_mentions: { parse: [] },
        }),
      };
    }
    case 'telegram': {
      const token = telegramBotTokenSchema.safeParse(secrets.botToken ?? '');
      const chat = telegramChatIdSchema.safeParse(secrets.chatId ?? '');
      if (!token.success || !chat.success) throw new ChannelTargetError(CHANNEL_ERRORS.blocked);
      return {
        url: `${TELEGRAM_API}/bot${token.data}/sendMessage`,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chat.data,
          // Plain text (no parse_mode): alert texts cannot inject markup or links.
          text: clip(`${title}\n${payload.body}`, 4000),
          disable_web_page_preview: true,
        }),
      };
    }
    case 'ntfy': {
      const server = integrationUrlSchema.safeParse(stored.server ?? DEFAULT_NTFY_SERVER);
      const topic = ntfyTopicSchema.safeParse(secrets.topic ?? '');
      if (!server.success || !topic.success) throw new ChannelTargetError(CHANNEL_ERRORS.blocked);
      const headers: Record<string, string> = {
        'content-type': 'text/plain; charset=utf-8',
        title: headerValue(clip(title, 200)),
        priority: NTFY_PRIORITY[payload.level],
        tags: `homelab,${level}`,
      };
      if (secrets.token !== undefined) {
        const token = ntfyTokenSchema.safeParse(secrets.token);
        if (!token.success) throw new ChannelTargetError(CHANNEL_ERRORS.unreadable);
        headers.authorization = `Bearer ${token.data}`;
      }
      return {
        url: `${normalizeServer(server.data)}/${topic.data}`,
        headers,
        body: clip(payload.body.length > 0 ? payload.body : title, 4000),
      };
    }
  }
}

/** Maps an HTTP status to null (delivered) or a fixed error text. */
export function statusError(status: number): ChannelErrorText | null {
  if (status >= 200 && status < 300) return null;
  if (status >= 300 && status < 400) return CHANNEL_ERRORS.redirect;
  if (status === 429) return CHANNEL_ERRORS.throttled;
  if (status === 400 || status === 401 || status === 403 || status === 404) {
    return CHANNEL_ERRORS.credentials;
  }
  return CHANNEL_ERRORS.unexpected;
}
