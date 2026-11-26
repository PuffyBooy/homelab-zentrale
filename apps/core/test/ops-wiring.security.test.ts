import { afterEach, describe, expect, it } from 'vitest';
import { stepUp, until } from './agent-helpers.js';
import { APP_ID, BOT_TOKEN, GUILD_ID } from './discord-helpers.js';
import { authHeaders, completeSetup, makeApp, type TestApp } from './helpers.js';

/** Discord bot and voice wired into the real app (app.ts). */

let t: TestApp | undefined;
afterEach(async () => {
  await t?.app.close();
  t = undefined;
});

describe('discord bot and voice in the app', () => {
  it('switching discordbot or voice on needs step-up', async () => {
    t = await makeApp({ modules: 'fresh' });
    const { cookie, secret } = await completeSetup(t);
    t.clock.advance(16 * 60_000);
    for (const m of ['discordbot', 'voice']) {
      const res = await t.app.inject({
        method: 'PUT',
        url: '/api/settings/modules',
        headers: authHeaders(cookie),
        payload: { [m]: true },
      });
      expect(res.statusCode, m).toBe(403);
      expect(res.json()).toMatchObject({ error: 'step_up_required' });
    }
    await stepUp(t, secret, cookie);
    const ok = await t.app.inject({
      method: 'PUT',
      url: '/api/settings/modules',
      headers: authHeaders(cookie),
      payload: { discordbot: true, voice: true },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ discordbot: true, voice: true });
    const v = await t.app.inject({
      method: 'GET',
      url: '/api/voice',
      headers: authHeaders(cookie),
    });
    expect(v.statusCode).toBe(200);
    expect(v.json()).toMatchObject({ haReady: false });
  });

  it('the bot token reaches only discord.com and never a log line or response', async () => {
    const calls: { url: string; auth: string | null }[] = [];
    t = await makeApp({
      captureLogs: true,
      modules: { discordbot: true },
      discordFetch: (url, init) => {
        const h = new Headers(init.headers);
        calls.push({ url, auth: h.get('authorization') });
        return Promise.resolve(new Response('{"message":"401: Unauthorized"}', { status: 401 }));
      },
    });
    const { cookie, secret } = await completeSetup(t);
    await stepUp(t, secret, cookie);
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/discord-bot',
      headers: authHeaders(cookie),
      payload: { token: BOT_TOKEN, applicationId: APP_ID, guildId: GUILD_ID },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(BOT_TOKEN);
    await until(() => calls.length > 0);
    let status = '';
    for (let i = 0; i < 50 && status !== 'error'; i++) {
      const s = await t.app.inject({
        method: 'GET',
        url: '/api/discord-bot',
        headers: authHeaders(cookie),
      });
      status = s.json<{ status: string }>().status;
      if (status !== 'error') await new Promise((r) => setTimeout(r, 20));
    }
    expect(status).toBe('error');
    for (const c of calls) expect(c.url.startsWith('https://discord.com/api/v10/')).toBe(true);
    await t.app.close();
    const all = t.logs.join('\n');
    expect(all).not.toContain(BOT_TOKEN);
    expect(all).not.toContain(BOT_TOKEN.slice(-20));
    t = undefined;
  });

  it('module off: discord and voice routes answer 404 module_disabled', async () => {
    t = await makeApp({ modules: { discordbot: false, voice: false } });
    const { cookie } = await completeSetup(t);
    for (const url of ['/api/discord-bot', '/api/voice']) {
      const res = await t.app.inject({ method: 'GET', url, headers: authHeaders(cookie) });
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toMatchObject({ error: 'module_disabled' });
    }
  });
});
