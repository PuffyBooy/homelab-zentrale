import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { auditLog, shareAudit } from '../src/db/schema.js';
import { COMMAND_DEFINITIONS, DISCORD_GAME_COOLDOWN_MS, TEXT } from '../src/discord/service.js';
import { DISCORD_API } from '../src/discord/rest.js';
import { stepUp, until, type WsClient } from './agent-helpers.js';
import {
  bindLink,
  closeBot,
  command,
  freshMetrics,
  getState,
  put,
  setupBot as setupBotWith,
  type BotSetup,
} from './discord-bot-helpers.js';
import {
  APP_ID,
  BOT_TOKEN,
  FRIEND_ID,
  GUILD_ID,
  interaction,
  OTHER_GUILD,
  STRANGER_ID,
} from './discord-helpers.js';
import { gameRequest, rpcsOf } from './games-helpers.js';
import { createShare, friend } from './share-helpers.js';

const clients: WsClient[] = [];
let current: BotSetup | undefined;
afterEach(async () => {
  await closeBot(current);
  current = undefined;
  for (const c of clients.splice(0)) c.ws.terminate();
});

const setupBot = (opts: Parameters<typeof setupBotWith>[1] = {}) =>
  setupBotWith(clients, opts, (b) => {
    current = b;
  });

async function stopGame(b: BotSetup): Promise<void> {
  const res = await gameRequest(b.s, 'POST', `/api/games/${b.game.id}/stop`);
  expect(res.statusCode).toBe(200);
}

describe('discord bot: settings and connection', () => {
  it('starts unconfigured, connects with token, application and guild, registers commands', async () => {
    const b = await setupBot({ configure: false });
    expect((await getState(b)).status).toBe('unconfigured');
    await stepUp(b.s.t, b.s.secret, b.s.cookie);
    const res = await put(b, '/api/discord-bot', {
      token: BOT_TOKEN,
      applicationId: APP_ID,
      guildId: GUILD_ID,
    });
    expect(res.statusCode).toBe(200);
    await until(() => b.bot.service.state().status === 'online');
    const st = await getState(b);
    expect(st).toMatchObject({
      tokenSet: true,
      applicationId: APP_ID,
      guildId: GUILD_ID,
      status: 'online',
      statusText: 'Verbunden als Zentrale',
    });
    const reg = b.rest.calls.find((c) => c.method === 'PUT');
    expect(reg?.url).toBe(`${DISCORD_API}/applications/${APP_ID}/guilds/${GUILD_ID}/commands`);
    expect((reg?.body as { name: string }[]).map((c) => c.name)).toEqual([
      'status',
      'start',
      'stop',
      'restart',
    ]);
    expect(reg?.body).toEqual(COMMAND_DEFINITIONS);
    // Every REST call went to discord.com only.
    expect(b.rest.calls.every((c) => c.url.startsWith(`${DISCORD_API}/`))).toBe(true);
  });

  it('keeps the token when only application or guild change', async () => {
    const b = await setupBot();
    await stepUp(b.s.t, b.s.secret, b.s.cookie);
    const res = await put(b, '/api/discord-bot', {
      applicationId: APP_ID,
      guildId: '666666666666666666',
    });
    expect(res.statusCode).toBe(200);
    await until(() => b.bot.service.state().status === 'online');
    const st = await getState(b);
    expect(st.tokenSet).toBe(true);
    expect(st.guildId).toBe('666666666666666666');
    expect(b.gw.connections).toBe(2);
  });

  it('guild missing: error "Server-ID (Guild) fehlt" without connecting', async () => {
    const b = await setupBot({ configure: false });
    await stepUp(b.s.t, b.s.secret, b.s.cookie);
    const res = await put(b, '/api/discord-bot', {
      token: BOT_TOKEN,
      applicationId: APP_ID,
      guildId: null,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'error', statusText: 'Server-ID (Guild) fehlt' });
    expect(b.gw.connections).toBe(0);
  });

  it('a token null deletes the token and disconnects', async () => {
    const b = await setupBot();
    await stepUp(b.s.t, b.s.secret, b.s.cookie);
    const res = await put(b, '/api/discord-bot', {
      token: null,
      applicationId: APP_ID,
      guildId: GUILD_ID,
    });
    expect(res.json()).toMatchObject({ tokenSet: false, status: 'unconfigured' });
    await until(() => b.gw.sockets.size === 0);
  });

  it('module off disconnects, on reconnects', async () => {
    const b = await setupBot();
    b.bot.setEnabled(false);
    expect(b.bot.service.state()).toMatchObject({ status: 'off' });
    await until(() => b.gw.sockets.size === 0);
    b.bot.setEnabled(true);
    await until(() => b.bot.service.state().status === 'online');
    expect(b.gw.connections).toBe(2);
  });

  it('command registration refused: error status with a hint', async () => {
    const b = await setupBot({ configure: false });
    b.rest.commandsStatus = 403;
    await stepUp(b.s.t, b.s.secret, b.s.cookie);
    await put(b, '/api/discord-bot', {
      token: BOT_TOKEN,
      applicationId: APP_ID,
      guildId: GUILD_ID,
    });
    await until(() => b.bot.service.state().status === 'error');
    expect(b.bot.service.state().statusText).toMatch(/Befehle konnten nicht registriert werden/);
  });
});

describe('discord bot: bindings', () => {
  it('lists every link with power or restart, binds and unbinds', async () => {
    const b = await setupBot();
    const power = await createShare(b.s, b.game.id, { person: 'Lena', perms: ['power'] });
    const restart = await createShare(b.s, b.game.id, { person: 'Max', perms: ['restart'] });
    await createShare(b.s, b.game.id, { person: 'Nur Konsole', perms: ['console_read'] });
    let st = await getState(b);
    expect(st.bindings.map((x) => x.person)).toEqual(['Lena', 'Max']);
    st = await bindLink(b, power.id);
    expect(st.bindings.find((x) => x.shareId === power.id)).toMatchObject({
      gameId: b.game.id,
      gameName: 'survival',
      discordUserId: FRIEND_ID,
      shareState: 'active',
    });
    expect(st.bindings.find((x) => x.shareId === restart.id)?.discordUserId).toBeNull();
    st = await bindLink(b, power.id, null);
    expect(st.bindings.every((x) => x.discordUserId === null)).toBe(true);
    const audit = b.s.t.db.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'discordbot.binding'))
      .all();
    expect(audit).toHaveLength(2);
  });

  it('bindings of deleted links disappear', async () => {
    const b = await setupBot();
    const link = await createShare(b.s, b.game.id, { perms: ['power'] });
    await bindLink(b, link.id);
    await stepUp(b.s.t, b.s.secret, b.s.cookie);
    expect((await gameRequest(b.s, 'POST', `/api/shares/${link.id}/revoke`)).statusCode).toBe(200);
    expect((await gameRequest(b.s, 'DELETE', `/api/shares/${link.id}`)).statusCode).toBe(200);
    const st = await getState(b);
    expect(st.bindings).toEqual([]);
    expect(
      b.s.t.db.sqlite
        .prepare("SELECT value_json AS v FROM settings WHERE key = 'discordbot.bindings'")
        .get(),
    ).toEqual({ v: '{}' });
  });
});

describe('discord bot: commands', () => {
  it('/status lists the friend-safe status of the bound games, ephemeral, no mentions', async () => {
    const b = await setupBot();
    const link = await createShare(b.s, b.game.id, { perms: ['power'] });
    await bindLink(b, link.id);
    const text = await command(b, interaction('status'));
    expect(text).toBe('survival: Läuft, 2/20 Spieler');
    const cb = b.rest.callbacks().at(-1);
    expect(cb).toMatchObject({ type: 4, data: { flags: 64, allowed_mentions: { parse: [] } } });
    // Never internal data: no Tailscale address, server name or container id.
    expect(text).not.toMatch(/100\.|heimserver|ts\.net/);
  });

  it('/start with power starts through the share link (audit, share audit via discord)', async () => {
    const b = await setupBot();
    const link = await createShare(b.s, b.game.id, { perms: ['power'] });
    await bindLink(b, link.id);
    await stopGame(b);
    await freshMetrics(b.s);
    const ups = rpcsOf(b.s, 'compose.up').length;
    const text = await command(b, interaction('start', { spiel: 'Survival' }));
    expect(text).toMatch(/^survival: Start ausgeführt\. Status: /);
    expect(rpcsOf(b.s, 'compose.up').length).toBe(ups + 1);
    // Deferred first (type 5, ephemeral), then the edit.
    const cbs = b.rest.callbacks();
    expect(cbs.at(-1)).toEqual({ type: 5, data: { flags: 64 } });
    expect(b.rest.edits().at(-1)?.allowed_mentions).toEqual({ parse: [] });
    const sa = b.s.t.db.db
      .select()
      .from(shareAudit)
      .where(and(eq(shareAudit.shareId, link.id), eq(shareAudit.action, 'start')))
      .all();
    expect(sa).toHaveLength(1);
    expect(sa[0]?.via).toBe('discord');
    const al = b.s.t.db.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'game.start'))
      .all()
      .at(-1);
    expect(al?.actor).toBe(`share:${link.id}`);
  });

  it('/stop and /restart need the rights of the link', async () => {
    const b = await setupBot();
    const link = await createShare(b.s, b.game.id, { perms: ['restart'] });
    await bindLink(b, link.id);
    const downs = rpcsOf(b.s, 'compose.down').length;
    expect(await command(b, interaction('stop', { spiel: 'survival' }))).toBe(TEXT.forbidden);
    expect(rpcsOf(b.s, 'compose.down').length).toBe(downs);
    const denied = b.s.t.db.db
      .select()
      .from(shareAudit)
      .where(and(eq(shareAudit.shareId, link.id), eq(shareAudit.action, 'denied')))
      .all();
    expect(denied).toHaveLength(1);
    expect(denied[0]?.via).toBe('discord');
    // restart is allowed for a running game.
    expect(await command(b, interaction('restart', { spiel: 'survival' }))).toMatch(
      /^survival: Neustart ausgeführt/,
    );
    expect(rpcsOf(b.s, 'container.restart')).toHaveLength(1);
  });

  it('unknown game names and games of other links are refused', async () => {
    const b = await setupBot();
    const link = await createShare(b.s, b.game.id, { perms: ['power'] });
    await bindLink(b, link.id);
    expect(await command(b, interaction('stop', { spiel: 'creative' }))).toBe(TEXT.unknownGame);
    expect(await command(b, interaction('stop', { spiel: '' }))).toBe(TEXT.noGame);
  });

  it('an unbound user gets "kein Zugang"', async () => {
    const b = await setupBot();
    const link = await createShare(b.s, b.game.id, { perms: ['power'] });
    await bindLink(b, link.id);
    expect(await command(b, interaction('status', { user: STRANGER_ID }))).toBe(TEXT.noAccess);
    expect(await command(b, interaction('stop', { user: STRANGER_ID, spiel: 'survival' }))).toBe(
      TEXT.noAccess,
    );
  });

  it('interactions from another guild, a DM or another application are ignored', async () => {
    const b = await setupBot();
    const link = await createShare(b.s, b.game.id, { perms: ['power'] });
    await bindLink(b, link.id);
    const before = b.rest.calls.length;
    await command(b, interaction('status', { guild: OTHER_GUILD }), false);
    await command(b, interaction('status', { guild: null }), false);
    await command(b, interaction('status', { app: '777777777777777777' }), false);
    await command(b, interaction('status', { type: 4 }), false);
    await command(b, { id: 'not-a-snowflake', type: 2 }, false);
    expect(b.rest.calls.length).toBe(before);
  });

  it('a revoked or expired link no longer works', async () => {
    const b = await setupBot();
    const day = await createShare(b.s, b.game.id, { perms: ['power'], expires: '1d' });
    await bindLink(b, day.id);
    expect(await command(b, interaction('status'))).toMatch(/^survival:/);
    b.s.t.clock.advance(24 * 60 * 60_000 + 1);
    await b.s.keepAlive();
    expect(await command(b, interaction('status'))).toBe(TEXT.noAccess);

    const b2 = await createShare(b.s, b.game.id, { perms: ['power'] });
    await bindLink(b, b2.id);
    expect(await command(b, interaction('status'))).toMatch(/^survival:/);
    await stepUp(b.s.t, b.s.secret, b.s.cookie);
    expect((await gameRequest(b.s, 'POST', `/api/shares/${b2.id}/revoke`)).statusCode).toBe(200);
    expect(await command(b, interaction('stop', { spiel: 'survival' }))).toBe(TEXT.noAccess);
  });

  it('per-user rate limit and per-game cooldown', async () => {
    const b = await setupBot();
    const link = await createShare(b.s, b.game.id, { perms: ['power'] });
    await bindLink(b, link.id);
    expect(await command(b, interaction('stop', { spiel: 'survival' }))).toMatch(/Gestoppt/);
    await freshMetrics(b.s);
    expect(await command(b, interaction('start', { spiel: 'survival' }))).toMatch(
      /^Gerade erst ausgeführt/,
    );
    for (let i = 0; i < 3; i += 1) await command(b, interaction('status'));
    expect(await command(b, interaction('status'))).toMatch(/^Zu viele Befehle/);
    b.s.t.clock.advance(Math.max(60_000, DISCORD_GAME_COOLDOWN_MS) + 1);
    await freshMetrics(b.s);
    expect(await command(b, interaction('start', { spiel: 'survival' }))).toMatch(
      /Start ausgeführt/,
    );
  });

  it('games module off: friendly refusal, nothing runs', async () => {
    const b = await setupBot();
    const link = await createShare(b.s, b.game.id, { perms: ['power'] });
    await bindLink(b, link.id);
    b.s.t.app.hzCore.games.setEnabled(false);
    const downs = rpcsOf(b.s, 'compose.down').length;
    expect(await command(b, interaction('stop', { spiel: 'survival' }))).toBe(TEXT.gamesOff);
    expect(rpcsOf(b.s, 'compose.down').length).toBe(downs);
  });

  it('a PIN link works for the bound user only through the binding', async () => {
    const b = await setupBot();
    const link = await createShare(b.s, b.game.id, { perms: ['power'], pin: '4711' });
    await bindLink(b, link.id);
    expect(await command(b, interaction('stop', { spiel: 'survival' }))).toMatch(/Gestoppt/);
    // The friend API still wants the PIN, and the share id is no token.
    expect((await friend(b.s, 'GET', 'status', { token: link.token })).statusCode).toBe(401);
    expect((await friend(b.s, 'GET', 'status', { token: link.id })).statusCode).toBe(404);
  });
});
