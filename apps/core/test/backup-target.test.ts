import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BACKUP_TARGET_DEFAULTS,
  backupTargetAlertKey,
  backupTargetResponseSchema,
  type BackupTargetStatusData,
} from '@hz/shared';
import {
  enrollAgent,
  listen,
  until,
  withStepUp,
  type Received,
  type WsClient,
} from './agent-helpers.js';
import { authHeaders, completeSetup, emptyDir, makeApp, type TestApp } from './helpers.js';

let t: TestApp | undefined;
let agent: WsClient | undefined;
const T = (): TestApp => {
  if (!t) throw new Error('no app');
  return t;
};
afterEach(async () => {
  agent?.close();
  agent = undefined;
  await t?.app.close();
  t = undefined;
});

let dataDir = '';
async function setup(modules: Record<string, boolean> = {}) {
  dataDir = emptyDir();
  t = await makeApp({ env: { HZ_DATA_DIR: dataDir }, modules });
  const { cookie } = await completeSetup(t);
  const url = await listen(t);
  const e = await enrollAgent(t, url, cookie);
  agent = e.agent;
  return { t, cookie, serverId: e.serverId, agent: e.agent };
}

const status = (over: Partial<BackupTargetStatusData> = {}): BackupTargetStatusData => ({
  state: 'mounted',
  fs: 'cifs',
  freeBytes: 500 * 1024 ** 3,
  totalBytes: 1000 * 1024 ** 3,
  games: [],
  core: { files: 0, bytes: 0, newest: null },
  ...over,
});

async function put(cookie: string, body: unknown, step = true) {
  const req = () =>
    T().app.inject({
      method: 'PUT',
      url: '/api/storage/backup-target',
      headers: authHeaders(cookie),
      payload: body as Record<string, unknown>,
    });
  return step ? withStepUp(T(), req) : req();
}

async function get(cookie: string) {
  const res = await T().app.inject({
    method: 'GET',
    url: '/api/storage/backup-target',
    headers: authHeaders(cookie),
  });
  expect(res.statusCode).toBe(200);
  return backupTargetResponseSchema.parse(res.json());
}

const run = (cookie: string) =>
  T().app.inject({
    method: 'POST',
    url: '/api/storage/backup-target/run',
    headers: authHeaders(cookie),
  });

/** The only reader of the fake agent's socket (WsClient has one cursor): every frame goes to `handler`. */
function answer(a: WsClient, handler: (m: Received) => void) {
  let on = true;
  void (async () => {
    while (on) {
      const m = await a.next(() => true, 20_000).catch(() => null);
      if (!m || !on) return;
      handler(m);
    }
  })();
  return () => {
    on = false;
  };
}

const ok = (a: WsClient, id: unknown, data: unknown) =>
  a.send({ type: 'rpc.result', id, ok: true, data });

describe('backup target settings', () => {
  it('starts off and saves valid settings with step-up', async () => {
    const s = await setup();
    const v = await get(s.cookie);
    expect(v.settings).toEqual(BACKUP_TARGET_DEFAULTS);
    expect(v.nextRunAt).toBeNull();
    const body = {
      enabled: true,
      serverIds: [s.serverId],
      dbServerId: s.serverId,
      keep: 7,
      time: '04:15',
    };
    const res = await put(s.cookie, body);
    expect(res.statusCode).toBe(200);
    const after = backupTargetResponseSchema.parse(res.json());
    expect(after.settings).toEqual(body);
    expect(after.nextRunAt).not.toBeNull();
    expect(after.servers.map((x) => x.serverId)).toEqual([s.serverId]);
  });
});

describe('backup target run', () => {
  it('read only, full NAS and failed games warn and resolve with an OK entry', async () => {
    const s = await setup();
    await put(s.cookie, {
      enabled: true,
      serverIds: [s.serverId],
      dbServerId: null,
      keep: 7,
      time: '05:00',
    });
    let mode: 'ro' | 'full' | 'failed' | 'ok' = 'ro';
    const stop = answer(s.agent, (m) => {
      if (m.type !== 'rpc') return;
      if (m.action === 'backup.target.status') {
        ok(s.agent, m.id, status(mode === 'ro' ? { state: 'read_only' } : {}));
      } else if (m.action === 'backup.target.sync') {
        const error = mode === 'full' ? 'no_space' : mode === 'failed' ? 'io' : null;
        ok(s.agent, m.id, {
          state: 'mounted',
          games: [
            { gameId: 'mc', copied: error ? 0 : 1, skipped: 0, removed: 0, bytes: 10, error },
          ],
          freeBytes: 1,
          totalBytes: 2,
        });
      }
    });
    const core = T().app.hzCore;
    const mount = backupTargetAlertKey({ serverId: s.serverId, kind: 'mount' });
    const sync = backupTargetAlertKey({ serverId: s.serverId, kind: 'sync' });
    const space = backupTargetAlertKey({ serverId: s.serverId, kind: 'space' });
    const once = async () => {
      expect((await run(s.cookie)).statusCode).toBe(202);
      await until(() => !core.backupTarget.isRunning, 5000);
    };
    await once();
    expect(core.alerts.active(mount)?.title).toMatch(/schreibgeschützt/);
    expect((await get(s.cookie)).servers[0]?.lastRun?.error).toBe('read_only');

    mode = 'full';
    await once();
    expect(core.alerts.active(mount)).toBeNull();
    expect(core.alerts.active(space)?.title).toMatch(/ist voll/);
    expect((await get(s.cookie)).servers[0]?.lastRun?.error).toBe('no_space');

    mode = 'failed';
    await once();
    expect(core.alerts.active(space)).toBeNull();
    expect(core.alerts.active(sync)?.title).toMatch(/nicht vollständig/);
    expect((await get(s.cookie)).servers[0]?.lastRun?.error).toBe('failed');

    mode = 'ok';
    await once();
    stop();
    expect(core.alerts.active(sync)).toBeNull();
    const okEntry = core.alerts
      .list({ state: 'all', limit: 50 })
      .find((a) => a.key === sync && a.level === 'ok');
    expect(okEntry?.body).toBe('1 neue Kopie, 0 GB.');
  });

  it('warns and writes nothing when the share is not mounted, resolves when it is back', async () => {
    const s = await setup();
    await put(s.cookie, {
      enabled: true,
      serverIds: [s.serverId],
      dbServerId: null,
      keep: 7,
      time: '05:00',
    });
    const actions: string[] = [];
    let mounted = false;
    const stop = answer(s.agent, (m) => {
      if (m.type !== 'rpc') return;
      actions.push(m.action as string);
      if (m.action === 'backup.target.status') {
        ok(
          s.agent,
          m.id,
          status(
            mounted ? {} : { state: 'not_mounted', fs: null, freeBytes: null, totalBytes: null },
          ),
        );
      } else if (m.action === 'backup.target.sync') {
        ok(s.agent, m.id, {
          state: 'mounted',
          games: [],
          freeBytes: 1,
          totalBytes: 2,
        });
      }
    });
    expect((await run(s.cookie)).statusCode).toBe(202);
    const core = T().app.hzCore;
    await until(
      () =>
        (core.alerts.active(backupTargetAlertKey({ serverId: s.serverId, kind: 'mount' })) ??
          null) !== null,
    );
    await until(() => !core.backupTarget.isRunning);
    expect(actions).toEqual(['backup.target.status']);
    let v = await get(s.cookie);
    expect(v.servers[0]?.lastRun).toMatchObject({ ok: false, error: 'not_mounted' });

    mounted = true;
    await until(() => !core.backupTarget.isRunning);
    expect((await run(s.cookie)).statusCode).toBe(202);
    await until(
      () =>
        core.alerts.active(backupTargetAlertKey({ serverId: s.serverId, kind: 'mount' })) === null,
    );
    await until(() => !core.backupTarget.isRunning, 5000);
    stop();
    expect(actions.slice(1)).toEqual([
      'backup.target.status',
      'backup.target.sync',
      'backup.target.status',
    ]);
    v = await get(s.cookie);
    expect(v.servers[0]?.lastRun).toMatchObject({ ok: true, error: null });
    expect(v.servers[0]?.status?.state).toBe('mounted');
  });

  it('sends a verified database snapshot and deletes its temp file', async () => {
    const s = await setup();
    await put(s.cookie, {
      enabled: true,
      serverIds: [],
      dbServerId: s.serverId,
      keep: 7,
      time: '05:00',
    });
    const parts: Buffer[] = [];
    let params: Record<string, unknown> = {};
    let streamId = '';
    const stop = answer(s.agent, (m) => {
      if (m.type === 'rpc' && m.action === 'backup.target.status') ok(s.agent, m.id, status());
      else if (m.type === 'rpc' && m.action === 'backup.target.store') {
        params = m.params as Record<string, unknown>;
        streamId = m.id as string;
        ok(s.agent, m.id, { streamId });
      } else if (m.type === 'transfer.chunk') {
        parts.push(Buffer.from(m.data as string, 'base64'));
        s.agent.send({ type: 'transfer.ack', streamId, seq: m.seq });
      } else if (m.type === 'transfer.end') {
        const all = Buffer.concat(parts);
        const sha256 = createHash('sha256').update(all).digest('hex');
        const result = { fileName: params.fileName, bytes: all.length, sha256, removed: 0 };
        s.agent.send({
          type: 'stream.data',
          streamId,
          channel: 'progress',
          chunk: `result ${JSON.stringify(result)}\n`,
        });
        s.agent.send({ type: 'stream.end', streamId, code: 0 });
      }
    });
    expect((await run(s.cookie)).statusCode).toBe(202);
    const core = T().app.hzCore;
    await until(() => !core.backupTarget.isRunning, 10_000);
    stop();
    const all = Buffer.concat(parts);
    expect(all.subarray(0, 15).toString()).toBe('SQLite format 3');
    expect(params.sha256).toBe(createHash('sha256').update(all).digest('hex'));
    expect(params.fileName).toMatch(/^homelab-zentrale-\d{8}-\d{4}\.sqlite$/);
    const v = await get(s.cookie);
    expect(v.db.lastRun).toMatchObject({ ok: true, fileName: params.fileName, bytes: all.length });
    expect(readdirSync(dataDir).filter((f) => f.startsWith('.export-'))).toEqual([]);
  });

  it('raises an alert when the agent breaks the transfer, and cleans up', async () => {
    const s = await setup();
    await put(s.cookie, {
      enabled: true,
      serverIds: [],
      dbServerId: s.serverId,
      keep: 7,
      time: '05:00',
    });
    let streamId = '';
    let cancelled = false;
    const stop = answer(s.agent, (m) => {
      if (m.type === 'rpc' && m.action === 'backup.target.status') ok(s.agent, m.id, status());
      else if (m.type === 'rpc' && m.action === 'backup.target.store') {
        streamId = m.id as string;
        ok(s.agent, m.id, { streamId });
      } else if (m.type === 'transfer.chunk' && m.seq === 0) {
        s.agent.send({ type: 'transfer.ack', streamId, seq: 999 });
      } else if (m.type === 'stream.cancel') cancelled = true;
    });
    expect((await run(s.cookie)).statusCode).toBe(202);
    const core = T().app.hzCore;
    await until(() => !core.backupTarget.isRunning, 10_000);
    stop();
    expect(core.alerts.active(backupTargetAlertKey({ kind: 'db' }))?.level).toBe('warn');
    expect((await get(s.cookie)).db.lastRun).toMatchObject({ ok: false, error: 'failed' });
    expect(readdirSync(dataDir).filter((f) => f.startsWith('.export-'))).toEqual([]);
    // The core cancelled the stream on the agent.
    await until(() => cancelled);
  });

  it('runs at the configured local time (the scheduler calls tick every minute)', async () => {
    const s = await setup();
    await put(s.cookie, {
      enabled: true,
      serverIds: [s.serverId],
      dbServerId: null,
      keep: 7,
      time: '05:00',
    });
    const actions: string[] = [];
    const stop = answer(s.agent, (m) => {
      if (m.type !== 'rpc') return;
      actions.push(m.action as string);
      ok(
        s.agent,
        m.id,
        status({ state: 'not_mounted', fs: null, freeBytes: null, totalBytes: null }),
      );
    });
    const core = T().app.hzCore;
    const next = core.backupTarget.nextRunAt ?? 0;
    expect(next).toBeGreaterThan(0);
    T().clock.t = next - 1000;
    core.backupTarget.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(actions).toEqual([]);
    T().clock.t = next + 1000;
    core.backupTarget.tick();
    await until(() => actions.length > 0);
    stop();
    expect(core.backupTarget.nextRunAt).toBeGreaterThan(next);
  });
});
