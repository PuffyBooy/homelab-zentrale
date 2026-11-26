import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  shareAuditResponseSchema,
  shareConsoleResponseSchema,
  shareListResponseSchema,
  shareStatusResponseSchema,
} from '@hz/shared';
import { randomToken } from '../src/crypto.js';
import { auditLog, shareAudit, shareLinks } from '../src/db/schema.js';
import { SHARE_CSP } from '../src/share/friend-routes.js';
import type { WsClient } from './agent-helpers.js';
import { stepUp, until, type Received } from './agent-helpers.js';
import {
  gameRequest,
  readyGame,
  rpcsOf,
  tick,
  withGames,
  type GameSetup,
} from './games-helpers.js';
import { emptyDir, HOST, makeApp, type TestApp } from './helpers.js';
import { createShare, friend } from './share-helpers.js';

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

describe('share links: admin', () => {
  it('creates, lists, revokes and deletes links', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const res = await gameRequest(s, 'POST', `/api/games/${g.id}/shares`, {
      person: 'Lena K.',
      perms: ['console_read', 'power', 'power'],
      expires: '7d',
      pin: '4711',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      share: { id: string; perms: string[]; hasPin: boolean; state: string; expiresAt: string };
      urls: { tailnet: string; public: string | null };
    }>();
    expect(body.share).toMatchObject({
      perms: ['power', 'console_read'],
      hasPin: true,
      state: 'active',
    });
    expect(Date.parse(body.share.expiresAt) - s.t.clock.t).toBe(7 * 24 * 60 * MIN);
    expect(body.urls.tailnet).toMatch(new RegExp(`^https://${HOST}/s/[A-Za-z0-9_-]{43}$`));
    expect(body.urls.public).toBeNull();
    expect(res.body).not.toContain('pin":');

    const list = shareListResponseSchema.parse(
      (await gameRequest(s, 'GET', `/api/games/${g.id}/shares`)).json(),
    );
    expect(list.shares.map((x) => x.person)).toEqual(['Lena K.']);

    // Active links cannot be deleted.
    const del = await gameRequest(s, 'DELETE', `/api/shares/${body.share.id}`);
    expect(del.statusCode).toBe(409);
    expect((await gameRequest(s, 'POST', `/api/shares/${body.share.id}/revoke`)).statusCode).toBe(
      200,
    );
    expect((await gameRequest(s, 'DELETE', `/api/shares/${body.share.id}`)).json()).toEqual({
      ok: true,
    });
    expect((await gameRequest(s, 'GET', `/api/games/${g.id}/shares`)).json()).toEqual({
      shares: [],
    });
    const actions = s.t.db.db
      .select()
      .from(auditLog)
      .all()
      .map((a) => `${a.actor} ${a.action}`);
    expect(actions).toEqual(
      expect.arrayContaining(['admin share.created', 'admin share.revoked', 'admin share.deleted']),
    );
  });

  it('validates input and unknown ids', async () => {
    const s = await setup();
    const g = await readyGame(s);
    for (const payload of [
      { person: '<b>x</b>', perms: ['power'], expires: '7d' },
      { person: 'Max', perms: [], expires: '7d' },
      { person: 'Max', perms: ['admin'], expires: '7d' },
      { person: 'Max', perms: ['power'], expires: '2d' },
      { person: 'Max', perms: ['power'], expires: '7d', pin: '12345' },
    ]) {
      const r = await gameRequest(s, 'POST', `/api/games/${g.id}/shares`, payload);
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const unknown = randomToken(12);
    expect(
      (
        await gameRequest(s, 'POST', `/api/games/${unknown}/shares`, {
          person: 'Max',
          perms: ['power'],
          expires: '7d',
        })
      ).statusCode,
    ).toBe(404);
    expect((await gameRequest(s, 'POST', `/api/shares/${unknown}/revoke`)).statusCode).toBe(404);
    expect((await gameRequest(s, 'GET', `/api/games/${g.id}/share-audit?limit=0`)).statusCode).toBe(
      400,
    );
  });

  it('the public link uses the gateway address only while the gateway is on', async () => {
    const s = await setup();
    const g = await readyGame(s);
    await stepUp(s.t, s.secret, s.cookie);
    await gameRequest(s, 'PUT', '/api/settings/share-gateway', {
      enabled: false,
      publicUrl: 'https://spiel.example.org',
    });
    expect((await createShare(s, g.id)).urls.public).toBeNull();
    await gameRequest(s, 'PUT', '/api/settings/share-gateway', {
      enabled: true,
      publicUrl: 'https://spiel.example.org',
    });
    const link = await createShare(s, g.id);
    expect(link.urls.public).toBe(`https://spiel.example.org/s/${link.token}`);
  });

  it('expired links show as expired and can be deleted; never-expiring links stay', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const short = await createShare(s, g.id, { expires: '1d' });
    const forever = await createShare(s, g.id, { expires: 'never' });
    s.t.clock.advance(2 * 24 * 60 * MIN);
    const list = shareListResponseSchema.parse(
      (await gameRequest(s, 'GET', `/api/games/${g.id}/shares`)).json(),
    );
    expect(Object.fromEntries(list.shares.map((x) => [x.id, x.state]))).toEqual({
      [short.id]: 'expired',
      [forever.id]: 'active',
    });
    expect((await gameRequest(s, 'DELETE', `/api/shares/${short.id}`)).statusCode).toBe(200);
  });

  it('deleting the game deletes its links and their history', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const link = await createShare(s, g.id);
    await friend(s, 'GET', 'status', { token: link.token });
    expect(s.t.db.db.select().from(shareAudit).all()).toHaveLength(1);
    await stepUp(s.t, s.secret, s.cookie);
    const del = await gameRequest(s, 'DELETE', `/api/games/${g.id}`, { confirmName: g.name });
    expect(del.statusCode).toBe(200);
    expect(s.t.db.db.select().from(shareLinks).all()).toHaveLength(0);
    expect(s.t.db.db.select().from(shareAudit).all()).toHaveLength(0);
    expect((await friend(s, 'GET', 'status', { token: link.token })).statusCode).toBe(404);
  });
});

describe('share links: friend API', () => {
  it('shows status, runs actions and records them for the admin', async () => {
    const s = await setup();
    const g = await readyGame(s);
    await gameRequest(s, 'PUT', `/api/games/${g.id}`, { externalAddress: 'mc.example.at' });
    const link = await createShare(s, g.id, { perms: ['power', 'restart'], expires: 'never' });

    const st = await friend(s, 'GET', 'status', { token: link.token, ip: '100.70.1.2' });
    expect(st.statusCode).toBe(200);
    const status = shareStatusResponseSchema.parse(st.json());
    expect(status).toMatchObject({
      person: 'Max',
      perms: ['power', 'restart'],
      expiresAt: null,
      game: {
        name: 'survival',
        game: 'Minecraft Java',
        status: 'ok',
        address: `mc.example.at:${g.ports[0]?.port}`,
        players: { online: 2, max: 20, names: ['alex', 'mia'] },
        whitelist: true,
      },
    });

    const stop = await friend(s, 'POST', 'action', {
      token: link.token,
      payload: { action: 'stop' },
    });
    expect(stop.statusCode).toBe(200);
    expect(rpcsOf(s, 'compose.down')).toHaveLength(1);
    expect(
      (await friend(s, 'POST', 'action', { token: link.token, payload: { action: 'x' } }))
        .statusCode,
    ).toBe(400);

    const audit = shareAuditResponseSchema.parse(
      (await gameRequest(s, 'GET', `/api/games/${g.id}/share-audit`)).json(),
    );
    expect(audit.entries.map((e) => [e.action, e.person, e.via])).toEqual([
      ['stop', 'Max', 'tailnet'],
      ['view', 'Max', 'tailnet'],
    ]);
    expect(audit.entries[1]?.ip).toBe('100.70.1.2');
    const row = s.t.db.db.select().from(shareLinks).where(eq(shareLinks.id, link.id)).get();
    expect(row?.lastUsedAt).toBe(s.t.clock.t);
  });

  it("audits 'view' and 'console_read' at most once per 10 minutes", async () => {
    const s = await setup();
    const g = await readyGame(s);
    const link = await createShare(s, g.id, { perms: ['console_read'] });
    for (let i = 0; i < 3; i++) {
      await friend(s, 'GET', 'status', { token: link.token });
      await friend(s, 'GET', 'console', { token: link.token });
    }
    const count = () =>
      s.t.db.db
        .select()
        .from(shareAudit)
        .all()
        .map((r) => r.action);
    expect(count().sort()).toEqual(['console_read', 'view']);
    s.t.clock.advance(10 * MIN);
    await friend(s, 'GET', 'status', { token: link.token });
    expect(count().filter((a) => a === 'view')).toHaveLength(2);
  });

  it('console: RCON events and container log lines with a cursor', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const link = await createShare(s, g.id, { perms: ['console_write'] });
    const cmd = await friend(s, 'POST', 'console', {
      token: link.token,
      payload: { command: 'list' },
    });
    expect(cmd.json()).toEqual({ output: 'ran list' });

    const first = shareConsoleResponseSchema.parse(
      (await friend(s, 'GET', 'console', { token: link.token })).json(),
    );
    expect(first.lines.map((l) => [l.kind, l.text])).toEqual([
      ['cmd', '> list'],
      ['out', 'ran list'],
    ]);
    // The first poll leased the container log stream on the agent.
    await until(() => rpcsOf(s, 'container.logs').length === 1);
    const streamId = (rpcsOf(s, 'container.logs')[0] as Received).id as string;
    s.agent.send({ type: 'stream.data', streamId, channel: 'stdout', chunk: 'Done (3.2s)!\n' });
    s.agent.send({ type: 'stream.data', streamId, channel: 'stderr', chunk: 'WARN lag\n' });
    await s.keepAlive();

    const after = first.lines.at(-1)?.id ?? '';
    const next = shareConsoleResponseSchema.parse(
      (await friend(s, 'GET', 'console', { token: link.token })).json(),
    );
    expect(next.lines.map((l) => l.text)).toContain('Done (3.2s)!');
    const delta = shareConsoleResponseSchema.parse(
      (
        await s.t.app.inject({
          method: 'GET',
          url: `/s/api/console?after=${encodeURIComponent(after)}`,
          headers: {
            host: HOST,
            authorization: `Share ${link.token}`,
            'x-forwarded-for': '10.9.9.9',
          },
        })
      ).json(),
    );
    expect(delta.lines.map((l) => [l.kind, l.text])).toEqual([
      ['out', 'Done (3.2s)!'],
      ['err', 'WARN lag'],
    ]);
    const last = delta.lines.at(-1)?.id ?? '';
    const none = await s.t.app.inject({
      method: 'GET',
      url: `/s/api/console?after=${encodeURIComponent(last)}`,
      headers: { host: HOST, authorization: `Share ${link.token}`, 'x-forwarded-for': '10.9.9.9' },
    });
    expect(none.json()).toEqual({ lines: [] });
    const bad = await s.t.app.inject({
      method: 'GET',
      url: '/s/api/console?after=abc',
      headers: { host: HOST, authorization: `Share ${link.token}`, 'x-forwarded-for': '10.9.9.9' },
    });
    expect(bad.statusCode).toBe(400);

    // The lease ends 2 minutes after the last poll: the stream is cancelled.
    await tick(s, 3 * MIN);
    expect(s.t.app.hzCore.logs.activeTopics).toEqual([]);
    const audit = s.t.db.db.select().from(auditLog).where(eq(auditLog.action, 'game.rcon')).all();
    expect(audit.map((a) => a.actor)).toEqual([`share:${link.id}`]);
  });

  it('answers unknown paths under /s/api with 404 in the share format', async () => {
    const s = await setup();
    for (const url of ['/s/api/nope', '/s/api/status/x', '/s/api/../api/games']) {
      const r = await s.t.app.inject({ method: 'GET', url, headers: { host: HOST } });
      expect([404], url).toContain(r.statusCode);
    }
  });
});

describe('share page', () => {
  it('serves the mini UI with strict headers for every token', async () => {
    const dir = emptyDir();
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Freigabe</title>');
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'app-1.js'), 'console.log(1)');
    writeFileSync(join(dir, 'secret.txt'), 'nope');
    t = await makeApp({ env: { HZ_SHARE_UI_DIR: dir } });
    for (const token of [randomToken(32), 'kaputt']) {
      const page = await t.app.inject({
        method: 'GET',
        url: `/s/${token}`,
        headers: { host: HOST },
      });
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
      expect(page.headers['content-security-policy']).toBe(SHARE_CSP);
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.headers['referrer-policy']).toBe('no-referrer');
      expect(page.headers['x-robots-tag']).toContain('noindex');
      expect(page.body).toContain('Freigabe');
    }
    const js = await t.app.inject({ method: 'GET', url: '/s/assets/app-1.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toContain('javascript');
    for (const url of [
      '/s/assets/../secret.txt',
      '/s/assets/%2e%2e%2fsecret.txt',
      '/s/assets/nope.js',
    ]) {
      const r = await t.app.inject({ method: 'GET', url });
      // Either 404 or (after URL normalisation to /s/secret.txt) the page itself, never the file.
      expect(r.body, url).not.toBe('nope');
      if (r.statusCode !== 404) expect(r.body, url).toContain('Freigabe');
    }
  });

  it('answers 503 with a German text while the UI is not built', async () => {
    t = await makeApp({ env: { HZ_SHARE_UI_DIR: emptyDir() } });
    const page = await t.app.inject({ method: 'GET', url: `/s/${randomToken(32)}` });
    expect(page.statusCode).toBe(503);
    expect(page.body).toContain('nicht verfügbar');
    expect(page.headers['cache-control']).toBe('no-store');
  });
});

describe('share audit retention', () => {
  it('prunes share audit entries older than 90 days in the hourly prune job', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const link = await createShare(s, g.id);
    await friend(s, 'GET', 'status', { token: link.token });
    s.t.clock.advance(91 * 24 * 60 * MIN);
    s.t.db.db
      .insert(shareAudit)
      .values({
        id: randomToken(12),
        shareId: link.id,
        gameId: g.id,
        person: 'Max',
        action: 'start',
        ts: s.t.clock.t,
        via: 'tailnet',
      })
      .run();
    await tick(s, 60 * MIN);
    expect(
      s.t.db.db
        .select()
        .from(shareAudit)
        .all()
        .map((r) => r.action),
    ).toEqual(['start']);
  });
});
