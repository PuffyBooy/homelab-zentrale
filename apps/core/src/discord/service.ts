import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import {
  DISCORD_COMMANDS,
  discordBindingSchema,
  discordBotStateSchema,
  snowflakeSchema,
  type DiscordBinding,
  type DiscordBotState,
  type SharePerm,
  type discordBotSettingsRequestSchema,
} from '@hz/shared';
import type { Clock } from '../clock.js';
import { DecryptError, type SecretBox } from '../crypto.js';
import type { Db } from '../db/index.js';
import { shareLinks, type ShareLinkRow } from '../db/schema.js';
import { readSetting, writeSetting } from '../db/settings.js';
import type { GameService } from '../games/service.js';
import { HttpError } from '../http/errors.js';
import { WindowLimiter } from '../share/limits.js';
import { shareErrorOf, type ShareContext, type ShareService } from '../share/service.js';
import {
  DiscordGateway,
  type GatewayDownReason,
  type GatewayOptions,
  type WsFactory,
} from './gateway.js';
import { DiscordRest, DiscordRestError, type DiscordMessage, type FetchLike } from './rest.js';

export const SETTINGS_KEY = 'discordbot.settings';
export const BINDINGS_KEY = 'discordbot.bindings';
const TOKEN_AAD = 'settings.discordbot.token';
/** Commands per Discord user and minute. */
export const DISCORD_USER_LIMIT = 5;
/** After a start/stop/restart from Discord the same game waits this long. */
export const DISCORD_GAME_COOLDOWN_MS = 30_000;
/** PUT settings waits this long for the first connection result. */
const SETTINGS_WAIT_MS = 5_000;
/** Ephemeral reply (only the friend sees it). */
const EPHEMERAL = 64;
const MAX_CONTENT = 1900;

export const TEXT = {
  noAccess: 'Du hast keinen Zugang. Frag den Admin nach einem Link.',
  gamesOff: 'Spiele sind gerade ausgeschaltet.',
  noGame: 'Gib den Namen des Spiels an.',
  unknownGame: 'Dieses Spiel ist nicht in deinen Links.',
  forbidden: 'Dafür hat dein Link keine Berechtigung.',
  busy: 'Der Server ist gerade beschäftigt. Versuch es gleich nochmal.',
  insufficientRam: 'Zu wenig Arbeitsspeicher frei. Frag den Admin.',
  unavailable: 'Der Server ist gerade nicht erreichbar.',
  rateLimited: 'Zu viele Aktionen. Versuch es später nochmal.',
  failed: 'Das hat nicht geklappt.',
} as const;

const STATUS_TEXT = {
  off: 'Modul aus',
  noToken: 'Bot-Token fehlt',
  noApp: 'Anwendungs-ID fehlt',
  noGuild: 'Server-ID (Guild) fehlt',
  connecting: 'Verbinde mit Discord',
  tokenUnreadable: 'Token nicht lesbar, bitte neu eintragen',
  appMismatch: 'Anwendungs-ID passt nicht zum Token',
  commandsFailed:
    'Befehle konnten nicht registriert werden (Bot im Server? Scope applications.commands?)',
} as const;

const DOWN_TEXT: Record<GatewayDownReason, string> = {
  auth_invalid: 'Token ungültig',
  fatal: 'Discord hat die Verbindung abgelehnt',
  bad_url: 'Unerwartete Gateway-Adresse',
  unreachable: 'Discord nicht erreichbar',
  closed: 'Verbindung unterbrochen',
};

const DONE_TEXT = {
  start: 'Start ausgeführt',
  stop: 'Gestoppt',
  restart: 'Neustart ausgeführt',
} as const;

const storedSettingsSchema = z.object({
  applicationId: snowflakeSchema.nullable().catch(null),
  guildId: snowflakeSchema.nullable().catch(null),
  tokenEnc: z.string().max(4096).nullable().catch(null),
});
type StoredSettings = z.infer<typeof storedSettingsSchema>;
const EMPTY: StoredSettings = { applicationId: null, guildId: null, tokenEnc: null };

const bindingsSchema = z.record(z.string().regex(/^[A-Za-z0-9_-]{8,64}$/), snowflakeSchema);

const optionSchema = z.object({
  name: z.string().max(32),
  type: z.number().int(),
  value: z.unknown().optional(),
});
/** Only the fields we use; anything else Discord sends is ignored. */
export const interactionSchema = z.object({
  id: snowflakeSchema,
  application_id: snowflakeSchema,
  type: z.number().int(),
  token: z.string().regex(/^[A-Za-z0-9._-]{20,500}$/),
  guild_id: snowflakeSchema.optional(),
  member: z.object({ user: z.object({ id: snowflakeSchema }) }).optional(),
  data: z
    .object({ name: z.string().max(32), options: z.array(optionSchema).max(25).optional() })
    .optional(),
});
type Interaction = z.infer<typeof interactionSchema>;
type Command = (typeof DISCORD_COMMANDS)[number];

const spielOption = {
  type: 3,
  name: 'spiel',
  description: 'Name des Spiels',
  required: true,
  max_length: 64,
};
/** Bulk overwrite body (guild commands, type 1 = slash command). */
export const COMMAND_DEFINITIONS = [
  { name: 'status', type: 1, description: 'Zeigt deine Spiele und ob sie laufen' },
  { name: 'start', type: 1, description: 'Startet ein Spiel', options: [spielOption] },
  { name: 'stop', type: 1, description: 'Stoppt ein Spiel', options: [spielOption] },
  { name: 'restart', type: 1, description: 'Startet ein Spiel neu', options: [spielOption] },
] as const;

const BIND_PERMS: readonly SharePerm[] = ['power', 'restart'];

function parsePerms(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const bindable = (row: ShareLinkRow): boolean =>
  parsePerms(row.permsJson).some((p) => (BIND_PERMS as readonly string[]).includes(p));

/** Text from Discord or the admin, safe inside a Discord message (no markdown, no mentions). */
function plain(text: string, max = 100): string {
  // eslint-disable-next-line no-control-regex
  const t = text.replace(/[\u0000-\u001f`*_~|>#@[\]()<\\]/g, '').trim();
  return t.length > max ? t.slice(0, max) : t;
}

export type DiscordSettingsRequest = z.output<typeof discordBotSettingsRequestSchema>;

export interface DiscordBotDeps {
  db: Db;
  box: SecretBox;
  now: Clock;
  log: FastifyBaseLogger;
  shares: ShareService;
  games: Pick<GameService, 'row' | 'enabled'>;
  /** Discord REST transport (tests: a fake). Only DISCORD_API is ever requested. */
  fetch?: FetchLike;
  /** Gateway WebSocket (tests: a local fake server). */
  wsFactory?: WsFactory;
  gatewayOptions?: GatewayOptions;
}

/**
 * Discord bot (module discordbot, api/ops.ts): outgoing Gateway connection,
 * guild slash commands /status /start /stop /restart for friends bound to share
 * links. Every action goes through ShareService with the link's rights (RAM
 * reserve, audit, share audit). No webhook endpoint: the hub stays private.
 */
export class DiscordBotService {
  private enabled = false;
  private gateway: DiscordGateway | null = null;
  private rest: DiscordRest | null = null;
  private status: DiscordBotState['status'] = 'off';
  private statusText: string = STATUS_TEXT.off;
  private appId: string | null = null;
  private guildId: string | null = null;
  private readonly userLimiter: WindowLimiter;
  private readonly cooldown = new Map<string, number>();
  private readonly background = new Set<Promise<unknown>>();
  private waiters: (() => void)[] = [];
  private lastOnlineText: string | null = null;

  constructor(private readonly deps: DiscordBotDeps) {
    this.userLimiter = new WindowLimiter(DISCORD_USER_LIMIT, 60_000, deps.now);
  }

  // ---- settings --------------------------------------------------------------------

  private stored(): StoredSettings {
    const p = storedSettingsSchema.safeParse(readSetting(this.deps.db, SETTINGS_KEY) ?? {});
    return p.success ? p.data : EMPTY;
  }

  private token(s: StoredSettings): string | null | 'unreadable' {
    if (s.tokenEnc === null) return null;
    try {
      return this.deps.box.decrypt(s.tokenEnc, TOKEN_AAD);
    } catch (err) {
      if (err instanceof DecryptError) return 'unreadable';
      throw err;
    }
  }

  /** token missing: keep; null: delete. applicationId/guildId are always set. */
  async updateSettings(
    body: DiscordSettingsRequest,
  ): Promise<{ tokenChanged: boolean; tokenCleared: boolean }> {
    const prev = this.stored();
    const next: StoredSettings = {
      applicationId: body.applicationId,
      guildId: body.guildId,
      tokenEnc:
        body.token === undefined
          ? prev.tokenEnc
          : body.token === null
            ? null
            : this.deps.box.encrypt(body.token, TOKEN_AAD),
    };
    writeSetting(this.deps.db, SETTINGS_KEY, next, this.deps.now());
    this.reconnect();
    await this.waitOutcome(SETTINGS_WAIT_MS);
    return { tokenChanged: typeof body.token === 'string', tokenCleared: body.token === null };
  }

  // ---- bindings --------------------------------------------------------------------

  private bindings(): Record<string, string> {
    const p = bindingsSchema.safeParse(readSetting(this.deps.db, BINDINGS_KEY) ?? {});
    return p.success ? { ...p.data } : {};
  }

  private writeBindings(b: Record<string, string>): void {
    writeSetting(this.deps.db, BINDINGS_KEY, b, this.deps.now());
  }

  /** Bindings of deleted links (or links that lost power/restart) are dropped here. */
  private liveBindings(): Record<string, string> {
    const all = this.bindings();
    const b = Object.fromEntries(
      Object.entries(all).filter(([shareId]) => {
        const row = this.deps.shares.row(shareId);
        return row !== undefined && bindable(row);
      }),
    );
    if (Object.keys(b).length !== Object.keys(all).length) this.writeBindings(b);
    return b;
  }

  bindingList(): DiscordBinding[] {
    const b = this.liveBindings();
    const rows = this.deps.db.select().from(shareLinks).all();
    const out: DiscordBinding[] = [];
    for (const row of rows) {
      if (!bindable(row)) continue;
      const game = this.deps.games.row(row.gameId);
      if (!game) continue;
      out.push(
        discordBindingSchema.parse({
          shareId: row.id,
          gameId: row.gameId,
          gameName: game.name,
          person: row.person,
          discordUserId: b[row.id] ?? null,
          shareState: this.deps.shares.linkState(row),
        }),
      );
    }
    out.sort(
      (a, c) =>
        a.gameName.localeCompare(c.gameName) ||
        a.person.localeCompare(c.person) ||
        a.shareId.localeCompare(c.shareId),
    );
    return out;
  }

  /** 404 unknown link, 400 link without power/restart or not active (binding). */
  bind(shareId: string, discordUserId: string | null): void {
    const row = this.deps.shares.row(shareId);
    if (!row) throw new HttpError(404, 'not_found');
    if (!bindable(row)) {
      throw new HttpError(
        400,
        'invalid_input',
        undefined,
        'Nur Links mit Start/Stopp oder Neustart lassen sich verknüpfen',
      );
    }
    const b = Object.fromEntries(
      Object.entries(this.liveBindings()).filter(([id]) => id !== shareId),
    );
    if (discordUserId !== null) {
      if (this.deps.shares.linkState(row) !== 'active') {
        throw new HttpError(400, 'invalid_input', undefined, 'Der Link ist nicht mehr aktiv');
      }
      b[shareId] = discordUserId;
    }
    this.writeBindings(b);
  }

  // ---- state -----------------------------------------------------------------------

  state(): DiscordBotState {
    const s = this.stored();
    return discordBotStateSchema.parse({
      tokenSet: s.tokenEnc !== null,
      applicationId: s.applicationId,
      guildId: s.guildId,
      status: this.status,
      statusText: this.statusText,
      bindings: this.bindingList(),
    });
  }

  private setStatus(status: DiscordBotState['status'], text: string): void {
    this.status = status;
    this.statusText = text.length > 200 ? text.slice(0, 200) : text;
    if (status !== 'connecting') this.wake();
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }

  /** Resolves once the connection is up, failed or off (or after `ms`). */
  waitOutcome(ms: number): Promise<void> {
    if (this.status !== 'connecting') return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref();
      this.waiters.push(done);
    });
  }

  // ---- lifecycle -------------------------------------------------------------------

  /** Module switch: on connects (if configured), off disconnects. */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    this.reconnect();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  private reconnect(): void {
    this.gateway?.stop();
    this.gateway = null;
    this.rest = null;
    if (!this.enabled) return this.setStatus('off', STATUS_TEXT.off);
    const s = this.stored();
    const token = this.token(s);
    if (token === 'unreadable') return this.setStatus('error', STATUS_TEXT.tokenUnreadable);
    if (token === null) return this.setStatus('unconfigured', STATUS_TEXT.noToken);
    if (s.applicationId === null) return this.setStatus('unconfigured', STATUS_TEXT.noApp);
    if (s.guildId === null) return this.setStatus('error', STATUS_TEXT.noGuild);
    this.appId = s.applicationId;
    this.guildId = s.guildId;
    const rest = new DiscordRest(token, this.deps.fetch ?? fetch);
    this.rest = rest;
    this.setStatus('connecting', STATUS_TEXT.connecting);
    const gw = new DiscordGateway(
      token,
      rest,
      {
        connecting: () => {
          if (this.gateway === gw && this.status !== 'online') {
            this.setStatus('connecting', STATUS_TEXT.connecting);
          }
        },
        ready: (info) => {
          if (this.gateway === gw) this.track(this.onReady(gw, rest, info));
        },
        resumed: () => {
          if (this.gateway === gw && this.status === 'connecting') {
            this.setStatus('online', this.lastOnlineText ?? 'Verbunden');
          }
        },
        interaction: (d) => {
          if (this.gateway === gw) this.track(this.onInteraction(rest, d));
        },
        down: (reason, willRetry) => {
          if (this.gateway !== gw) return;
          this.deps.log.info({ reason, willRetry }, 'discord gateway down');
          if (willRetry && reason === 'closed')
            this.setStatus('connecting', STATUS_TEXT.connecting);
          else this.setStatus('error', DOWN_TEXT[reason]);
        },
      },
      this.deps.wsFactory,
      this.deps.gatewayOptions,
    );
    this.gateway = gw;
    gw.start();
  }

  private async onReady(
    gw: DiscordGateway,
    rest: DiscordRest,
    info: { userName: string; applicationId: string | null },
  ): Promise<void> {
    const appId = this.appId;
    const guildId = this.guildId;
    if (appId === null || guildId === null) return;
    if (info.applicationId !== null && info.applicationId !== appId) {
      this.setStatus('error', STATUS_TEXT.appMismatch);
      return;
    }
    try {
      await rest.putGuildCommands(appId, guildId, [...COMMAND_DEFINITIONS]);
    } catch (err) {
      if (this.gateway !== gw) return;
      const status = err instanceof DiscordRestError ? err.status : 0;
      this.deps.log.info({ status }, 'discord command registration failed');
      this.setStatus('error', STATUS_TEXT.commandsFailed);
      return;
    }
    if (this.gateway !== gw) return;
    this.lastOnlineText = `Verbunden als ${plain(info.userName, 80)}`;
    this.deps.log.info('discord bot online');
    this.setStatus('online', this.lastOnlineText);
  }

  private track(p: Promise<unknown>): void {
    const t = p
      .catch((err: unknown) =>
        this.deps.log.error(
          { err: err instanceof Error ? { name: err.name } : 'error' },
          'discord handler failed',
        ),
      )
      .finally(() => this.background.delete(t));
    this.background.add(t);
  }

  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  shutdown(): void {
    this.gateway?.stop();
    this.gateway = null;
    this.rest = null;
  }

  // ---- interactions ----------------------------------------------------------------

  private message(content: string): DiscordMessage {
    const c = content.length > MAX_CONTENT ? content.slice(0, MAX_CONTENT) : content;
    return { content: c, flags: EPHEMERAL, allowed_mentions: { parse: [] } };
  }

  private async reply(rest: DiscordRest, i: Interaction, content: string): Promise<void> {
    try {
      await rest.callback(i.id, i.token, { type: 4, data: this.message(content) });
    } catch (err) {
      this.deps.log.info(
        { status: err instanceof DiscordRestError ? err.status : 0 },
        'discord reply failed',
      );
    }
  }

  /** Active links bound to this Discord user (a ShareContext each, via discord). */
  private contextsOf(userId: string): ShareContext[] {
    const out: ShareContext[] = [];
    for (const [shareId, uid] of Object.entries(this.liveBindings())) {
      if (uid !== userId) continue;
      const ctx = this.deps.shares.contextForLink(shareId, 'discord');
      if (ctx) out.push(ctx);
    }
    return out;
  }

  private gameName(ctx: ShareContext): string | null {
    return this.deps.games.row(ctx.link.gameId)?.name ?? null;
  }

  private statusReply(ctxs: ShareContext[]): string {
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const ctx of ctxs) {
      if (seen.has(ctx.link.gameId)) continue;
      seen.add(ctx.link.gameId);
      try {
        const st = this.deps.shares.status(ctx);
        const parts: string[] = [st.game.statusText];
        if (st.game.players) parts.push(`${st.game.players.online}/${st.game.players.max} Spieler`);
        if (st.game.address) parts.push(`Adresse: ${plain(st.game.address, 120)}`);
        lines.push(`${plain(st.game.name, 64)}: ${parts.join(', ')}`);
      } catch {
        const name = this.gameName(ctx);
        if (name) lines.push(`${plain(name, 64)}: ${TEXT.unavailable}`);
      }
    }
    return lines.length > 0 ? lines.join('\n') : TEXT.noAccess;
  }

  private errorText(err: unknown): string {
    switch (shareErrorOf(err).code) {
      case 'forbidden':
        return TEXT.forbidden;
      case 'busy':
        return TEXT.busy;
      case 'insufficient_ram':
        return TEXT.insufficientRam;
      case 'rate_limited':
        return TEXT.rateLimited;
      case 'not_found':
        return TEXT.unknownGame;
      case 'unavailable':
        return TEXT.unavailable;
      default:
        return TEXT.failed;
    }
  }

  private async onInteraction(rest: DiscordRest, raw: unknown): Promise<void> {
    const p = interactionSchema.safeParse(raw);
    if (!p.success) return;
    const i = p.data;
    // Only application commands, only ours, only from the configured guild.
    if (i.type !== 2 || i.application_id !== this.appId) return;
    if (this.guildId === null || i.guild_id !== this.guildId) return;
    const userId = i.member?.user.id;
    const name = i.data?.name;
    if (userId === undefined || name === undefined) return;
    if (!(DISCORD_COMMANDS as readonly string[]).includes(name)) return;
    const command = name as Command;
    const wait = this.userLimiter.hit(userId);
    if (wait !== null) {
      return this.reply(rest, i, `Zu viele Befehle. Versuch es in ${wait} s nochmal.`);
    }
    if (!this.deps.games.enabled) return this.reply(rest, i, TEXT.gamesOff);
    const ctxs = this.contextsOf(userId);
    if (ctxs.length === 0) return this.reply(rest, i, TEXT.noAccess);
    if (command === 'status') return this.reply(rest, i, this.statusReply(ctxs));

    const opt = i.data?.options?.find((o) => o.name === 'spiel')?.value;
    const wanted = typeof opt === 'string' ? opt.trim().toLowerCase() : '';
    if (wanted === '' || wanted.length > 64) return this.reply(rest, i, TEXT.noGame);
    const matching = ctxs.filter((c) => this.gameName(c)?.toLowerCase() === wanted);
    if (matching.length === 0) return this.reply(rest, i, TEXT.unknownGame);
    // Prefer a link with the right ShareService.action checks; else the first one,
    // whose denial ShareService records in the share audit.
    const need: SharePerm = command === 'restart' ? 'restart' : 'power';
    const ctx = matching.find((c) => c.perms.includes(need)) ?? (matching[0] as ShareContext);
    const gameId = ctx.link.gameId;
    const now = this.deps.now();
    const until = this.cooldown.get(gameId) ?? 0;
    if (until > now) {
      const s = Math.max(1, Math.ceil((until - now) / 1000));
      return this.reply(rest, i, `Gerade erst ausgeführt. Versuch es in ${s} s nochmal.`);
    }
    // Starts can take longer than Discord's 3 s: defer, then edit the reply.
    try {
      await rest.callback(i.id, i.token, { type: 5, data: { flags: EPHEMERAL } });
    } catch (err) {
      this.deps.log.info(
        { status: err instanceof DiscordRestError ? err.status : 0 },
        'discord defer failed',
      );
      return;
    }
    let text: string;
    try {
      const st = await this.deps.shares.action(ctx, command);
      this.cooldown.set(gameId, this.deps.now() + DISCORD_GAME_COOLDOWN_MS);
      for (const [k, v] of this.cooldown) if (v <= this.deps.now()) this.cooldown.delete(k);
      text = `${plain(st.game.name, 64)}: ${DONE_TEXT[command]}. Status: ${st.game.statusText}.`;
    } catch (err) {
      text = this.errorText(err);
    }
    try {
      if (this.appId === null) return;
      await rest.editOriginal(this.appId, i.token, this.message(text));
    } catch (err) {
      this.deps.log.info(
        { status: err instanceof DiscordRestError ? err.status : 0 },
        'discord reply failed',
      );
    }
  }
}
