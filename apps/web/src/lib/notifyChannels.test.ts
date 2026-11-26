import { afterEach, describe, expect, it, vi } from 'vitest';
import { channel, json, mockFetch } from '../test-m14.js';
import {
  buildChannelSecrets,
  channelStatus,
  channelStatusText,
  channelTestErrorText,
  channelToForm,
  testNotifyChannel,
} from './notifyChannels.js';

afterEach(() => vi.unstubAllGlobals());

const WEBHOOK = `https://discord.com/api/webhooks/123456789012/${'a'.repeat(40)}`;

describe('notify channels', () => {
  it('shows the state with shape and text', () => {
    expect(channelStatusText(channel())).toBe('nicht eingerichtet');
    expect(channelStatus(channel({ configured: true, enabled: true }))).toBe('ok');
    expect(channelStatus(channel({ configured: true, enabled: true, lastError: 'HTTP 404' }))).toBe(
      'warn',
    );
    expect(channelStatusText(channel({ configured: true }))).toBe('aus');
  });

  it('needs all secrets for a new channel and validates them', () => {
    const c = channel();
    expect(buildChannelSecrets(c, channelToForm(c)).errors.discordWebhook).toBe(
      'Webhook-URL fehlt.',
    );
    expect(
      buildChannelSecrets(c, { ...channelToForm(c), discordWebhook: 'https://evil.example/x' })
        .errors.discordWebhook,
    ).toMatch(/Discord-Webhook-URL/);
    expect(buildChannelSecrets(c, { ...channelToForm(c), discordWebhook: WEBHOOK }).patch).toEqual({
      discordWebhook: WEBHOOK,
    });
    const t = channel({ id: 'telegram' });
    const r = buildChannelSecrets(t, { ...channelToForm(t), telegramChatId: '-100123' });
    expect(r.errors.telegramBotToken).toBe('Bot-Token fehlt.');
    expect(r.errors.telegramChatId).toBeUndefined();
  });

  it('keeps stored secrets when fields stay empty', () => {
    const c = channel({ id: 'telegram', configured: true });
    expect(buildChannelSecrets(c, channelToForm(c))).toEqual({ patch: {}, errors: {} });
  });

  it('ntfy: default server, new server needs the topic again, token removable', () => {
    const n = channel({ id: 'ntfy' });
    const f = channelToForm(n);
    expect(f.ntfyServer).toBe('https://ntfy.sh');
    expect(buildChannelSecrets(n, { ...f, ntfyTopic: 'homelab-a8f3k2' }).patch).toEqual({
      ntfyServer: 'https://ntfy.sh',
      ntfyTopic: 'homelab-a8f3k2',
    });
    const set = channel({
      id: 'ntfy',
      configured: true,
      server: 'https://ntfy.sh',
      tokenSet: true,
    });
    const moved = buildChannelSecrets(set, {
      ...channelToForm(set),
      ntfyServer: 'https://ntfy.lan',
    });
    expect(moved.errors.ntfyTopic).toBe('Neuer Server: Thema neu eintragen.');
    expect(
      buildChannelSecrets(set, { ...channelToForm(set), removeNtfyToken: true }).patch,
    ).toEqual({ ntfyToken: null });
    expect(
      buildChannelSecrets(set, { ...channelToForm(set), ntfyToken: 'nope' }).errors.ntfyToken,
    ).toMatch(/tk_/);
  });

  it('shows the fixed message of a failed test', async () => {
    mockFetch(
      json(502, { ok: false, error: 'channel_failed', message: 'Webhook abgelehnt (HTTP 404)' }),
    );
    const err = await testNotifyChannel('discord').catch((e: unknown) => e);
    expect(channelTestErrorText(err)).toBe(
      'Testnachricht fehlgeschlagen: Webhook abgelehnt (HTTP 404)',
    );
  });
});
