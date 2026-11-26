import { z } from 'zod';

/** The only REST host the bot talks to (fixed, never from settings or Discord). */
export const DISCORD_API = 'https://discord.com/api/v10';
/** Largest REST response body read. */
const MAX_RESPONSE_BYTES = 1024 * 1024;
const USER_AGENT = 'DiscordBot (homelab-zentrale, 1)';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * A failed Discord REST call. Carries only the HTTP status (0: network error,
 * timeout, redirect or unreadable answer), never the URL (interaction tokens
 * live in the path), the token or the response text.
 */
export class DiscordRestError extends Error {
  constructor(readonly status: number) {
    super(`discord_http_${status}`);
    this.name = 'DiscordRestError';
  }
}

/** Path segments that go into URLs: snowflakes and interaction tokens. */
const SEGMENT = /^[A-Za-z0-9._-]{1,500}$/;

function seg(v: string): string {
  if (!SEGMENT.test(v) || v === '.' || v === '..') throw new DiscordRestError(0);
  return v;
}

const gatewayBotSchema = z.object({ url: z.string().max(512) });

export interface DiscordMessage {
  content: string;
  flags?: number;
  allowed_mentions: { parse: [] };
}

/**
 * Discord REST client. The bot token goes only into the Authorization header of
 * requests to DISCORD_API; interaction callbacks are authorized by the
 * interaction token in the path and get no bot token. Redirects are errors.
 */
export class DiscordRest {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  private async request(
    method: 'GET' | 'PUT' | 'POST' | 'PATCH',
    path: string,
    body: unknown,
    auth: boolean,
  ): Promise<unknown> {
    const headers: Record<string, string> = { 'user-agent': USER_AGENT };
    if (auth) headers.authorization = `Bot ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchImpl(`${DISCORD_API}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new DiscordRestError(0);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new DiscordRestError(res.status);
    }
    if (res.status === 204) return null;
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new DiscordRestError(0);
    }
    if (text.length > MAX_RESPONSE_BYTES) throw new DiscordRestError(0);
    if (text === '') return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new DiscordRestError(0);
    }
  }

  /** GET /gateway/bot: the WebSocket URL (checked by the gateway). */
  async gatewayUrl(): Promise<string> {
    const p = gatewayBotSchema.safeParse(
      await this.request('GET', '/gateway/bot', undefined, true),
    );
    if (!p.success) throw new DiscordRestError(0);
    return p.data.url;
  }

  /** Bulk overwrite of the guild commands (instant, no global commands). */
  async putGuildCommands(appId: string, guildId: string, commands: unknown[]): Promise<void> {
    await this.request(
      'PUT',
      `/applications/${seg(appId)}/guilds/${seg(guildId)}/commands`,
      commands,
      true,
    );
  }

  /** POST /interactions/{id}/{token}/callback (type 4 message, type 5 deferred). */
  async callback(
    interactionId: string,
    interactionToken: string,
    body: { type: 4; data: DiscordMessage } | { type: 5; data: { flags: number } },
  ): Promise<void> {
    await this.request(
      'POST',
      `/interactions/${seg(interactionId)}/${seg(interactionToken)}/callback`,
      body,
      false,
    );
  }

  /** PATCH the deferred reply. */
  async editOriginal(appId: string, interactionToken: string, msg: DiscordMessage): Promise<void> {
    await this.request(
      'PATCH',
      `/webhooks/${seg(appId)}/${seg(interactionToken)}/messages/@original`,
      msg,
      false,
    );
  }
}
