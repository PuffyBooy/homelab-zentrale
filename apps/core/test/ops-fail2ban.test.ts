import { afterEach, describe, expect, it } from 'vitest';
import { fail2banResponseSchema, fail2banServerSchema, type Fail2banJail } from '@hz/shared';
import { until, type Received, type WsClient } from './agent-helpers.js';
import { authHeaders, SAME_ORIGIN, type TestApp } from './helpers.js';
import { fail, ok, opsSetup } from './ops-helpers.js';

const clients: WsClient[] = [];
let t: TestApp | undefined;
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.app.close();
  t = undefined;
});

const isStatus = (m: Received): boolean => m.action === 'fail2ban.status';
const isUnban = (m: Received): boolean => m.action === 'fail2ban.unban';

function jail(ips: string[]): Fail2banJail {
  return {
    name: 'sshd',
    currentlyFailed: 1,
    totalFailed: 20,
    currentlyBanned: ips.length,
    totalBanned: 7,
    bannedIps: ips,
  };
}

describe('fail2ban', () => {
  it('GET lists every server: ok, not_installed, unsupported, failed, offline', async () => {
    const s = await opsSetup(clients, {
      servers: [
        {
          name: 'heimserver',
          reply: (rpc) =>
            isStatus(rpc) ? ok(rpc, { installed: true, jails: [jail(['203.0.113.7'])] }) : null,
        },
        {
          name: 'nas',
          reply: (rpc) => (isStatus(rpc) ? ok(rpc, { installed: false, jails: [] }) : null),
        },
        { name: 'alt', reply: (rpc) => (isStatus(rpc) ? fail(rpc, 'not_allowed') : null) },
        { name: 'kaputt', reply: (rpc) => (isStatus(rpc) ? ok(rpc, { jails: 'x' }) : null) },
        { name: 'weg' },
      ],
    });
    t = s.t;
    const weg = s.agents[4];
    if (!weg) throw new Error('no agent');
    weg.agent.close();
    await until(() => !s.t.app.hzCore.hub.isConnected(weg.serverId));
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/fail2ban',
      headers: authHeaders(s.cookie),
    });
    expect(res.statusCode).toBe(200);
    const body = fail2banResponseSchema.parse(res.json());
    expect(Object.fromEntries(body.servers.map((x) => [x.name, x.state]))).toEqual({
      heimserver: 'ok',
      nas: 'not_installed',
      alt: 'unsupported',
      kaputt: 'failed',
      weg: 'offline',
    });
    expect(body.servers.find((x) => x.name === 'heimserver')?.jails[0]?.bannedIps).toEqual([
      '203.0.113.7',
    ]);
    expect(weg.rpcs.some(isStatus)).toBe(false);
  });

  it('caches per server for 30 s', async () => {
    const s = await opsSetup(clients, {
      servers: [
        {
          name: 'heimserver',
          reply: (rpc) => (isStatus(rpc) ? ok(rpc, { installed: true, jails: [jail([])] }) : null),
        },
      ],
    });
    t = s.t;
    const get = () =>
      s.t.app.inject({ method: 'GET', url: '/api/fail2ban', headers: authHeaders(s.cookie) });
    await get();
    await get();
    expect(s.agents[0]?.rpcs.filter(isStatus)).toHaveLength(1);
    t.clock.advance(29_000);
    await get();
    expect(s.agents[0]?.rpcs.filter(isStatus)).toHaveLength(1);
    t.clock.advance(2_000);
    await get();
    expect(s.agents[0]?.rpcs.filter(isStatus)).toHaveLength(2);
  });

  it('unban: sends jail + ip, invalidates the cache, returns the fresh server, audits', async () => {
    let banned = ['203.0.113.7', '2001:db8::1'];
    const s = await opsSetup(clients, {
      servers: [
        {
          name: 'heimserver',
          reply: (rpc) => {
            if (isStatus(rpc)) return ok(rpc, { installed: true, jails: [jail(banned)] });
            if (isUnban(rpc)) {
              const p = rpc.params as { ip: string };
              banned = banned.filter((ip) => ip !== p.ip);
              return ok(rpc, null);
            }
            return null;
          },
        },
      ],
    });
    t = s.t;
    const headers = authHeaders(s.cookie);
    await t.app.inject({ method: 'GET', url: '/api/fail2ban', headers });
    const sid = s.agents[0]?.serverId ?? '';
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/fail2ban/unban',
      headers,
      payload: { serverId: sid, jail: 'sshd', ip: '2001:db8::1' },
    });
    expect(res.statusCode).toBe(200);
    const server = fail2banServerSchema.parse(res.json());
    expect(server.jails[0]?.bannedIps).toEqual(['203.0.113.7']);
    expect(s.agents[0]?.rpcs.find(isUnban)?.params).toEqual({ jail: 'sshd', ip: '2001:db8::1' });
    expect(s.agents[0]?.rpcs.filter(isStatus)).toHaveLength(2);
    const audit = t.db.sqlite
      .prepare("SELECT target, details_json AS d FROM audit_log WHERE action = 'fail2ban.unban'")
      .all() as { target: string; d: string }[];
    expect(audit).toHaveLength(1);
    expect(audit[0]?.target).toBe(sid);
    expect(JSON.parse(audit[0]?.d ?? '{}')).toEqual({
      serverId: sid,
      jail: 'sshd',
      ip: '2001:db8::1',
    });
  });

  it('unban errors: unknown server 404, unknown jail 404, offline 409', async () => {
    const s = await opsSetup(clients, {
      servers: [
        { name: 'heimserver', reply: (rpc) => (isUnban(rpc) ? fail(rpc, 'not_found') : null) },
        { name: 'weg' },
      ],
    });
    t = s.t;
    const headers = authHeaders(s.cookie);
    const unban = (serverId: string) =>
      s.t.app.inject({
        method: 'POST',
        url: '/api/fail2ban/unban',
        headers,
        payload: { serverId, jail: 'sshd', ip: '198.51.100.1' },
      });
    expect((await unban('AAAAAAAAAAAAAAAAAAAAAA')).statusCode).toBe(404);
    expect((await unban(s.agents[0]?.serverId ?? '')).statusCode).toBe(404);
    const weg = s.agents[1];
    if (!weg) throw new Error('no agent');
    weg.agent.close();
    await until(() => !s.t.app.hzCore.hub.isConnected(weg.serverId));
    const off = await unban(weg.serverId);
    expect(off.statusCode).toBe(409);
    expect(off.json()).toMatchObject({ error: 'agent_offline' });
  });

  it('module off -> 404 module_disabled; anonymous -> 401', async () => {
    const s = await opsSetup(clients, { modules: { fail2ban: false } });
    t = s.t;
    for (const [method, url] of [
      ['GET', '/api/fail2ban'],
      ['POST', '/api/fail2ban/unban'],
    ] as const) {
      const off = await t.app.inject({
        method,
        url,
        headers: authHeaders(s.cookie),
        ...(method === 'POST' ? { payload: {} } : {}),
      });
      expect(off.statusCode, url).toBe(404);
      expect(off.json()).toEqual({ ok: false, error: 'module_disabled' });
      const anon = await t.app.inject({ method, url, headers: SAME_ORIGIN });
      expect(anon.statusCode, url).toBe(401);
    }
    expect(s.agents[0]?.rpcs.some((r) => isStatus(r) || isUnban(r))).toBe(false);
  });
});
