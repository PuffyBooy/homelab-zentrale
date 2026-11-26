import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_CLOSE,
  gameFolderNameSchema,
  TRANSFER_CHUNK_BYTES,
  TRANSFER_WINDOW,
} from '@hz/shared';
import { auditLog } from '../src/db/schema.js';
import { stepUp, until, withStepUp, type WsClient } from './agent-helpers.js';
import { readyGame, rpcsOf } from './games-helpers.js';
import { SAME_ORIGIN, type TestApp } from './helpers.js';
import {
  actionsOf,
  archive,
  installExport,
  keepAlive,
  settled,
  startMigration,
  withTwoServers,
  type MigrateSetup,
} from './migrate-helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

async function setup(imp: Parameters<typeof withTwoServers>[1] = {}): Promise<MigrateSetup> {
  const m = await withTwoServers(clients, imp);
  t = m.s.t;
  return m;
}

describe('migration routes: auth', () => {
  it('401 without a session on every migration route', async () => {
    const m = await setup();
    const id = m.gameId;
    const target = m.target.serverId;
    const calls = [
      {
        method: 'POST' as const,
        url: `/api/games/${id}/migrate`,
        payload: { targetServerId: target },
      },
      { method: 'GET' as const, url: `/api/games/${id}/migration` },
      {
        method: 'GET' as const,
        url: `/api/games/${id}/migration/suggest?targetServerId=${target}`,
      },
      { method: 'POST' as const, url: `/api/games/${id}/migration/cancel` },
    ];
    for (const c of calls) {
      const res = await m.s.t.app.inject({ ...c, headers: SAME_ORIGIN });
      expect(res.statusCode, c.url).toBe(401);
    }
    expect(rpcsOf(m.s, 'game.export')).toHaveLength(0);
  });

  it('starting a migration needs step-up', async () => {
    const m = await setup();
    const res = await startMigration(m.s, m.gameId, { targetServerId: m.target.serverId });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'step_up_required' });
    expect(rpcsOf(m.s, 'game.export')).toHaveLength(0);
    expect(rpcsOf(m.s, 'compose.down')).toHaveLength(0);
    installExport(m.s, { data: archive(100) });
    await stepUp(m.s.t, m.s.secret, m.s.cookie);
    const ok = await startMigration(m.s, m.gameId, { targetServerId: m.target.serverId });
    expect(ok.statusCode).toBe(202);
    await settled(m.s, m.gameId);
  });

  it('404 with the games module off', async () => {
    const m = await setup();
    await withStepUp(m.s.t, () =>
      m.s.t.app.inject({
        method: 'PUT',
        url: '/api/settings/modules',
        headers: m.s.headers,
        payload: { github: true, homeassistant: true, games: false },
      }),
    );
    const res = await m.s.t.app.inject({
      method: 'GET',
      url: `/api/games/${m.gameId}/migration`,
      headers: m.s.headers,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'module_disabled' });
  });
});

describe('migration routes: input', () => {
  it('400 for target = source, invalid ids and extra fields; 404 for unknown', async () => {
    const m = await setup();
    const { s } = m;
    await stepUp(s.t, s.secret, s.cookie);
    const same = await startMigration(s, m.gameId, { targetServerId: s.serverId });
    expect(same.statusCode).toBe(400);
    expect(same.json()).toMatchObject({ error: 'invalid_input' });
    for (const body of [
      { targetServerId: '../../etc' },
      { targetServerId: m.target.serverId, dir: '/opt/homelab/games/x' },
      { targetServerId: m.target.serverId, ports: { game: 80 } },
      { targetServerId: m.target.serverId, ports: {} },
      {},
    ]) {
      const res = await startMigration(s, m.gameId, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(
      (await startMigration(s, m.gameId, { targetServerId: 'unknown-server-1' })).statusCode,
    ).toBe(404);
    expect(
      (await startMigration(s, 'unknown-game-1', { targetServerId: m.target.serverId })).statusCode,
    ).toBe(404);
    expect(rpcsOf(s, 'game.export')).toHaveLength(0);
    const refused = s.t.db.db
      .select()
      .from(auditLog)
      .all()
      .filter((a) => a.action === 'game.migrate_refused');
    expect(refused.length).toBeGreaterThanOrEqual(2);
  });

  it('409 when the target agent is offline', async () => {
    const m = await setup();
    const { s } = m;
    await stepUp(s.t, s.secret, s.cookie);
    m.target.ws.ws.terminate();
    await until(() => !s.t.app.hzCore.hub.isConnected(m.target.serverId));
    const res = await startMigration(s, m.gameId, { targetServerId: m.target.serverId });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'agent_offline' });
  });

  it('one migration per game and per target at a time', async () => {
    const m = await setup();
    const { s } = m;
    const second = await readyGame(s, { name: 'creative' });
    await stepUp(s.t, s.secret, s.cookie);
    const ctl = installExport(s, { data: archive(100), holdBegin: true });
    expect(
      (await startMigration(s, m.gameId, { targetServerId: m.target.serverId })).statusCode,
    ).toBe(202);
    const again = await startMigration(s, m.gameId, { targetServerId: m.target.serverId });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: 'busy' });
    const other = await startMigration(s, second.id, { targetServerId: m.target.serverId });
    expect(other.statusCode).toBe(409);
    expect(other.json()).toMatchObject({ error: 'busy' });
    // While migrating, other game actions are refused too.
    const start = await s.t.app.inject({
      method: 'POST',
      url: `/api/games/${m.gameId}/start`,
      headers: s.headers,
    });
    expect(start.statusCode).toBe(409);
    await until(() => rpcsOf(s, 'game.export').length === 1);
    ctl.release();
    expect((await settled(s, m.gameId)).phase).toBe('done');
  });
});

describe('migration: only game folders, transfer frames checked', () => {
  it('agents only get folder names and paths below /opt/homelab/games/', async () => {
    const m = await setup();
    const { s } = m;
    await stepUp(s.t, s.secret, s.cookie);
    installExport(s, { data: archive(2 * TRANSFER_CHUNK_BYTES + 5) });
    await startMigration(s, m.gameId, { targetServerId: m.target.serverId });
    expect((await settled(s, m.gameId)).phase).toBe('done');
    const exp = rpcsOf(s, 'game.export')[0]?.params as Record<string, unknown>;
    expect(Object.keys(exp).sort()).toEqual(['gameId', 'maxBytes']);
    expect(gameFolderNameSchema.safeParse(exp.gameId).success).toBe(true);
    const imp = actionsOf(m.target.rpcs, 'game.import')[0]?.params as Record<string, unknown>;
    expect(Object.keys(imp).sort()).toEqual(['bytes', 'chunks', 'gameId', 'sha256']);
    expect(imp.gameId).toBe('survival');
    for (const r of [...s.rpcs, ...m.target.rpcs]) {
      const p = r.params as Record<string, unknown>;
      for (const key of ['dir', 'gameDir']) {
        if (typeof p[key] === 'string') {
          expect(p[key] as string).toMatch(/^\/opt\/homelab\/games\/[a-z0-9-]+$/);
        }
      }
    }
  });

  it('transfer frames for unknown streams or from the wrong server are ignored', async () => {
    const m = await setup();
    const { s } = m;
    await stepUp(s.t, s.secret, s.cookie);
    const ctl = installExport(s, { data: archive(3 * TRANSFER_CHUNK_BYTES), stopAfterChunks: 1 });
    await startMigration(s, m.gameId, { targetServerId: m.target.serverId });
    await until(() => m.target.chunks.length === 1);
    const exportId = ctl.streamIds[0] as string;
    const evil = Buffer.alloc(TRANSFER_CHUNK_BYTES, 0x41).toString('base64');
    // The target pretends to be the source of the export stream.
    m.target.ws.send({ type: 'transfer.chunk', streamId: exportId, seq: 1, data: evil });
    m.target.ws.send({
      type: 'transfer.end',
      streamId: exportId,
      chunks: 3,
      bytes: 3 * TRANSFER_CHUNK_BYTES,
      sha256: 'c'.repeat(64),
    });
    // The source sends frames for a stream id the core never opened.
    s.agent.send({ type: 'transfer.chunk', streamId: 'never-opened-1', seq: 0, data: evil });
    s.agent.send({ type: 'transfer.ack', streamId: 'never-opened-1', seq: 0 });
    await keepAlive(m.target);
    await s.keepAlive();
    expect(m.target.chunks).toHaveLength(1);
    ctl.release();
    const mig = await settled(s, m.gameId);
    expect(mig.phase).toBe('done');
    expect(m.target.chunks.map((c) => c.seq)).toEqual([0, 1, 2]);
  });

  it('a flood of stray transfer frames closes the agent connection', async () => {
    const m = await setup();
    const frame = { type: 'transfer.ack', streamId: 'never-opened-1', seq: 0 };
    for (let i = 0; i < 30; i += 1) m.target.ws.send(frame);
    const closed = await m.target.ws.closed;
    expect(closed.code).toBe(AGENT_CLOSE.POLICY);
  });

  it('backpressure: in flight never exceeds the window; a source ignoring it is aborted', async () => {
    const m = await setup({ holdAcks: true });
    const { s } = m;
    await stepUp(s.t, s.secret, s.cookie);
    // A well-behaved source stops at the window while the target does not ack.
    const ctl = installExport(s, { data: archive(40 * TRANSFER_CHUNK_BYTES) });
    await startMigration(s, m.gameId, { targetServerId: m.target.serverId });
    await until(() => m.target.chunks.length === TRANSFER_WINDOW);
    await s.keepAlive();
    await keepAlive(m.target);
    expect(ctl.sent).toBe(TRANSFER_WINDOW);
    expect(m.target.chunks).toHaveLength(TRANSFER_WINDOW);
    // Acks for chunks the core never forwarded abort the transfer.
    m.target.ws.send({
      type: 'transfer.ack',
      streamId: actionsOf(m.target.rpcs, 'game.import')[0]?.id,
      seq: TRANSFER_WINDOW + 3,
    });
    const mig = await settled(s, m.gameId);
    expect(mig.phase).toBe('failed');
    expect(s.running.has('survival')).toBe(true);
  });

  it('backpressure: a source that sends beyond the window is aborted, core forwards ≤ window', async () => {
    const m = await setup({ holdAcks: true });
    const { s } = m;
    await stepUp(s.t, s.secret, s.cookie);
    installExport(s, { data: archive(40 * TRANSFER_CHUNK_BYTES), ignoreWindow: true });
    await startMigration(s, m.gameId, { targetServerId: m.target.serverId });
    const mig = await settled(s, m.gameId);
    expect(mig.phase).toBe('failed');
    expect(mig.error).toBe('export_failed');
    expect(m.target.chunks.length).toBeLessThanOrEqual(TRANSFER_WINDOW);
    expect(s.t.app.hzCore.hub.bufferedAmount(m.target.serverId)).toBe(0);
  });
});
