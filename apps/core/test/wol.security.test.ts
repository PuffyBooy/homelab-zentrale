import { afterEach, describe, expect, it } from 'vitest';
import { rpcParamsByAction } from '@hz/shared';
import { auditLog, settings } from '../src/db/schema.js';
import { writeSetting } from '../src/db/settings.js';
import { wolKey } from '../src/wol/service.js';
import { authHeaders, SAME_ORIGIN } from './helpers.js';
import { makePluginApp, type PluginApp } from './notify-helpers.js';

const A = 'srv-heim-0001';
const B = 'srv-pi-000002';
const MAC = 'AA:BB:CC:DD:EE:01';

let p: PluginApp | undefined;
afterEach(async () => {
  await p?.app.close();
  p = undefined;
});

async function app(): Promise<PluginApp> {
  const t = await makePluginApp();
  t.servers.set(A, { id: A, name: 'heimserver' });
  t.servers.set(B, { id: B, name: 'raspi' });
  return t;
}

const put = (t: PluginApp, id: string, payload: Record<string, unknown>) =>
  t.app.inject({
    method: 'PUT',
    url: `/api/servers/${id}/wol`,
    headers: authHeaders(t.cookie),
    payload,
  });
const wake = (t: PluginApp, id: string) =>
  t.app.inject({ method: 'POST', url: `/api/servers/${id}/wake`, headers: authHeaders(t.cookie) });

describe('wake-on-lan: authentication', () => {
  it('every route needs an admin session', async () => {
    p = await app();
    for (const [method, url] of [
      ['GET', `/api/servers/${A}/wol`],
      ['PUT', `/api/servers/${A}/wol`],
      ['POST', `/api/servers/${A}/wake`],
    ] as const) {
      const res = await p.app.inject({ method, url, headers: SAME_ORIGIN, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    expect(p.udp.sent).toEqual([]);
  });

  it('no step-up needed (waking is harmless)', async () => {
    p = await app();
    p.clock.advance(20 * 60_000);
    expect((await put(p, A, { mac: MAC })).statusCode).toBe(200);
    expect((await wake(p, A)).statusCode).toBe(200);
  });
});

describe('wake-on-lan: input rules', () => {
  it('broadcast to a public IP or a unicast outside private ranges is refused', async () => {
    p = await app();
    for (const broadcast of [
      '8.8.8.8',
      '1.1.1.255',
      '100.64.0.255',
      '169.254.255.255',
      'evil.example',
      '::1',
    ]) {
      const res = await put(p, A, { mac: MAC, broadcast });
      expect(res.statusCode, broadcast).toBe(400);
    }
    for (const broadcast of ['255.255.255.255', '192.168.1.255', '10.0.0.255', '172.16.255.255']) {
      expect((await put(p, A, { mac: MAC, broadcast })).statusCode, broadcast).toBe(200);
    }
  });

  it('via the server itself is refused, an unknown sender too', async () => {
    p = await app();
    const self = await put(p, A, { mac: MAC, via: A });
    expect(self.statusCode).toBe(400);
    expect(self.json()).toMatchObject({ error: 'invalid_input' });
    const unknown = await put(p, A, { mac: MAC, via: 'srv-unknown-9' });
    expect(unknown.statusCode).toBe(400);
    expect(
      p.db.db
        .select()
        .from(settings)
        .all()
        .filter((r) => r.key.startsWith('wol.')),
    ).toEqual([]);
  });

  it('broken MACs and ports are refused', async () => {
    p = await app();
    for (const body of [
      { mac: 'FF:FF:FF:FF:FF:FF' },
      { mac: '00:00:00:00:00:00' },
      { mac: '01:00:5E:00:00:01' },
      { mac: 'AA:BB:CC:DD:EE' },
      { mac: MAC, port: 80 },
      { mac: MAC, extra: true },
      {},
    ]) {
      expect((await put(p, A, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('unknown server: 404', async () => {
    p = await app();
    expect((await put(p, 'srv-missing-1', { mac: MAC })).statusCode).toBe(404);
    expect((await wake(p, 'srv-missing-1')).statusCode).toBe(404);
  });

  it('a tampered stored entry is treated as not set up (no packet to a public address)', async () => {
    p = await app();
    writeSetting(
      p.db.db,
      wolKey(A),
      { mac: MAC, broadcast: '8.8.8.8', port: 9, via: 'core' },
      p.clock.t,
    );
    const res = await wake(p, A);
    expect(res.statusCode).toBe(404);
    expect(p.udp.sent).toEqual([]);
  });
});

describe('wake-on-lan: wake', () => {
  it('404 with a hint when no MAC is set', async () => {
    p = await app();
    const res = await wake(p, A);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      ok: false,
      error: 'not_found',
      message: 'Keine MAC-Adresse eingetragen',
    });
  });

  it('rate limit: 6 per minute and server, then 429', async () => {
    p = await app();
    await put(p, A, { mac: MAC });
    await put(p, B, { mac: 'AA:BB:CC:DD:EE:02' });
    for (let i = 0; i < 6; i++) expect((await wake(p, A)).statusCode).toBe(200);
    const limited = await wake(p, A);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: 'rate_limited' });
    expect(p.udp.sent).toHaveLength(6);
    // Other servers have their own budget.
    expect((await wake(p, B)).statusCode).toBe(200);
    p.clock.advance(61_000);
    expect((await wake(p, A)).statusCode).toBe(200);
  });

  it('via another server: agent wol.send with checked params; 409 if offline', async () => {
    p = await app();
    await put(p, A, { mac: 'aa-bb-cc-dd-ee-01', broadcast: '192.168.1.255', port: 7, via: B });
    const offline = await wake(p, A);
    expect(offline.statusCode).toBe(409);
    expect(offline.json()).toMatchObject({ error: 'agent_offline' });
    p.online.add(B);
    const ok = await wake(p, A);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, via: B });
    expect(p.udp.sent).toEqual([]);
    expect(p.hubCalls).toHaveLength(1);
    const call = p.hubCalls[0];
    expect(call?.serverId).toBe(B);
    expect(call?.action).toBe('wol.send');
    expect(call?.params).toEqual({ mac: MAC, broadcast: '192.168.1.255', port: 7 });
    expect(rpcParamsByAction['wol.send'].safeParse(call?.params).success).toBe(true);
  });

  it('every change and wake is audited', async () => {
    p = await app();
    await put(p, A, { mac: MAC });
    await wake(p, A);
    await put(p, A, { mac: null });
    const actions = p.db.db
      .select()
      .from(auditLog)
      .all()
      .map((a) => [a.action, a.target]);
    expect(actions).toEqual(
      expect.arrayContaining([
        ['server.wol_updated', A],
        ['server.wake', A],
        ['server.wol_removed', A],
      ]),
    );
  });
});
