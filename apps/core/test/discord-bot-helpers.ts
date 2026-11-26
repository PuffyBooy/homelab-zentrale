import { expect } from 'vitest';
import { discordBotStateSchema, type DiscordBotState, type GameSummary } from '@hz/shared';
import { setupDiscordBot, type DiscordBotHandle } from '../src/discord/index.js';
import { metricsMsg, stepUp, until, type WsClient } from './agent-helpers.js';
import {
  APP_ID,
  BOT_TOKEN,
  box,
  FakeGateway,
  FakeRest,
  FRIEND_ID,
  GUILD_ID,
  sideApp,
  type SideApp,
} from './discord-helpers.js';
import { readyGame, withGames, type GameSetup } from './games-helpers.js';
import { authHeaders } from './helpers.js';

export interface BotSetup {
  s: GameSetup;
  game: GameSummary;
  gw: FakeGateway;
  rest: FakeRest;
  side: SideApp;
  bot: DiscordBotHandle;
}

export async function closeBot(b: BotSetup | undefined): Promise<void> {
  if (!b) return;
  b.bot.shutdown();
  await b.side.app.close();
  await b.gw.stop();
  await b.s.t.app.close();
}

export async function setupBot(
  clients: WsClient[],
  opts: { configure?: boolean; captureLogs?: boolean } = {},
  onCreate: (b: BotSetup) => void = () => undefined,
): Promise<BotSetup> {
  const s = await withGames(clients, { captureLogs: opts.captureLogs ?? false });
  const game = await readyGame(s);
  const gw = new FakeGateway();
  await gw.start();
  const rest = new FakeRest();
  let bot: DiscordBotHandle | undefined;
  const side = await sideApp(s.t, async (app) => {
    bot = await setupDiscordBot(app, {
      db: s.t.db.db,
      box: box(),
      now: () => s.t.clock.t,
      log: app.log,
      shares: s.t.app.hzCore.shares,
      games: s.t.app.hzCore.games,
      fetch: rest.fetch,
      wsFactory: gw.factory,
      gatewayOptions: { backoffBaseMs: 20, backoffMaxMs: 100 },
    });
  });
  if (!bot) throw new Error('no bot');
  const b: BotSetup = { s, game, gw, rest, side, bot };
  onCreate(b);
  bot.setEnabled(true);
  if (opts.configure !== false) {
    await stepUp(s.t, s.secret, s.cookie);
    const res = await put(b, '/api/discord-bot', {
      token: BOT_TOKEN,
      applicationId: APP_ID,
      guildId: GUILD_ID,
    });
    if (res.statusCode !== 200) throw new Error(`settings ${res.statusCode} ${res.body}`);
    await until(() => bot?.service.state().status === 'online');
  }
  return b;
}

export function put(b: BotSetup, url: string, payload: unknown) {
  return b.side.app.inject({
    method: 'PUT',
    url,
    headers: authHeaders(b.s.cookie),
    payload: payload as Record<string, unknown>,
  });
}

export async function getState(b: BotSetup): Promise<DiscordBotState> {
  const res = await b.side.app.inject({
    method: 'GET',
    url: '/api/discord-bot',
    headers: authHeaders(b.s.cookie),
  });
  expect(res.statusCode).toBe(200);
  return discordBotStateSchema.parse(res.json());
}

export async function bindLink(b: BotSetup, shareId: string, user: string | null = FRIEND_ID) {
  const res = await put(b, `/api/discord-bot/bindings/${shareId}`, { discordUserId: user });
  expect(res.statusCode).toBe(200);
  return discordBotStateSchema.parse(res.json());
}

/** Sends an interaction and waits until it is handled (reply or nothing). */
export async function command(
  b: BotSetup,
  d: Record<string, unknown>,
  expectReply = true,
): Promise<string | null> {
  const before = b.rest.calls.length;
  b.gw.dispatch('INTERACTION_CREATE', d);
  if (expectReply) {
    await until(() => b.rest.calls.slice(before).some((c) => c.url.includes(`/${String(d.id)}/`)));
  } else {
    await new Promise((r) => setTimeout(r, 80));
  }
  await b.bot.idle();
  const mine = b.rest.calls.slice(before);
  const edit = mine.find((c) => c.method === 'PATCH');
  if (edit) return (edit.body as { content: string }).content;
  const cb = mine.find((c) => c.url.endsWith('/callback'));
  return cb ? ((cb.body as { data: { content?: string } }).data.content ?? null) : null;
}

/** Fresh metrics, so the RAM reserve check of a friend's start is not "unknown". */
export async function freshMetrics(s: GameSetup): Promise<void> {
  s.agent.send(metricsMsg({ ramPct: 40 }));
  await s.keepAlive();
}
