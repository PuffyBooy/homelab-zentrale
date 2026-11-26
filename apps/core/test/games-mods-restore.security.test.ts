import { afterEach, describe, expect, it } from 'vitest';
import { gameModsResponseSchema } from '@hz/shared';
import { auditLog } from '../src/db/schema.js';
import { pickModFile } from '../src/games/mods.js';
import { stepUp, until, type WsClient } from './agent-helpers.js';
import { gameRequest, readyGame, rpcsOf, withGames, type GameSetup } from './games-helpers.js';
import type { TestApp } from './helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

const PROJECT = 'AbCd1234';
const SHA = 'a'.repeat(128);
const cdn = (file: string, host = 'cdn.modrinth.com') =>
  `https://${host}/data/${PROJECT}/versions/Ver12345/${file}`;

interface FakeModrinth {
  calls: { url: string; init: RequestInit }[];
  file: {
    url: string;
    filename: string;
    primary: boolean;
    size: number;
    hashes: { sha512?: string };
  };
}

function modrinth(): {
  fake: FakeModrinth;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
} {
  const fake: FakeModrinth = {
    calls: [],
    file: {
      url: cdn('cool-1.0.jar'),
      filename: 'cool-1.0.jar',
      primary: true,
      size: 1000,
      hashes: { sha512: SHA },
    },
  };
  const json = (v: unknown) =>
    new Response(JSON.stringify(v), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  return {
    fake,
    fetch: async (url, init) => {
      fake.calls.push({ url, init });
      const u = new URL(url);
      if (u.host !== 'api.modrinth.com') throw new Error('foreign host');
      if (u.pathname === '/v2/search') {
        return json({
          hits: [
            {
              project_id: PROJECT,
              slug: 'cool',
              title: 'Cool',
              description: 'd',
              downloads: 5,
              extra: 1,
            },
            { project_id: '../evil', slug: 'x', title: 'x', description: 'x', downloads: 1 },
          ],
        });
      }
      if (u.pathname === `/v2/project/${PROJECT}`)
        return json({ id: PROJECT, title: 'Cool Plugin' });
      if (u.pathname === `/v2/project/${PROJECT}/version`) {
        return json([
          {
            id: 'old',
            project_id: PROJECT,
            date_published: '2025-01-01T00:00:00Z',
            files: [{ ...fake.file, filename: 'old.jar', url: cdn('old.jar') }],
          },
          {
            id: 'new',
            project_id: PROJECT,
            date_published: '2026-01-01T00:00:00Z',
            files: [fake.file],
          },
        ]);
      }
      return new Response('', { status: 404 });
    },
  };
}

async function setup(fetch?: ReturnType<typeof modrinth>['fetch']): Promise<GameSetup> {
  const s = await withGames(clients, fetch ? { gameFetch: fetch } : {});
  t = s.t;
  return s;
}

describe('mods via Modrinth (M12)', () => {
  it('search: facets for Paper + version, generic User-Agent, strict parsing', async () => {
    const m = modrinth();
    const s = await setup(m.fetch);
    const g = await readyGame(s, { values: { VERSION: '1.21.4' } });
    expect(g.modsKind).toBe('plugins');
    const res = await gameRequest(s, 'GET', `/api/games/${g.id}/mods/search?q=cool`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      hits: [
        {
          projectId: PROJECT,
          slug: 'cool',
          title: 'Cool',
          description: 'd',
          downloads: 5,
          installed: false,
        },
      ],
    });
    const u = new URL(m.fake.calls[0]?.url ?? '');
    expect(JSON.parse(u.searchParams.get('facets') ?? '')).toEqual([
      ['project_type:plugin'],
      ['categories:paper'],
      ['versions:1.21.4'],
    ]);
    expect((m.fake.calls[0]?.init.headers as Record<string, string>)['user-agent']).toBe(
      'homelab-zentrale',
    );
    expect(m.fake.calls[0]?.init.redirect).toBe('error');
  });

  it('install picks the newest primary jar with sha512; remove; restart needed', async () => {
    const m = modrinth();
    const s = await setup(m.fetch);
    const g = await readyGame(s, { values: { VERSION: '1.21.4' } });
    const res = await gameRequest(s, 'POST', `/api/games/${g.id}/mods`, { projectId: PROJECT });
    expect(res.statusCode).toBe(200);
    const body = gameModsResponseSchema.parse(res.json());
    expect(body).toMatchObject({
      kind: 'plugins',
      loader: 'paper',
      gameVersion: '1.21.4',
      restartNeeded: true,
    });
    expect(body.files).toEqual([
      { fileName: 'cool-1.0.jar', sizeBytes: 1000, title: 'Cool Plugin', projectId: PROJECT },
    ]);
    expect(rpcsOf(s, 'game.mods.install')[0]?.params).toEqual({
      gameId: 'survival',
      kind: 'plugins',
      url: cdn('cool-1.0.jar'),
      fileName: 'cool-1.0.jar',
      sha512: SHA,
      sizeBytes: 1000,
    });
    const versions = new URL(m.fake.calls.find((c) => c.url.includes('/version'))?.url ?? '');
    expect(versions.searchParams.get('loaders')).toBe('["paper"]');
    expect(versions.searchParams.get('game_versions')).toBe('["1.21.4"]');

    const del = await gameRequest(s, 'DELETE', `/api/games/${g.id}/mods/cool-1.0.jar`);
    expect(del.statusCode).toBe(200);
    expect(gameModsResponseSchema.parse(del.json()).files).toEqual([]);
    expect(rpcsOf(s, 'game.mods.remove')).toHaveLength(1);
    // A start clears "Neustart nötig".
    await gameRequest(s, 'POST', `/api/games/${g.id}/restart`);
    await gameRequest(s, 'POST', `/api/games/${g.id}/stop`);
    await gameRequest(s, 'POST', `/api/games/${g.id}/start`);
    expect(
      gameModsResponseSchema.parse((await gameRequest(s, 'GET', `/api/games/${g.id}/mods`)).json())
        .restartNeeded,
    ).toBe(false);
  });

  it('refuses a foreign download host and a missing hash; nothing reaches the agent', async () => {
    for (const file of [
      { url: cdn('cool-1.0.jar', 'evil.example'), hashes: { sha512: SHA } },
      { url: cdn('cool-1.0.jar'), hashes: {} },
      { url: cdn('cool-1.0.zip'), hashes: { sha512: SHA }, filename: 'cool-1.0.zip' },
    ]) {
      const m = modrinth();
      m.fake.file = { ...m.fake.file, ...file };
      const s = await setup(m.fetch);
      const g = await readyGame(s);
      const res = await gameRequest(s, 'POST', `/api/games/${g.id}/mods`, { projectId: PROJECT });
      expect(res.statusCode).toBe(409);
      expect(rpcsOf(s, 'game.mods.install')).toHaveLength(0);
      for (const c of clients.splice(0)) c.ws.terminate();
      await s.t.app.close();
      t = undefined;
    }
  });

  it('invalid input 400, not moddable 409, no session 401', async () => {
    const m = modrinth();
    const s = await setup(m.fetch);
    const g = await readyGame(s);
    expect(
      (await gameRequest(s, 'POST', `/api/games/${g.id}/mods`, { projectId: '../../x' }))
        .statusCode,
    ).toBe(400);
    expect((await gameRequest(s, 'DELETE', `/api/games/${g.id}/mods/..%2Fx.jar`)).statusCode).toBe(
      400,
    );
    const vanilla = await readyGame(s, {
      name: 'vanilla',
      values: { TYPE: 'VANILLA' },
      ports: { game: 25570 },
    });
    expect(vanilla.modsKind).toBeNull();
    expect((await gameRequest(s, 'GET', `/api/games/${vanilla.id}/mods`)).statusCode).toBe(409);
    const anon = await s.t.app.inject({ method: 'GET', url: `/api/games/${g.id}/mods` });
    expect(anon.statusCode).toBe(401);
  });

  it('pickModFile: only cdn.modrinth.com jars with a sha512', () => {
    const base = { id: 'v', project_id: PROJECT, date_published: '2026-01-01T00:00:00Z' };
    const f = {
      url: cdn('a.jar'),
      filename: 'a.jar',
      primary: true,
      size: 10,
      hashes: { sha512: SHA },
    };
    expect(pickModFile({ ...base, files: [f] })).not.toBeNull();
    expect(
      pickModFile({ ...base, files: [{ ...f, url: 'https://cdn.modrinth.com.evil/data/x' }] }),
    ).toBeNull();
    expect(pickModFile({ ...base, files: [{ ...f, filename: '../a.jar' }] })).toBeNull();
    expect(pickModFile({ ...base, files: [{ ...f, size: 200 * 1024 * 1024 }] })).toBeNull();
  });
});

describe('restore a backup (M12)', () => {
  it('needs step-up and the name; backs up first, stops, restores, starts again', async () => {
    const s = await setup();
    const g = await readyGame(s);
    await gameRequest(s, 'POST', `/api/games/${g.id}/backup`);
    await s.t.app.hzCore.games.idle();
    const [backup] = s.t.app.hzCore.games.backups(g.id);
    if (!backup) throw new Error('no backup');
    const url = `/api/games/${g.id}/backups/${backup.id}/restore`;
    const denied = await gameRequest(s, 'POST', url, { confirmName: 'survival' });
    expect(denied.statusCode).toBe(403);
    expect(rpcsOf(s, 'game.restore')).toHaveLength(0);
    await stepUp(s.t, s.secret, s.cookie);
    expect((await gameRequest(s, 'POST', url, { confirmName: 'other' })).statusCode).toBe(400);
    expect(
      (
        await gameRequest(s, 'POST', `/api/games/${g.id}/backups/nonexistent1/restore`, {
          confirmName: 'survival',
        })
      ).statusCode,
    ).toBe(404);
    const before = s.rpcs.length;
    const res = await gameRequest(s, 'POST', url, { confirmName: 'survival' });
    expect(res.statusCode).toBe(202);
    await s.t.app.hzCore.games.idle();
    const order = s.rpcs.slice(before).map((r) => r.action);
    expect(order).toEqual(['game.backup', 'compose.down', 'game.restore', 'compose.up']);
    expect(rpcsOf(s, 'game.restore')[0]?.params).toEqual({
      gameId: 'survival',
      fileName: backup.fileName,
    });
    // keep 8: the fresh backup never deletes the file being restored.
    expect((rpcsOf(s, 'game.backup').at(-1)?.params as { keep: number }).keep).toBe(8);
    const events = s.t.app.hzCore.games.eventsOf(g.id).map((e) => e.text);
    expect(events).toContain(`Wiederhergestellt: ${backup.fileName}`);
    const audit = s.t.db.db.select().from(auditLog).all();
    expect(audit.some((a) => a.action === 'game.restored')).toBe(true);
    expect(s.t.app.hzCore.games.isRunning(g.id)).toBe(true);
  });

  it('a failed restore keeps the old data and starts the game again', async () => {
    const s = await setup();
    const g = await readyGame(s);
    await gameRequest(s, 'POST', `/api/games/${g.id}/backup`);
    await s.t.app.hzCore.games.idle();
    const [backup] = s.t.app.hzCore.games.backups(g.id);
    s.behaviour.restore = 'fail';
    await stepUp(s.t, s.secret, s.cookie);
    const res = await gameRequest(s, 'POST', `/api/games/${g.id}/backups/${backup?.id}/restore`, {
      confirmName: 'survival',
    });
    expect(res.statusCode).toBe(202);
    await s.t.app.hzCore.games.idle();
    await until(() => s.t.app.hzCore.games.isRunning(g.id));
    const audit = s.t.db.db.select().from(auditLog).all();
    expect(audit.some((a) => a.action === 'game.restore_failed')).toBe(true);
  });
});
