import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import {
  discordWebhookUrlSchema,
  gameNotifyEventSchema,
  gameNotifySchema,
  type GameSummary,
} from '@hz/shared';
import type { FetchLike } from '../checks/rdap.js';
import type { Clock } from '../clock.js';
import type { SecretBox } from '../crypto.js';
import type { Db } from '../db/index.js';
import { gameNotify, type GameNotifyRow } from '../db/schema.js';
import { HttpError } from '../http/errors.js';
import { hasTailnetAddress } from '../share/service.js';
import type { GameLifecycleEvent, GameService } from './service.js';

export type GameNotifyEvent = z.infer<typeof gameNotifyEventSchema>;
export type GameNotify = z.infer<typeof gameNotifySchema>;

/** Discord must answer within this time. */
export const DISCORD_TIMEOUT_MS = 5_000;
const USER_AGENT = 'homelab-zentrale';
const aad = (gameId: string): string => `game_notify.discord:${gameId}`;

const EVENT_TEXT: Record<GameNotifyEvent | 'test', string> = {
  online: 'ist online',
  offline: 'ist offline',
  sleep: 'schläft (der erste Login weckt ihn)',
  wake: 'wurde aufgeweckt und startet',
  test: 'Testnachricht der Homelab-Zentrale',
};

/** Characters Discord renders as markup; names are plain, but stay on the safe side. */
const MARKUP = /[*_~`|>@#<:[\]()\\]/g;

/**
 * Message text: only game name, template name, the external address the admin
 * entered (never a Tailscale IP, never the server name) and the player count.
 */
export function discordMessage(
  s: Pick<GameSummary, 'name' | 'game' | 'externalAddress' | 'ports' | 'players'>,
  event: GameNotifyEvent | 'test',
): string {
  const parts = [
    `${s.name.replace(MARKUP, '')} (${s.game.replace(MARKUP, '')}) ${EVENT_TEXT[event]}`,
  ];
  const ext = s.externalAddress.trim();
  if (ext !== '' && !hasTailnetAddress(ext)) {
    const port = s.ports[0]?.port;
    parts.push(`Adresse: ${port === undefined ? ext : `${ext}:${port}`}`);
  }
  if (event === 'online' && s.players) parts.push(`Spieler: ${s.players.online}/${s.players.max}`);
  return parts.join(' · ').slice(0, 1900);
}

const eventsOf = (json: string): GameNotifyEvent[] => {
  try {
    const p = z.array(gameNotifyEventSchema).safeParse(JSON.parse(json));
    return p.success ? p.data : [];
  } catch {
    return [];
  }
};

/**
 * Discord webhook per game server (SPEC 6.5). The URL is a secret: stored with
 * AES-256-GCM, never logged, never returned (only `discordSet`), never in an
 * error text. Only discord.com / discordapp.com webhook URLs are accepted and
 * re-checked before every send; redirects are refused.
 */
export class GameNotifier {
  private readonly background = new Set<Promise<unknown>>();

  constructor(
    private readonly deps: {
      db: Db;
      box: SecretBox;
      now: Clock;
      games: GameService;
      log: FastifyBaseLogger;
      fetch?: FetchLike;
    },
  ) {
    deps.games.onLifecycle((id, event) => this.onLifecycle(id, event));
  }

  private row(gameId: string): GameNotifyRow | undefined {
    return this.deps.db.select().from(gameNotify).where(eq(gameNotify.gameId, gameId)).get();
  }

  get(gameId: string): GameNotify {
    const r = this.row(gameId);
    return gameNotifySchema.parse({
      discordSet: r?.webhookEnc != null,
      events: r ? eventsOf(r.eventsJson) : [],
      lastSentAt: r?.lastSentAt == null ? null : new Date(r.lastSentAt).toISOString(),
      lastError: r?.lastError ?? null,
    });
  }

  /** `url` undefined keeps it, null removes it. */
  set(gameId: string, url: string | null | undefined, events: readonly GameNotifyEvent[]): void {
    const now = this.deps.now();
    const prev = this.row(gameId);
    let enc = prev?.webhookEnc ?? null;
    if (url === null) enc = null;
    else if (url !== undefined) {
      if (!discordWebhookUrlSchema.safeParse(url).success)
        throw new HttpError(400, 'invalid_input');
      enc = this.deps.box.encrypt(url, aad(gameId));
    }
    const values = {
      gameId,
      webhookEnc: enc,
      eventsJson: JSON.stringify([...new Set(events)]),
      lastSentAt: prev?.lastSentAt ?? null,
      lastError: url === undefined ? (prev?.lastError ?? null) : null,
      updatedAt: now,
    };
    this.deps.db
      .insert(gameNotify)
      .values(values)
      .onConflictDoUpdate({ target: gameNotify.gameId, set: values })
      .run();
  }

  private url(r: GameNotifyRow | undefined): string | null {
    if (!r?.webhookEnc) return null;
    let url: string;
    try {
      url = this.deps.box.decrypt(r.webhookEnc, aad(r.gameId));
    } catch {
      return null;
    }
    // Defense in depth: never send to anything but a Discord webhook.
    return discordWebhookUrlSchema.safeParse(url).success ? url : null;
  }

  private onLifecycle(id: string, event: GameLifecycleEvent): void {
    const r = this.row(id);
    if (!r?.webhookEnc || !eventsOf(r.eventsJson).includes(event)) return;
    const p = this.send(id, event).catch(() => false);
    this.background.add(p);
    void p.finally(() => this.background.delete(p));
  }

  /** Sends one message. Returns whether Discord accepted it; errors are stored as text. */
  async send(gameId: string, event: GameNotifyEvent | 'test'): Promise<boolean> {
    const r = this.row(gameId);
    const url = this.url(r);
    const summary = this.deps.games.summary(gameId);
    if (url === null || !summary) throw new HttpError(409, 'conflict');
    const body = JSON.stringify({
      content: discordMessage(summary, event),
      allowed_mentions: { parse: [] },
    });
    let error: string | null = null;
    try {
      const res = await (this.deps.fetch ?? fetch)(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
      });
      await res.body?.cancel().catch(() => undefined);
      if (res.status < 200 || res.status > 299) error = `Discord antwortet ${res.status}`;
    } catch (err) {
      error =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
          ? 'Discord antwortet nicht (Zeitüberschreitung)'
          : 'Discord nicht erreichbar';
    }
    // Never the URL, the body or the error object: only the game and the outcome.
    this.deps.log.info({ gameId, event, ok: error === null }, 'discord notification');
    this.deps.db
      .update(gameNotify)
      .set(error === null ? { lastSentAt: this.deps.now(), lastError: null } : { lastError: error })
      .where(eq(gameNotify.gameId, gameId))
      .run();
    return error === null;
  }

  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }
}
