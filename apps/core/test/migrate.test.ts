import { afterEach, describe, expect, it } from 'vitest';
import { migrationSuggestResponseSchema, TRANSFER_CHUNK_BYTES } from '@hz/shared';
import { auditLog, gameMigrations, gameServers } from '../src/db/schema.js';
import { MigrationService } from '../src/games/migrate.js';
import { Scheduler } from '../src/scheduler.js';
import { metricsMsg, stepUp, until, type WsClient } from './agent-helpers.js';
import { rpcsOf, tick } from './games-helpers.js';
import type { TestApp } from './helpers.js';
import {
  actionsOf,
  archive,
  installExport,
  keepAlive,
  reconnect,
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

async function setup(...args: Parameters<typeof withTwoServers>[1][]): Promise<MigrateSetup> {
  const m = await withTwoServers(clients, args[0] ?? {});
  t = m.s.t;
  await stepUp(m.s.t, m.s.secret, m.s.cookie);
  return m;
}

const audits = (m: MigrateSetup, action: string) =>
  m.s.t.db.db
    .select()
    .from(auditLog)
    .all()
    .filter((a) => a.action === action);

const gameRow = (m: MigrateSetup) =>
  m.s.t.db.db
    .select()
    .from(gameServers)
    .all()
    .find((g) => g.id === m.gameId);

describe('game migration', () => {
  it('moves a running game to the target: runs there afterwards, old one stopped', async () => {
    const m = await setup();
    const { s } = m;
    const data = archive(3 * TRANSFER_CHUNK_BYTES + 1234);
    installExport(s, { data });
    const before = gameRow(m);
    const createEnv = (rpcsOf(s, 'compose.write')[0]?.params as { files: Record<string, string> })
      .files['.env'];
    const res = await startMigration(s, m.gameId, { targetServerId: m.target.serverId });
    expect(res.statusCode).toBe(202);
    const mig = await settled(s, m.gameId);
    expect(mig.phase).toBe('done');
    expect(mig.error).toBeNull();
    expect(mig.progress).toEqual({ bytesDone: data.length, bytesTotal: data.length });
    expect(mig.sourceServerName).toBe('heimserver');
    expect(mig.targetServerName).toBe('cloud');
    // 25566 is taken on the target: the next free port, with the forwarding hint.
    expect(mig.ports).toEqual([
      { name: 'game', port: 25567, protocol: 'tcp', count: 1, local: false },
    ]);
    expect(mig.forwardingHint).toBe('Portweiterleitung am Ziel einrichten: game 25567 (TCP)');
    expect(mig.rollback).toContain('heimserver');

    // Source: saved via RCON, stopped (compose down) before the export, never removed.
    expect(rpcsOf(s, 'game.rcon').map((r) => (r.params as { command: string }).command)).toContain(
      'save-all',
    );
    const order = s.rpcs.map((r) => r.action);
    expect(order.lastIndexOf('compose.down')).toBeLessThan(order.lastIndexOf('game.export'));
    expect(rpcsOf(s, 'game.remove')).toHaveLength(0);
    expect(s.running.has('survival')).toBe(false);

    // Target: import, compose.write with the new port and the same RCON password, up.
    expect(actionsOf(m.target.rpcs, 'game.import')).toHaveLength(1);
    expect(m.target.chunks.map((c) => c.seq)).toEqual([0, 1, 2, 3]);
    const write = actionsOf(m.target.rpcs, 'compose.write')[0]?.params as {
      dir: string;
      files: Record<string, string>;
    };
    expect(write.dir).toBe('/opt/homelab/games/survival');
    expect(write.files['compose.yml']).toContain('25567');
    const pw = (env: string | undefined) => /RCON_PASSWORD=(.*)/.exec(env ?? '')?.[1];
    expect(pw(write.files['.env'])).toBeTruthy();
    expect(pw(write.files['.env'])).toBe(pw(createEnv));
    expect(actionsOf(m.target.rpcs, 'compose.up')).toHaveLength(1);
    expect(actionsOf(m.target.rpcs, 'game.remove')).toHaveLength(0);
    expect(m.target.running.has('survival')).toBe(true);

    // The record points to the target; same id and same encrypted RCON secret.
    const after = gameRow(m);
    expect(after?.serverId).toBe(m.target.serverId);
    expect(after?.rconSecretEnc).toBe(before?.rconSecretEnc);
    expect(JSON.parse(after?.portsJson ?? '[]')).toEqual([
      { name: 'game', port: 25567, protocol: 'tcp', count: 1, local: false },
    ]);
    // The next status poll asks the target.
    await tick(s, 30_000);
    const summary = s.t.app.hzCore.games.summary(m.gameId);
    expect(summary?.serverName).toBe('cloud');
    expect(summary?.status).toBe('ok');
    expect(summary?.address.endsWith(':25567')).toBe(true);

    expect(audits(m, 'game.migrate_started')).toHaveLength(1);
    const done = audits(m, 'game.migrate_done');
    expect(done).toHaveLength(1);
    expect(JSON.parse(done[0]?.detailsJson ?? '{}')).toMatchObject({
      source: s.serverId,
      target: m.target.serverId,
      bytes: data.length,
    });
    const events = s.t.app.hzCore.games.eventsOf(m.gameId).map((e) => e.text);
    expect(events).toContain('Umzug: Übertragung');
    expect(events.some((e) => e.startsWith('Umzug nach cloud fertig'))).toBe(true);
    // Response bodies never carry the RCON password.
    const get = await s.t.app.inject({
      method: 'GET',
      url: `/api/games/${m.gameId}/migration`,
      headers: s.headers,
    });
    expect(get.body).not.toContain(pw(createEnv) ?? 'x');
  });

  it('suggests ports, forwarding hint and RAM on the target', async () => {
    const m = await setup();
    const { s } = m;
    const res = await s.t.app.inject({
      method: 'GET',
      url: `/api/games/${m.gameId}/migration/suggest?targetServerId=${m.target.serverId}`,
      headers: s.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = migrationSuggestResponseSchema.parse(res.json());
    expect(body.ports).toEqual({ game: 25567 });
    expect(body.changed).toEqual([
      { name: 'game', protocol: 'tcp', count: 1, from: 25566, to: 25567, local: false },
    ]);
    expect(body.forwardingHint).toBe('Portweiterleitung am Ziel einrichten: game 25567 (TCP)');
    expect(body.freeRamBytes).toBeGreaterThan(0);
    expect(body.ramWarning).toBeNull();

    const same = await s.t.app.inject({
      method: 'GET',
      url: `/api/games/${m.gameId}/migration/suggest?targetServerId=${s.serverId}`,
      headers: s.headers,
    });
    expect(same.statusCode).toBe(400);
    const unknown = await s.t.app.inject({
      method: 'GET',
      url: `/api/games/${m.gameId}/migration/suggest?targetServerId=unknown-server-1`,
      headers: s.headers,
    });
    expect(unknown.statusCode).toBe(404);
    const bad = await s.t.app.inject({
      method: 'GET',
      url: `/api/games/${m.gameId}/migration/suggest?targetServerId=../x`,
      headers: s.headers,
    });
    expect(bad.statusCode).toBe(400);
  });

  it('accepts ports from the request and refuses taken ones', async () => {
    const m = await setup();
    const { s } = m;
    const taken = await startMigration(s, m.gameId, {
      targetServerId: m.target.serverId,
      ports: { game: 25566 },
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ error: 'conflict' });
    const unknownName = await startMigration(s, m.gameId, {
      targetServerId: m.target.serverId,
      ports: { query: 25600 },
    });
    expect(unknownName.statusCode).toBe(400);
    installExport(s, { data: archive(1000) });
    const ok = await startMigration(s, m.gameId, {
      targetServerId: m.target.serverId,
      ports: { game: 25600 },
    });
    expect(ok.statusCode).toBe(202);
    const mig = await settled(s, m.gameId);
    expect(mig.phase).toBe('done');
    expect(mig.ports[0]?.port).toBe(25600);
  });

  it('checksum mismatch: failed, target copy removed, source started again', async () => {
    const m = await setup();
    const { s } = m;
    // The agent ends with a checksum that does not match the bytes it sent; the
    // core recomputes sha256 itself. The import was accepted (a chunk arrived).
    const ctl = installExport(s, {
      data: archive(2 * TRANSFER_CHUNK_BYTES),
      endSha: 'b'.repeat(64),
      stopAfterChunks: 1,
    });
    const ups = rpcsOf(s, 'compose.up').length;
    const res = await startMigration(s, m.gameId, { targetServerId: m.target.serverId });
    expect(res.statusCode).toBe(202);
    await until(() => m.target.chunks.length === 1);
    ctl.release();
    const mig = await settled(s, m.gameId);
    expect(mig.phase).toBe('failed');
    expect(mig.error).toBe('checksum_mismatch');
    expect(mig.failedPhase).toBe('transfer');
    expect(mig.errorText).toBe('Prüfsumme stimmt nicht, Übertragung verworfen');
    expect(mig.rollback).toBe(
      'Die Kopie auf cloud wurde entfernt. Der alte Server heimserver ist unverändert und läuft wieder.',
    );
    expect(actionsOf(m.target.rpcs, 'game.remove')).toHaveLength(1);
    expect(actionsOf(m.target.rpcs, 'compose.write')).toHaveLength(0);
    expect(rpcsOf(s, 'compose.up').length).toBe(ups + 1);
    expect(s.running.has('survival')).toBe(true);
    expect(gameRow(m)?.serverId).toBe(s.serverId);
    expect(gameRow(m)?.phase).toBe('running');
    expect(audits(m, 'game.migrate_failed')).toHaveLength(1);
    expect(s.t.app.hzCore.games.isBusy(m.gameId)).toBe(false);
  });

  it('source agent disconnects mid-transfer: failed, target removed, source restarted later', async () => {
    const m = await setup();
    const { s } = m;
    const ctl = installExport(s, { data: archive(40 * TRANSFER_CHUNK_BYTES), stopAfterChunks: 3 });
    const res = await startMigration(s, m.gameId, { targetServerId: m.target.serverId });
    expect(res.statusCode).toBe(202);
    await until(() => m.target.chunks.length === 3);
    expect(ctl.sent).toBe(3);
    s.agent.ws.terminate();
    const mig = await settled(s, m.gameId);
    expect(mig.phase).toBe('failed');
    expect(mig.error).toBe('agent_offline');
    expect(actionsOf(m.target.rpcs, 'game.remove')).toHaveLength(1);
    // The source is offline: the restart is pending.
    expect(mig.rollback).toContain('wird wieder gestartet, sobald er verbunden ist');
    const row = s.t.db.db.select().from(gameMigrations).all()[0];
    expect(row?.restartSource).toBe(true);
    expect(row?.cleanupTarget).toBe(false);
    expect(gameRow(m)?.serverId).toBe(s.serverId);

    // The source comes back: the cleanup job starts the game again.
    const back = await reconnect(s, s.url, s.agentToken, s.serverId, 'heimserver', clients);
    s.t.clock.advance(15_000);
    await s.t.app.hzCore.scheduler.tick();
    await until(() => actionsOf(back.rpcs, 'compose.up').length === 1);
    await until(() => s.t.db.db.select().from(gameMigrations).all()[0]?.restartSource === false);
    const final = s.t.db.db.select().from(gameMigrations).all()[0];
    expect(final?.rollback).toContain('läuft wieder');
  });

  it('too large: refused by the source agent, or more bytes than announced', async () => {
    const m = await setup();
    const { s } = m;
    installExport(s, { data: archive(10), failWith: 'too_large' });
    await startMigration(s, m.gameId, { targetServerId: m.target.serverId });
    const first = await settled(s, m.gameId);
    expect(first.error).toBe('too_large');
    expect(first.failedPhase).toBe('backup');
    // Nothing reached the target, so nothing is removed there.
    expect(actionsOf(m.target.rpcs, 'game.import')).toHaveLength(0);
    expect(actionsOf(m.target.rpcs, 'game.remove')).toHaveLength(0);
    expect(first.rollback).toBe('Der alte Server heimserver ist unverändert und läuft wieder.');
    await s.keepAlive();
    await keepAlive(m.target);
  });

  it('too large: the core stops at the announced size', async () => {
    const m = await setup();
    const { s } = m;
    // Announces less than it sends (same chunk count): the core refuses the excess.
    const ctl = installExport(s, {
      data: archive(3 * TRANSFER_CHUNK_BYTES),
      beginBytes: 2 * TRANSFER_CHUNK_BYTES + 10,
      stopAfterChunks: 1,
    });
    await startMigration(s, m.gameId, { targetServerId: m.target.serverId });
    await until(() => m.target.chunks.length === 1);
    ctl.release();
    const mig = await settled(s, m.gameId);
    expect(mig.error).toBe('too_large');
    expect(m.target.chunks.length).toBeLessThanOrEqual(2);
    expect(actionsOf(m.target.rpcs, 'game.remove')).toHaveLength(1);
  });

  it('cancel before start: failed/cancelled, streams cancelled, rollback', async () => {
    const m = await setup();
    const { s } = m;
    installExport(s, { data: archive(10 * TRANSFER_CHUNK_BYTES), stopAfterChunks: 2 });
    const none = await s.t.app.inject({
      method: 'POST',
      url: `/api/games/${m.gameId}/migration/cancel`,
      headers: s.headers,
    });
    expect(none.statusCode).toBe(409);
    await startMigration(s, m.gameId, { targetServerId: m.target.serverId });
    await until(() => m.target.chunks.length === 2);
    const res = await s.t.app.inject({
      method: 'POST',
      url: `/api/games/${m.gameId}/migration/cancel`,
      headers: s.headers,
    });
    expect(res.statusCode).toBe(200);
    const mig = await settled(s, m.gameId);
    expect(mig.phase).toBe('failed');
    expect(mig.error).toBe('cancelled');
    expect(mig.failedPhase).toBe('transfer');
    await until(() => s.agent.received.some((r) => r.type === 'stream.cancel'));
    await until(() => m.target.ws.received.some((r) => r.type === 'stream.cancel'));
    expect(actionsOf(m.target.rpcs, 'game.remove')).toHaveLength(1);
    expect(s.running.has('survival')).toBe(true);
    expect(audits(m, 'game.migrate_cancel')).toHaveLength(1);
  });

  it('insufficient RAM on the target: 409 before, failed before the transfer', async () => {
    const m = await setup();
    const { s } = m;
    m.target.ws.send(metricsMsg({ ramPct: 95 }));
    await keepAlive(m.target);
    const res = await startMigration(s, m.gameId, { targetServerId: m.target.serverId });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'insufficient_ram' });
    expect(rpcsOf(s, 'game.export')).toHaveLength(0);

    // RAM was fine at the start but is gone when the archive is ready.
    m.target.ws.send(metricsMsg({ ramPct: 40 }));
    await keepAlive(m.target);
    const ctl = installExport(s, { data: archive(1000), holdBegin: true });
    expect(
      (await startMigration(s, m.gameId, { targetServerId: m.target.serverId })).statusCode,
    ).toBe(202);
    await until(() => rpcsOf(s, 'game.export').length === 1);
    m.target.ws.send(metricsMsg({ ramPct: 95 }));
    await keepAlive(m.target);
    ctl.release();
    const mig = await settled(s, m.gameId);
    expect(mig.error).toBe('insufficient_ram');
    expect(mig.failedPhase).toBe('transfer');
    expect(actionsOf(m.target.rpcs, 'game.import')).toHaveLength(0);
    expect(s.running.has('survival')).toBe(true);
  });

  it('target refuses the import (folder exists): nothing removed on the target', async () => {
    const m = await setup({ refuse: { code: 'busy', message: 'data exists' } });
    const { s } = m;
    installExport(s, { data: archive(1000) });
    await startMigration(s, m.gameId, { targetServerId: m.target.serverId });
    const mig = await settled(s, m.gameId);
    expect(mig.error).toBe('target_exists');
    expect(actionsOf(m.target.rpcs, 'game.remove')).toHaveLength(0);
    expect(s.running.has('survival')).toBe(true);
  });

  it('a core restart marks a running migration failed (interrupted) and rolls back', async () => {
    const m = await setup();
    const { s } = m;
    const now = s.t.clock.t;
    // Simulate a migration of a previous process that stopped the source and had
    // the import accepted on the target.
    s.t.db.db
      .insert(gameMigrations)
      .values({
        id: 'old-migration-1',
        gameId: m.gameId,
        gameName: 'survival',
        sourceServerId: s.serverId,
        sourceServerName: 'heimserver',
        targetServerId: m.target.serverId,
        targetServerName: 'cloud',
        phase: 'transfer',
        wasRunning: true,
        targetTouched: true,
        startedAt: now,
        updatedAt: now,
      })
      .run();
    const core = s.t.app.hzCore;
    const scheduler = new Scheduler(() => s.t.clock.t);
    const svc = new MigrationService({
      db: s.t.db.db,
      now: () => s.t.clock.t,
      hub: core.hub,
      games: core.games,
      scheduler,
      log: s.t.app.log,
    });
    svc.start();
    const mig = svc.latest(m.gameId);
    expect(mig?.phase).toBe('failed');
    expect(mig?.error).toBe('interrupted');
    expect(mig?.failedPhase).toBe('transfer');
    await core.games.action(m.gameId, 'stop', 'system');
    await svc.cleanupTick();
    expect(actionsOf(m.target.rpcs, 'game.remove')).toHaveLength(1);
    expect(s.running.has('survival')).toBe(true);
    const after = svc.latest(m.gameId);
    expect(after?.rollback).toBe(
      'Die Kopie auf cloud wurde entfernt. Der alte Server heimserver ist unverändert und läuft wieder.',
    );
    expect(audits(m, 'game.migrate_failed')).toHaveLength(1);
  });
});
