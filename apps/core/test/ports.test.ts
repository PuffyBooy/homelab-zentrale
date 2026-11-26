import { afterEach, describe, expect, it } from 'vitest';
import { portAlertKey, portAuditResponseSchema, type ListeningPort } from '@hz/shared';
import { enrollAgent, inventoryMsg, listen, until, type WsClient } from './agent-helpers.js';
import { authHeaders, completeSetup, makeApp, type TestApp } from './helpers.js';

let t: TestApp | undefined;
let agent: WsClient | undefined;
afterEach(async () => {
  agent?.close();
  agent = undefined;
  await t?.app.close();
  t = undefined;
});

function T(): TestApp {
  if (!t) throw new Error('no app');
  return t;
}

async function setup(): Promise<{ cookie: string; serverId: string }> {
  t = await makeApp();
  const { cookie } = await completeSetup(t);
  const url = await listen(t);
  const e = await enrollAgent(t, url, cookie);
  agent = e.agent;
  return { cookie, serverId: e.serverId };
}

let invCount = 0;
/** Sends an inventory and waits until the core stored it. */
async function sendPorts(serverId: string, ports: ListeningPort[]): Promise<void> {
  if (!t || !agent) throw new Error('no app');
  const db = t.db;
  const marker = `host-${++invCount}`;
  const inv = inventoryMsg({ listeningPorts: ports });
  agent.send({ ...inv, system: { ...inv.system, hostname: marker } });
  await until(() => {
    const row = db.sqlite
      .prepare('SELECT system_json s FROM server_state WHERE server_id = ?')
      .get(serverId) as { s: string } | undefined;
    return row?.s.includes(marker) === true;
  });
}

const tcp = (port: number, address = '0.0.0.0', process: string | null = null): ListeningPort => ({
  proto: 'tcp',
  address,
  port,
  ...(process ? { process } : {}),
});

function portAlerts(serverId: string) {
  if (!t) throw new Error('no app');
  return t.app.hzCore.alerts
    .list({ state: 'all', limit: 500 })
    .filter((a) => a.key.startsWith(`port:${serverId}:`));
}

async function audit(cookie: string, serverId: string) {
  if (!t) throw new Error('no app');
  const res = await t.app.inject({
    method: 'GET',
    url: `/api/servers/${serverId}/ports/allowed`,
    headers: authHeaders(cookie),
  });
  expect(res.statusCode).toBe(200);
  return portAuditResponseSchema.parse(res.json());
}

describe('port audit', () => {
  it('the first inventory seeds the list and raises no alert', async () => {
    const { cookie, serverId } = await setup();
    // enrollAgent sends no inventory: nothing seeded yet.
    expect(await audit(cookie, serverId)).toEqual({ seeded: false, allowed: [], open: [] });
    await sendPorts(serverId, [tcp(22, '0.0.0.0', 'sshd'), tcp(443, '::'), tcp(5432, '127.0.0.1')]);
    const a = await audit(cookie, serverId);
    expect(a.seeded).toBe(true);
    expect(a.allowed).toEqual([
      { port: 22, proto: 'tcp' },
      { port: 443, proto: 'tcp' },
    ]);
    expect(a.open.map((p) => [p.port, p.allowed])).toEqual([
      [22, true],
      [443, true],
    ]);
    expect(portAlerts(serverId)).toEqual([]);
  });

  it('an empty port list neither seeds nor changes anything', async () => {
    const { cookie, serverId } = await setup();
    await sendPorts(serverId, []);
    expect((await audit(cookie, serverId)).seeded).toBe(false);
  });

  it('a new public port raises one warn alert (deduped) and allow resolves it', async () => {
    const { cookie, serverId } = await setup();
    await sendPorts(serverId, [tcp(22, '0.0.0.0', 'sshd')]);
    await sendPorts(serverId, [tcp(22, '0.0.0.0', 'sshd'), tcp(8081, '0.0.0.0', 'nginx')]);
    await sendPorts(serverId, [tcp(22, '0.0.0.0', 'sshd'), tcp(8081, '0.0.0.0', 'nginx')]);
    const open = portAlerts(serverId).filter((x) => x.state !== 'resolved');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      key: portAlertKey(serverId, 'tcp', 8081),
      level: 'warn',
      source: 'server',
      serverId,
      title: 'Neuer offener Port 8081 (nginx)',
      body: 'heimserver: TCP 8081 lauscht auf 0.0.0.0. Erlauben, wenn das gewollt ist, sonst den Dienst prüfen.',
    });

    const res = await T().app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/ports/allow`,
      headers: authHeaders(cookie),
      payload: { port: 8081, proto: 'tcp', note: 'Reverse Proxy' },
    });
    expect(res.statusCode).toBe(200);
    const body = portAuditResponseSchema.parse(res.json());
    expect(body.allowed).toContainEqual({ port: 8081, proto: 'tcp', note: 'Reverse Proxy' });
    expect(body.open.find((p) => p.port === 8081)?.allowed).toBe(true);
    expect(portAlerts(serverId).filter((x) => x.state !== 'resolved')).toEqual([]);
    // Allowed by hand: closed without an OK entry.
    expect(portAlerts(serverId).filter((x) => x.level === 'ok')).toEqual([]);
    // Idempotent.
    const again = await T().app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/ports/allow`,
      headers: authHeaders(cookie),
      payload: { port: 8081, proto: 'tcp' },
    });
    expect(
      portAuditResponseSchema.parse(again.json()).allowed.filter((p) => p.port === 8081),
    ).toEqual([{ port: 8081, proto: 'tcp', note: 'Reverse Proxy' }]);
    const actions = T()
      .db.sqlite.prepare("SELECT action, target FROM audit_log WHERE action LIKE 'ports.%'")
      .all();
    expect(actions).toEqual([
      { action: 'ports.allow', target: serverId },
      { action: 'ports.allow', target: serverId },
    ]);
  });

  it('a port that is gone resolves its alert', async () => {
    const { serverId } = await setup();
    await sendPorts(serverId, [tcp(22)]);
    await sendPorts(serverId, [tcp(22), { proto: 'udp', address: '0.0.0.0', port: 27015 }]);
    expect(portAlerts(serverId).filter((x) => x.state === 'open')).toHaveLength(1);
    expect(portAlerts(serverId)[0]?.title).toBe('Neuer offener Port 27015 (UDP)');
    await sendPorts(serverId, [tcp(22)]);
    expect(portAlerts(serverId).filter((x) => x.state !== 'resolved')).toEqual([]);
  });

  it('private, loopback and tailscale binds are ignored', async () => {
    const { cookie, serverId } = await setup();
    await sendPorts(serverId, [tcp(22)]);
    await sendPorts(serverId, [
      tcp(22),
      tcp(3000, '127.0.0.1'),
      tcp(3001, '::1'),
      tcp(3002, '192.168.1.10'),
      tcp(3003, '10.0.0.5'),
      tcp(3004, '172.20.0.1'),
      tcp(3005, '100.64.0.5'),
      tcp(3006, 'fd7a:115c:a1e0::1'),
      tcp(3007, 'fe80::1%eth0'),
    ]);
    expect(portAlerts(serverId)).toEqual([]);
    expect((await audit(cookie, serverId)).open.map((p) => p.port)).toEqual([22]);
    // A global address counts.
    await sendPorts(serverId, [tcp(22), tcp(9000, '203.0.113.7')]);
    expect(portAlerts(serverId).map((a) => a.key)).toEqual([portAlertKey(serverId, 'tcp', 9000)]);
  });

  it('PUT replaces the list, alerts follow, seeded becomes true', async () => {
    const { cookie, serverId } = await setup();
    const put = (ports: unknown) =>
      T().app.inject({
        method: 'PUT',
        url: `/api/servers/${serverId}/ports/allowed`,
        headers: authHeaders(cookie),
        payload: { ports },
      });
    // Before any inventory: a PUT counts as seeding.
    const first = await put([{ port: 22, proto: 'tcp', note: 'SSH' }]);
    expect(portAuditResponseSchema.parse(first.json())).toMatchObject({
      seeded: true,
      allowed: [{ port: 22, proto: 'tcp', note: 'SSH' }],
    });
    await sendPorts(serverId, [tcp(22), tcp(80)]);
    expect(
      portAlerts(serverId)
        .filter((a) => a.state === 'open')
        .map((a) => a.key),
    ).toEqual([portAlertKey(serverId, 'tcp', 80)]);
    await put([
      { port: 22, proto: 'tcp' },
      { port: 80, proto: 'tcp' },
    ]);
    expect(portAlerts(serverId).filter((a) => a.state !== 'resolved')).toEqual([]);
    // Removing 80 again raises it again.
    await put([{ port: 22, proto: 'tcp' }]);
    expect(portAlerts(serverId).filter((a) => a.state === 'open')).toHaveLength(1);
    expect(
      T().db.sqlite.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'ports.update'").get(),
    ).toEqual({ n: 3 });
  });

  it('deleting the server drops its list', async () => {
    const { serverId } = await setup();
    await sendPorts(serverId, [tcp(22)]);
    T().app.hzCore.servers.delete(serverId);
    expect(T().db.sqlite.prepare('SELECT COUNT(*) n FROM server_allowed_ports').get()).toEqual({
      n: 0,
    });
    expect(T().db.sqlite.prepare('SELECT COUNT(*) n FROM server_port_audit').get()).toEqual({
      n: 0,
    });
  });
});
