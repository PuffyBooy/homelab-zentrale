import { afterEach, describe, expect, it } from 'vitest';
import {
  azurePricesResponseSchema,
  CLOUD_GAME_TEXT,
  cloudOverviewSchema,
  errorResponseSchema,
  gameResponseSchema,
  shareCreateResponseSchema,
} from '@hz/shared';
import { until, withStepUp } from './agent-helpers.js';
import {
  B2MS_RUNNING,
  cloudTick,
  machineOf,
  order,
  orderBody,
  orderedWithGame,
  req,
  untilState,
  withCloud,
  type CloudSetup,
  type SimAgent,
} from './cloud-helpers.js';
import { HOST } from './helpers.js';

let s: CloudSetup | null = null;
let agents: SimAgent[] = [];

afterEach(async () => {
  for (const a of agents) await a.disconnect();
  agents = [];
  await s?.t.app.close();
  s = null;
});

async function setup(opts: Parameters<typeof withCloud>[0] = {}): Promise<CloudSetup> {
  s = await withCloud(opts);
  return s;
}

/** Advances the clock in 30 s steps, keeping the agent alive (heartbeat 90 s). */
async function pass(c: CloudSetup, ms: number, agent?: SimAgent, step = 30_000): Promise<void> {
  for (let left = ms; left > 0; left -= step) await cloudTick(c, Math.min(step, left), agent);
}

async function shareLink(c: CloudSetup, gameId: string): Promise<string> {
  const res = await withStepUp(c.t, () =>
    req(c, 'POST', `/api/games/${gameId}/shares`, {
      person: 'Max',
      perms: ['power'],
      expires: '7d',
    }),
  );
  expect(res.statusCode, res.body).toBe(201);
  return shareCreateResponseSchema.parse(res.json()).urls.tailnet.split('/s/')[1] ?? '';
}

function friendStart(c: CloudSetup, token: string) {
  return c.t.app.inject({
    method: 'POST',
    url: '/s/api/action',
    headers: {
      host: HOST,
      origin: `https://${HOST}`,
      'x-forwarded-for': '100.64.0.99',
      authorization: `Share ${token}`,
    },
    payload: { action: 'start' },
  });
}

/** Lets the machine fall asleep: game stopped, idle time over, VM deallocated. */
async function sleepMachine(c: CloudSetup, id: string, gameId: string, agent: SimAgent) {
  const stop = await req(c, 'POST', `/api/games/${gameId}/stop`);
  expect(stop.statusCode).toBe(200);
  await cloudTick(c, 5_000, agent);
  expect(machineOf(c, id).state).toBe('running');
  c.azure.onPower = (_vm, state) => {
    if (state === 'deallocated') void agent.disconnect();
  };
  await pass(c, 15 * 60_000, agent);
  await untilState(c, id, 'deallocated');
  await until(() => !c.t.app.hzCore.hub.isConnected(agent.serverId));
}

describe('cloud servers (M22)', { timeout: 60_000 }, () => {
  it('prices: live Linux pay-as-you-go prices, Windows and Spot skipped; fallback estimate', async () => {
    const c = await setup();
    const res = await req(c, 'GET', '/api/cloud/azure/prices');
    expect(res.statusCode).toBe(200);
    const p = azurePricesResponseSchema.parse(res.json());
    const b2ms = p.sizes.find((x) => x.size === 'Standard_B2ms');
    expect(b2ms?.cost.source).toBe('live');
    expect(b2ms?.cost.runningEurPerHour).toBe(B2MS_RUNNING);
    expect(p.fetchedAt).not.toBeNull();
    // A second call is served from the cache.
    const n = c.azure.requests.filter((r) => r.path === '/api/retail/prices').length;
    await req(c, 'GET', '/api/cloud/azure/prices?region=germanywestcentral');
    expect(c.azure.requests.filter((r) => r.path === '/api/retail/prices').length).toBe(n);
    // Another region with the prices API down: built-in estimate.
    c.azure.prices = null;
    const est = azurePricesResponseSchema.parse(
      (
        await req(c, 'GET', '/api/cloud/azure/prices?region=westeurope&diskGb=64&publicIp=false')
      ).json(),
    );
    expect(est.fetchedAt).toBeNull();
    expect(est.sizes.every((x) => x.cost.source === 'estimate')).toBe(true);
    expect((await req(c, 'GET', '/api/cloud/azure/prices?diskGb=33')).statusCode).toBe(400);
  });

  it('orders a Minecraft machine, the agent enrolls, the game is created, the NSG opens its port', async () => {
    const c = await setup();
    const ordered = await order(c);
    expect(ordered.state).toBe('creating');
    expect(ordered.pendingGameName).toBe('survival');
    expect(ordered.cost.runningEurPerHour).toBe(B2MS_RUNNING);
    const audit = c.t.db.sqlite
      .prepare("SELECT details_json AS d FROM audit_log WHERE action = 'cloud.machine_ordered'")
      .get() as { d: string };
    expect(JSON.parse(audit.d)).toMatchObject({ name: 'hz-mc', size: 'Standard_B2ms' });

    const { machine, agent, gameId } = await orderedWithGame(c, { name: 'hz-mc2' });
    agents.push(agent);
    expect(c.azure.names()).toEqual(
      expect.arrayContaining([
        'virtualNetworks/hz-vnet-germanywestcentral',
        'networkSecurityGroups/hz-mc2-nsg',
        'publicIPAddresses/hz-mc2-ip',
        'networkInterfaces/hz-mc2-nic',
        'virtualMachines/hz-mc2',
        'disks/hz-mc2-disk',
      ]),
    );
    expect(machine.state).toBe('running');
    expect(machine.publicIp).toBe('203.0.113.7');
    expect(machine.serverId).toBe(agent.serverId);
    expect(machine.pendingGameName).toBeNull();
    const server = c.t.app.hzCore.servers.summary(agent.serverId);
    expect(server?.network).toBe('cloud');
    const game = c.t.app.hzCore.games.summary(gameId);
    expect(game?.serverId).toBe(agent.serverId);
    expect(game?.status).toBe('ok');
    expect(game?.externalAddress).toBe('203.0.113.7');
    expect(c.azure.nsgPorts('hz-mc2')).toEqual(['tcp/25565']);
    const cloudInit = c.azure.cloudInit('hz-mc2') ?? '';
    expect(cloudInit).toMatch(/^#cloud-config\n/);
    expect(cloudInit).toContain(
      "tailscale up --auth-key=file:/run/hz/tailscale.key --hostname='hz-mc2'",
    );
    expect(cloudInit).toMatch(
      /curl -fsSL http:\/\/127\.0\.0\.1:\d+\/install\.sh \| sudo sh -s -- /,
    );

    const overview = cloudOverviewSchema.parse((await req(c, 'GET', '/api/cloud')).json());
    expect(overview.machines.map((m) => m.name)).toEqual(['hz-mc', 'hz-mc2']);
    expect(overview.azure.secretSet).toBe(true);
    expect(overview.budget.state).toBe('ok');
  });

  it('a game created or deleted later on the cloud server resyncs the NSG', async () => {
    const c = await setup();
    const { machine, agent } = await orderedWithGame(c);
    agents.push(agent);
    const res = await req(c, 'POST', '/api/games', {
      templateId: 'valheim',
      serverId: agent.serverId,
      name: 'wikinger',
      values: { SERVER_PASS: 'geheim12345' },
    });
    expect(res.statusCode, res.body).toBe(202);
    const vh = gameResponseSchema.parse(res.json()).game;
    await cloudTick(c, 5_000, agent);
    const ports = c.azure.nsgPorts(machine.name);
    expect(ports).toContain('tcp/25565');
    expect(ports.some((p) => p.startsWith('udp/'))).toBe(true);
    for (let i = 0; i < 5 && c.t.app.hzCore.games.summary(vh.id)?.status !== 'ok'; i++) {
      await c.t.app.hzCore.games.idle();
      await cloudTick(c, 5_000, agent);
    }
    const del = await withStepUp(c.t, () =>
      req(c, 'DELETE', `/api/games/${vh.id}`, { confirmName: 'wikinger' }),
    );
    expect(del.statusCode, del.body).toBe(200);
    await cloudTick(c, 5_000, agent);
    expect(c.azure.nsgPorts(machine.name)).toEqual(['tcp/25565']);
  });

  it('idle: all games stopped for idleMinutes -> deallocated; the server is OFF, not offline', async () => {
    const c = await setup();
    const { machine, agent, gameId } = await orderedWithGame(c);
    agents.push(agent);
    await sleepMachine(c, machine.id, gameId, agent);
    expect(c.azure.power.get(machine.name)).toBe('deallocated');
    expect(c.azure.requests.some((r) => r.path.endsWith('/deallocate'))).toBe(true);
    // Disconnected for minutes: no offline alert, status OFF.
    await pass(c, 3 * 60_000);
    const srv = c.t.app.hzCore.servers.summary(agent.serverId);
    expect(srv?.status).toBe('off');
    expect(c.t.app.hzCore.alerts.active(`server:${agent.serverId}:offline`)).toBeNull();
    expect(c.t.app.hzCore.games.summary(gameId)?.statusText).toBe(CLOUD_GAME_TEXT.deallocated);
    const m = machineOf(c, machine.id);
    expect(m.monthHours).toBeGreaterThan(0);
    // Asleep: hours no longer grow, only disk/IP cost.
    await pass(c, 6 * 60 * 60_000, undefined, 30 * 60_000);
    expect(machineOf(c, machine.id).monthHours).toBe(m.monthHours);
    expect(machineOf(c, machine.id).monthEur).toBeGreaterThan(m.monthEur);
  });

  it('a share-link start wakes the VM first, then the game starts', async () => {
    const c = await setup();
    const { machine, agent, gameId } = await orderedWithGame(c);
    agents.push(agent);
    const token = await shareLink(c, gameId);
    await sleepMachine(c, machine.id, gameId, agent);
    const res = await friendStart(c, token);
    expect(res.statusCode, res.body).toBe(200);
    expect(machineOf(c, machine.id).state).toBe('starting');
    expect(c.t.app.hzCore.games.summary(gameId)?.statusText).toBe(CLOUD_GAME_TEXT.starting);
    // A second start while waiting: busy.
    expect((await friendStart(c, token)).statusCode).toBe(409);
    await cloudTick(c);
    expect(c.azure.power.get(machine.name)).toBe('running');
    expect(c.azure.requests.some((r) => r.path.endsWith(`/${machine.name}/start`))).toBe(true);
    await agent.reconnect(c);
    agents.push(agent);
    const ups = agent.rpcs.filter((r) => r.action === 'compose.up').length;
    await cloudTick(c, 5_000, agent);
    expect(machineOf(c, machine.id).state).toBe('running');
    await c.t.app.hzCore.games.idle();
    expect(agent.rpcs.filter((r) => r.action === 'compose.up').length).toBe(ups + 1);
    expect(c.t.app.hzCore.games.isRunning(gameId)).toBe(true);
    const audit = c.t.db.sqlite
      .prepare("SELECT actor FROM audit_log WHERE action = 'game.start' ORDER BY id DESC")
      .get() as { actor: string };
    expect(audit.actor).toMatch(/^share:/);
  });

  it('an admin start of the game answers 202 and starts the VM; wakeForGame for the relay', async () => {
    const c = await setup();
    const { machine, agent, gameId } = await orderedWithGame(c);
    agents.push(agent);
    await sleepMachine(c, machine.id, gameId, agent);
    const res = await req(c, 'POST', `/api/games/${gameId}/start`);
    expect(res.statusCode).toBe(202);
    expect(gameResponseSchema.parse(res.json()).game.statusText).toBe(CLOUD_GAME_TEXT.starting);
    await cloudTick(c);
    await agent.reconnect(c);
    await cloudTick(c, 5_000, agent);
    await c.t.app.hzCore.games.idle();
    expect(c.t.app.hzCore.games.isRunning(gameId)).toBe(true);
    expect(await c.t.app.hzCore.cloud.wakeForGame(gameId)).toBe('running');
    expect(await c.t.app.hzCore.cloud.wakeForGame('nope-nope-nope')).toBe('not_found');
  });

  it('a VM whose agent does not come back: start fails after the timeout, the waiting game gives up', async () => {
    const c = await setup();
    const { machine, agent, gameId } = await orderedWithGame(c);
    agents.push(agent);
    await sleepMachine(c, machine.id, gameId, agent);
    expect((await req(c, 'POST', `/api/games/${gameId}/start`)).statusCode).toBe(202);
    await pass(c, 9 * 60_000);
    const m = machineOf(c, machine.id);
    expect(m.state).toBe('failed');
    expect(m.error).toBe('Agent hat sich nicht gemeldet');
    await c.t.app.hzCore.games.idle();
    expect(c.t.app.hzCore.games.isBusy(gameId)).toBe(false);
    expect(c.azure.power.get(machine.name)).toBe('deallocated');
  });

  it('budget: warn at 80 %, at 100 % automatic starts are refused, the admin needs overBudget', async () => {
    const c = await setup();
    const { machine, agent, gameId } = await orderedWithGame(c);
    agents.push(agent);
    const token = await shareLink(c, gameId);
    await sleepMachine(c, machine.id, gameId, agent);
    const budget = await req(c, 'PUT', '/api/cloud/azure', { budgetEurPerMonth: 1 });
    expect(budget.statusCode).toBe(200);
    const month = /^(\d{4}-\d{2})/.exec(new Date(c.t.clock.t).toISOString())?.[1];
    const setHours = (h: number) =>
      c.t.db.sqlite
        .prepare('UPDATE cloud_usage SET running_seconds = ? WHERE machine_id = ? AND month = ?')
        .run(Math.round(h * 3600), machine.id, month);
    setHours(8.8);
    await cloudTick(c);
    const warn = c.t.app.hzCore.alerts.active('cloud:budget');
    expect(warn?.level).toBe('warn');
    expect(c.t.app.hzCore.cloud.budget().state).toBe('warn');
    setHours(12);
    await cloudTick(c);
    expect(c.t.app.hzCore.alerts.active('cloud:budget')?.level).toBe('crit');
    expect(c.t.app.hzCore.cloud.budget().state).toBe('over');
    // Friend: refused, the VM stays asleep.
    const f = await friendStart(c, token);
    expect(f.statusCode).toBe(503);
    expect(machineOf(c, machine.id).state).toBe('deallocated');
    expect(await c.t.app.hzCore.cloud.wakeForGame(gameId)).toBe('over_budget');
    // Admin game start: 409 over_budget with the fixed text.
    const g = await req(c, 'POST', `/api/games/${gameId}/start`);
    expect(g.statusCode).toBe(409);
    expect(errorResponseSchema.parse(g.json())).toEqual({
      ok: false,
      error: 'over_budget',
      message: CLOUD_GAME_TEXT.overBudget,
    });
    // Machine start and a new order need overBudget.
    expect((await req(c, 'POST', `/api/cloud/machines/${machine.id}/start`)).statusCode).toBe(409);
    const o = await req(
      c,
      'POST',
      '/api/cloud/machines',
      orderBody({ name: 'hz-two', game: undefined }),
    );
    expect(o.json()).toMatchObject({ error: 'over_budget' });
    const ok = await req(c, 'POST', `/api/cloud/machines/${machine.id}/start`, {
      overBudget: true,
    });
    expect(ok.statusCode).toBe(202);
    expect(machineOf(c, machine.id).state).toBe('starting');
    // While starting, a game start waits for it (no budget check for a VM that runs anyway).
    expect((await req(c, 'POST', `/api/games/${gameId}/start`)).statusCode).toBe(202);
    // Budget raised: the alert resolves.
    await req(c, 'PUT', '/api/cloud/azure', { budgetEurPerMonth: 100 });
    await cloudTick(c);
    expect(c.t.app.hzCore.alerts.active('cloud:budget')).toBeNull();
  });

  it('price mismatch: 409 price_changed with the current price; nothing is ordered', async () => {
    const c = await setup();
    const res = await req(c, 'POST', '/api/cloud/machines', orderBody({ confirmEurPerHour: 0.05 }));
    expect(res.statusCode).toBe(409);
    const body = errorResponseSchema.parse(res.json());
    expect(body.error).toBe('price_changed');
    expect(body.currentEurPerHour).toBe(B2MS_RUNNING);
    expect(body.message).toMatch(/^Der Preis hat sich geändert: jetzt €\s0,\d+ pro Stunde$/);
    expect(c.t.app.hzCore.cloud.overview().machines).toEqual([]);
    // Within the tolerance: accepted.
    expect(
      (
        await req(
          c,
          'POST',
          '/api/cloud/machines',
          orderBody({ confirmEurPerHour: B2MS_RUNNING + 0.0004 }),
        )
      ).statusCode,
    ).toBe(202);
  });

  it('order refusals: RAM too small for the game, name taken, no Tailscale key, max count, bad game', async () => {
    const c = await setup();
    const small = await req(
      c,
      'POST',
      '/api/cloud/machines',
      orderBody({ size: 'Standard_B2s', confirmEurPerHour: 0.0541 }),
    );
    expect(small.statusCode).toBe(409);
    expect(small.json()).toMatchObject({
      error: 'conflict',
      message: 'Zu wenig RAM für das Spiel, empfohlen: Standard_B2ms',
    });
    const badGame = await req(
      c,
      'POST',
      '/api/cloud/machines',
      orderBody({ game: { templateId: 'nope', name: 'x1', values: {} } }),
    );
    expect(badGame.statusCode).toBe(400);
    const badValue = await req(
      c,
      'POST',
      '/api/cloud/machines',
      orderBody({ game: { templateId: 'minecraft-java', name: 'x1', values: { MEMORY: '99G' } } }),
    );
    expect(badValue.statusCode).toBe(400);
    await order(c);
    const taken = await req(c, 'POST', '/api/cloud/machines', orderBody());
    expect(taken.json()).toMatchObject({ error: 'conflict', message: 'Name ist schon vergeben' });
    expect(
      (await req(c, 'POST', '/api/cloud/machines', orderBody({ name: 'Bad Name' }))).statusCode,
    ).toBe(400);
    c.t.db.sqlite.prepare("DELETE FROM settings WHERE key = 'cloud.azure.tailscaleAuthKey'").run();
    const noKey = await req(c, 'POST', '/api/cloud/machines', orderBody({ name: 'hz-other' }));
    expect(noKey.json()).toMatchObject({ error: 'conflict', message: 'Tailscale-Auth-Key fehlt' });
  });

  it('Azure errors: quota and missing group become fixed texts; the machine fails', async () => {
    const c = await setup();
    c.azure.override = (r) =>
      r.method === 'PUT' && r.path.includes('virtualMachines')
        ? { status: 409, body: { error: { code: 'QuotaExceeded', message: 'secret details' } } }
        : null;
    const m = await order(c);
    const failed = await untilState(c, m.id, 'failed');
    expect(failed.error).toBe('Kontingent der Region erschöpft');
    expect(c.t.app.hzCore.alerts.active(`cloud:${m.id}:failed`)?.level).toBe('crit');
    // Its onboarding code is cancelled.
    const open = c.t.db.sqlite
      .prepare('SELECT COUNT(*) AS n FROM onboarding_codes WHERE cancelled_at IS NULL')
      .get() as { n: number };
    expect(open.n).toBe(0);
    c.azure.override = null;
    c.azure.group = 'other-group';
    const test = await req(c, 'POST', '/api/cloud/azure/test');
    expect(test.json()).toMatchObject({
      status: 'error',
      error: 'Ressourcengruppe nicht gefunden',
    });
  });

  it('installing without the agent: failed after the install timeout and deallocated', async () => {
    const c = await setup();
    const m = await order(c, { game: undefined });
    await untilState(c, m.id, 'installing');
    await pass(c, 26 * 60_000);
    const f = machineOf(c, m.id);
    expect(f.state).toBe('failed');
    expect(f.error).toBe('Agent hat sich nicht gemeldet');
    expect(c.azure.power.get('hz-mc')).toBe('deallocated');
  });

  it('delete: step-up and name, refused while games exist, removes every Azure resource', async () => {
    const c = await setup();
    const { machine, agent, gameId } = await orderedWithGame(c);
    agents.push(agent);
    const url = `/api/cloud/machines/${machine.id}`;
    const noStep = await req(c, 'DELETE', url, { confirmName: machine.name });
    expect(noStep.json()).toEqual({ ok: false, error: 'step_up_required' });
    const wrong = await withStepUp(c.t, () => req(c, 'DELETE', url, { confirmName: 'hz-other' }));
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ error: 'confirm_mismatch' });
    const withGames = await withStepUp(c.t, () =>
      req(c, 'DELETE', url, { confirmName: machine.name }),
    );
    expect(withGames.statusCode).toBe(409);
    const del = await withStepUp(c.t, () =>
      req(c, 'DELETE', `/api/games/${gameId}`, { confirmName: 'survival' }),
    );
    expect(del.statusCode).toBe(200);
    await c.t.app.hzCore.games.idle();
    const res = await withStepUp(c.t, () => req(c, 'DELETE', url, { confirmName: machine.name }));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ machine: { state: 'deleting' } });
    for (let i = 0; i < 10 && c.t.app.hzCore.cloud.overview().machines.length > 0; i++) {
      await cloudTick(c, 5_000, agent.connected ? agent : undefined);
    }
    expect(c.t.app.hzCore.cloud.overview().machines).toEqual([]);
    expect(c.azure.names()).toEqual(['virtualNetworks/hz-vnet-germanywestcentral']);
    const deletes = c.azure.requests
      .filter((r) => r.method === 'DELETE')
      .map((r) => r.path.split('/').slice(-2).join('/'));
    expect(deletes).toEqual(
      expect.arrayContaining([
        'virtualMachines/hz-mc',
        'networkInterfaces/hz-mc-nic',
        'publicIPAddresses/hz-mc-ip',
        'networkSecurityGroups/hz-mc-nsg',
        'disks/hz-mc-disk',
      ]),
    );
    expect(c.t.app.hzCore.servers.summary(agent.serverId)).toBeNull();
    await until(() => !agent.connected);
    const tokens = c.t.db.sqlite
      .prepare('SELECT COUNT(*) AS n FROM agent_tokens WHERE revoked_at IS NULL')
      .get() as { n: number };
    expect(tokens.n).toBe(0);
    const actions = (
      c.t.db.sqlite.prepare("SELECT action FROM audit_log WHERE action LIKE 'cloud.%'").all() as {
        action: string;
      }[]
    ).map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'cloud.settings_updated',
        'cloud.machine_ordered',
        'cloud.machine_delete',
        'cloud.machine_deleted',
      ]),
    );
  });

  it('stop/start from the cloud page, idle minutes, module off keeps machines and makes no Azure calls', async () => {
    const c = await setup();
    const { machine, agent } = await orderedWithGame(c);
    agents.push(agent);
    const upd = await req(c, 'PUT', `/api/cloud/machines/${machine.id}`, { idleMinutes: 0 });
    expect(upd.json()).toMatchObject({ machine: { idleMinutes: 0 } });
    c.azure.onPower = (_vm, state) => {
      if (state === 'deallocated') void agent.disconnect();
    };
    const stop = await req(c, 'POST', `/api/cloud/machines/${machine.id}/stop`);
    expect(stop.statusCode).toBe(202);
    await c.t.app.hzCore.cloud.idle();
    // The running game was stopped before the VM went down.
    expect(agent.rpcs.some((r) => r.action === 'compose.down')).toBe(true);
    await untilState(c, machine.id, 'deallocated');
    const mod = await withStepUp(c.t, () =>
      req(c, 'PUT', '/api/settings/modules', { cloud: false }),
    );
    expect(mod.statusCode, mod.body).toBe(200);
    const n = c.azure.requests.length;
    await pass(c, 5 * 60_000);
    expect(c.azure.requests.length).toBe(n);
    expect((await req(c, 'GET', '/api/cloud')).statusCode).toBe(404);
    expect(c.t.db.sqlite.prepare('SELECT state FROM cloud_machines').get()).toEqual({
      state: 'deallocated',
    });
    await withStepUp(c.t, () => req(c, 'PUT', '/api/settings/modules', { cloud: true }));
    const start = await req(c, 'POST', `/api/cloud/machines/${machine.id}/start`, {});
    expect(start.statusCode).toBe(202);
    await cloudTick(c);
    await agent.reconnect(c);
    await untilState(c, machine.id, 'running', agent);
    expect(
      (await req(c, 'POST', `/api/cloud/machines/${machine.id}/start`, { bad: 1 })).statusCode,
    ).toBe(400);
  });
});
