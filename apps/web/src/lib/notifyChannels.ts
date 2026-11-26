import {
  discordWebhookSchema,
  integrationUrlSchema,
  notifyChannelSchema,
  notifyChannelsResponseSchema,
  ntfyTokenSchema,
  ntfyTopicSchema,
  okResponseSchema,
  telegramBotTokenSchema,
  telegramChatIdSchema,
  type NotifyChannel,
  type NotifyChannelId,
  type NotifyChannelUpdateRequest,
} from '@hz/shared';
import type { Status } from '@hz/ui';
import { api, isApiError } from './api.js';
import { errorText } from './errors.js';

/**
 * Meldungskanäle (SPEC 16): Discord, Telegram, ntfy. Core feature, no module.
 * Secrets are write-only; changing them needs step-up (api() asks and retries).
 */

export const notifyChannelsKey = ['notify', 'channels'] as const;

export async function fetchNotifyChannels(signal?: AbortSignal): Promise<NotifyChannel[]> {
  const r = await api('/api/notify/channels', { schema: notifyChannelsResponseSchema, signal });
  return r.channels;
}

export function saveNotifyChannel(
  id: NotifyChannelId,
  body: NotifyChannelUpdateRequest,
): Promise<NotifyChannel> {
  return api(`/api/notify/channels/${id}`, { method: 'PUT', body, schema: notifyChannelSchema });
}

export async function deleteNotifyChannel(id: NotifyChannelId): Promise<void> {
  await api(`/api/notify/channels/${id}`, { method: 'DELETE', schema: okResponseSchema });
}

export async function testNotifyChannel(id: NotifyChannelId): Promise<void> {
  await api(`/api/notify/channels/${id}/test`, { method: 'POST', schema: okResponseSchema });
}

export const CHANNEL_LABEL: Record<NotifyChannelId, string> = {
  discord: 'Discord',
  telegram: 'Telegram',
  ntfy: 'ntfy',
};

export const MIN_LEVEL_OPTIONS = [
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warnung' },
  { value: 'crit', label: 'Kritisch' },
] as const;

export const NTFY_DEFAULT_SERVER = 'https://ntfy.sh';

export function channelStatus(c: NotifyChannel): Status {
  if (!c.configured || !c.enabled) return 'off';
  return c.lastError ? 'warn' : 'ok';
}

export function channelStatusText(c: NotifyChannel): string {
  if (!c.configured) return 'nicht eingerichtet';
  if (!c.enabled) return 'aus';
  return c.lastError ? 'Fehler' : 'an';
}

/** 502 channel_failed carries a fixed German message from the core. */
export function channelTestErrorText(err: unknown): string {
  if (isApiError(err, 'channel_failed'))
    return err.hint ? `Testnachricht fehlgeschlagen: ${err.hint}` : 'Testnachricht fehlgeschlagen.';
  return errorText(err);
}

export interface ChannelForm {
  discordWebhook: string;
  telegramBotToken: string;
  telegramChatId: string;
  ntfyServer: string;
  ntfyTopic: string;
  ntfyToken: string;
  /** Remove the stored ntfy token. */
  removeNtfyToken: boolean;
}

export type ChannelErrors = Partial<Record<keyof ChannelForm, string>>;

export function channelToForm(c: NotifyChannel): ChannelForm {
  return {
    discordWebhook: '',
    telegramBotToken: '',
    telegramChatId: '',
    ntfyServer: c.server ?? (c.id === 'ntfy' ? NTFY_DEFAULT_SERVER : ''),
    ntfyTopic: '',
    ntfyToken: '',
    removeNtfyToken: false,
  };
}

/**
 * Secret fields of the channel from the form (empty = keep). A channel that is not
 * configured yet needs all of its required secrets in one request.
 */
export function buildChannelSecrets(
  c: NotifyChannel,
  f: ChannelForm,
): { patch: NotifyChannelUpdateRequest; errors: ChannelErrors } {
  const patch: NotifyChannelUpdateRequest = {};
  const errors: ChannelErrors = {};
  const need = !c.configured;

  function take<K extends keyof ChannelForm & keyof NotifyChannelUpdateRequest>(
    key: K,
    schema: { safeParse(v: unknown): { success: boolean } },
    msg: string,
    missing: string,
  ): void {
    const v = String(f[key]).trim();
    if (!v) {
      if (need) errors[key] = missing;
      return;
    }
    if (!schema.safeParse(v).success) errors[key] = msg;
    else (patch as Record<string, unknown>)[key] = v;
  }

  if (c.id === 'discord') {
    take(
      'discordWebhook',
      discordWebhookSchema,
      'Discord-Webhook-URL erwartet (https://discord.com/api/webhooks/…).',
      'Webhook-URL fehlt.',
    );
  } else if (c.id === 'telegram') {
    take(
      'telegramBotToken',
      telegramBotTokenSchema,
      'Bot-Token von @BotFather erwartet (123456:ABC…).',
      'Bot-Token fehlt.',
    );
    take(
      'telegramChatId',
      telegramChatIdSchema,
      'Chat-ID als Zahl oder @kanalname.',
      'Chat-ID fehlt.',
    );
  } else {
    const server = f.ntfyServer.trim() || NTFY_DEFAULT_SERVER;
    const serverChanged = server !== (c.server ?? NTFY_DEFAULT_SERVER);
    if (serverChanged || need) {
      if (!integrationUrlSchema.safeParse(server).success)
        errors.ntfyServer = 'Adresse mit http:// oder https://, ohne Benutzer, Query oder Anker.';
      else if (serverChanged || !c.server) patch.ntfyServer = server;
    }
    // A new server drops topic and token in the core: ask for the topic again.
    take(
      'ntfyTopic',
      ntfyTopicSchema,
      'Thema aus Buchstaben, Ziffern, - und _ (höchstens 64).',
      'Thema fehlt.',
    );
    if (serverChanged && !need && !patch.ntfyTopic && !errors.ntfyTopic)
      errors.ntfyTopic = 'Neuer Server: Thema neu eintragen.';
    const token = f.ntfyToken.trim();
    if (token) {
      if (!ntfyTokenSchema.safeParse(token).success)
        errors.ntfyToken = 'Zugriffstoken (tk_…) erwartet.';
      else patch.ntfyToken = token;
    } else if (f.removeNtfyToken && c.tokenSet) {
      patch.ntfyToken = null;
    }
  }
  return { patch, errors };
}
