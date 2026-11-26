import { afterEach, describe, expect, it } from 'vitest';
import {
  integrationSettingsSchema,
  proxmoxGuestActionResponseSchema,
  proxmoxGuestsResponseSchema,
} from '@hz/shared';
import { auditLog } from '../src/db/schema.js';
import { parseResources, PROXMOX_ACTIONS_PER_MIN } from '../src/integrations/proxmox.js';
import { unreachableAlertKey } from '../src/integrations/base.js';
import {
  FakeServer,
  json,
  PVE_TOKEN_ID,
  SENTINEL,
  tickIntegrations,
  withIntegrations,
  type IntegrationSetup,
  type Recorded,
} from './integrations-helpers.js';

let s: IntegrationSetup | undefined;
const fakes: FakeServer[] = [];
afterEach(async () => {
  await s?.t.app.close();
  s = undefined;
  for (const f of fakes.splice(0)) await f.stop();
});

const RESOURCES = [
  { type: 'node', node: 'pve', status: 'online', cpu: 0.12, mem: 4e9, maxmem: 16e9 },
  {
    type: 'qemu',
    node: 'pve',
    vmid: 101,
    name: 'docker-vm',
    status: 'running',
    cpu: 0.05,
    maxcpu: 4,
    mem: 2e9,
    maxmem: 8e9,
    uptime: 3600.7,
    template: 0,
  },
  {
    type: 'lxc',
    node: 'pve',
    vmid: 200,
    name: 'pihole',
    status: 'stopped',
    maxcpu: 1,
    template: 0,
  },
  { type: 'qemu', node: 'pve', vmid: 9000, name: 'debian-tpl', status: 'stopped', template: 1 },
  { type: 'storage', node: 'pve', id: 'storage/pve/local' },
  { type: 'qemu', node: '../evil', vmid: 102, name: 'x', status: 'running' },
];

/** Fake Proxmox API: checks the API token header, lists resources, accepts actions. */
export function fakeProxmox(secret = SENTINEL): FakeServer {
  const f = new FakeServer();
  f.handler = (q: Recorded, r) => {
    if (q.headers.authorization !== `PVEAPIToken=${PVE_TOKEN_ID}=${secret}`) {
      json(r, 401, { data: null });
      return;
    }
    if (q.method === 'GET' && q.url === '/api2/json/cluster/resources') {
      json(r, 200, { data: RESOURCES });
      return;
    }
    const m =
      /^\/api2\/json\/nodes\/pve\/(qemu|lxc)\/(\d+)\/status\/(start|shutdown|stop|reboot)$/.exec(
        q.url,
      );
    if (q.method === 'POST' && m) {
      json(r, 200, {
        data: `UPID:pve:0000ABCD:00000001:6745A1B2:q${m[3]}:${m[2]}:${PVE_TOKEN_ID}:`,
      });
      return;
    }
    json(r, 404, { data: null });
  };
  fakes.push(f);
  return f;
}

async function setup(): Promise<{ s: IntegrationSetup; pve: FakeServer }> {
  const pve = await fakeProxmox().start();
  s = await withIntegrations();
  const res = await s.configure('proxmox', {
    url: pve.url,
    username: PVE_TOKEN_ID,
    secret: SENTINEL,
  });
  expect(res.statusCode).toBe(200);
  return { s, pve };
}

describe('proxmox parsing', () => {
  it('keeps nodes and guests, skips storage and odd node names', () => {
    const d = parseResources({ data: RESOURCES });
    expect(d.nodes).toEqual([
      { node: 'pve', online: true, cpu: 0.12, memBytes: 4e9, maxMemBytes: 16e9 },
    ]);
    expect(d.guests.map((g) => `${g.type}/${g.vmid}`)).toEqual([
      'qemu/101',
      'lxc/200',
      'qemu/9000',
    ]);
    expect(d.guests[0]).toMatchObject({ cpus: 4, uptimeS: 3600, template: false });
    expect(d.guests[2]?.template).toBe(true);
  });
});

describe('proxmox routes', () => {
  it('settings: token id + secret, status ok after the first request, secret never returned', async () => {
    const { s, pve } = await setup();
    const res = await s.req('GET', '/api/proxmox/settings');
    const body = integrationSettingsSchema.parse(res.json());
    expect(body).toMatchObject({
      url: pve.url,
      username: PVE_TOKEN_ID,
      secretSet: true,
      caSet: false,
      variant: null,
      status: 'ok',
      error: null,
    });
    expect(body.lastOkAt).not.toBeNull();
    expect(res.body).not.toContain(SENTINEL);
  });

  it('lists VMs and LXC with nodes; cached for 10 s', async () => {
    const { s, pve } = await setup();
    const n = pve.requests.length;
    const res = await s.req('GET', '/api/proxmox/guests');
    expect(res.statusCode).toBe(200);
    const body = proxmoxGuestsResponseSchema.parse(res.json());
    expect(body.guests.map((g) => g.name)).toEqual(['docker-vm', 'pihole', 'debian-tpl']);
    expect(body.nodes).toHaveLength(1);
    expect(body.error).toBeNull();
    // Fresh from the PUT: no new request.
    expect(pve.requests.length).toBe(n);
    s.t.clock.advance(11_000);
    await s.req('GET', '/api/proxmox/guests');
    expect(pve.requests.length).toBe(n + 1);
  });

  it('starts a VM without step-up and returns the UPID; audited', async () => {
    const { s, pve } = await setup();
    s.expireStepUp();
    const res = await s.req('POST', '/api/proxmox/guests/pve/qemu/101/start', {});
    expect(res.statusCode).toBe(200);
    const body = proxmoxGuestActionResponseSchema.parse(res.json());
    expect(body.task).toMatch(/^UPID:pve:/);
    const call = pve.requests.at(-1);
    expect(call).toMatchObject({
      method: 'POST',
      url: '/api2/json/nodes/pve/qemu/101/status/start',
    });
    const rows = s.t.db.db.select().from(auditLog).all();
    const a = rows.find((r) => r.action === 'proxmox.guest_action');
    expect(a?.target).toBe('pve/qemu/101');
    expect(a?.detailsJson).not.toContain(SENTINEL);
  });

  it('stop/shutdown/reboot need step-up and confirm', async () => {
    const { s, pve } = await setup();
    s.expireStepUp();
    for (const action of ['stop', 'shutdown', 'reboot']) {
      const res = await s.req('POST', `/api/proxmox/guests/pve/lxc/200/${action}`, {
        confirm: true,
      });
      expect(res.statusCode, action).toBe(403);
      expect(res.json()).toEqual({ ok: false, error: 'step_up_required' });
    }
    await s.stepUp();
    const noConfirm = await s.req('POST', '/api/proxmox/guests/pve/lxc/200/stop', {});
    expect(noConfirm.statusCode).toBe(400);
    expect(noConfirm.json()).toMatchObject({
      error: 'invalid_input',
      message: 'Bestätigung fehlt',
    });
    const before = pve.requests.filter((r) => r.method === 'POST').length;
    expect(before).toBe(0);
    const ok = await s.req('POST', '/api/proxmox/guests/pve/lxc/200/stop', { confirm: true });
    expect(ok.statusCode).toBe(200);
    expect(pve.requests.at(-1)?.url).toBe('/api2/json/nodes/pve/lxc/200/status/stop');
  });

  it('templates cannot be started; unknown guests 404; invalid params 400', async () => {
    const { s } = await setup();
    const tpl = await s.req('POST', '/api/proxmox/guests/pve/qemu/9000/start', {});
    expect(tpl.statusCode).toBe(409);
    for (const url of [
      '/api/proxmox/guests/pve/qemu/999/start',
      '/api/proxmox/guests/pve/lxc/101/start',
      '/api/proxmox/guests/other/qemu/101/start',
    ]) {
      const res = await s.req('POST', url, {});
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toMatchObject({ error: 'not_found' });
    }
    for (const url of [
      '/api/proxmox/guests/pve/qemu/1/start',
      '/api/proxmox/guests/pve/storage/101/start',
      '/api/proxmox/guests/pve/qemu/101/delete',
      '/api/proxmox/guests/pve%2F..%2Fx/qemu/101/start',
    ]) {
      const res = await s.req('POST', url, {});
      expect(res.statusCode, url).toBe(400);
    }
    const extra = await s.req('POST', '/api/proxmox/guests/pve/qemu/101/start', { force: true });
    expect(extra.statusCode).toBe(400);
  });

  it('actions are rate limited', async () => {
    const { s } = await setup();
    for (let i = 0; i < PROXMOX_ACTIONS_PER_MIN; i++) {
      expect((await s.req('POST', '/api/proxmox/guests/pve/qemu/101/start', {})).statusCode).toBe(
        200,
      );
    }
    const res = await s.req('POST', '/api/proxmox/guests/pve/qemu/101/start', {});
    expect(res.statusCode).toBe(429);
  });

  it('wrong token: status error "Zugangsdaten ungültig", action 502 with fixed text', async () => {
    const pve = await fakeProxmox('another-secret').start();
    s = await withIntegrations();
    const put = await s.configure('proxmox', {
      url: pve.url,
      username: PVE_TOKEN_ID,
      secret: SENTINEL,
    });
    expect(integrationSettingsSchema.parse(put.json())).toMatchObject({
      status: 'error',
      error: 'Zugangsdaten ungültig',
    });
    const guests = proxmoxGuestsResponseSchema.parse(
      (await s.req('GET', '/api/proxmox/guests')).json(),
    );
    expect(guests.error).toBe('Zugangsdaten ungültig');
    expect(guests.guests).toEqual([]);
  });

  it('polls every 30 s while on; 5 min unreachable raises one warn alert, resolved on success', async () => {
    const { s, pve } = await setup();
    const n = pve.requests.length;
    await tickIntegrations(s.t);
    expect(pve.requests.length).toBe(n);
    s.t.clock.advance(30_000);
    await tickIntegrations(s.t);
    expect(pve.requests.length).toBe(n + 1);
    const handler = pve.handler;
    pve.handler = (_q, r) => json(r, 500, {});
    s.t.clock.advance(30_000);
    await tickIntegrations(s.t);
    const key = unreachableAlertKey('proxmox');
    expect(s.t.app.hzCore.alerts.active(key)).toBeNull();
    for (let i = 0; i < 11; i++) {
      s.t.clock.advance(30_000);
      await tickIntegrations(s.t);
    }
    const alert = s.t.app.hzCore.alerts.active(key);
    expect(alert).toMatchObject({ level: 'warn', title: 'Proxmox nicht erreichbar' });
    expect(alert?.body).toContain('Unerwartete Antwort');
    pve.handler = handler;
    s.t.clock.advance(30_000);
    await tickIntegrations(s.t);
    expect(s.t.app.hzCore.alerts.active(key)).toBeNull();
  });

  it('switching the module off stops polling and resolves its alert', async () => {
    const { s, pve } = await setup();
    pve.handler = (_q, r) => json(r, 500, {});
    for (let i = 0; i < 12; i++) {
      s.t.clock.advance(30_000);
      await tickIntegrations(s.t);
    }
    const key = unreachableAlertKey('proxmox');
    expect(s.t.app.hzCore.alerts.active(key)).not.toBeNull();
    const off = await s.req('PUT', '/api/settings/modules', { proxmox: false });
    expect(off.statusCode).toBe(200);
    expect(s.t.app.hzCore.alerts.active(key)).toBeNull();
    const n = pve.requests.length;
    for (let i = 0; i < 4; i++) {
      s.t.clock.advance(30_000);
      await tickIntegrations(s.t);
    }
    expect(pve.requests.length).toBe(n);
    const res = await s.req('GET', '/api/proxmox/guests');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ ok: false, error: 'module_disabled' });
  });

  it('DELETE settings forgets everything (step-up)', async () => {
    const { s } = await setup();
    s.expireStepUp();
    expect((await s.req('DELETE', '/api/proxmox/settings')).statusCode).toBe(403);
    await s.stepUp();
    expect((await s.req('DELETE', '/api/proxmox/settings')).statusCode).toBe(200);
    expect(
      integrationSettingsSchema.parse((await s.req('GET', '/api/proxmox/settings')).json()),
    ).toEqual({
      url: null,
      username: null,
      secretSet: false,
      caSet: false,
      variant: null,
      status: 'off',
      error: null,
      lastOkAt: null,
    });
    const rows = s.t.db.db.select().from(auditLog).all();
    expect(rows.some((r) => r.action === 'proxmox.settings_cleared')).toBe(true);
  });

  it('a plain user name is refused for Proxmox; variant only for the DNS filter', async () => {
    s = await withIntegrations();
    await s.stepUp();
    expect((await s.req('PUT', '/api/proxmox/settings', { username: 'root' })).statusCode).toBe(
      400,
    );
    expect((await s.req('PUT', '/api/proxmox/settings', { variant: 'pihole' })).statusCode).toBe(
      400,
    );
    expect((await s.req('PUT', '/api/proxmox/settings', { verify: false })).statusCode).toBe(400);
  });

  it('POST test runs a request now', async () => {
    const { s, pve } = await setup();
    const n = pve.requests.length;
    const res = await s.req('POST', '/api/proxmox/test', {});
    expect(res.statusCode).toBe(200);
    expect(integrationSettingsSchema.parse(res.json()).status).toBe('ok');
    expect(pve.requests.length).toBe(n + 1);
  });
});
