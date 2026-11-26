import { afterEach, describe, expect, it } from 'vitest';
import { vulnScanStateSchema } from '@hz/shared';
import type { Received, WsClient } from './agent-helpers.js';
import { info } from './container-helpers.js';
import { authHeaders, SAME_ORIGIN, type TestApp } from './helpers.js';
import { fail, ok, opsSetup, vulnData } from './ops-helpers.js';
import { VULNSCAN_RESULTS_KEY, vulnAlertKey } from '../src/ops/vulnscan.js';
import { readSetting } from '../src/db/settings.js';

const clients: WsClient[] = [];
let t: TestApp | undefined;
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.app.close();
  t = undefined;
});

const OPS_PREFIXES = ['/api/logsearch', '/api/vulnscan', '/api/fail2ban'];

describe('ops modules security', () => {
  it('no ops route answers without a session (also with the modules on)', async () => {
    const s = await opsSetup(clients);
    t = s.t;
    const routes = t.app.hzRoutes.filter((r) =>
      OPS_PREFIXES.some((p) => r.url === p || r.url.startsWith(`${p}/`)),
    );
    expect(routes.map((r) => `${r.method} ${r.url}`).sort()).toEqual(
      expect.arrayContaining([
        'POST /api/logsearch',
        'GET /api/vulnscan',
        'PUT /api/vulnscan/settings',
        'POST /api/vulnscan/run',
        'GET /api/fail2ban',
        'POST /api/fail2ban/unban',
      ]),
    );
    for (const r of routes) {
      const res = await t.app.inject({
        method: r.method as 'GET',
        url: r.url,
        headers: SAME_ORIGIN,
        ...(r.method === 'GET' || r.method === 'HEAD' ? {} : { payload: {} }),
      });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
    }
    // A changing request from another origin is refused even with a session.
    const cross = await t.app.inject({
      method: 'POST',
      url: '/api/fail2ban/unban',
      headers: { ...authHeaders(s.cookie), origin: 'https://evil.example' },
      payload: { serverId: s.agents[0]?.serverId, jail: 'sshd', ip: '203.0.113.7' },
    });
    expect(cross.statusCode).toBe(403);
    expect(s.agents[0]?.rpcs.some((r) => r.action === 'fail2ban.unban')).toBe(false);
  });

  it('the log search query never appears in app logs or the audit log', async () => {
    // Split so secret scanners do not flag the fake token in this file.
    const SECRET = ['ghp', 'SuperSecretToken1234567890'].join('_');
    const s = await opsSetup(clients, {
      captureLogs: true,
      servers: [
        {
          name: 'heimserver',
          reply: (rpc) => (rpc.action === 'logs.search' ? fail(rpc, 'failed') : null),
        },
        {
          name: 'cloud',
          reply: (rpc) => (rpc.action === 'logs.search' ? ok(rpc, { bogus: SECRET }) : null),
        },
      ],
    });
    t = s.t;
    const headers = authHeaders(s.cookie);
    for (const payload of [
      { query: SECRET },
      { query: SECRET, caseSensitive: 'yes' },
      { query: `${SECRET}\u0007` },
    ]) {
      await t.app.inject({ method: 'POST', url: '/api/logsearch', headers, payload });
    }
    const logs = t.logs.join('');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain('SuperSecretToken');
    const audit = t.db.sqlite.prepare('SELECT details_json AS d FROM audit_log').all() as {
      d: string | null;
    }[];
    expect(audit.some((a) => a.d?.includes('SuperSecretToken'))).toBe(false);
  });

  it('unban: a bad ip or jail is rejected with 400 and never reaches the agent', async () => {
    const s = await opsSetup(clients);
    t = s.t;
    const serverId = s.agents[0]?.serverId ?? '';
    const headers = authHeaders(s.cookie);
    for (const payload of [
      { serverId, jail: 'sshd', ip: '203.0.113.7; rm -rf /' },
      { serverId, jail: 'sshd', ip: '999.1.1.1' },
      { serverId, jail: 'sshd', ip: '10.0.0.0/8' },
      { serverId, jail: 'sshd', ip: '' },
      { serverId, jail: 'ssh d', ip: '203.0.113.7' },
      { serverId, jail: '../etc', ip: '203.0.113.7' },
      { serverId, jail: '-h', ip: '203.0.113.7' },
      { serverId, jail: '.hidden', ip: '203.0.113.7' },
      { serverId, jail: 'a'.repeat(65), ip: '203.0.113.7' },
      { serverId, jail: 'sshd', ip: '203.0.113.7', all: true },
      { serverId: '../x', jail: 'sshd', ip: '203.0.113.7' },
      { jail: 'sshd', ip: '203.0.113.7' },
    ]) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/fail2ban/unban',
        headers,
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json()).toEqual({ ok: false, error: 'invalid_input' });
    }
    expect(s.agents[0]?.rpcs.some((r) => r.action === 'fail2ban.unban')).toBe(false);
  });

  it('vulnscan cannot be told an image or container (strict bodies)', async () => {
    const s = await opsSetup(clients);
    t = s.t;
    const headers = authHeaders(s.cookie);
    for (const payload of [
      { image: 'evil/miner:latest' },
      { id: 'abcdef012345' },
      { containers: ['x'] },
    ]) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/vulnscan/run',
        headers,
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const put = await t.app.inject({
      method: 'PUT',
      url: '/api/vulnscan/settings',
      headers,
      payload: { time: '03:30', alertFrom: 'critical', trivyImage: 'evil/trivy' },
    });
    expect(put.statusCode).toBe(400);
    expect(s.agents[0]?.rpcs.some((r) => r.action === 'image.scan')).toBe(false);
    // The core only ever sends the docker id of an inventoried container.
    const run = await t.app.inject({
      method: 'POST',
      url: '/api/vulnscan/run',
      headers,
      payload: {},
    });
    expect(run.statusCode).toBe(202);
    await t.app.hzCore.ops.vulnscan.idle();
    const sent = s.agents[0]?.rpcs.filter((r) => r.action === 'image.scan') ?? [];
    expect(sent.map((r) => r.params)).toEqual([{ id: info('heimserver-web').dockerId }]);
  });

  it('results and alerts of a deleted server disappear', async () => {
    const scan = (rpc: Received) => (rpc.action === 'image.scan' ? ok(rpc, vulnData(2, 0)) : null);
    const s = await opsSetup(clients, {
      servers: [
        { name: 'heimserver', containers: [info('nginx')], reply: scan },
        { name: 'cloud', containers: [info('proxy')], reply: scan },
      ],
    });
    t = s.t;
    await t.app.hzCore.ops.vulnscan.start();
    const gone = s.agents[1]?.serverId ?? '';
    expect(t.app.hzCore.alerts.active(vulnAlertKey(gone, 'proxy'))).not.toBeNull();
    t.app.hzCore.hub.disconnect(gone, 'deleted');
    expect(t.app.hzCore.servers.delete(gone)).toBe(true);
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/vulnscan',
      headers: authHeaders(s.cookie),
    });
    const st = vulnScanStateSchema.parse(res.json());
    expect(st.results.map((r) => r.serverName)).toEqual(['heimserver']);
    expect(JSON.stringify(readSetting(t.db.db, VULNSCAN_RESULTS_KEY))).not.toContain(gone);
    expect(t.app.hzCore.alerts.active(vulnAlertKey(gone, 'proxy'))).toBeNull();
    expect(
      t.app.hzCore.alerts.active(vulnAlertKey(s.agents[0]?.serverId ?? '', 'nginx')),
    ).not.toBeNull();
  });
});
