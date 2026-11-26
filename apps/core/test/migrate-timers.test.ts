import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRANSFER_CHUNK_BYTES } from '@hz/shared';
import type { SetTimer } from '../src/clock.js';
import { MigrationService } from '../src/games/migrate.js';
import { BACKUP_TIMEOUT_MS } from '../src/games/service.js';
import { Scheduler } from '../src/scheduler.js';
import { metricsMsg, stepUp, until, type Received, type WsClient } from './agent-helpers.js';
import { rpcsOf, type GameSetup } from './games-helpers.js';
import type { TestApp } from './helpers.js';
import {
  actionsOf,
  archive,
  installExport,
  keepAlive,
  reached,
  settled,
  startMigration,
  withTwoServers,
  type ImportBehaviour,
  type MigrateSetup,
} from './migrate-helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

async function setup(imp: ImportBehaviour = {}): Promise<MigrateSetup> {
  const m = await withTwoServers(clients, imp);
  t = m.s.t;
  await stepUp(m.s.t, m.s.secret, m.s.cookie);
  return m;
}

/** Manual timer: nothing fires until advance(). */
function fakeTimer() {
  let now = 0;
  const pending = new Set<{ at: number; fn: () => void }>();
  const set: SetTimer = (fn, ms) => {
    const e = { at: now + ms, fn };
    pending.add(e);
    return () => pending.delete(e);
  };
  return {
    set,
    get pending() {
      return pending.size;
    },
    advance(ms: number) {
      now += ms;
      for (const e of [...pending].sort((a, b) => a.at - b.at)) {
        if (e.at > now || !pending.has(e)) continue;
        pending.delete(e);
        e.fn();
      }
    },
  };
}

/** A MigrationService on the app's hub/games with a fake timer. */
function serviceWith(s: GameSetup, timer: SetTimer): MigrationService {
  const core = s.t.app.hzCore;
  return new MigrationService({
    db: s.t.db.db,
    now: () => s.t.clock.t,
    hub: core.hub,
    games: core.games,
    scheduler: new Scheduler(() => s.t.clock.t),
    log: s.t.app.log,
    timer,
  });
}

const phaseOf = (s: GameSetup, gameId: string): string | undefined =>
  (
    s.t.db.sqlite
      .prepare('SELECT phase FROM game_migrations WHERE game_id = ? ORDER BY started_at DESC')
      .get(gameId) as { phase: string } | undefined
  )?.phase;

/** Lets frames and promise chains run (a failure would show up in the DB). */
async function flush(m: MigrateSetup): Promise<void> {
  await m.s.keepAlive();
  await keepAlive(m.target);
}

describe('migration timeouts are cleared after their wait', () => {
  it('long transfer and long extraction after an early accept: still done', async () => {
    const m = await setup({ holdEnd: true });
    const { s } = m;
    const timer = fakeTimer();
    const svc = serviceWith(s, timer.set);
    const ctl = installExport(s, {
      data: archive(3 * TRANSFER_CHUNK_BYTES + 77),
      stopAfterChunks: 1,
    });
    svc.begin(m.gameId, { targetServerId: m.target.serverId });

    // The import was accepted and the first chunk is through: transfer runs.
    await until(() => m.target.chunks.length === 1);
    await flush(m);
    expect(phaseOf(s, m.gameId)).toBe('transfer');
    // No timeout of an earlier wait (begin, import accept) is left over.
    expect(timer.pending).toBe(0);
    timer.advance(61_000);
    timer.advance(BACKUP_TIMEOUT_MS);
    await flush(m);
    expect(phaseOf(s, m.gameId)).toBe('transfer');

    // The rest arrives; the target extracts (held) for longer than 61 s.
    ctl.release();
    await reached(s, m.gameId, 'restore');
    // Only the timeout of the import end (2 h) is armed, not the export end.
    await until(() => timer.pending === 1);
    timer.advance(61_000);
    await flush(m);
    expect(phaseOf(s, m.gameId)).toBe('restore');

    m.target.releaseEnd();
    const mig = await settled(s, m.gameId);
    expect(mig.phase).toBe('done');
    expect(mig.error).toBeNull();
    expect(m.target.running.has('survival')).toBe(true);
    await svc.idle();
    expect(timer.pending).toBe(0);
  });

  it('a timeout that is due still fails the migration (no transfer.begin)', async () => {
    const m = await setup();
    const { s } = m;
    const timer = fakeTimer();
    const svc = serviceWith(s, timer.set);
    installExport(s, { data: archive(1000), holdBegin: true });
    svc.begin(m.gameId, { targetServerId: m.target.serverId });
    await until(() => rpcsOf(s, 'game.export').length === 1);
    await until(() => timer.pending === 1);
    timer.advance(BACKUP_TIMEOUT_MS);
    const mig = await settled(s, m.gameId);
    expect(mig.phase).toBe('failed');
    expect(mig.error).toBe('timeout');
    expect(mig.failedPhase).toBe('backup');
    await svc.idle();
    expect(timer.pending).toBe(0);
  });
});

interface Hold {
  serverId: string;
  bytes: number;
  released: boolean;
}

/** Records every RAM hold of the throttle service and whether it was released. */
function trackHolds(s: GameSetup): Hold[] {
  const holds: Hold[] = [];
  const throttle = s.t.app.hzCore.throttle;
  const orig = throttle.holdRam.bind(throttle);
  vi.spyOn(throttle, 'holdRam').mockImplementation((serverId, bytes) => {
    const h: Hold = { serverId, bytes, released: false };
    holds.push(h);
    const release = orig(serverId, bytes);
    return () => {
      h.released = true;
      release();
    };
  });
  return holds;
}

/** Number of unreleased holds on `serverId` at each compose.up the agent receives. */
function heldAtUp(ws: WsClient, holds: Hold[], serverId: string): number[] {
  const seen: number[] = [];
  ws.ws.on('message', (raw) => {
    const m = JSON.parse(String(raw)) as Received;
    if (m.type === 'rpc' && m.action === 'compose.up') {
      seen.push(holds.filter((h) => h.serverId === serverId && !h.released).length);
    }
  });
  return seen;
}

describe('migration starts hold the RAM reserve until compose up returned', () => {
  it('target start: RAM held during compose up, released afterwards', async () => {
    const m = await setup();
    const { s } = m;
    const holds = trackHolds(s);
    const seen = heldAtUp(m.target.ws, holds, m.target.serverId);
    installExport(s, { data: archive(1000) });
    expect(
      (await startMigration(s, m.gameId, { targetServerId: m.target.serverId })).statusCode,
    ).toBe(202);
    const mig = await settled(s, m.gameId);
    expect(mig.phase).toBe('done');
    expect(seen).toEqual([1]);
    expect(holds.filter((h) => h.serverId === m.target.serverId).length).toBeGreaterThan(0);
    expect(holds.every((h) => h.released)).toBe(true);
    expect(holds.every((h) => h.bytes > 0)).toBe(true);
  });

  it('source restart after a failure: RAM held during compose up, released afterwards', async () => {
    const m = await setup();
    const { s } = m;
    const holds = trackHolds(s);
    const seen = heldAtUp(s.agent, holds, s.serverId);
    installExport(s, { data: archive(1000), holdBegin: true });
    await startMigration(s, m.gameId, { targetServerId: m.target.serverId });
    await until(() => rpcsOf(s, 'game.export').length === 1);
    const res = await s.t.app.inject({
      method: 'POST',
      url: `/api/games/${m.gameId}/migration/cancel`,
      headers: s.headers,
    });
    expect(res.statusCode).toBe(200);
    const mig = await settled(s, m.gameId);
    expect(mig.error).toBe('cancelled');
    expect(s.running.has('survival')).toBe(true);
    expect(seen).toEqual([1]);
    expect(holds.every((h) => h.released)).toBe(true);
  });

  it('source restart is refused when the RAM reserve does not fit (no compose up)', async () => {
    const m = await setup();
    const { s } = m;
    installExport(s, { data: archive(1000), holdBegin: true });
    await startMigration(s, m.gameId, { targetServerId: m.target.serverId });
    await until(() => rpcsOf(s, 'game.export').length === 1);
    // The source is stopped for the backup; meanwhile its RAM is gone.
    s.agent.send(metricsMsg({ ramPct: 97 }));
    await s.keepAlive();
    const ups = rpcsOf(s, 'compose.up').length;
    await s.t.app.inject({
      method: 'POST',
      url: `/api/games/${m.gameId}/migration/cancel`,
      headers: s.headers,
    });
    const mig = await settled(s, m.gameId);
    expect(mig.error).toBe('cancelled');
    expect(rpcsOf(s, 'compose.up').length).toBe(ups);
    expect(s.running.has('survival')).toBe(false);
    expect(actionsOf(m.target.rpcs, 'compose.up')).toHaveLength(0);
  });
});
