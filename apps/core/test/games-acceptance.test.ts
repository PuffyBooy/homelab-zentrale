import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  gameBackupListResponseSchema,
  gameEventSchema,
  gameResponseSchema,
  gameSummarySchema,
  gameSuggestResponseSchema,
  gameTemplateListResponseSchema,
  liveTopicItemSchemas,
} from '@hz/shared';
import { createSecretBox } from '../src/crypto.js';
import { auditLog, gameServers } from '../src/db/schema.js';
import { stepUp, until, WsClient } from './agent-helpers.js';
import {
  createGame,
  fakeSecret,
  gameRequest,
  ONLINE,
  readyGame,
  rpcsOf,
  tick,
  withGames,
  type GameSetup,
} from './games-helpers.js';
import { KEY, type TestApp } from './helpers.js';

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

describe('M6 acceptance: Minecraft Paper from the UI flow', () => {
  it('creates, comes online with players and TPS, RCON works, a backup is created', async () => {
    const s = await setup({ ramPct: 80 });

    // 1. Templates: only the valid fixtures.
    const list = gameTemplateListResponseSchema.parse(
      (await gameRequest(s, 'GET', '/api/games/templates')).json(),
    );
    expect(list.templates.map((x) => x.id)).toEqual(['minecraft-java', 'valheim']);

    // 2. Suggestion: 25565 is taken on the server -> 25566; 3,2 GB free < 6 GB.
    const sug = gameSuggestResponseSchema.parse(
      (
        await gameRequest(
          s,
          'GET',
          `/api/games/suggest?templateId=minecraft-java&serverId=${s.serverId}`,
        )
      ).json(),
    );
    expect(sug.ports).toEqual({ game: 25566 });
    expect(sug.ramWarning).toBe('Zu wenig RAM frei (3,2 GB frei, 6 GB empfohlen)');

    // 3. Create.
    const res = await createGame(s, { values: { TYPE: 'PAPER', MAX_PLAYERS: 10 } });
    expect(res.statusCode).toBe(202);
    const created = gameResponseSchema.parse(res.json()).game;
    expect(created.status).toBe('busy');
    await s.t.app.hzCore.games.idle();

    // 4. compose.write: compose.yml with ports, no password; .env with the password.
    const [write] = rpcsOf(s, 'compose.write');
    const params = write?.params as { dir: string; files: Record<string, string> };
    expect(params.dir).toBe('/opt/homelab/games/survival');
    const compose = params.files['compose.yml'] ?? '';
    const env = params.files['.env'] ?? '';
    expect(compose).toContain("- '25566:25565/tcp'");
    expect(compose).toContain("- '127.0.0.1:25575:25575/tcp'");
    expect(compose).toContain('TYPE: "PAPER"');
    expect(compose).toContain('MAX_PLAYERS: 10');
    expect(compose).toContain('ENABLE_WHITELIST: "true"');
    expect(compose).toContain('container_name: game-survival');
    expect(compose).not.toContain('RCON_PASSWORD');
    const pw = /^RCON_PASSWORD=([A-Za-z0-9_-]+)$/m.exec(env)?.[1] ?? '';
    expect(pw.length).toBeGreaterThanOrEqual(24);
    expect(compose).not.toContain(pw);
    expect(env).toContain('PORT_RCON=25575');
    // Stored encrypted only.
    const row = s.t.db.db.select().from(gameServers).where(eq(gameServers.id, created.id)).get();
    expect(JSON.stringify(row)).not.toContain(pw);
    expect(
      createSecretBox(Buffer.from(KEY, 'base64')).decrypt(
        row?.rconSecretEnc ?? '',
        `game_servers.rcon:${created.id}`,
      ),
    ).toBe(pw);

    // 5. Order: write, pull, up; then waiting for the world.
    expect(s.rpcs.map((r) => r.action).filter((a) => String(a).startsWith('compose'))).toEqual([
      'compose.write',
      'compose.pull',
      'compose.up',
    ]);
    expect(s.t.app.hzCore.games.summary(created.id)?.statusText).toBe('Welt wird erzeugt');

    // 6. The agent reports online -> ready, with players and TPS.
    await tick(s, 5_000);
    const got = gameResponseSchema.parse(
      (await gameRequest(s, 'GET', `/api/games/${created.id}`)).json(),
    ).game;
    expect(got).toMatchObject({
      status: 'ok',
      statusText: 'Läuft',
      players: ONLINE.players,
      tps: 19.8,
      version: 'Paper 1.21.4',
      address: '100.64.0.5:25566',
      ramBytes: 3 * 1024 ** 3,
      ramLimitBytes: 6 * 1024 ** 3,
      rcon: true,
      externalAddress: '',
    });
    const status = rpcsOf(s, 'game.status')[0]?.params;
    expect(status).toMatchObject({
      gameDir: '/opt/homelab/games/survival',
      method: 'minecraft',
      port: 25566,
      tpsCommand: 'tps',
    });
    const events = s.t.app.hzCore.games.eventsOf(created.id).map((e) => e.text);
    expect(events).toEqual(
      expect.arrayContaining(['Image wird geladen', 'Welt wird erzeugt', 'bereit']),
    );
    const alerts = s.t.app.hzCore.alerts.list({ state: 'all', limit: 50 });
    expect(alerts.find((a) => a.title === 'Gameserver survival ist bereit')).toMatchObject({
      level: 'info',
      source: 'game',
    });

    // 7. RCON (the console: step-up, docs/SECURITY.md).
    await stepUp(s.t, s.secret, s.cookie);
    const rcon = await gameRequest(s, 'POST', `/api/games/${created.id}/rcon`, {
      command: 'list',
    });
    expect(rcon.statusCode).toBe(200);
    expect(rcon.json()).toEqual({ output: 'ran list' });

    // 8. Backup.
    const b = await gameRequest(s, 'POST', `/api/games/${created.id}/backup`);
    expect(b.statusCode).toBe(200);
    await s.t.app.hzCore.games.idle();
    const backups = gameBackupListResponseSchema.parse(
      (await gameRequest(s, 'GET', `/api/games/${created.id}/backups`)).json(),
    ).backups;
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatchObject({ fileName: 'survival-001.tar.zst', sizeBytes: 123_456 });
    expect(s.t.app.hzCore.games.summary(created.id)?.lastBackupAt).toBe(backups[0]?.createdAt);
    const texts = s.t.app.hzCore.games.eventsOf(created.id).map((e) => `${e.kind}:${e.text}`);
    expect(texts).toEqual(
      expect.arrayContaining([
        'console:> list',
        'console:ran list',
        'progress:12,5 MiB geschrieben',
        'progress:Backup erstellt: survival-001.tar.zst',
      ]),
    );
    expect(texts.join('\n')).not.toContain('result ');

    const actions = s.t.db.db
      .select()
      .from(auditLog)
      .all()
      .map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(['game.created', 'game.ready', 'game.rcon', 'game.backup']),
    );
  });

  it('publishes the topics games and game:<id>', async () => {
    const s = await setup();
    const browser = await WsClient.connect(`${s.url}/live`, {
      cookie: `hz_session=${s.cookie}`,
      origin: s.url.replace('ws://', 'http://'),
    });
    clients.push(browser);
    browser.send({ type: 'subscribe', topics: ['games'] });
    const snap = await browser.next((m) => m.type === 'snapshot' && m.topic === 'games');
    expect(snap.data).toEqual([]);

    const res = await createGame(s);
    const { game } = gameResponseSchema.parse(res.json());
    browser.send({ type: 'subscribe', topics: [`game:${game.id}`] });
    const gs = await browser.next((m) => m.type === 'snapshot' && m.topic === `game:${game.id}`);
    for (const e of gs.data as unknown[]) gameEventSchema.parse(e);
    await s.t.app.hzCore.games.idle();
    await tick(s, 5_000);
    const ready = await browser.next(
      (m) =>
        m.type === 'update' &&
        m.topic === `game:${game.id}` &&
        (m.upsert as { kind: string }[]).some((e) => e.kind === 'ready'),
    );
    expect(ready).toBeTruthy();
    await until(() =>
      browser.received.some(
        (m) =>
          m.type === 'update' &&
          m.topic === 'games' &&
          (m.upsert as { status: string }[] | undefined)?.some((g) => g.status === 'ok') === true,
      ),
    );
    const upd = browser.received.filter((m) => m.type === 'update' && m.topic === 'games');
    for (const m of upd)
      for (const g of (m.upsert as unknown[]) ?? []) liveTopicItemSchemas.games.parse(g);
    // Unknown game topic.
    browser.send({ type: 'subscribe', topics: ['game:doesnotexist1'] });
    const err = await browser.next((m) => m.type === 'error');
    expect(err.code).toBe('unknown_topic');
  });
});

describe('games: status, actions, settings', () => {
  it('polls every 30 s and shows low TPS as warning', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const before = rpcsOf(s, 'game.status').length;
    s.behaviour.status = { ...ONLINE, tps: 11.2 };
    await tick(s, 30_000);
    expect(rpcsOf(s, 'game.status').length).toBe(before + 1);
    expect(s.t.app.hzCore.games.summary(g.id)).toMatchObject({
      status: 'warn',
      statusText: 'TPS niedrig (11,2)',
    });
    // The agent no longer answers: after the grace the game is a warning.
    s.behaviour.status = { error: 'connect ECONNREFUSED' };
    await tick(s, 30_000);
    expect(s.t.app.hzCore.games.summary(g.id)?.players).toBeNull();
  });

  it('stop, start and restart use compose down/up and container.restart', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const stop = await gameRequest(s, 'POST', `/api/games/${g.id}/stop`);
    expect(stop.statusCode).toBe(200);
    expect(gameSummarySchema.parse(stop.json().game)).toMatchObject({
      status: 'off',
      statusText: 'Gestoppt',
      players: null,
    });
    expect(rpcsOf(s, 'compose.down')).toHaveLength(1);
    // A stopped game raises no container alert.
    expect(s.t.app.hzCore.alerts.list({ state: 'active', limit: 50 })).toEqual([]);

    const start = await gameRequest(s, 'POST', `/api/games/${g.id}/start`);
    expect(start.statusCode).toBe(200);
    expect(start.json().game.statusText).toBe('Startet');
    await tick(s, 30_000);
    expect(s.t.app.hzCore.games.summary(g.id)?.status).toBe('ok');

    const restart = await gameRequest(s, 'POST', `/api/games/${g.id}/restart`);
    expect(restart.statusCode).toBe(200);
    expect(rpcsOf(s, 'container.restart')).toHaveLength(1);
    expect(rpcsOf(s, 'container.restart')[0]?.params).toEqual({
      id: s.running.get('survival')?.dockerId,
    });
  });

  it('settings: re-renders, writes and restarts; unknown fields are refused', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const writes = rpcsOf(s, 'compose.write').length;
    const ups = rpcsOf(s, 'compose.up').length;
    const res = await gameRequest(s, 'PUT', `/api/games/${g.id}`, {
      values: { MAX_PLAYERS: 42, MOTD: 'Hallo: Welt # mit Doppelpunkt' },
      autoStopMinutes: 15,
      externalAddress: 'mc.example.at',
    });
    expect(res.statusCode).toBe(200);
    const game = gameSummarySchema.parse(res.json().game);
    expect(game).toMatchObject({ autoStopMinutes: 15, address: 'mc.example.at:25566' });
    expect(game.values).toMatchObject({ MAX_PLAYERS: 42, TYPE: 'PAPER' });
    const w = rpcsOf(s, 'compose.write');
    expect(w.length).toBe(writes + 1);
    const files = (w.at(-1)?.params as { files: Record<string, string> }).files;
    expect(files['compose.yml']).toContain('MAX_PLAYERS: 42');
    expect(files['compose.yml']).toContain('MOTD: "Hallo: Welt # mit Doppelpunkt"');
    expect(files['.env']).not.toContain('MOTD');
    // Same RCON password as before.
    const pw = (
      s.rpcs.find((r) => r.action === 'compose.write')?.params as {
        files: Record<string, string>;
      }
    ).files['.env'];
    expect(files['.env']).toContain(/^RCON_PASSWORD=.*$/m.exec(pw ?? '')?.[0] ?? 'x');
    expect(rpcsOf(s, 'compose.up').length).toBe(ups + 1);

    const bad = await gameRequest(s, 'PUT', `/api/games/${g.id}`, { values: { NOPE: 1 } });
    expect(bad.statusCode).toBe(400);
    expect(rpcsOf(s, 'compose.write').length).toBe(writes + 1);
  });

  it('auto-stops a game after N minutes without players (info alert)', async () => {
    const s = await setup();
    s.behaviour.status = { ...ONLINE, players: { online: 0, max: 20, names: [] } };
    const g = await readyGame(s, { autoStopMinutes: 2 });
    for (let i = 0; i < 4; i += 1) await tick(s, 30_000);
    await tick(s, 60_000);
    expect(rpcsOf(s, 'compose.down')).toHaveLength(1);
    expect(s.t.app.hzCore.games.summary(g.id)?.statusText).toBe('Gestoppt');
    const a = s.t.app.hzCore.alerts.list({ state: 'all', limit: 50 });
    expect(a.find((x) => x.title === 'Gameserver survival automatisch gestoppt')).toMatchObject({
      level: 'info',
    });
    const audit = s.t.db.db.select().from(auditLog).all();
    expect(audit.find((x) => x.action === 'game.stop')?.actor).toBe('system');
  });

  it('keeps the last 7 backups', async () => {
    const s = await setup();
    const g = await readyGame(s);
    for (let i = 0; i < 9; i += 1) {
      s.t.clock.advance(1000);
      expect((await gameRequest(s, 'POST', `/api/games/${g.id}/backup`)).statusCode).toBe(200);
      await s.t.app.hzCore.games.idle();
    }
    const list = s.t.app.hzCore.games.backups(g.id);
    expect(list).toHaveLength(7);
    expect(list[0]?.fileName).toBe('survival-009.tar.zst');
    expect(rpcsOf(s, 'game.backup')[0]?.params).toEqual({
      gameDir: '/opt/homelab/games/survival',
      keep: 7,
    });
  });

  it('a second action while a backup runs is 409 busy', async () => {
    const s = await setup();
    const g = await readyGame(s);
    s.behaviour.backup = { kind: 'hold' };
    expect((await gameRequest(s, 'POST', `/api/games/${g.id}/backup`)).statusCode).toBe(200);
    expect(s.t.app.hzCore.games.summary(g.id)).toMatchObject({
      status: 'busy',
      statusText: 'Backup läuft',
    });
    const stop = await gameRequest(s, 'POST', `/api/games/${g.id}/stop`);
    expect(stop.statusCode).toBe(409);
    expect(stop.json().error).toBe('busy');
    await until(() => rpcsOf(s, 'game.backup').length > 0);
    const id = rpcsOf(s, 'game.backup')[0]?.id as string;
    s.agent.send({ type: 'stream.end', streamId: id, code: 1, error: 'tar failed' });
    await s.t.app.hzCore.games.idle();
    expect(s.t.app.hzCore.games.summary(g.id)?.status).toBe('ok');
    expect(s.t.app.hzCore.games.backups(g.id)).toEqual([]);
    expect(s.t.app.hzCore.games.eventsOf(g.id).at(-1)?.text).toMatch(/^Backup fehlgeschlagen/);
  });
});

describe('games: templates without world data (CS2)', () => {
  it('backup not_found: German message, delete still works', async () => {
    const s = await setup();
    const g = await readyGame(s);
    s.behaviour.backup = { kind: 'refuse', code: 'not_found', message: 'no data directory' };
    expect((await gameRequest(s, 'POST', `/api/games/${g.id}/backup`)).statusCode).toBe(200);
    await s.t.app.hzCore.games.idle();
    expect(s.t.app.hzCore.games.eventsOf(g.id).at(-1)?.text).toBe(
      'Backup fehlgeschlagen: Keine Weltdaten zum Sichern',
    );
    expect(s.t.app.hzCore.games.backups(g.id)).toEqual([]);
    await stepUp(s.t, s.secret, s.cookie);
    const del = await gameRequest(s, 'DELETE', `/api/games/${g.id}`, { confirmName: 'survival' });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });
    expect(rpcsOf(s, 'game.remove')).toHaveLength(1);
  });
});

describe('games: setup failures', () => {
  it('a failing pull fails the setup with a crit alert', async () => {
    const s = await setup();
    s.behaviour.fail['compose.pull'] = {
      code: 'failed',
      message: 'compose pull failed: manifest unknown',
    };
    const res = await createGame(s);
    const { game } = gameResponseSchema.parse(res.json());
    await s.t.app.hzCore.games.idle();
    expect(s.t.app.hzCore.games.summary(game.id)).toMatchObject({
      status: 'crit',
      statusText:
        'Aufsetzen fehlgeschlagen: Image laden fehlgeschlagen: compose pull failed: manifest unknown',
    });
    expect(rpcsOf(s, 'compose.up')).toHaveLength(0);
    const active = s.t.app.hzCore.alerts.list({ state: 'active', limit: 10 });
    expect(active[0]).toMatchObject({
      level: 'crit',
      title: 'Gameserver survival konnte nicht aufgesetzt werden',
    });
    expect(s.t.app.hzCore.games.eventsOf(game.id).at(-1)?.kind).toBe('error');
  });

  it('times out after 10 minutes without an answer', async () => {
    const s = await setup();
    s.behaviour.status = { error: 'connect ECONNREFUSED' };
    const res = await createGame(s);
    const { game } = gameResponseSchema.parse(res.json());
    await s.t.app.hzCore.games.idle();
    for (let i = 0; i < 9; i += 1) await tick(s, 60_000);
    expect(s.t.app.hzCore.games.summary(game.id)?.status).toBe('busy');
    await tick(s, 61_000);
    await tick(s, 5_000);
    expect(s.t.app.hzCore.games.summary(game.id)).toMatchObject({
      status: 'crit',
      statusText: 'Aufsetzen fehlgeschlagen: nach 10 Min nicht bereit',
    });
    // A failed game can be started again by hand.
    s.behaviour.status = ONLINE;
    const start = await gameRequest(s, 'POST', `/api/games/${game.id}/start`);
    expect(start.statusCode).toBe(200);
    await tick(s, 30_000);
    expect(s.t.app.hzCore.games.summary(game.id)?.status).toBe('ok');
  });

  it('agent offline: 409 before anything is stored', async () => {
    const s = await setup();
    s.agent.ws.terminate();
    await until(() => !s.t.app.hzCore.hub.isConnected(s.serverId));
    const res = await createGame(s);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('agent_offline');
    expect(s.t.app.hzCore.games.list()).toEqual([]);
  });

  it('a name is unique per server and ports conflicts are refused', async () => {
    const s = await setup();
    expect((await createGame(s)).statusCode).toBe(202);
    await s.t.app.hzCore.games.idle();
    expect((await createGame(s)).statusCode).toBe(409);
    // 25565 is listening on the server.
    const taken = await createGame(s, { name: 'creative', ports: { game: 25565 } });
    expect(taken.statusCode).toBe(409);
    // The first game's port is not suggested again.
    const second = await createGame(s, { name: 'creative' });
    expect(second.statusCode).toBe(202);
    expect(gameResponseSchema.parse(second.json()).game.ports[0]?.port).toBe(25567);
    await s.t.app.hzCore.games.idle();
    // Valheim: a range of 3 udp ports; 2457 is in use -> 2458..2460.
    const v = await createGame(s, {
      templateId: 'valheim',
      name: 'valheim',
      values: { SERVER_PASS: fakeSecret() },
    });
    expect(v.statusCode).toBe(202);
    expect(gameResponseSchema.parse(v.json()).game.ports).toEqual([
      { name: 'game', port: 2458, protocol: 'udp' },
    ]);
    await s.t.app.hzCore.games.idle();
    const vw = rpcsOf(s, 'compose.write').at(-1)?.params as { files: Record<string, string> };
    expect(vw.files['compose.yml']).toContain("- '2458-2460:2456-2458/udp'");
  });
});
