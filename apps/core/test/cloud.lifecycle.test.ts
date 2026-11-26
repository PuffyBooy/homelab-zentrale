import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLOUD_MACHINE_STATE_TEXT,
  cloudMachineCreateRequestSchema,
  errorResponseSchema,
} from '@hz/shared';
import { formatEur, formatEurHour } from '../src/cloud/service.js';
import { UNREADABLE } from '../src/cloud/store.js';
import { until, withStepUp } from './agent-helpers.js';
import {
  cloudTick,
  FAKE_AZURE_SECRET,
  machineOf,
  order,
  orderBody,
  orderedWithGame,
  pass,
  req,
  SimAgent,
  untilState,
  withCloud,
  type CloudSetup,
} from './cloud-helpers.js';

const OTHER_GUID = '12345678-1234-1234-1234-123456789abc';
const OFF_REFUSAL = 'Erst alle Cloud-Server schlafen legen oder löschen';

let s: CloudSetup | null = null;
let agents: SimAgent[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const a of agents) await a.disconnect();
  agents = [];
  await s?.t.app.close();
  s = null;
});

async function setup(): Promise<CloudSetup> {
  s = await withCloud();
  return s;
}

/** A machine without a game: ordered, agent enrolled, running. */
async function bareMachine(
  c: CloudSetup,
  name = 'hz-box',
): Promise<{ id: string; agent: SimAgent }> {
  const m = await order(c, { name, game: undefined });
  await untilState(c, m.id, 'installing');
  const code = c.azure.onboardingCode(name);
  if (!code) throw new Error('no code');
  const agent = new SimAgent(name);
  agents.push(agent);
  await agent.enroll(c, code);
  await until(() => c.t.app.hzCore.hub.isConnected(agent.serverId));
  await untilState(c, m.id, 'running', agent);
  return { id: m.id, agent };
}

/** Puts a running bare machine to sleep from the cloud page (the agent goes with the VM). */
async function sleepBare(c: CloudSetup, id: string, agent: SimAgent): Promise<void> {
  c.azure.onPower = (_vm, state) => {
    if (state === 'deallocated') void agent.disconnect();
  };
  expect((await req(c, 'POST', `/api/cloud/machines/${id}/stop`)).statusCode).toBe(202);
  await untilState(c, id, 'deallocated', agent);
  await until(() => !c.t.app.hzCore.hub.isConnected(agent.serverId));
}

function vmPowered(c: CloudSetup, id: string): number {
  const r = c.t.db.sqlite
    .prepare('SELECT vm_powered AS p FROM cloud_machines WHERE id = ?')
    .get(id) as {
    p: number;
  };
  return r.p;
}

function openCodes(c: CloudSetup): number {
  return (
    c.t.db.sqlite
      .prepare('SELECT COUNT(*) AS n FROM onboarding_codes WHERE cancelled_at IS NULL')
      .get() as { n: number }
  ).n;
}

describe('cloud machine lifecycle (M22 review)', { timeout: 60_000 }, () => {
  it('a stop during a start wins: the start step never writes running afterwards', async () => {
    const c = await setup();
    const { id, agent } = await bareMachine(c);
    await sleepBare(c, id, agent);
    expect(vmPowered(c, id)).toBe(0);
    // The admin stops while the tick waits for the power state (agent already back).
    let hit = false;
    c.azure.override = (r) => {
      if (
        !hit &&
        r.method === 'GET' &&
        r.path.endsWith('/instanceView') &&
        c.t.app.hzCore.hub.isConnected(agent.serverId)
      ) {
        hit = true;
        c.t.app.hzCore.cloud.stop(id);
      }
      return null;
    };
    expect((await req(c, 'POST', `/api/cloud/machines/${id}/start`, {})).statusCode).toBe(202);
    await c.t.app.hzCore.cloud.idle();
    expect(c.azure.power.get('hz-box')).toBe('running');
    expect(vmPowered(c, id)).toBe(1);
    await agent.reconnect(c);
    await c.t.app.hzCore.cloud.idle();
    await cloudTick(c, 5_000, agent);
    expect(hit).toBe(true);
    // Never running after the stop: the late write of the start step was dropped.
    expect(['stopping', 'deallocated']).toContain(machineOf(c, id).state);
    const ready = c.t.db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'cloud.machine_stop'")
      .get() as { n: number };
    expect(ready.n).toBe(2);
    c.azure.override = null;
    await untilState(c, id, 'deallocated', agent);
    expect(c.azure.power.get('hz-box')).toBe('deallocated');
    expect(vmPowered(c, id)).toBe(0);
    await pass(c, 60_000);
    expect(machineOf(c, id).state).toBe('deallocated');
  });

  it('a delete during a start wins: the VM is removed, billed until it is gone', async () => {
    const c = await setup();
    const { id, agent } = await bareMachine(c);
    await sleepBare(c, id, agent);
    let hit = false;
    c.azure.override = (r) => {
      if (!hit && r.method === 'POST' && r.path.endsWith('/start')) {
        hit = true;
        c.t.app.hzCore.cloud.remove(id, 'hz-box');
      }
      return null;
    };
    expect((await req(c, 'POST', `/api/cloud/machines/${id}/start`, {})).statusCode).toBe(202);
    await c.t.app.hzCore.cloud.idle();
    expect(hit).toBe(true);
    const m = machineOf(c, id);
    expect(m.state).toBe('deleting');
    expect(m.stateText).not.toBe('VM startet');
    // The VM was started: deleting is billed until Azure has removed it.
    expect(vmPowered(c, id)).toBe(1);
    c.azure.override = null;
    for (let i = 0; i < 10 && c.t.app.hzCore.cloud.overview().machines.length > 0; i++) {
      await cloudTick(c);
    }
    expect(c.t.app.hzCore.cloud.overview().machines).toEqual([]);
    expect(c.azure.names()).toEqual(['virtualNetworks/hz-vnet-germanywestcentral']);
    expect(c.t.app.hzCore.servers.summary(agent.serverId)).toBeNull();
  });

  it('stop is refused while a game is busy; stop needs a session', async () => {
    const c = await setup();
    const { machine, agent, gameId } = await orderedWithGame(c);
    agents.push(agent);
    const url = `/api/cloud/machines/${machine.id}/stop`;
    const noSession = await c.t.app.inject({
      method: 'POST',
      url,
      headers: { ...c.headers, cookie: '' },
    });
    expect(noSession.statusCode).toBe(401);
    vi.spyOn(c.t.app.hzCore.games, 'isBusy').mockImplementation((g) => g === gameId);
    const busy = await req(c, 'POST', url);
    expect(busy.statusCode).toBe(409);
    expect(errorResponseSchema.parse(busy.json())).toEqual({
      ok: false,
      error: 'busy',
      message: 'Ein Gameserver ist gerade beschäftigt',
    });
    expect(machineOf(c, machine.id).state).toBe('running');
    vi.restoreAllMocks();
    expect((await req(c, 'POST', url)).statusCode).toBe(202);
  });

  it('a running VM whose agent is gone is deallocated after the start timeout, with a warning; its server is deleted only via the cloud page', async () => {
    const c = await setup();
    const { machine, agent } = await orderedWithGame(c);
    agents.push(agent);
    const del = await withStepUp(c.t, () => req(c, 'DELETE', `/api/servers/${agent.serverId}`));
    expect(del.statusCode).toBe(409);
    expect(errorResponseSchema.parse(del.json())).toEqual({
      ok: false,
      error: 'conflict',
      message: 'Über die Cloud-Seite löschen',
    });
    expect(c.t.app.hzCore.servers.summary(agent.serverId)).not.toBeNull();
    expect((await req(c, 'DELETE', `/api/servers/${agent.serverId}`)).json()).toEqual({
      ok: false,
      error: 'step_up_required',
    });

    await agent.disconnect();
    await until(() => !c.t.app.hzCore.hub.isConnected(agent.serverId));
    // CLOUD_START_TIMEOUT_MINUTES (8): until then it may come back.
    await pass(c, 7 * 60_000);
    expect(machineOf(c, machine.id).state).toBe('running');
    expect(c.azure.power.get(machine.name)).toBe('running');
    await pass(c, 2 * 60_000);
    await untilState(c, machine.id, 'deallocated');
    expect(c.azure.power.get(machine.name)).toBe('deallocated');
    expect(vmPowered(c, machine.id)).toBe(0);
    const alert = c.t.app.hzCore.alerts.active(`cloud:${machine.id}:agent`);
    expect(alert?.level).toBe('warn');
    expect(alert?.title).toBe(`Cloud-Server ${machine.name} ohne Agent schlafen gelegt`);
    const audit = c.t.db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'cloud.machine_agent_lost'")
      .get() as { n: number };
    expect(audit.n).toBe(1);
  });

  it('failed with a VM that does not deallocate: retried every tick, billed meanwhile, module off refused', async () => {
    const c = await setup();
    const m = await order(c, { game: undefined });
    await untilState(c, m.id, 'installing');
    c.azure.override = (r) =>
      r.method === 'POST' && r.path.endsWith('/deallocate') ? { status: 500, body: {} } : null;
    await pass(c, 26 * 60_000);
    const f = machineOf(c, m.id);
    expect(f.state).toBe('failed');
    expect(f.error).toBe('Agent hat sich nicht gemeldet');
    expect(f.stateText).toBe('Einrichtung fehlgeschlagen');
    expect(c.t.app.hzCore.alerts.active(`cloud:${m.id}:failed`)?.body).toBe(
      'Einrichtung fehlgeschlagen. Auf der Seite Cloud löschen und neu bestellen.',
    );
    expect(c.azure.power.get('hz-mc')).toBe('running');
    const tries = () =>
      c.azure.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/deallocate')).length;
    const before = tries();
    const h1 = f.monthHours;
    await pass(c, 30 * 60_000);
    expect(tries()).toBeGreaterThan(before + 10);
    expect(machineOf(c, m.id).monthHours).toBeCloseTo(h1 + 0.5, 1);

    const off = await withStepUp(c.t, () =>
      req(c, 'PUT', '/api/settings/modules', { cloud: false }),
    );
    expect(off.statusCode).toBe(409);
    expect(errorResponseSchema.parse(off.json())).toEqual({
      ok: false,
      error: 'conflict',
      message: OFF_REFUSAL,
    });
    expect((await req(c, 'GET', '/api/cloud')).statusCode).toBe(200);

    c.azure.override = null;
    await cloudTick(c);
    await cloudTick(c);
    expect(c.azure.power.get('hz-mc')).toBe('deallocated');
    expect(vmPowered(c, m.id)).toBe(0);
    const h2 = machineOf(c, m.id).monthHours;
    await pass(c, 30 * 60_000);
    expect(machineOf(c, m.id).monthHours).toBe(h2);
    const ok = await withStepUp(c.t, () =>
      req(c, 'PUT', '/api/settings/modules', { cloud: false }),
    );
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('module off is refused while a machine runs; bad input 400', async () => {
    const c = await setup();
    const { id, agent } = await bareMachine(c);
    const off = await withStepUp(c.t, () =>
      req(c, 'PUT', '/api/settings/modules', { cloud: false }),
    );
    expect(off.statusCode).toBe(409);
    expect(off.json()).toMatchObject({ error: 'conflict', message: OFF_REFUSAL });
    const bad = await withStepUp(c.t, () =>
      req(c, 'PUT', '/api/settings/modules', { cloud: 'aus' }),
    );
    expect(bad.statusCode).toBe(400);
    await sleepBare(c, id, agent);
    const ok = await withStepUp(c.t, () =>
      req(c, 'PUT', '/api/settings/modules', { cloud: false }),
    );
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('unreadable credentials: an order fails, a stop waits with an alert; account changes are refused while machines exist', async () => {
    const c = await setup();
    const { id, agent } = await bareMachine(c);
    const fresh = await order(c, { name: 'hz-new', game: undefined });
    // The secret can no longer be decrypted (e.g. HZ_SECRET_KEY changed).
    c.t.db.sqlite
      .prepare("UPDATE settings SET value_json = ? WHERE key = 'cloud.azure.clientSecret'")
      .run(JSON.stringify('v1.broken'));
    c.azure.onPower = (_vm, state) => {
      if (state === 'deallocated') void agent.disconnect();
    };
    expect((await req(c, 'POST', `/api/cloud/machines/${id}/stop`)).statusCode).toBe(202);
    await cloudTick(c, 5_000, agent);
    await cloudTick(c, 5_000, agent);
    const failed = machineOf(c, fresh.id);
    expect(failed.state).toBe('failed');
    expect(failed.error).toBe(UNREADABLE);
    expect(failed.stateText).toBe('Bestellung fehlgeschlagen');
    const stopping = machineOf(c, id);
    expect(stopping.state).toBe('stopping');
    expect(stopping.stateText).toBe(`${CLOUD_MACHINE_STATE_TEXT.stopping} (${UNREADABLE})`);
    expect(c.t.app.hzCore.alerts.active('cloud:credentials')?.level).toBe('crit');

    // An app, account or group change would leave the machines without credentials.
    for (const body of [
      { clientId: OTHER_GUID },
      { tenantId: OTHER_GUID },
      { subscriptionId: OTHER_GUID },
      { resourceGroup: 'andere-gruppe' },
    ]) {
      const res = await withStepUp(c.t, () => req(c, 'PUT', '/api/cloud/azure', body));
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        error: 'conflict',
        message: 'Erst alle Cloud-Server löschen, dann Konto, App oder Ressourcengruppe wechseln',
      });
    }
    const bad = await withStepUp(c.t, () => req(c, 'PUT', '/api/cloud/azure', { clientId: 'x' }));
    expect(bad.statusCode).toBe(400);
    // A new secret for the same app is fine: the stop goes on.
    const fix = await withStepUp(c.t, () =>
      req(c, 'PUT', '/api/cloud/azure', { clientSecret: FAKE_AZURE_SECRET }),
    );
    expect(fix.statusCode, fix.body).toBe(200);
    await untilState(c, id, 'deallocated', agent);
    await cloudTick(c);
    expect(c.t.app.hzCore.alerts.active('cloud:credentials')).toBeNull();
  });

  it('a transient error on the VM PUT keeps the onboarding code; the next tick finds the VM', async () => {
    const c = await setup();
    let lost = false;
    c.azure.override = (r) => {
      if (!lost && r.method === 'PUT' && r.path.includes('/virtualMachines/')) {
        lost = true;
        // The VM is created, but the answer never arrives.
        c.azure.handle(r);
        return { status: 503, body: {} };
      }
      return null;
    };
    const m = await order(c, { game: undefined });
    await untilState(c, m.id, 'installing');
    expect(lost).toBe(true);
    expect(openCodes(c)).toBe(1);
    const puts = c.azure.requests.filter(
      (r) => r.method === 'PUT' && r.path.endsWith('/virtualMachines/hz-mc'),
    );
    expect(puts).toHaveLength(2); // the lost one, seen twice by the fake (override + handle)
    const code = c.azure.onboardingCode('hz-mc');
    if (!code) throw new Error('no code');
    const agent = new SimAgent('hz-mc');
    agents.push(agent);
    await agent.enroll(c, code);
    await untilState(c, m.id, 'running', agent);
  });

  it('orders racing for the last slot or the same name: only one wins', async () => {
    const c = await setup();
    const cloud = c.t.app.hzCore.cloud;
    const body = (name: string) =>
      cloudMachineCreateRequestSchema.parse(orderBody({ name, game: undefined }));
    const same = await Promise.allSettled([
      cloud.create(body('hz-same')),
      cloud.create(body('hz-same')),
    ]);
    expect(same.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(same.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { userMessage: 'Name ist schon vergeben' },
    });
    for (let i = 0; i < 8; i++) await order(c, { name: `hz-m${i}`, game: undefined });
    const last = await Promise.allSettled([cloud.create(body('hz-a')), cloud.create(body('hz-b'))]);
    expect(last.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(last.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { userMessage: 'Höchstens 10 Cloud-Server' },
    });
    expect(cloud.overview().machines).toHaveLength(10);
    await cloud.idle();
  });

  it('euro amounts like the web: "1.234,50 €", "0,0961 €/Std"', () => {
    expect(formatEur(1234.5)).toBe('1.234,50 €');
    expect(formatEur(0.1)).toBe('0,10 €');
    expect(formatEurHour(0.0961)).toBe('0,0961 €/Std');
    expect(formatEurHour(0.19)).toBe('0,19 €/Std');
    expect(formatEurHour(0)).toBe('0,00 €/Std');
  });
});
