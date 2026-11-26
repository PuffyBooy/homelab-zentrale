import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { stepUp, until, type WsClient } from './agent-helpers.js';
import {
  bindLink,
  closeBot,
  command,
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
  OTHER_BOT_TOKEN,
} from './discord-helpers.js';
import { DISCORD_API } from '../src/discord/rest.js';
import { DISCORD_BINDING_LIMIT } from '../src/discord/routes.js';
import { authHeaders, SAME_ORIGIN } from './helpers.js';
import { createShare } from './share-helpers.js';

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

const dropStepUp = (b: BotSetup) =>
  b.s.t.db.sqlite.prepare('UPDATE sessions SET step_up_until = NULL').run();

const settings = { token: BOT_TOKEN, applicationId: APP_ID, guildId: GUILD_ID };

describe('discord bot: auth and step-up', () => {
  it('every route needs the admin session', async () => {
    const b = await setupBot({ configure: false });
    const app = b.side.app;
    expect((await app.inject({ method: 'GET', url: '/api/discord-bot' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/discord-bot',
          headers: SAME_ORIGIN,
          payload: settings,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/discord-bot/bindings/abcdefgh12',
          headers: SAME_ORIGIN,
          payload: { discordUserId: null },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('PUT /api/discord-bot needs step-up, also for changing only the guild', async () => {
    const b = await setupBot({ configure: false });
    const res = await put(b, '/api/discord-bot', settings);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'step_up_required' });
    const noToken = await put(b, '/api/discord-bot', { applicationId: APP_ID, guildId: GUILD_ID });
    expect(noToken.statusCode).toBe(403);
    expect((await getState(b)).tokenSet).toBe(false);
    expect(b.gw.connections).toBe(0);
  });

  it('a cross-site PUT is refused (Origin)', async () => {
    const b = await setupBot({ configure: false });
    await stepUp(b.s.t, b.s.secret, b.s.cookie);
    const res = await b.side.app.inject({
      method: 'PUT',
      url: '/api/discord-bot',
      headers: { ...authHeaders(b.s.cookie), origin: 'https://evil.example' },
      payload: settings,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'bad_origin' });
  });

  it('invalid input is 400 without echo', async () => {
    const b = await setupBot({ configure: false });
    await stepUp(b.s.t, b.s.secret, b.s.cookie);
    for (const payload of [
      { ...settings, token: 'kurz' },
      { ...settings, token: `${BOT_TOKEN} ` },
      { ...settings, applicationId: '123' },
      { ...settings, guildId: 'abc' },
      { ...settings, extra: true },
    ]) {
      const res = await put(b, '/api/discord-bot', payload);
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain(BOT_TOKEN);
    }
  });

  it('binding a user needs step-up, unbinding does not; 404 unknown link, 400 for links without power/restart', async () => {
    const b = await setupBot();
    const power = await createShare(b.s, b.game.id, { perms: ['power'] });
    const consoleOnly = await createShare(b.s, b.game.id, { perms: ['console_read'] });
    dropStepUp(b);
    // Without step-up: binding is refused and changes nothing.
    const denied = await put(b, `/api/discord-bot/bindings/${power.id}`, {
      discordUserId: FRIEND_ID,
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: 'step_up_required' });
    const bound = () =>
      b.bot.service.state().bindings.find((x) => x.shareId === power.id)?.discordUserId;
    expect(bound()).toBeNull();
    // Invalid input is still 400 (validated before the step-up check).
    const invalid = await put(b, `/api/discord-bot/bindings/${consoleOnly.id}`, {
      discordUserId: '<@everyone>',
    });
    expect(invalid.statusCode).toBe(400);
    // With step-up: binds; 404 unknown link, 400 for a link without power/restart.
    await stepUp(b.s.t, b.s.secret, b.s.cookie);
    const unknown = await put(b, '/api/discord-bot/bindings/abcdefgh1234', {
      discordUserId: FRIEND_ID,
    });
    expect(unknown.statusCode).toBe(404);
    const bad = await put(b, `/api/discord-bot/bindings/${consoleOnly.id}`, {
      discordUserId: FRIEND_ID,
    });
    expect(bad.statusCode).toBe(400);
    expect(
      (await put(b, `/api/discord-bot/bindings/${power.id}`, { discordUserId: FRIEND_ID }))
        .statusCode,
    ).toBe(200);
    expect(bound()).toBe(FRIEND_ID);
    // Unbinding works without step-up.
    dropStepUp(b);
    const unbind = await put(b, `/api/discord-bot/bindings/${power.id}`, { discordUserId: null });
    expect(unbind.statusCode).toBe(200);
    expect(bound()).toBeNull();
  });

  it('binding changes are rate limited per session (429)', async () => {
    const b = await setupBot();
    const power = await createShare(b.s, b.game.id, { perms: ['power'] });
    for (let i = 0; i < DISCORD_BINDING_LIMIT; i += 1) {
      const res = await put(b, `/api/discord-bot/bindings/${power.id}`, { discordUserId: null });
      expect(res.statusCode).toBe(200);
    }
    const res = await put(b, `/api/discord-bot/bindings/${power.id}`, { discordUserId: null });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: 'rate_limited' });
  });
});

describe('discord bot: the token stays secret', () => {
  it('never in responses, logs, the audit log or the settings in plain text', async () => {
    const b = await setupBot({ captureLogs: true });
    const link = await createShare(b.s, b.game.id, { perms: ['power'] });
    await bindLink(b, link.id);
    await command(b, interaction('status'));
    const state = await b.side.app.inject({
      method: 'GET',
      url: '/api/discord-bot',
      headers: authHeaders(b.s.cookie),
    });
    expect(state.body).not.toContain(BOT_TOKEN);
    expect(Object.keys(state.json() as object)).not.toContain('token');
    const rows = b.s.t.db.sqlite.prepare('SELECT * FROM settings').all();
    expect(JSON.stringify(rows)).not.toContain(BOT_TOKEN);
    const audit = b.s.t.db.sqlite.prepare('SELECT * FROM audit_log').all();
    expect(JSON.stringify(audit)).not.toContain(BOT_TOKEN);
    expect(b.side.logs.length).toBeGreaterThan(0);
    expect(b.side.logs.join('\n')).not.toContain(BOT_TOKEN);
    expect(b.s.t.logs.join('\n')).not.toContain(BOT_TOKEN);
    // The interaction token (in the callback URL path) is not logged either.
    const tok = String(interaction('status').token).slice(0, 16);
    expect(b.side.logs.join('\n')).not.toContain(tok);
  });

  it('the bot token goes only to discord.com bot endpoints', async () => {
    const b = await setupBot();
    const link = await createShare(b.s, b.game.id, { perms: ['power'] });
    await bindLink(b, link.id);
    await command(b, interaction('stop', { spiel: 'survival' }));
    for (const c of b.rest.calls) {
      expect(c.url.startsWith(`${DISCORD_API}/`)).toBe(true);
      expect(c.redirect).toBe('error');
      const isBotEndpoint = c.url.includes('/gateway/bot') || c.url.includes('/applications/');
      if (isBotEndpoint) expect(c.headers.authorization).toBe(`Bot ${BOT_TOKEN}`);
      else expect(c.headers.authorization).toBeUndefined();
    }
  });

  it('an invalid token: "Token ungültig", no retries until the settings change', async () => {
    const b = await setupBot({ configure: false });
    b.gw.tokens.clear();
    b.gw.tokens.add(OTHER_BOT_TOKEN);
    await stepUp(b.s.t, b.s.secret, b.s.cookie);
    const res = await put(b, '/api/discord-bot', settings);
    expect(res.statusCode).toBe(200);
    await until(() => b.bot.service.state().status === 'error');
    expect(b.bot.service.state().statusText).toBe('Token ungültig');
    expect(res.body).not.toContain(BOT_TOKEN);
    await new Promise((r) => setTimeout(r, 200));
    expect(b.gw.connections).toBe(1);
    // A new token reconnects.
    b.gw.tokens.add(BOT_TOKEN);
    await put(b, '/api/discord-bot', settings);
    await until(() => b.bot.service.state().status === 'online');
  });
});

describe('discord bot: friend messages', () => {
  it('replies never mention anyone and never contain internal data', async () => {
    const b = await setupBot();
    const link = await createShare(b.s, b.game.id, { perms: ['power'] });
    await bindLink(b, link.id);
    await command(b, interaction('status'));
    await command(b, interaction('stop', { spiel: '@everyone' }));
    for (const c of b.rest.callbacks()) {
      if (c.type === 4) expect(c.data.allowed_mentions).toEqual({ parse: [] });
      expect(c.data.flags).toBe(64);
    }
    for (const text of b.rest.texts()) {
      expect(text).not.toContain('@everyone');
      expect(text).not.toMatch(/100\.\d+\.\d+\.\d+|ts\.net|heimserver/);
    }
  });
});

describe('discord bot: share context without token', () => {
  it('contextForLink is not used by the friend APIs (token + PIN there)', () => {
    for (const f of ['friend-routes.ts', 'routes.ts']) {
      const src = readFileSync(new URL(`../src/share/${f}`, import.meta.url), 'utf8');
      expect(src).not.toContain('contextForLink');
    }
  });

  it('contextForLink refuses revoked, expired, locked and unknown links', async () => {
    const b = await setupBot();
    const shares = b.s.t.app.hzCore.shares;
    const link = await createShare(b.s, b.game.id, { perms: ['power'], expires: '1d' });
    expect(shares.contextForLink(link.id, 'discord')).toMatchObject({ ip: null, via: 'discord' });
    expect(shares.contextForLink('abcdefgh1234', 'discord')).toBeNull();
    b.s.t.db.sqlite
      .prepare('UPDATE share_links SET locked_until = ? WHERE id = ?')
      .run(b.s.t.clock.t + 60_000, link.id);
    expect(shares.contextForLink(link.id, 'discord')).toBeNull();
    b.s.t.db.sqlite.prepare('UPDATE share_links SET locked_until = NULL WHERE id = ?').run(link.id);
    b.s.t.clock.advance(24 * 60 * 60_000 + 1);
    expect(shares.contextForLink(link.id, 'discord')).toBeNull();
    const other = await createShare(b.s, b.game.id, { perms: ['power'] });
    shares.revoke(other.id);
    expect(shares.contextForLink(other.id, 'discord')).toBeNull();
  });
});
