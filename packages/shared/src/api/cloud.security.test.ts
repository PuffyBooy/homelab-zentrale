import { describe, expect, it } from 'vitest';
import {
  azureResourceGroupSchema,
  azureSettingsRequestSchema,
  azureUpdateNeedsStepUp,
  cloudMachineCreateRequestSchema,
  cloudMachineNameSchema,
  estimateAzureCost,
  recommendAzureSize,
  tailscaleAuthKeySchema,
} from './cloud.js';
import { MODULE_DEFAULTS, MODULES_ENABLE_STEP_UP } from './modules.js';

// Fake key split so secret scanners do not flag it.
const FAKE_TS_KEY = ['tskey', 'auth', 'kTEST1234CNTRL-abcdefghijk'].join('-');

describe('cloud module', () => {
  it('is off by default and needs step-up to switch on', () => {
    expect(MODULE_DEFAULTS.cloud).toBe(false);
    expect(MODULES_ENABLE_STEP_UP).toContain('cloud');
  });
});

describe('Azure settings', () => {
  it('accepts GUIDs and normalises them to lower case', () => {
    const r = azureSettingsRequestSchema.parse({
      tenantId: '8F2B1C3D-0000-4000-8000-000000000001',
    });
    expect(r.tenantId).toBe('8f2b1c3d-0000-4000-8000-000000000001');
  });

  it('refuses anything that could change the request path', () => {
    for (const v of ['../x', 'a/b', 'abc?x=1', 'x%2fy', 'grp.']) {
      expect(azureResourceGroupSchema.safeParse(v).success, v).toBe(false);
    }
    expect(azureSettingsRequestSchema.safeParse({ tenantId: 'common/../x' }).success).toBe(false);
    expect(azureSettingsRequestSchema.safeParse({ subscriptionId: 'x' }).success).toBe(false);
    expect(azureSettingsRequestSchema.safeParse({ region: 'eastus' }).success).toBe(false);
    expect(azureSettingsRequestSchema.safeParse({ unknown: 1 }).success).toBe(false);
  });

  it('needs step-up for credentials, not for region or budget', () => {
    expect(azureUpdateNeedsStepUp({ region: 'westeurope', budgetEurPerMonth: 30 })).toBe(false);
    expect(azureUpdateNeedsStepUp({ clientSecret: 'x'.repeat(12) })).toBe(true);
    expect(azureUpdateNeedsStepUp({ tailscaleAuthKey: FAKE_TS_KEY })).toBe(true);
    expect(azureUpdateNeedsStepUp({ resourceGroup: 'homelab' })).toBe(true);
  });

  it('checks the Tailscale key shape (it ends up in a shell environment)', () => {
    expect(tailscaleAuthKeySchema.safeParse(FAKE_TS_KEY).success).toBe(true);
    for (const v of ['tskey-auth-x; rm -rf /', 'tskey-auth-$(id)', 'abc', `${FAKE_TS_KEY}\n`]) {
      expect(tailscaleAuthKeySchema.safeParse(v).success, v).toBe(false);
    }
  });
});

describe('machines', () => {
  it('VM names are safe for Azure, DNS and shell', () => {
    expect(cloudMachineNameSchema.safeParse('hz-mc-freunde').success).toBe(true);
    for (const v of ['A', 'mc', '-mc', 'mc-', 'mc_x', 'mc;id', 'a'.repeat(40)]) {
      expect(cloudMachineNameSchema.safeParse(v).success, v).toBe(false);
    }
  });

  it('an order needs a confirmed price and a known size', () => {
    const base = { provider: 'azure', name: 'hz-mc', size: 'Standard_B2ms' };
    expect(cloudMachineCreateRequestSchema.safeParse(base).success).toBe(false);
    expect(
      cloudMachineCreateRequestSchema.safeParse({ ...base, confirmEurPerHour: 0.1 }).success,
    ).toBe(true);
    expect(
      cloudMachineCreateRequestSchema.safeParse({
        ...base,
        size: 'Standard_M416ms_v2',
        confirmEurPerHour: 0.1,
      }).success,
    ).toBe(false);
    expect(
      cloudMachineCreateRequestSchema.safeParse({ ...base, confirmEurPerHour: 0.1, diskGb: 4096 })
        .success,
    ).toBe(false);
  });

  it('a pending game cannot pick its own server', () => {
    const r = cloudMachineCreateRequestSchema.safeParse({
      provider: 'azure',
      name: 'hz-mc',
      size: 'Standard_B2ms',
      confirmEurPerHour: 0.1,
      game: { templateId: 'minecraft-java', serverId: 'abcdefgh', name: 'mc', values: {} },
    });
    expect(r.success).toBe(false);
  });
});

describe('size and cost', () => {
  it('recommends a small size for Minecraft, not the biggest', () => {
    expect(recommendAzureSize(4)?.size).toBe('Standard_B2ms');
    expect(recommendAzureSize(1)?.size).toBe('Standard_B2s');
    expect(recommendAzureSize(12)?.size).toBe('Standard_B4ms');
    expect(recommendAzureSize(64)).toBeNull();
  });

  it('a deallocated VM only costs disk and IP', () => {
    const c = estimateAzureCost({
      computeEurPerHour: 0.1,
      diskType: 'StandardSSD_LRS',
      diskGb: 32,
      publicIp: false,
      source: 'estimate',
    });
    expect(c.sleepingEurPerMonth).toBe(2.3);
    expect(c.fullMonthEur).toBeCloseTo(75.3, 1);
  });
});
