import { afterEach, describe, expect, it } from 'vitest';
import { backupTargetAlertKey } from '@hz/shared';
import { enrollAgent, listen, until, withStepUp, type WsClient } from './agent-helpers.js';
import { KEY, authHeaders, completeSetup, emptyDir, makeApp, type TestApp } from './helpers.js';

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

async function setup() {
  t = await makeApp({ env: { HZ_DATA_DIR: emptyDir() } });
  const { cookie } = await completeSetup(t);
  const url = await listen(t);
  const e = await enrollAgent(t, url, cookie);
  agent = e.agent;
  return { cookie, serverId: e.serverId, agent: e.agent };
}

const valid = (serverId: string) => ({
  enabled: true,
  serverIds: [serverId],
  dbServerId: serverId,
  keep: 7,
  time: '05:00',
});

describe('backup target routes', () => {
  it('need an admin session', async () => {
    t = await makeApp();
    for (const [method, url] of [
      ['GET', '/api/storage/backup-target'],
      ['PUT', '/api/storage/backup-target'],
      ['POST', '/api/storage/backup-target/run'],
    ] as const) {
      const res = await t.app.inject(
        method === 'GET' ? { method, url } : { method, url, payload: {} },
      );
      expect(res.statusCode).toBe(401);
    }
  });

  it('changing the target needs step-up (it decides where the database goes)', async () => {
    const s = await setup();
    const res = await T().app.inject({
      method: 'PUT',
      url: '/api/storage/backup-target',
      headers: authHeaders(s.cookie),
      payload: valid(s.serverId),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'step_up_required' });
  });

  it('rejects unknown servers, extra fields and bad values', async () => {
    const s = await setup();
    const bad = [
      { ...valid(s.serverId), serverIds: ['unknownserver01'] },
      { ...valid(s.serverId), dbServerId: 'unknownserver01' },
      { ...valid(s.serverId), path: '/etc' },
      { ...valid(s.serverId), time: '25:00' },
      { ...valid(s.serverId), keep: 0 },
      { ...valid(s.serverId), serverIds: ['../../etc'] },
    ];
    for (const payload of bad) {
      const res = await withStepUp(T(), () =>
        T().app.inject({
          method: 'PUT',
          url: '/api/storage/backup-target',
          headers: authHeaders(s.cookie),
          payload,
        }),
      );
      expect(res.statusCode).toBe(400);
    }
    expect(T().app.hzCore.backupTarget.settings().enabled).toBe(false);
  });

  it('are gone with module storage off, and its alerts are resolved', async () => {
    const s = await setup();
    await withStepUp(T(), () =>
      T().app.inject({
        method: 'PUT',
        url: '/api/storage/backup-target',
        headers: authHeaders(s.cookie),
        payload: valid(s.serverId),
      }),
    );
    const key = backupTargetAlertKey({ serverId: s.serverId, kind: 'mount' });
    T().app.hzCore.alerts.raise(key, 'warn', 'x', 'y', s.serverId, 'system');
    const off = await T().app.inject({
      method: 'PUT',
      url: '/api/settings/modules',
      headers: authHeaders(s.cookie),
      payload: { storage: false },
    });
    expect(off.statusCode).toBe(200);
    expect(T().app.hzCore.alerts.active(key)).toBeNull();
    expect(T().app.hzCore.backupTarget.nextRunAt).toBeNull();
    for (const [method, url] of [
      ['GET', '/api/storage/backup-target'],
      ['POST', '/api/storage/backup-target/run'],
    ] as const) {
      const res = await T().app.inject({ method, url, headers: authHeaders(s.cookie) });
      expect(res.statusCode).toBe(404);
    }
  });

  it('the database copy never contains the secret key', async () => {
    const s = await setup();
    await withStepUp(T(), () =>
      T().app.inject({
        method: 'PUT',
        url: '/api/storage/backup-target',
        headers: authHeaders(s.cookie),
        payload: { ...valid(s.serverId), serverIds: [] },
      }),
    );
    let streamId = '';
    const parts: Buffer[] = [];
    let on = true;
    void (async () => {
      while (on) {
        const m = await s.agent.next(() => true, 20_000).catch(() => null);
        if (!m) return;
        if (m.type === 'rpc' && m.action === 'backup.target.status') {
          s.agent.send({
            type: 'rpc.result',
            id: m.id,
            ok: true,
            data: {
              state: 'mounted',
              fs: 'cifs',
              freeBytes: 1e12,
              totalBytes: 2e12,
              games: [],
              core: { files: 0, bytes: 0, newest: null },
            },
          });
        } else if (m.type === 'rpc' && m.action === 'backup.target.store') {
          streamId = m.id as string;
          s.agent.send({ type: 'rpc.result', id: m.id, ok: true, data: { streamId } });
        } else if (m.type === 'transfer.chunk') {
          parts.push(Buffer.from(m.data as string, 'base64'));
          s.agent.send({ type: 'transfer.ack', streamId, seq: m.seq });
        } else if (m.type === 'transfer.end') {
          s.agent.send({ type: 'stream.end', streamId, code: 1, error: 'io' });
        }
      }
    })();
    const res = await T().app.inject({
      method: 'POST',
      url: '/api/storage/backup-target/run',
      headers: authHeaders(s.cookie),
    });
    expect(res.statusCode).toBe(202);
    await until(() => !T().app.hzCore.backupTarget.isRunning, 10_000);
    on = false;
    const all = Buffer.concat(parts);
    expect(all.length).toBeGreaterThan(0);
    expect(all.includes(Buffer.from(KEY))).toBe(false);
    expect(all.includes(Buffer.from(KEY, 'base64'))).toBe(false);
    // stream.end 1 is a failed copy, not a success.
    expect(T().app.hzCore.backupTarget.view().db.lastRun).toMatchObject({ ok: false });
  });

  it('a second run while one is going on is refused', async () => {
    const s = await setup();
    await withStepUp(T(), () =>
      T().app.inject({
        method: 'PUT',
        url: '/api/storage/backup-target',
        headers: authHeaders(s.cookie),
        payload: { ...valid(s.serverId), dbServerId: null },
      }),
    );
    // The agent never answers: the first run hangs in backup.target.status.
    const first = await T().app.inject({
      method: 'POST',
      url: '/api/storage/backup-target/run',
      headers: authHeaders(s.cookie),
    });
    expect(first.statusCode).toBe(202);
    const second = await T().app.inject({
      method: 'POST',
      url: '/api/storage/backup-target/run',
      headers: authHeaders(s.cookie),
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: 'busy' });
  });
});
