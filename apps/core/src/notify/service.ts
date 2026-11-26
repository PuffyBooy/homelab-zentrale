import type { FastifyBaseLogger } from 'fastify';
import {
  NOTIFY_CHANNELS,
  notifyChannelIdSchema,
  notifyChannelSchema,
  type NotifyChannel,
  type NotifyChannelId,
  type NotifyChannelUpdateRequest,
  type PushPayload,
} from '@hz/shared';
import type { Clock } from '../clock.js';
import type { SecretBox } from '../crypto.js';
import type { Db } from '../db/index.js';
import { readSetting, writeSetting } from '../db/settings.js';
import { HttpError } from '../http/errors.js';
import { filterRank, maxFilterLevel, type FilterLevel, type PushSink } from '../push/notifier.js';
import { maskAddresses } from '../wall/service.js';
import {
  buildRequest,
  CHANNEL_ERRORS,
  ChannelTargetError,
  channelKey,
  DEFAULT_NTFY_SERVER,
  normalizeServer,
  secretAad,
  SECRET_FIELDS,
  statusError,
  statusKey,
  storedChannelSchema,
  storedStatusSchema,
  type ChannelErrorText,
  type ChannelSecrets,
  type SecretField,
  type StoredChannel,
  type StoredStatus,
} from './channels.js';
import { httpNotifyTransport, NotifyTransportError, type NotifyTransport } from './transport.js';

export interface NotifyServiceDeps {
  db: Db;
  box: SecretBox;
  now: Clock;
  log: FastifyBaseLogger;
  /** Outgoing HTTP (tests: a fake). Default: node http/https, 8 s, no redirects. */
  transport?: NotifyTransport;
}

/** What an update changed (field names only, never values; for the audit log). */
export interface ChannelUpdateResult {
  channel: NotifyChannel;
  secretsChanged: SecretField[];
  /** Secrets dropped because the ntfy server changed without them. */
  dropped: SecretField[];
  serverChanged: boolean;
}

/** Fields of the update request that carry a secret, per channel. */
const REQUEST_FIELDS: Record<NotifyChannelId, readonly (keyof NotifyChannelUpdateRequest)[]> = {
  discord: ['discordWebhook'],
  telegram: ['telegramBotToken', 'telegramChatId'],
  ntfy: ['ntfyServer', 'ntfyTopic', 'ntfyToken'],
};

const TEST_PAYLOAD: PushPayload = {
  title: 'Testnachricht der Homelab-Zentrale',
  body: 'Dieser Kanal ist eingerichtet. Meldungen kommen ab jetzt auch hier an.',
  level: 'info',
  url: '/alerts',
  tag: 'channel-test',
};

/**
 * Extra alert channels (SPEC 9/16): Discord webhook, Telegram bot, ntfy.
 * Config in `settings` (`notify.channel.<id>`), secrets AES-256-GCM encrypted
 * with an AAD per channel and field. Delivery never throws; the outcome is
 * stored per channel as lastSentAt / lastError (fixed German text).
 */
export class NotifyService {
  private readonly transport: NotifyTransport;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly deps: NotifyServiceDeps) {
    this.transport = deps.transport ?? httpNotifyTransport;
  }

  // ---- storage -------------------------------------------------------------

  private stored(id: NotifyChannelId): StoredChannel {
    const parsed = storedChannelSchema.safeParse(readSetting(this.deps.db, channelKey(id)) ?? {});
    return parsed.success ? parsed.data : storedChannelSchema.parse({});
  }

  private status(id: NotifyChannelId): StoredStatus {
    const parsed = storedStatusSchema.safeParse(readSetting(this.deps.db, statusKey(id)) ?? {});
    return parsed.success ? parsed.data : storedStatusSchema.parse({});
  }

  private writeStatus(id: NotifyChannelId, s: StoredStatus): void {
    writeSetting(this.deps.db, statusKey(id), s, this.deps.now());
  }

  private configured(id: NotifyChannelId, s: StoredChannel): boolean {
    return SECRET_FIELDS[id].required.every((f) => s.secrets[f] !== undefined);
  }

  /** Decrypted secrets, or null if one of them cannot be read (key changed, tampered). */
  private secrets(id: NotifyChannelId, s: StoredChannel): ChannelSecrets | null {
    const out: ChannelSecrets = {};
    for (const field of SECRET_FIELDS[id].all) {
      const enc = s.secrets[field];
      if (enc === undefined) continue;
      try {
        out[field] = this.deps.box.decrypt(enc, secretAad(id, field));
      } catch {
        return null;
      }
    }
    return out;
  }

  // ---- API -------------------------------------------------------------------

  view(id: NotifyChannelId): NotifyChannel {
    const s = this.stored(id);
    const st = this.status(id);
    return notifyChannelSchema.parse({
      id,
      enabled: s.enabled,
      minLevel: s.minLevel,
      configured: this.configured(id, s),
      server: id === 'ntfy' ? (s.server ?? DEFAULT_NTFY_SERVER) : null,
      tokenSet: id === 'ntfy' && s.secrets.token !== undefined,
      lastSentAt: st.lastSentAt === null ? null : new Date(st.lastSentAt).toISOString(),
      lastError: st.lastError,
    });
  }

  list(): NotifyChannel[] {
    return NOTIFY_CHANNELS.map((id) => this.view(id));
  }

  /** Enabled and configured channels. */
  activeIds(): NotifyChannelId[] {
    return NOTIFY_CHANNELS.filter((id) => {
      const s = this.stored(id);
      return s.enabled && this.configured(id, s);
    });
  }

  update(id: NotifyChannelId, body: NotifyChannelUpdateRequest): ChannelUpdateResult {
    for (const other of NOTIFY_CHANNELS) {
      if (other === id) continue;
      if (REQUEST_FIELDS[other].some((f) => body[f] !== undefined)) {
        throw new HttpError(400, 'invalid_input', undefined, 'Feld passt nicht zu diesem Kanal');
      }
    }
    const s = this.stored(id);
    const secrets = { ...s.secrets };
    const changed: SecretField[] = [];
    const dropped: SecretField[] = [];
    const put = (field: SecretField, value: string): void => {
      secrets[field] = this.deps.box.encrypt(value, secretAad(id, field));
      changed.push(field);
    };

    let server = s.server;
    let serverChanged = false;
    if (body.ntfyServer !== undefined) {
      const next = normalizeServer(body.ntfyServer);
      serverChanged = next !== normalizeServer(s.server ?? DEFAULT_NTFY_SERVER);
      server = next;
      if (serverChanged) {
        // A topic or token is never sent to a server it was not entered for.
        if (body.ntfyTopic === undefined && secrets.topic !== undefined) {
          delete secrets.topic;
          dropped.push('topic');
        }
        if (body.ntfyToken === undefined && secrets.token !== undefined) {
          delete secrets.token;
          dropped.push('token');
        }
      }
    }
    if (body.discordWebhook !== undefined) put('webhook', body.discordWebhook);
    if (body.telegramBotToken !== undefined) put('botToken', body.telegramBotToken);
    if (body.telegramChatId !== undefined) put('chatId', body.telegramChatId);
    if (body.ntfyTopic !== undefined) put('topic', body.ntfyTopic);
    if (body.ntfyToken === null) {
      if (secrets.token !== undefined) {
        delete secrets.token;
        dropped.push('token');
      }
    } else if (body.ntfyToken !== undefined) {
      put('token', body.ntfyToken);
    }

    const next: StoredChannel = {
      enabled: body.enabled ?? s.enabled,
      minLevel: body.minLevel ?? s.minLevel,
      server,
      secrets,
    };
    const configured = this.configured(id, next);
    if (body.enabled === true && !configured) {
      throw new HttpError(409, 'conflict', undefined, CHANNEL_ERRORS.notConfigured);
    }
    if (!configured) next.enabled = false;
    writeSetting(this.deps.db, channelKey(id), next, this.deps.now());
    if (changed.length > 0 || dropped.length > 0 || serverChanged) {
      // A new target: the old error says nothing about it.
      this.writeStatus(id, { ...this.status(id), lastError: null });
    }
    return { channel: this.view(id), secretsChanged: changed, dropped, serverChanged };
  }

  /** Forgets all secrets and the ntfy server, disables the channel. */
  remove(id: NotifyChannelId): NotifyChannel {
    writeSetting(this.deps.db, channelKey(id), storedChannelSchema.parse({}), this.deps.now());
    this.writeStatus(id, storedStatusSchema.parse({}));
    return this.view(id);
  }

  /**
   * Sends a fixed test message now (also when the channel is switched off).
   * Throws 409 when not configured, 502 channel_failed with the fixed text.
   */
  async test(id: NotifyChannelId): Promise<NotifyChannel> {
    const s = this.stored(id);
    if (!this.configured(id, s)) {
      throw new HttpError(409, 'conflict', undefined, CHANNEL_ERRORS.notConfigured);
    }
    const error = await this.track(this.sendOne(id, TEST_PAYLOAD, 'info'));
    if (error !== null) throw new HttpError(502, 'channel_failed', undefined, error);
    return this.view(id);
  }

  /**
   * Sends to every active channel whose minimum level is reached (optionally
   * only to `only`). Addresses in title and body are masked: the messages leave
   * the tailnet. Resolves with the number of delivered messages; never throws.
   */
  deliver(
    payload: PushPayload,
    level: FilterLevel,
    only?: ReadonlySet<NotifyChannelId>,
  ): Promise<number> {
    const masked: PushPayload = {
      ...payload,
      title: maskAddresses(payload.title),
      body: maskAddresses(payload.body),
    };
    const targets = this.activeIds().filter(
      (id) =>
        (only === undefined || only.has(id)) &&
        filterRank(level) >= filterRank(this.stored(id).minLevel),
    );
    if (targets.length === 0) return Promise.resolve(0);
    return this.track(
      Promise.all(targets.map((id) => this.sendOne(id, masked, level))).then(
        (errors) => errors.filter((e) => e === null).length,
      ),
    );
  }

  /** Resolves when all running deliveries are done (shutdown). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p)).catch(() => undefined);
    return p;
  }

  /** One message to one channel. Returns null or the fixed error text; never throws. */
  private async sendOne(
    id: NotifyChannelId,
    payload: PushPayload,
    level: FilterLevel,
  ): Promise<ChannelErrorText | null> {
    let error: ChannelErrorText | null;
    try {
      error = await this.attempt(id, payload, level);
    } catch {
      error = CHANNEL_ERRORS.unexpected;
    }
    const st = this.status(id);
    this.writeStatus(id, {
      lastSentAt: error === null ? this.deps.now() : st.lastSentAt,
      lastError: error,
    });
    if (error !== null) this.deps.log.warn({ channel: id, error }, 'alert channel delivery failed');
    return error;
  }

  private async attempt(
    id: NotifyChannelId,
    payload: PushPayload,
    level: FilterLevel,
  ): Promise<ChannelErrorText | null> {
    const s = this.stored(id);
    if (!this.configured(id, s)) return CHANNEL_ERRORS.notConfigured;
    const secrets = this.secrets(id, s);
    if (secrets === null) return CHANNEL_ERRORS.unreadable;
    let request;
    try {
      request = buildRequest(id, s, secrets, payload, level);
    } catch (err) {
      if (err instanceof ChannelTargetError) return err.text;
      return CHANNEL_ERRORS.unexpected;
    }
    try {
      const res = await this.transport.post(request);
      return statusError(res.status);
    } catch (err) {
      if (!(err instanceof NotifyTransportError)) return CHANNEL_ERRORS.unreachable;
      switch (err.kind) {
        case 'timeout':
          return CHANNEL_ERRORS.timeout;
        case 'tls':
          return CHANNEL_ERRORS.tls;
        case 'blocked':
          return CHANNEL_ERRORS.blocked;
        case 'unreachable':
          return CHANNEL_ERRORS.unreachable;
      }
    }
  }
}

/** Pseudo device ids of the channels in the push digest (`channel:discord`, ...). */
export const CHANNEL_DEVICE_PREFIX = 'channel:';

/**
 * PushSink around the phone push that also fans out to the alert channels, so
 * the channels follow exactly the same policy as the phone (quiet hours, warn
 * bundle, morning digest). Active channels appear as pseudo device ids
 * (`channel:<id>`) in deviceIds(): items held back in quiet hours are stored
 * for them as well (also when no phone is registered), and sendTo() routes the
 * digest to the channels that were active when the items were held back.
 */
export class ChannelFanoutSink implements PushSink {
  constructor(
    private readonly push: PushSink,
    private readonly channels: NotifyService,
  ) {}

  deviceIds(): string[] {
    return [
      ...this.push.deviceIds(),
      ...this.channels.activeIds().map((id) => `${CHANNEL_DEVICE_PREFIX}${id}`),
    ];
  }

  async sendAll(payload: PushPayload, level?: FilterLevel): Promise<number> {
    const channels = this.channels.deliver(payload, level ?? maxFilterLevel([payload.level]));
    const phones = await this.push.sendAll(payload, level);
    return phones + (await channels);
  }

  async sendTo(
    deviceIds: readonly string[],
    payload: PushPayload,
    level?: FilterLevel,
  ): Promise<number> {
    const devices: string[] = [];
    const only = new Set<NotifyChannelId>();
    for (const id of deviceIds) {
      if (id.startsWith(CHANNEL_DEVICE_PREFIX)) {
        const parsed = notifyChannelIdSchema.safeParse(id.slice(CHANNEL_DEVICE_PREFIX.length));
        if (parsed.success) only.add(parsed.data);
      } else {
        devices.push(id);
      }
    }
    const channels =
      only.size > 0
        ? this.channels.deliver(payload, level ?? maxFilterLevel([payload.level]), only)
        : Promise.resolve(0);
    const phones = devices.length > 0 ? await this.push.sendTo(devices, payload, level) : 0;
    return phones + (await channels);
  }
}
