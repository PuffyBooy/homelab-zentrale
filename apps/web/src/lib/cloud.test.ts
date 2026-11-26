import { afterEach, describe, expect, it, vi } from 'vitest';
import { azure, prices } from '../test-cloud.js';
import { ApiError } from './api.js';
import {
  buildAzurePatch,
  CLOUD_FAST_MS,
  CLOUD_SLOW_MS,
  cloudConflict,
  cloudRefetchMs,
  costLine,
  createMachine,
  defaultMachineName,
  defaultSize,
  deleteMachine,
  dropsSecret,
  emptyMachineDraft,
  fetchAzurePrices,
  formatEurHour,
  formatEurMonth,
  machineCreateBody,
  machineStatus,
  orderReady,
  pendingGame,
  ramGbOf,
  sizeOptions,
  startMachine,
  validateMachine,
  azureToForm,
} from './cloud.js';

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sizes', () => {
  it('recommends Standard_B2ms for Minecraft Java (4 GB), not the biggest size', () => {
    const opts = sizeOptions(prices().sizes, ramGbOf('4G'));
    expect(defaultSize(opts)).toBe('Standard_B2ms');
    const rec = opts.filter((o) => o.recommended);
    expect(rec.map((o) => o.size)).toEqual(['Standard_B2ms']);
    expect(rec[0]?.label).toContain('Empfohlen');
  });

  it('recommends Standard_B2s for Terraria (1 GB)', () => {
    expect(defaultSize(sizeOptions(prices().sizes, 1))).toBe('Standard_B2s');
  });

  it('disables sizes with less RAM than game + OS and marks the free tier', () => {
    const opts = sizeOptions(prices().sizes, 4);
    const by = (s: string) => opts.find((o) => o.size === s);
    expect(by('Standard_B2ats_v2')?.disabledReason).toBe('zu wenig RAM, braucht 5 GB');
    expect(by('Standard_B2ats_v2')?.label).toContain('Free-Tier');
    expect(by('Standard_B2s')?.disabledReason).not.toBeNull();
    expect(by('Standard_B2ms')?.disabledReason).toBeNull();
    // Cheapest first.
    expect(opts[0]?.size).toBe('Standard_B2ats_v2');
  });

  it('without a game nothing is disabled and nothing recommended; cheapest is preselected', () => {
    const opts = sizeOptions(prices().sizes, 0);
    expect(opts.every((o) => o.disabledReason === null && !o.recommended)).toBe(true);
    expect(defaultSize(opts)).toBe('Standard_B2ats_v2');
  });
});

describe('numbers in Austrian format', () => {
  it('formats prices per hour and month', () => {
    expect(formatEurHour(0.1)).toBe('0,10 €/Std');
    expect(formatEurHour(0.0095)).toBe('0,0095 €/Std');
    expect(formatEurMonth(6.3)).toBe('6,30 €/Monat');
    expect(formatEurMonth(75.04)).toBe('75 €/Monat');
    expect(formatEurMonth(1234.5)).toBe('1.235 €/Monat');
    expect(
      costLine({
        runningEurPerHour: 0.1,
        sleepingEurPerMonth: 6.3,
        fullMonthEur: 75,
        source: 'estimate',
      }),
    ).toBe('Läuft: 0,10 €/Std · Schläft: 6,30 €/Monat · Dauerbetrieb: 75 €/Monat');
  });
});

describe('order', () => {
  it('default machine name is hz- plus the game name', () => {
    expect(defaultMachineName('mc-freunde')).toBe('hz-mc-freunde');
    expect(defaultMachineName('Minecraft Java')).toBe('hz-minecraft-java');
    expect(defaultMachineName('')).toBe('hz-server');
    expect(defaultMachineName('a'.repeat(40))).toHaveLength(32);
  });

  it('validates the name with the shared schema and refuses taken names', () => {
    const d = { ...emptyMachineDraft('westeurope', 'hz-mc'), size: 'Standard_B2ms' };
    expect(validateMachine(d)).toEqual({ ok: true });
    expect(validateMachine({ ...d, name: 'HZ_MC' }).ok).toBe(false);
    expect(validateMachine({ ...d, name: 'hz' }).ok).toBe(false);
    expect(validateMachine(d, ['hz-mc']).ok).toBe(false);
    expect(validateMachine({ ...d, idleMinutes: '2000' }).ok).toBe(false);
  });

  it('submit stays disabled until the price is confirmed (and the budget override, if needed)', () => {
    const selected = { disabledReason: null };
    const base = { selected, confirmed: false, needsOverBudget: false, overBudget: false };
    expect(orderReady(base)).toBe(false);
    expect(orderReady({ ...base, confirmed: true })).toBe(true);
    expect(orderReady({ ...base, confirmed: true, needsOverBudget: true })).toBe(false);
    expect(orderReady({ ...base, confirmed: true, needsOverBudget: true, overBudget: true })).toBe(
      true,
    );
    expect(orderReady({ ...base, confirmed: true, selected: { disabledReason: 'zu klein' } })).toBe(
      false,
    );
    expect(orderReady({ ...base, confirmed: true, selected: undefined })).toBe(false);
  });

  it('payload carries confirmEurPerHour and a game without serverId', () => {
    const d = {
      ...emptyMachineDraft('germanywestcentral', 'hz-mc-freunde'),
      size: 'Standard_B2ms',
    };
    const game = pendingGame({
      templateId: 'minecraft-java',
      serverId: 'cloud:azure',
      name: 'mc-freunde',
      values: { TYPE: 'PAPER' },
      ports: { game: 25565 },
      autoStopMinutes: 15,
      wakeOnConnect: true,
      externalAddress: '',
    });
    const body = machineCreateBody(d, 0.1027, { game });
    expect(body).toEqual({
      provider: 'azure',
      name: 'hz-mc-freunde',
      size: 'Standard_B2ms',
      region: 'germanywestcentral',
      diskType: 'StandardSSD_LRS',
      diskGb: 32,
      publicIp: true,
      idleMinutes: 15,
      confirmEurPerHour: 0.1027,
      overBudget: false,
      game: {
        templateId: 'minecraft-java',
        name: 'mc-freunde',
        values: { TYPE: 'PAPER' },
        ports: { game: 25565 },
        autoStopMinutes: 15,
        wakeOnConnect: true,
        externalAddress: '',
      },
    });
    expect(body.game).not.toHaveProperty('serverId');
  });

  it('posts the order and reads price_changed with the current price', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        reply(409, { ok: false, error: 'price_changed', currentEurPerHour: 0.1132 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const d = { ...emptyMachineDraft('germanywestcentral', 'hz-mc'), size: 'Standard_B2ms' };
    const err = await createMachine(machineCreateBody(d, 0.1027)).catch((e: unknown) => e);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/cloud/machines');
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toMatchObject({ confirmEurPerHour: 0.1027 });
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).currentEurPerHour).toBe(0.1132);
    expect(cloudConflict(err, {})).toBe('price');
  });

  it('tells price change, budget and other conflicts apart', () => {
    expect(cloudConflict(new ApiError(409, 'over_budget'), {})).toBe('budget');
    const plain = new ApiError(409, 'conflict');
    expect(cloudConflict(plain, { confirmed: 0.1, current: 0.12 })).toBe('price');
    expect(cloudConflict(plain, { confirmed: 0.1, current: 0.1002 })).toBe('other');
    expect(cloudConflict(plain, { budget: { state: 'over' } })).toBe('budget');
    expect(cloudConflict(new ApiError(409, 'conflict', undefined, 'Budget aufgebraucht'), {})).toBe(
      'budget',
    );
    expect(cloudConflict(new ApiError(502, 'cloud_error'), { budget: { state: 'over' } })).toBe(
      'other',
    );
  });

  it('prices query and machine actions use fixed paths', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(reply(200, prices())));
    vi.stubGlobal('fetch', fetchMock);
    await fetchAzurePrices({
      region: 'westeurope',
      diskType: 'Premium_LRS',
      diskGb: 64,
      publicIp: false,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/cloud/azure/prices?region=westeurope&diskType=Premium_LRS&diskGb=64&publicIp=false',
    );
  });

  it('start sends overBudget, delete sends the typed name', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(reply(409, { ok: false, error: 'over_budget' }));
    vi.stubGlobal('fetch', fetchMock);
    await startMachine('mach-00000001', true).catch(() => undefined);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/cloud/machines/mach-00000001/start');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ overBudget: true });
    await deleteMachine('mach-00000001', 'hz-mc').catch(() => undefined);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/cloud/machines/mach-00000001');
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('DELETE');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      confirmName: 'hz-mc',
    });
  });
});

describe('machines', () => {
  it('polls every 5 s while a machine changes state, else every 30 s', () => {
    expect(cloudRefetchMs([{ state: 'running' }, { state: 'deallocated' }])).toBe(CLOUD_SLOW_MS);
    for (const state of ['creating', 'installing', 'stopping', 'starting', 'deleting'] as const) {
      expect(cloudRefetchMs([{ state: 'running' }, { state }])).toBe(CLOUD_FAST_MS);
    }
    expect(cloudRefetchMs(undefined)).toBe(CLOUD_SLOW_MS);
  });

  it('maps states to status shapes', () => {
    expect(machineStatus('running')).toBe('ok');
    expect(machineStatus('deallocated')).toBe('off');
    expect(machineStatus('failed')).toBe('crit');
    expect(machineStatus('installing')).toBe('busy');
  });
});

describe('Azure account form', () => {
  it('secret inputs start empty, an empty input leaves the secret unchanged', () => {
    const s = azure();
    const f = azureToForm(s);
    expect(f.clientSecret).toBe('');
    expect(f.tailscaleAuthKey).toBe('');
    expect(buildAzurePatch(s, f)).toEqual({ patch: {}, errors: {} });
    expect(
      buildAzurePatch(s, { ...f, region: 'westeurope', budgetEurPerMonth: '30' }).patch,
    ).toEqual({ region: 'westeurope', budgetEurPerMonth: 30 });
  });

  it('sends only changed credentials and checks them', () => {
    const s = azure();
    const f = azureToForm(s);
    const r = buildAzurePatch(s, {
      ...f,
      clientSecret: 'abc~DEF.ghi-123',
      tailscaleAuthKey: 'tskey-auth-kAbCdEf12345',
    });
    expect(r.errors).toEqual({});
    expect(r.patch).toEqual({
      clientSecret: 'abc~DEF.ghi-123',
      tailscaleAuthKey: 'tskey-auth-kAbCdEf12345',
    });
    const bad = buildAzurePatch(s, { ...f, tenantId: 'nope', tailscaleAuthKey: 'x' });
    expect(Object.keys(bad.errors).sort()).toEqual(['tailscaleAuthKey', 'tenantId']);
    expect(bad.patch).toEqual({});
  });

  it('warns that a new tenant without a new secret drops the stored one', () => {
    const s = azure();
    const { patch } = buildAzurePatch(s, {
      ...azureToForm(s),
      tenantId: '99999999-2222-3333-4444-555555555555',
    });
    expect(dropsSecret(s, patch)).toBe(true);
    expect(dropsSecret(s, { ...patch, clientSecret: 'abc~DEF.ghi-123' })).toBe(false);
  });
});
