import { afterEach, describe, expect, it } from 'vitest';
import {
  containerDetailsResponseSchema,
  dockerImageListResponseSchema,
  dockerNetworkListResponseSchema,
  dockerVolumeListResponseSchema,
  stackActionResponseSchema,
} from '@hz/shared';
import { stepUp, until, type Received, type WsClient } from './agent-helpers.js';
import {
  containerByName,
  info,
  inventory,
  withAgent,
  type AgentSetup,
} from './container-helpers.js';
import { authHeaders, type TestApp } from './helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

const HEX = (c: string) => c.repeat(64);
const ISO = '2026-11-01T10:00:00.000Z';

const ok = (m: Received, data: unknown) => ({ type: 'rpc.result', id: m.id, ok: true, data });

const DETAILS = {
  id: HEX('a'),
  name: 'nextcloud',
  image: 'nextcloud:29',
  imageId: `sha256:${HEX('b')}`,
  createdAt: ISO,
  startedAt: ISO,
  finishedAt: null,
  state: 'running',
  health: 'healthy',
  exitCode: null,
  restartCount: 0,
  restartPolicy: 'unless-stopped',
  envKeys: ['MYSQL_PASSWORD', 'TZ'],
  mounts: [{ type: 'volume', source: 'nc-data', destination: '/var/www', rw: true }],
  networks: [{ name: 'nc_default', ip: '172.18.0.2' }],
  ports: [{ privatePort: 80, publicPort: 8080, protocol: 'tcp', ip: '0.0.0.0' }],
  composeProject: 'nc',
  composeService: 'app',
  protected: false,
  stats: {
    cpuPercent: 1.5,
    memBytes: 1000,
    memLimitBytes: null,
    netRxBytes: 1,
    netTxBytes: 2,
    blockReadBytes: 3,
    blockWriteBytes: 4,
    pids: 9,
  },
};

const IMAGE = {
  id: `sha256:${HEX('c')}`,
  tags: ['nginx:1.27'],
  sizeBytes: 1e8,
  createdAt: ISO,
  containers: 0,
  dangling: false,
  protected: false,
};
const VOLUME = {
  name: 'nc-data',
  driver: 'local',
  createdAt: ISO,
  sizeBytes: 5e8,
  containers: ['nextcloud'],
  composeProject: 'nc',
  protected: false,
};
const NETWORK = {
  id: HEX('d'),
  name: 'nc_default',
  driver: 'bridge',
  scope: 'local',
  builtin: false,
  internal: false,
  containers: ['nextcloud'],
  composeProject: 'nc',
  protected: false,
};

function replies(m: Received): Record<string, unknown> | null {
  switch (m.action) {
    case 'container.inspect':
      return ok(m, DETAILS);
    case 'docker.images':
      return ok(m, { images: [IMAGE] });
    case 'docker.volumes':
      return ok(m, { volumes: [VOLUME] });
    case 'docker.networks':
      return ok(m, { networks: [NETWORK] });
    case 'image.pull':
      return ok(m, { id: IMAGE.id, tags: ['nginx:1.27'] });
    case 'stack.op':
      return ok(m, { containers: 2, via: 'api' });
    default:
      return null;
  }
}

const CONTAINERS = [
  info('nextcloud', { composeProject: 'nc', composeService: 'app' }),
  info('nc-db', { composeProject: 'nc', composeService: 'db' }),
  info('old', { state: 'exited', exitCode: 0 }),
  info('other', { composeProject: 'misc' }),
];

async function setup(): Promise<AgentSetup> {
  const s = await withAgent(clients, { containers: CONTAINERS, reply: replies });
  t = s.t;
  return s;
}

const get = (s: AgentSetup, url: string) =>
  s.t.app.inject({ method: 'GET', url, headers: authHeaders(s.cookie) });
const post = (s: AgentSetup, url: string, payload: object = {}) =>
  s.t.app.inject({ method: 'POST', url, headers: authHeaders(s.cookie), payload });

function auditRows(s: AgentSetup, prefix: string) {
  return s.t.db.sqlite
    .prepare(
      'SELECT action, target, details_json AS d FROM audit_log WHERE action LIKE ? ORDER BY id',
    )
    .all(`${prefix}%`) as { action: string; target: string; d: string }[];
}

const idOf = (s: AgentSetup, name: string): string => {
  const c = containerByName(s.t, name);
  if (!c) throw new Error(`missing ${name}`);
  return c.id;
};

describe('docker: container details and removal', () => {
  it('details: container.inspect with the docker id, response validated', async () => {
    const s = await setup();
    const res = await get(s, `/api/containers/${idOf(s, 'nextcloud')}/details`);
    expect(res.statusCode).toBe(200);
    const body = containerDetailsResponseSchema.parse(res.json());
    expect(body.details.envKeys).toEqual(['MYSQL_PASSWORD', 'TZ']);
    const rpc = s.rpcs.find((r) => r.action === 'container.inspect');
    expect(rpc?.params).toEqual({ id: containerByName(s.t, 'nextcloud')?.dockerId });
  });

  it('details: unknown container 404, malformed id 400', async () => {
    const s = await setup();
    expect((await get(s, `/api/containers/${'Z'.repeat(22)}/details`)).statusCode).toBe(404);
    expect((await get(s, '/api/containers/x/details')).statusCode).toBe(400);
  });

  it('details: an agent answer that breaks the schema is 502', async () => {
    const s = await withAgent(clients, {
      containers: CONTAINERS,
      reply: (m) =>
        m.action === 'container.inspect' ? ok(m, { ...DETAILS, env: { A: 'b' } }) : null,
    });
    t = s.t;
    const res = await get(s, `/api/containers/${idOf(s, 'nextcloud')}/details`);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ ok: false, error: 'agent_error' });
  });

  it('remove: a stopped container with step-up and name, row gone, audit written', async () => {
    const s = await setup();
    await stepUp(s.t, s.secret, s.cookie);
    const id = idOf(s, 'old');
    const res = await post(s, `/api/containers/${id}/remove`, {
      confirmName: 'old',
      removeVolumes: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const rpc = s.rpcs.find((r) => r.action === 'container.remove');
    expect(rpc?.params).toEqual({ id: info('old').dockerId, removeVolumes: true });
    expect(s.t.app.hzCore.containers.row(id)).toBeUndefined();
    expect(containerByName(s.t, 'old')).toBeUndefined();
    const audit = auditRows(s, 'docker.container.remove');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.target).toBe(id);
    expect(JSON.parse(audit[0]?.d ?? '{}')).toEqual({
      serverId: s.serverId,
      name: 'old',
      removeVolumes: true,
    });
  });

  it('remove: removeVolumes defaults to false', async () => {
    const s = await setup();
    await stepUp(s.t, s.secret, s.cookie);
    const res = await post(s, `/api/containers/${idOf(s, 'old')}/remove`, { confirmName: 'old' });
    expect(res.statusCode).toBe(200);
    expect(s.rpcs.find((r) => r.action === 'container.remove')?.params).toMatchObject({
      removeVolumes: false,
    });
  });

  it('remove: a running container is 409 and nothing reaches the agent', async () => {
    const s = await setup();
    await stepUp(s.t, s.secret, s.cookie);
    const res = await post(s, `/api/containers/${idOf(s, 'nextcloud')}/remove`, {
      confirmName: 'nextcloud',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      ok: false,
      error: 'conflict',
      message: 'Container zuerst stoppen',
    });
    expect(s.rpcs.filter((r) => r.action === 'container.remove')).toEqual([]);
  });

  it('remove: agent busy is 409 busy and the row stays, failure audited', async () => {
    const s = await withAgent(clients, {
      containers: CONTAINERS,
      reply: (m) =>
        m.action === 'container.remove'
          ? { type: 'rpc.result', id: m.id, ok: false, error: { code: 'busy', message: 'in use' } }
          : null,
    });
    t = s.t;
    await stepUp(s.t, s.secret, s.cookie);
    const id = idOf(s, 'old');
    const res = await post(s, `/api/containers/${id}/remove`, { confirmName: 'old' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ ok: false, error: 'busy' });
    expect(s.t.app.hzCore.containers.row(id)).toBeDefined();
    expect(auditRows(s, 'docker.container.remove').map((a) => a.action)).toEqual([
      'docker.container.remove',
      'docker.container.remove_failed',
    ]);
  });

  it('remove: an open alert of the crashed container is resolved, no comeback', async () => {
    const s = await setup();
    const crashed = CONTAINERS.map((c) =>
      c.name === 'nextcloud' ? { ...c, state: 'exited' as const, exitCode: 1 } : c,
    );
    inventory(s.t, s.serverId, crashed);
    const open = () =>
      s.t.db.sqlite
        .prepare("SELECT level FROM alerts WHERE key LIKE '%:nextcloud' AND resolved_at IS NULL")
        .all();
    expect(open()).toEqual([{ level: 'crit' }]);
    await stepUp(s.t, s.secret, s.cookie);
    const id = idOf(s, 'nextcloud');
    const res = await post(s, `/api/containers/${id}/remove`, { confirmName: 'nextcloud' });
    expect(res.statusCode).toBe(200);
    expect(open()).toEqual([]);
    inventory(
      s.t,
      s.serverId,
      crashed.filter((c) => c.name !== 'nextcloud'),
    );
    expect(containerByName(s.t, 'nextcloud')).toBeUndefined();
    expect(open()).toEqual([]);
  });
});

describe('docker: images, volumes, networks', () => {
  it('lists images, volumes and networks of a server', async () => {
    const s = await setup();
    const images = await get(s, `/api/servers/${s.serverId}/docker/images`);
    expect(images.statusCode).toBe(200);
    expect(dockerImageListResponseSchema.parse(images.json()).images).toEqual([IMAGE]);
    const volumes = await get(s, `/api/servers/${s.serverId}/docker/volumes`);
    expect(dockerVolumeListResponseSchema.parse(volumes.json()).volumes).toEqual([VOLUME]);
    const networks = await get(s, `/api/servers/${s.serverId}/docker/networks`);
    expect(dockerNetworkListResponseSchema.parse(networks.json()).networks).toEqual([NETWORK]);
  });

  it('unknown server 404', async () => {
    const s = await setup();
    for (const kind of ['images', 'volumes', 'networks']) {
      const res = await get(s, `/api/servers/${'Q'.repeat(22)}/docker/${kind}`);
      expect(res.statusCode).toBe(404);
    }
  });

  it('pull: image.pull with the ref, the image back, audit', async () => {
    const s = await setup();
    const res = await post(s, `/api/servers/${s.serverId}/docker/images/pull`, {
      ref: 'nginx:1.27',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ image: { id: IMAGE.id, tags: ['nginx:1.27'] } });
    expect(s.rpcs.find((r) => r.action === 'image.pull')?.params).toEqual({ ref: 'nginx:1.27' });
    expect(auditRows(s, 'docker.image.pull')).toHaveLength(1);
  });

  it('pull: invalid refs are 400 and never reach the agent', async () => {
    const s = await setup();
    for (const ref of ['-v', 'Nginx', 'nginx latest', 'https://x/y', '']) {
      const res = await post(s, `/api/servers/${s.serverId}/docker/images/pull`, { ref });
      expect(res.statusCode, ref).toBe(400);
    }
    expect(s.rpcs.filter((r) => r.action === 'image.pull')).toEqual([]);
  });

  it('image remove: sends sha256:<id>, audit', async () => {
    const s = await setup();
    const res = await post(s, `/api/servers/${s.serverId}/docker/images/${HEX('c')}/remove`);
    expect(res.statusCode).toBe(200);
    expect(s.rpcs.find((r) => r.action === 'image.remove')?.params).toEqual({
      id: `sha256:${HEX('c')}`,
    });
    expect(auditRows(s, 'docker.image.remove')).toHaveLength(1);
    const bad = await post(s, `/api/servers/${s.serverId}/docker/images/sha256:${HEX('c')}/remove`);
    expect(bad.statusCode).toBe(400);
  });

  it('volume remove: with step-up and the name', async () => {
    const s = await setup();
    await stepUp(s.t, s.secret, s.cookie);
    const res = await post(s, `/api/servers/${s.serverId}/docker/volumes/nc-data/remove`, {
      confirmName: 'nc-data',
    });
    expect(res.statusCode).toBe(200);
    expect(s.rpcs.find((r) => r.action === 'volume.remove')?.params).toEqual({ name: 'nc-data' });
    expect(auditRows(s, 'docker.volume.remove')).toHaveLength(1);
  });

  it('network remove: network.remove with the id', async () => {
    const s = await setup();
    const res = await post(s, `/api/servers/${s.serverId}/docker/networks/${HEX('d')}/remove`);
    expect(res.statusCode).toBe(200);
    expect(s.rpcs.find((r) => r.action === 'network.remove')?.params).toEqual({ id: HEX('d') });
    expect(auditRows(s, 'docker.network.remove')).toHaveLength(1);
    const bad = await post(s, `/api/servers/${s.serverId}/docker/networks/bridge/remove`);
    expect(bad.statusCode).toBe(400);
  });
});

describe('docker: compose stacks', () => {
  it('start/stop/restart: stack.op with the same op, the project containers back', async () => {
    const s = await setup();
    for (const op of ['start', 'stop', 'restart'] as const) {
      const res = await post(s, `/api/servers/${s.serverId}/stacks/nc/${op}`);
      expect(res.statusCode, op).toBe(200);
      const body = stackActionResponseSchema.parse(res.json());
      expect(body.containers.map((c) => c.name).sort()).toEqual(['nc-db', 'nextcloud']);
    }
    expect(s.rpcs.filter((r) => r.action === 'stack.op').map((r) => r.params)).toEqual([
      { project: 'nc', op: 'start' },
      { project: 'nc', op: 'stop' },
      { project: 'nc', op: 'restart' },
    ]);
    expect(auditRows(s, 'docker.stack.').map((a) => a.action)).toEqual([
      'docker.stack.start',
      'docker.stack.stop',
      'docker.stack.restart',
    ]);
  });

  it('stop sets a stop intent on every container of the project, restart a timed one', async () => {
    const s = await setup();
    await post(s, `/api/servers/${s.serverId}/stacks/nc/stop`);
    const c = s.t.app.hzCore.containers;
    expect(c.row(idOf(s, 'nextcloud'))?.intent).toBe('stop');
    expect(c.row(idOf(s, 'nc-db'))?.intent).toBe('stop');
    expect(c.row(idOf(s, 'other'))?.intent).toBeNull();
    await post(s, `/api/servers/${s.serverId}/stacks/nc/restart`);
    const row = c.row(idOf(s, 'nextcloud'));
    expect(row?.intent).toBe('restart');
    expect(row?.intentUntil).toBe(s.t.clock.t + 60_000);
  });

  it('update: stack.op pull then up', async () => {
    const s = await setup();
    const res = await post(s, `/api/servers/${s.serverId}/stacks/nc/update`);
    expect(res.statusCode).toBe(200);
    expect(s.rpcs.filter((r) => r.action === 'stack.op').map((r) => r.params)).toEqual([
      { project: 'nc', op: 'pull' },
      { project: 'nc', op: 'up' },
    ]);
    expect(auditRows(s, 'docker.stack.update')).toHaveLength(1);
  });

  it('down: needs the project name, then stack.op down', async () => {
    const s = await setup();
    for (const payload of [{}, { confirmName: 'NC' }, { confirmName: 'misc' }]) {
      const res = await post(s, `/api/servers/${s.serverId}/stacks/nc/down`, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ ok: false, error: 'confirm_mismatch' });
    }
    expect(s.rpcs.filter((r) => r.action === 'stack.op')).toEqual([]);
    const res = await post(s, `/api/servers/${s.serverId}/stacks/nc/down`, { confirmName: 'nc' });
    expect(res.statusCode).toBe(200);
    expect(s.rpcs.filter((r) => r.action === 'stack.op').map((r) => r.params)).toEqual([
      { project: 'nc', op: 'down' },
    ]);
  });

  it('unknown project 404, invalid op or project 400', async () => {
    const s = await setup();
    expect((await post(s, `/api/servers/${s.serverId}/stacks/nope/stop`)).statusCode).toBe(404);
    expect((await post(s, `/api/servers/${s.serverId}/stacks/nc/kill`)).statusCode).toBe(400);
    expect((await post(s, `/api/servers/${s.serverId}/stacks/NC/stop`)).statusCode).toBe(400);
    expect((await post(s, `/api/servers/${'Q'.repeat(22)}/stacks/nc/stop`)).statusCode).toBe(404);
  });

  it('a failed stack op clears the intents and writes *_failed', async () => {
    const s = await withAgent(clients, {
      containers: CONTAINERS,
      reply: (m) =>
        m.action === 'stack.op'
          ? { type: 'rpc.result', id: m.id, ok: false, error: { code: 'failed', message: 'x' } }
          : null,
    });
    t = s.t;
    const res = await post(s, `/api/servers/${s.serverId}/stacks/nc/stop`);
    expect(res.statusCode).toBe(502);
    expect(s.t.app.hzCore.containers.row(idOf(s, 'nextcloud'))?.intent).toBeNull();
    expect(auditRows(s, 'docker.stack.stop').map((a) => a.action)).toEqual([
      'docker.stack.stop',
      'docker.stack.stop_failed',
    ]);
  });

  it('no alert for containers of a stack stopped through the core', async () => {
    const s = await setup();
    await post(s, `/api/servers/${s.serverId}/stacks/nc/stop`);
    inventory(
      s.t,
      s.serverId,
      CONTAINERS.map((c) =>
        c.composeProject === 'nc' ? { ...c, state: 'exited' as const, exitCode: 137 } : c,
      ),
    );
    await until(() => containerByName(s.t, 'nextcloud')?.state === 'exited');
    const alerts = s.t.db.sqlite
      .prepare("SELECT level FROM alerts WHERE resolved_at IS NULL AND level = 'crit'")
      .all();
    expect(alerts).toEqual([]);
  });
});
