import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { shareStatusResponseSchema, whitelistRequestListResponseSchema } from '@hz/shared';
import { auditLog, shareAudit } from '../src/db/schema.js';
import { type WsClient } from './agent-helpers.js';
import { gameRequest, readyGame, rpcsOf, withGames, type GameSetup } from './games-helpers.js';
import type { TestApp } from './helpers.js';
import { createShare, enableGateway, friend, gateway } from './share-helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

async function setup(): Promise<GameSetup> {
  const s = await withGames(clients);
  t = s.t;
  return s;
}

const HOUR = 60 * 60_000;

describe('share link: whitelist request (M12)', () => {
  it('a friend asks, the admin gets a push and approves over RCON', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const link = await createShare(s, g.id, { person: 'Max', perms: ['whitelist_request'] });
    const res = await friend(s, 'POST', 'whitelist-request', {
      token: link.token,
      payload: { player: 'Steve' },
    });
    expect(res.statusCode).toBe(200);
    const st = shareStatusResponseSchema.parse(res.json());
    expect(st.whitelistRequests).toEqual([
      { player: 'Steve', state: 'pending', createdAt: new Date(s.t.clock.t).toISOString() },
    ]);
    const alerts = s.t.app.hzCore.alerts.list({ state: 'all', limit: 50 });
    expect(alerts.some((a) => a.title === 'Max möchte auf die Whitelist von survival: Steve')).toBe(
      true,
    );
    // Same player twice: busy.
    const again = await friend(s, 'POST', 'whitelist-request', {
      token: link.token,
      payload: { player: 'Steve' },
    });
    expect(again.statusCode).toBe(409);

    const list = whitelistRequestListResponseSchema.parse(
      (await gameRequest(s, 'GET', `/api/games/${g.id}/whitelist-requests`)).json(),
    );
    const id = list.requests[0]?.id ?? '';
    const ok = await gameRequest(s, 'POST', `/api/whitelist-requests/${id}/approve`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ request: { state: 'approved', player: 'Steve' } });
    expect(rpcsOf(s, 'game.rcon').map((r) => (r.params as { command: string }).command)).toContain(
      'whitelist add Steve',
    );
    expect((await gameRequest(s, 'POST', `/api/whitelist-requests/${id}/approve`)).statusCode).toBe(
      409,
    );
    expect((await gameRequest(s, 'POST', `/api/whitelist-requests/${id}/maybe`)).statusCode).toBe(
      400,
    );
  });

  it('approve needs a running game (409); reject works anyway; limits per link', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const link = await createShare(s, g.id, { perms: ['whitelist_request'] });
    for (const p of ['Aa1', 'Bb2', 'Cc3']) {
      expect(
        (
          await friend(s, 'POST', 'whitelist-request', {
            token: link.token,
            payload: { player: p },
          })
        ).statusCode,
      ).toBe(200);
    }
    const fourth = await friend(s, 'POST', 'whitelist-request', {
      token: link.token,
      payload: { player: 'Dd4' },
    });
    expect(fourth.statusCode).toBe(429);
    await gameRequest(s, 'POST', `/api/games/${g.id}/stop`);
    const [r1, r2] = s.t.app.hzCore.whitelistRequests.list(g.id);
    const ap = await gameRequest(s, 'POST', `/api/whitelist-requests/${r1?.id}/approve`);
    expect(ap.statusCode).toBe(409);
    expect(
      (await gameRequest(s, 'POST', `/api/whitelist-requests/${r2?.id}/reject`)).statusCode,
    ).toBe(200);
    // Bad name never reaches RCON.
    const bad = await friend(s, 'POST', 'whitelist-request', {
      token: link.token,
      payload: { player: 'x; op me' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('without the right 403, revoked 410, only own requests are shown', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const other = await createShare(s, g.id, { person: 'Lena', perms: ['whitelist_request'] });
    await friend(s, 'POST', 'whitelist-request', {
      token: other.token,
      payload: { player: 'Lena1' },
    });
    const power = await createShare(s, g.id, { perms: ['power'] });
    const no = await friend(s, 'POST', 'whitelist-request', {
      token: power.token,
      payload: { player: 'Steve' },
    });
    expect(no.statusCode).toBe(403);
    const st = shareStatusResponseSchema.parse(
      (await friend(s, 'GET', 'status', { token: power.token })).json(),
    );
    expect(st.whitelistRequests).toEqual([]);
    await gameRequest(s, 'POST', `/api/shares/${other.id}/revoke`);
    const gone = await friend(s, 'POST', 'whitelist-request', {
      token: other.token,
      payload: { player: 'Lena2' },
    });
    expect(gone.statusCode).toBe(410);
  });

  it('a whitelist_request link needs a Minecraft template with a whitelist command', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const vh = await gameRequest(s, 'POST', '/api/games', {
      templateId: 'valheim',
      serverId: s.serverId,
      name: 'wikinger',
      values: { SERVER_PASS: 'geheim123' },
    });
    expect(vh.statusCode).toBe(202);
    const id = vh.json<{ game: { id: string } }>().game.id;
    const res = await gameRequest(s, 'POST', `/api/games/${id}/shares`, {
      person: 'Max',
      perms: ['whitelist_request'],
      expires: '7d',
    });
    expect([400, 403]).toContain(res.statusCode);
    expect(g.id).not.toBe(id);
  });
});

describe('share link: world download (M12)', () => {
  it('only templates with worldPaths offer the right (400 when creating the link)', async () => {
    const s = await setup();
    const vh = await gameRequest(s, 'POST', '/api/games', {
      templateId: 'valheim',
      serverId: s.serverId,
      name: 'wikinger',
      values: { SERVER_PASS: 'geheim123' },
    });
    const id = vh.json<{ game: { id: string } }>().game.id;
    const res = await gameRequest(s, 'POST', `/api/games/${id}/shares`, {
      person: 'Max',
      perms: ['world_download'],
      expires: '7d',
    });
    expect([400, 403]).toContain(res.statusCode);
    expect(s.t.app.hzCore.shares.list(id)).toHaveLength(0);
  });

  it('streams the archive with the right headers, audited, once per hour', async () => {
    const s = await setup();
    const data = Buffer.alloc(150_000, 7);
    s.behaviour.exportData = data;
    const g = await readyGame(s);
    const link = await createShare(s, g.id, { perms: ['world_download'] });
    const res = await friend(s, 'GET', 'world', { token: link.token });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zstd');
    expect(res.headers['content-disposition']).toBe('attachment; filename="survival-welt.tar.zst"');
    expect(res.headers['content-length']).toBe(String(data.length));
    expect(createHash('sha256').update(res.rawPayload).digest('hex')).toBe(
      createHash('sha256').update(data).digest('hex'),
    );
    // Only the template's worldPaths, never the whole data/ (configs hold RCON passwords).
    expect(rpcsOf(s, 'game.export')[0]?.params).toMatchObject({
      gameId: 'survival',
      paths: ['world'],
    });
    const audit = s.t.db.db.select().from(shareAudit).all();
    expect(audit.filter((a) => a.action === 'world_download')).toHaveLength(1);
    expect(
      s.t.db.db
        .select()
        .from(auditLog)
        .all()
        .some((a) => a.action === 'share.world_download'),
    ).toBe(true);

    const second = await friend(s, 'GET', 'world', { token: link.token });
    expect(second.statusCode).toBe(429);
    s.t.clock.advance(HOUR + 1000);
    s.agent.send({ type: 'ping', ts: new Date(s.t.clock.t).toISOString() });
    await s.keepAlive();
    expect((await friend(s, 'GET', 'world', { token: link.token })).statusCode).toBe(200);
  });

  it('without the right 403 (nothing exported); revoked 410; export error 503', async () => {
    const s = await setup();
    s.behaviour.exportData = Buffer.from('x');
    const g = await readyGame(s);
    const power = await createShare(s, g.id, { perms: ['power'] });
    expect((await friend(s, 'GET', 'world', { token: power.token })).statusCode).toBe(403);
    expect(rpcsOf(s, 'game.export')).toHaveLength(0);
    const link = await createShare(s, g.id, { perms: ['world_download'] });
    s.behaviour.exportFail = true;
    const fail = await friend(s, 'GET', 'world', { token: link.token });
    expect(fail.statusCode).toBe(503);
    expect(fail.json()).toEqual({ ok: false, error: 'unavailable' });
    // A failed attempt counts for the hourly limit too.
    s.behaviour.exportFail = false;
    expect((await friend(s, 'GET', 'world', { token: link.token })).statusCode).toBe(429);
    expect(rpcsOf(s, 'game.export')).toHaveLength(1);
    await gameRequest(s, 'POST', `/api/shares/${link.id}/revoke`);
    expect((await friend(s, 'GET', 'world', { token: link.token })).statusCode).toBe(410);
  });

  it('works through the gateway API with the same checks', async () => {
    const s = await setup();
    s.behaviour.exportData = Buffer.from('world-bytes');
    const g = await readyGame(s);
    const gw = await enableGateway(s);
    const link = await createShare(s, g.id, { perms: ['world_download', 'whitelist_request'] });
    const res = await gateway(s, 'GET', 'world', { gatewayToken: gw, token: link.token });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('world-bytes');
    const wl = await gateway(s, 'POST', 'whitelist-request', {
      gatewayToken: gw,
      token: link.token,
      payload: { player: 'Steve' },
    });
    expect(wl.statusCode).toBe(200);
    expect(JSON.stringify(wl.json())).not.toMatch(/100\.64\.|serverId|containerId/);
    expect((await gateway(s, 'GET', 'world', { token: link.token })).statusCode).toBe(401);
  });
});

describe('share API outer rate limit (M12)', () => {
  it('caps one IP across all routes with a schema-shaped 429', async () => {
    const s = await setup();
    let last = await friend(s, 'GET', 'world', { ip: '100.64.9.9', token: 'x' });
    for (let i = 0; i < 600 && last.statusCode !== 429; i++) {
      last = await friend(s, 'GET', 'world', { ip: '100.64.9.9', token: 'x' });
    }
    expect(last.statusCode).toBe(429);
    const body = last.json() as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.error).toBe('rate_limited');
  });
});
