import { afterEach, describe, expect, it } from 'vitest';
import { gameSchedulesResponseSchema, gameStatsResponseSchema } from '@hz/shared';
import { auditLog, gameNotify, gamePlayerSessions } from '../src/db/schema.js';
import { nextRun } from '../src/games/schedules.js';
import { cleanPlayerName, STATS_RETENTION_MS } from '../src/games/stats.js';
import { stepUp, type WsClient } from './agent-helpers.js';
import {
  gameRequest,
  ONLINE,
  readyGame,
  rpcsOf,
  tick,
  withGames,
  type GameSetup,
} from './games-helpers.js';
import { HOST, type TestApp } from './helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

async function setup(opts: Parameters<typeof withGames>[1] = {}): Promise<GameSetup> {
  const s = await withGames(clients, opts);
  t = s.t;
  return s;
}

const MIN = 60_000;
// T0 = Wed 2026-11-25 12:00 UTC = 13:00 in Europe/Vienna.
const WEBHOOK = `https://discord.com/api/webhooks/123456789/${'w'.repeat(40)}`;

function anon(s: GameSetup, method: 'GET' | 'PUT' | 'POST', url: string) {
  return s.t.app.inject({ method, url, headers: { host: HOST, origin: `https://${HOST}` } });
}

describe('schedules (M12)', () => {
  it('GET/PUT replaces the list, validates input, needs a session', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const url = `/api/games/${g.id}/schedules`;
    expect((await anon(s, 'GET', url)).statusCode).toBe(401);
    expect(
      (
        await gameRequest(s, 'PUT', url, {
          schedules: [{ kind: 'x', days: [1], time: '25:00', enabled: true }],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await gameRequest(s, 'PUT', url, {
          schedules: [{ kind: 'backup', days: [1, 1], time: '04:00', enabled: true }],
        })
      ).statusCode,
    ).toBe(400);
    const put = await gameRequest(s, 'PUT', url, {
      schedules: [
        { kind: 'backup', days: [3], time: '13:05', enabled: true },
        { kind: 'restart', days: [1, 5], time: '06:00', enabled: false },
      ],
    });
    expect(put.statusCode).toBe(200);
    const body = gameSchedulesResponseSchema.parse(put.json());
    expect(body.schedules).toHaveLength(2);
    expect(body.next[0]).toBe('2026-11-25T12:05:00.000Z');
    expect(body.next[1]).toBeNull();
    expect((await gameRequest(s, 'GET', url)).json()).toEqual(put.json());
  });

  it('nextRun uses HZ_TIMEZONE and ISO weekdays (7 = Sunday)', () => {
    const from = Date.UTC(2026, 10, 25, 12, 0); // Wednesday
    expect(new Date(nextRun({ days: [7], time: '19:00' }, from) ?? 0).toISOString()).toBe(
      '2026-11-29T18:00:00.000Z',
    );
  });

  it('restart: warns 5 and 1 minute before over RCON, then restarts; backup at its minute', async () => {
    const s = await setup();
    const g = await readyGame(s);
    await gameRequest(s, 'PUT', `/api/games/${g.id}/schedules`, {
      schedules: [
        { kind: 'restart', days: [3], time: '13:10', enabled: true },
        { kind: 'backup', days: [3], time: '13:12', enabled: true },
      ],
    });
    const says = () =>
      rpcsOf(s, 'game.rcon')
        .map((r) => (r.params as { command: string }).command)
        .filter((c) => c.startsWith('say '));
    for (let i = 0; i < 5; i += 1) await tick(s, MIN); // 13:05
    expect(says()).toEqual(['say Neustart in 5 Minuten']);
    for (let i = 0; i < 4; i += 1) await tick(s, MIN); // 13:09
    expect(says()).toEqual(['say Neustart in 5 Minuten', 'say Neustart in 1 Minute']);
    expect(rpcsOf(s, 'container.restart')).toHaveLength(0);
    await tick(s, MIN); // 13:10
    expect(rpcsOf(s, 'container.restart')).toHaveLength(1);
    const backups = rpcsOf(s, 'game.backup').length;
    await tick(s, MIN);
    await tick(s, MIN); // 13:12
    expect(rpcsOf(s, 'game.backup')).toHaveLength(backups + 1);
    const audit = s.t.db.db.select().from(auditLog).all();
    expect(audit.filter((a) => a.action === 'game.schedule_run')).toHaveLength(2);
  });

  it('a restart of a stopped game is skipped (never started)', async () => {
    const s = await setup();
    const g = await readyGame(s);
    await gameRequest(s, 'POST', `/api/games/${g.id}/stop`);
    await gameRequest(s, 'PUT', `/api/games/${g.id}/schedules`, {
      schedules: [{ kind: 'restart', days: [3], time: '13:02', enabled: true }],
    });
    const ups = rpcsOf(s, 'compose.up').length;
    for (let i = 0; i < 3; i += 1) await tick(s, MIN);
    expect(rpcsOf(s, 'compose.up')).toHaveLength(ups);
    expect(rpcsOf(s, 'container.restart')).toHaveLength(0);
    const audit = s.t.db.db.select().from(auditLog).all();
    expect(audit.find((a) => a.action === 'game.schedule_skipped')).toBeTruthy();
  });
});

describe('Discord webhook (M12)', () => {
  it('setting the URL needs step-up; the URL is never returned, logged or stored in plain', async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const s = await setup({
      captureLogs: true,
      gameFetch: async (url, init) => {
        sent.push({ url, init });
        return new Response(null, { status: 204 });
      },
    });
    const g = await readyGame(s, { externalAddress: 'mc.example.at' });
    const url = `/api/games/${g.id}/notify`;
    const payload = { discordWebhookUrl: WEBHOOK, events: ['online', 'offline'] };
    const denied = await gameRequest(s, 'PUT', url, payload);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: 'step_up_required' });
    await stepUp(s.t, s.secret, s.cookie);
    for (const bad of [
      'https://evil.example/api/webhooks/1/abc',
      'https://discord.com.evil.example/api/webhooks/1/abc',
      'http://discord.com/api/webhooks/1/abc',
    ]) {
      expect(
        (await gameRequest(s, 'PUT', url, { ...payload, discordWebhookUrl: bad })).statusCode,
      ).toBe(400);
    }
    const put = await gameRequest(s, 'PUT', url, payload);
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({
      discordSet: true,
      events: ['online', 'offline'],
      lastSentAt: null,
      lastError: null,
    });
    // Events alone need no step-up.
    s.t.clock.advance(20 * MIN);
    expect((await gameRequest(s, 'PUT', url, { events: ['offline'] })).statusCode).toBe(200);

    const test = await gameRequest(s, 'POST', `${url}/test`);
    expect(test.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(WEBHOOK);
    expect(sent[0]?.init.redirect).toBe('error');
    const body = JSON.parse(String(sent[0]?.init.body)) as {
      content: string;
      allowed_mentions: unknown;
    };
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.content).toContain('mc.example.at');
    expect(body.content).not.toMatch(/100\.64\./);

    await gameRequest(s, 'POST', `/api/games/${g.id}/stop`);
    await s.t.app.hzCore.gameNotifier.idle();
    expect(sent).toHaveLength(2);
    expect(JSON.parse(String(sent[1]?.init.body)).content).toContain('ist offline');

    const secretPart = WEBHOOK.split('/').pop() ?? '';
    const everything = [
      ...s.t.logs,
      JSON.stringify(s.t.db.db.select().from(auditLog).all()),
      JSON.stringify(s.t.db.db.select().from(gameNotify).all()),
      (await gameRequest(s, 'GET', url)).body,
    ].join('\n');
    expect(everything).not.toContain(secretPart);
  });

  it('a failing Discord: German error without the URL; no fetch to foreign hosts', async () => {
    const hosts: string[] = [];
    const s = await setup({
      gameFetch: async (url) => {
        hosts.push(new URL(url).host);
        return new Response('nope', { status: 404 });
      },
    });
    const g = await readyGame(s);
    await stepUp(s.t, s.secret, s.cookie);
    await gameRequest(s, 'PUT', `/api/games/${g.id}/notify`, {
      discordWebhookUrl: WEBHOOK,
      events: [],
    });
    expect((await gameRequest(s, 'POST', `/api/games/${g.id}/notify/test`)).json()).toEqual({
      ok: false,
    });
    const st = (await gameRequest(s, 'GET', `/api/games/${g.id}/notify`)).json<{
      lastError: string;
    }>();
    expect(st.lastError).toBe('Discord antwortet 404');
    expect(hosts).toEqual(['discord.com']);
    // Removing it needs step-up too, then test is 409.
    s.t.clock.advance(20 * MIN);
    expect(
      (
        await gameRequest(s, 'PUT', `/api/games/${g.id}/notify`, {
          discordWebhookUrl: null,
          events: [],
        })
      ).statusCode,
    ).toBe(403);
    await stepUp(s.t, s.secret, s.cookie);
    await gameRequest(s, 'PUT', `/api/games/${g.id}/notify`, {
      discordWebhookUrl: null,
      events: [],
    });
    expect((await gameRequest(s, 'POST', `/api/games/${g.id}/notify/test`)).statusCode).toBe(409);
  });
});

describe('player statistics (M12)', () => {
  it('sessions from the polls, hours, peak; names cleaned; query validated', async () => {
    const s = await setup();
    s.behaviour.status = {
      ...ONLINE,
      players: { online: 2, max: 20, names: ['steve', 'mia\u0007‮'] },
    };
    const g = await readyGame(s);
    for (let i = 0; i < 4; i += 1) await tick(s, 30_000);
    s.behaviour.status = { ...ONLINE, players: { online: 1, max: 20, names: ['steve'] } };
    for (let i = 0; i < 4; i += 1) await tick(s, 30_000);
    const res = await gameRequest(s, 'GET', `/api/games/${g.id}/stats?days=7`);
    expect(res.statusCode).toBe(200);
    const st = gameStatsResponseSchema.parse(res.json());
    expect(st.players.map((p) => p.name).sort()).toEqual(['mia', 'steve']);
    expect(st.players.find((p) => p.name === 'steve')?.sessions).toBe(1);
    expect(st.peak?.online).toBe(2);
    expect(st.hours.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(st.names).toBe(true);
    expect((await gameRequest(s, 'GET', `/api/games/${g.id}/stats?days=8`)).statusCode).toBe(400);
    expect((await anon(s, 'GET', `/api/games/${g.id}/stats`)).statusCode).toBe(401);

    // Older than 90 days is pruned.
    s.t.clock.advance(STATS_RETENTION_MS + MIN);
    await gameRequest(s, 'POST', `/api/games/${g.id}/stop`);
    s.t.app.hzCore.gameStats.prune();
    expect(s.t.db.db.select().from(gamePlayerSessions).all()).toHaveLength(0);
  });

  it('cleanPlayerName strips control characters and cuts at 40', () => {
    expect(cleanPlayerName('a\u0000b​c')).toBe('abc');
    expect(cleanPlayerName('x'.repeat(60))).toHaveLength(40);
  });
});
