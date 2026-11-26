import { afterEach, describe, expect, it } from 'vitest';
import {
  containerActionResponseSchema,
  containerListResponseSchema,
  containerSummarySchema,
  type Alert,
} from '@hz/shared';
import { containerCoreId } from '../src/containers/service.js';
import { auditLog } from '../src/db/schema.js';
import { inventoryMsg, until, WsClient, type Received } from './agent-helpers.js';
import {
  containerByName,
  event,
  info,
  insertServer,
  inventory,
  withAgent,
} from './container-helpers.js';
import { authHeaders, completeSetup, makeApp, type TestApp } from './helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

async function plain() {
  t = await makeApp();
  const serverId = insertServer(t);
  return { t, serverId };
}

const containerAlerts = (t: TestApp): Alert[] =>
  t.app.hzCore.alerts.list({ state: 'all', limit: 100 }).filter((a) => a.source === 'container');

describe('inventory reconciliation', () => {
  it('stores containers with a stable id per server + name and deletes the missing ones', async () => {
    const { t, serverId } = await plain();
    inventory(t, serverId, [
      info('homeassistant', {
        composeProject: 'ha',
        composeService: 'homeassistant',
        composeDir: '/opt/homelab/apps/ha',
        ports: [{ privatePort: 8123, publicPort: 8123, proto: 'tcp' }],
        cpu: 3.5,
        memBytes: 1024,
        restartCount: 2,
        startedAt: '2026-11-25T10:00:00.000Z',
      }),
      info('old', { state: 'exited', exitCode: 0 }),
    ]);
    const ha = containerByName(t, 'homeassistant');
    expect(containerSummarySchema.parse(ha)).toMatchObject({
      id: containerCoreId(serverId, 'homeassistant'),
      serverName: 'heimserver',
      composeProject: 'ha',
      composeService: 'homeassistant',
      composeManaged: true,
      status: 'ok',
      statusText: 'läuft',
      cpu: 3.5,
      memBytes: 1024,
      restartCount: 2,
      startedAt: '2026-11-25T10:00:00.000Z',
      ports: [{ privatePort: 8123, publicPort: 8123, proto: 'tcp' }],
    });
    expect(containerByName(t, 'old')).toMatchObject({ status: 'off', exitCode: 0 });

    // Recreated (new docker id, e.g. after an image update): same core id.
    inventory(t, serverId, [info('homeassistant', { dockerId: 'ab'.repeat(32) })]);
    const again = containerByName(t, 'homeassistant');
    expect(again?.id).toBe(ha?.id);
    expect(again?.dockerId).toBe('ab'.repeat(32));
    expect(containerByName(t, 'old')).toBeUndefined();

    inventory(t, serverId, []);
    expect(t.app.hzCore.containers.list()).toEqual([]);
  });

  it('keeps ids per server apart and counts running/total in the server summary', async () => {
    const { t, serverId } = await plain();
    const other = insertServer(t, 'oracle-a1');
    inventory(t, serverId, [info('web'), info('db', { state: 'exited', exitCode: 1 })]);
    inventory(t, other, [info('web')]);
    expect(containerByName(t, 'web', serverId)?.id).not.toBe(containerByName(t, 'web', other)?.id);
    expect(t.app.hzCore.containers.list(other)).toHaveLength(1);
    expect(t.app.hzCore.servers.summary(serverId)).toMatchObject({
      containersRunning: 1,
      containersTotal: 2,
    });
    // Problems first.
    expect(t.app.hzCore.containers.list(serverId).map((c) => c.name)).toEqual(['db', 'web']);
  });

  it('a compose dir outside /opt/homelab/ is not managed', async () => {
    const { t, serverId } = await plain();
    inventory(t, serverId, [
      info('a', { composeProject: 'a', composeDir: '/srv/a' }),
      info('b', { composeProject: 'b', composeDir: '/opt/homelab/../etc' }),
    ]);
    expect(containerByName(t, 'a')?.composeManaged).toBe(false);
    expect(containerByName(t, 'b')?.composeManaged).toBe(false);
  });

  it('server deletion removes its containers', async () => {
    const { t, serverId } = await plain();
    inventory(t, serverId, [info('web')]);
    const removed: string[] = [];
    t.app.hzCore.containers.onChange((id, deleted) => deleted && removed.push(id));
    t.app.hzCore.servers.delete(serverId);
    expect(removed).toEqual([containerCoreId(serverId, 'web')]);
    expect(t.app.hzCore.containers.list()).toEqual([]);
  });
});

describe('docker events', () => {
  it('die/start/health update the row and the server counts', async () => {
    const { t, serverId } = await plain();
    inventory(t, serverId, [info('web')]);
    event(t, serverId, {
      kind: 'container',
      dockerId: info('web').dockerId,
      name: 'web',
      action: 'die',
      exitCode: 2,
    });
    expect(containerByName(t, 'web')).toMatchObject({
      state: 'exited',
      exitCode: 2,
      status: 'crit',
    });
    expect(t.app.hzCore.servers.summary(serverId)?.containersRunning).toBe(0);
    event(t, serverId, {
      kind: 'container',
      dockerId: info('web').dockerId,
      name: 'web',
      action: 'start',
    });
    expect(containerByName(t, 'web')).toMatchObject({
      state: 'running',
      exitCode: null,
      status: 'ok',
    });
    event(t, serverId, {
      kind: 'container',
      dockerId: info('web').dockerId,
      name: 'web',
      action: 'health_status',
      health: 'unhealthy',
    });
    expect(containerByName(t, 'web')).toMatchObject({ health: 'unhealthy', status: 'crit' });
    // Unknown containers wait for the inventory.
    event(t, serverId, {
      kind: 'container',
      dockerId: 'ff'.repeat(6),
      name: 'nope',
      action: 'start',
    });
    expect(containerByName(t, 'nope')).toBeUndefined();
  });
});

describe('container alerts', () => {
  const die = (name: string, exitCode: number) =>
    ({ kind: 'container', dockerId: info(name).dockerId, name, action: 'die', exitCode }) as const;

  it('crash: crit with exit code, recovery: resolved plus OK', async () => {
    const { t, serverId } = await plain();
    inventory(t, serverId, [info('web')]);
    expect(containerAlerts(t)).toEqual([]);
    event(t, serverId, die('web', 1));
    const [crit] = containerAlerts(t);
    expect(crit).toMatchObject({
      key: `container:${serverId}:web`,
      level: 'crit',
      title: 'web auf heimserver ist ausgefallen',
      state: 'open',
      serverId,
    });
    expect(crit?.body).toContain('Exit-Code 1');
    // The inventory repeats the state: no second alert.
    inventory(t, serverId, [info('web', { state: 'exited', exitCode: 1 })]);
    expect(containerAlerts(t)).toHaveLength(1);

    inventory(t, serverId, [info('web')]);
    const all = containerAlerts(t);
    expect(all.find((a) => a.id === crit?.id)?.state).toBe('resolved');
    expect(all.find((a) => a.level === 'ok')).toMatchObject({
      title: 'web auf heimserver läuft wieder',
      key: `container:${serverId}:web`,
    });
  });

  it('exit 0 is info "gestoppt"; dead, oom and unhealthy are crit', async () => {
    const { t, serverId } = await plain();
    inventory(t, serverId, [info('a'), info('b'), info('c'), info('d')]);
    event(t, serverId, die('a', 0));
    event(t, serverId, { kind: 'oom', dockerId: info('b').dockerId, name: 'b' });
    event(t, serverId, die('b', 137));
    inventory(t, serverId, [
      info('a', { state: 'exited', exitCode: 0 }),
      info('b', { state: 'exited', exitCode: 137 }),
      info('c', { state: 'dead' }),
      info('d', { health: 'unhealthy' }),
    ]);
    const byName = (n: string) => containerAlerts(t).find((a) => a.key.endsWith(`:${n}`));
    expect(byName('a')).toMatchObject({ level: 'info', title: 'a auf heimserver gestoppt' });
    expect(byName('a')?.body).toContain('Exit-Code 0');
    expect(byName('b')).toMatchObject({ level: 'crit', title: 'b auf heimserver ist ausgefallen' });
    expect(byName('b')?.body).toMatch(/OOM.*Exit-Code 137/);
    expect(byName('c')).toMatchObject({ level: 'crit' });
    expect(byName('d')).toMatchObject({ level: 'crit' });
    expect(byName('d')?.body).toContain('Healthcheck');
  });

  it('containers that are already down when first seen: crit only for failures', async () => {
    const { t, serverId } = await plain();
    inventory(t, serverId, [
      info('ok-stopped', { state: 'exited', exitCode: 0 }),
      info('created', { state: 'created' }),
      info('failed', { state: 'exited', exitCode: 3 }),
    ]);
    const alerts = containerAlerts(t);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      level: 'crit',
      title: 'failed auf heimserver ist ausgefallen',
    });
  });

  it('a removed container resolves its alert without an OK alert', async () => {
    const { t, serverId } = await plain();
    inventory(t, serverId, [info('web', { state: 'exited', exitCode: 1 })]);
    inventory(t, serverId, []);
    const alerts = containerAlerts(t);
    expect(alerts.map((a) => [a.level, a.state])).toEqual([['crit', 'resolved']]);
  });
});

describe('GET /api/containers', () => {
  it('lists all or per server', async () => {
    const { t, serverId } = await plain();
    const { cookie } = await completeSetup(t);
    const other = insertServer(t, 'pi');
    inventory(t, serverId, [info('web')]);
    inventory(t, other, [info('db')]);
    const all = await t.app.inject({ url: '/api/containers', headers: authHeaders(cookie) });
    expect(all.statusCode).toBe(200);
    expect(containerListResponseSchema.parse(all.json()).containers).toHaveLength(2);
    const one = await t.app.inject({
      url: `/api/containers?serverId=${other}`,
      headers: authHeaders(cookie),
    });
    expect(one.json<{ containers: { name: string }[] }>().containers.map((c) => c.name)).toEqual([
      'db',
    ]);
  });

  it('400 for unknown query keys, 404 for an unknown server', async () => {
    const { t } = await plain();
    const { cookie } = await completeSetup(t);
    const bad = await t.app.inject({ url: '/api/containers?x=1', headers: authHeaders(cookie) });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ ok: false, error: 'invalid_input' });
    const long = await t.app.inject({
      url: `/api/containers?serverId=${'a'.repeat(65)}`,
      headers: authHeaders(cookie),
    });
    expect(long.statusCode).toBe(400);
    const missing = await t.app.inject({
      url: '/api/containers?serverId=nope',
      headers: authHeaders(cookie),
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('POST /api/containers/:id/:action', () => {
  const post = (t: TestApp, cookie: string, id: string, action: string) =>
    t.app.inject({
      method: 'POST',
      url: `/api/containers/${id}/${action}`,
      headers: authHeaders(cookie),
    });

  it('start/stop/restart send the RPC with the docker id and write the audit log', async () => {
    const s = await withAgent(clients);
    t = s.t;
    const ha = containerByName(s.t, 'homeassistant');
    if (!ha) throw new Error('missing');
    for (const action of ['start', 'stop', 'restart'] as const) {
      const res = await post(s.t, s.cookie, ha.id, action);
      expect(res.statusCode).toBe(200);
      expect(containerActionResponseSchema.parse(res.json()).container?.id).toBe(ha.id);
    }
    expect(s.rpcs.map((r) => [r.action, r.params])).toEqual([
      ['container.start', { id: ha.dockerId }],
      ['container.stop', { id: ha.dockerId }],
      ['container.restart', { id: ha.dockerId }],
    ]);
    const audit = s.t.db.db
      .select()
      .from(auditLog)
      .all()
      .filter((a) => a.action.startsWith('container.'));
    expect(audit.map((a) => [a.action, a.target, a.actor])).toEqual([
      ['container.start', ha.id, 'admin'],
      ['container.stop', ha.id, 'admin'],
      ['container.restart', ha.id, 'admin'],
    ]);
    expect(JSON.parse(audit[0]?.detailsJson ?? '{}')).toEqual({
      serverId: s.serverId,
      name: 'homeassistant',
    });
  });

  it('a stop through the core gives info "gestoppt", the start an OK alert', async () => {
    const s = await withAgent(clients);
    t = s.t;
    const ha = containerByName(s.t, 'homeassistant');
    if (!ha) throw new Error('missing');
    expect((await post(s.t, s.cookie, ha.id, 'stop')).statusCode).toBe(200);
    s.agent.send({
      type: 'event',
      ts: new Date().toISOString(),
      event: {
        kind: 'container',
        dockerId: ha.dockerId,
        name: 'homeassistant',
        action: 'die',
        exitCode: 137,
      },
    });
    await until(() => containerAlerts(s.t).length === 1);
    expect(containerByName(s.t, 'homeassistant')).toMatchObject({ status: 'off', exitCode: 137 });
    expect(containerAlerts(s.t)[0]).toMatchObject({
      level: 'info',
      title: 'homeassistant auf heimserver gestoppt',
    });
    expect(containerAlerts(s.t)[0]?.body).toContain('über die Zentrale gestoppt');

    expect((await post(s.t, s.cookie, ha.id, 'start')).statusCode).toBe(200);
    s.agent.send(inventoryMsg({ containers: [info('homeassistant')] }));
    await until(() => containerAlerts(s.t).some((a) => a.level === 'ok'));
    expect(containerAlerts(s.t).find((a) => a.level === 'info')?.state).toBe('resolved');
  });

  it('a restart through the core raises no alert', async () => {
    const s = await withAgent(clients);
    t = s.t;
    const ha = containerByName(s.t, 'homeassistant');
    if (!ha) throw new Error('missing');
    expect((await post(s.t, s.cookie, ha.id, 'restart')).statusCode).toBe(200);
    const ev = (action: 'die' | 'start', exitCode?: number) =>
      s.agent.send({
        type: 'event',
        ts: new Date().toISOString(),
        event: {
          kind: 'container',
          dockerId: ha.dockerId,
          name: 'homeassistant',
          action,
          ...(exitCode !== undefined ? { exitCode } : {}),
        },
      });
    ev('die', 143);
    await until(() => containerByName(s.t, 'homeassistant')?.state === 'exited');
    ev('start');
    await until(() => containerByName(s.t, 'homeassistant')?.state === 'running');
    expect(containerAlerts(s.t)).toEqual([]);
  });

  it('400 for an invalid id or action, 404 for an unknown container', async () => {
    const s = await withAgent(clients);
    t = s.t;
    const ha = containerByName(s.t, 'homeassistant');
    if (!ha) throw new Error('missing');
    for (const [id, action] of [
      [ha.id, 'delete'],
      [ha.id, 'exec'],
      [ha.id, 'START'],
      ['short', 'start'],
      ['a'.repeat(65), 'start'],
      ['bad%21id00', 'start'],
    ] as const) {
      const res = await post(s.t, s.cookie, id, action);
      expect(res.statusCode, `${id}/${action}`).toBe(400);
      expect(res.json()).toEqual({ ok: false, error: 'invalid_input' });
    }
    expect((await post(s.t, s.cookie, 'A'.repeat(22), 'start')).statusCode).toBe(404);
    expect(s.rpcs).toEqual([]);
  });

  it('409 agent_offline when the agent is not connected, 502 when the agent fails', async () => {
    const s = await withAgent(clients, {
      reply: (rpc: Received) => ({
        type: 'rpc.result',
        id: rpc.id,
        ok: false,
        error: { code: 'failed', message: 'docker said no' },
      }),
    });
    t = s.t;
    const ha = containerByName(s.t, 'homeassistant');
    if (!ha) throw new Error('missing');
    const failed = await post(s.t, s.cookie, ha.id, 'stop');
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toEqual({ ok: false, error: 'agent_error' });
    // The failed stop leaves no intent behind.
    expect(s.t.app.hzCore.containers.row(ha.id)?.intent).toBeNull();

    s.agent.close();
    await until(() => !s.t.app.hzCore.hub.isConnected(s.serverId));
    const off = await post(s.t, s.cookie, ha.id, 'start');
    expect(off.statusCode).toBe(409);
    expect(off.json()).toEqual({ ok: false, error: 'agent_offline' });
  });
});

describe('live topic containers', () => {
  it('snapshot, then throttled upserts and removals', async () => {
    const s = await withAgent(clients);
    t = s.t;
    const origin = s.url.replace('ws://', 'http://');
    const live = await WsClient.connect(`${s.url}/live`, {
      cookie: `hz_session=${s.cookie}`,
      origin,
    });
    clients.push(live);
    live.send({ type: 'subscribe', topics: ['containers'] });
    const snap = await live.nextOfType('snapshot');
    expect((snap.data as { name: string }[]).map((c) => c.name).sort()).toEqual([
      'homeassistant',
      'old',
    ]);
    const ha = containerByName(s.t, 'homeassistant');
    s.agent.send({
      type: 'event',
      ts: new Date().toISOString(),
      event: {
        kind: 'container',
        dockerId: ha?.dockerId,
        name: 'homeassistant',
        action: 'die',
        exitCode: 1,
      },
    });
    const up = await live.next((m) => m.type === 'update' && m.topic === 'containers');
    expect(up.upsert).toEqual([
      expect.objectContaining({ id: ha?.id, status: 'crit', exitCode: 1 }),
    ]);

    s.agent.send(
      inventoryMsg({ containers: [info('homeassistant', { state: 'exited', exitCode: 1 })] }),
    );
    const rm = await live.next((m) => m.type === 'update' && Array.isArray(m.remove));
    expect(rm.remove).toEqual([containerCoreId(s.serverId, 'old')]);
  });
});
