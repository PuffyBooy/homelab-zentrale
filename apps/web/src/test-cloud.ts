import {
  AZURE_VM_SIZES,
  estimateAzureCost,
  type AzurePricesResponse,
  type AzureSettings,
  type CloudMachine,
  type CloudOverview,
} from '@hz/shared';

/** Test data for M22 (Cloud-Server), same shapes as the core's responses. */

/** Prices like GET /api/cloud/azure/prices from the built-in table (32 GB SSD, public IP). */
export function prices(): AzurePricesResponse {
  return {
    region: 'germanywestcentral',
    fetchedAt: null,
    sizes: AZURE_VM_SIZES.map((s) => ({
      size: s.size,
      vcpus: s.vcpus,
      ramGb: s.ramGb,
      freeTier: s.freeTier,
      burstable: s.burstable,
      cost: estimateAzureCost({
        computeEurPerHour: s.eurPerHour,
        diskType: 'StandardSSD_LRS',
        diskGb: 32,
        publicIp: true,
        source: 'estimate',
      }),
    })),
  };
}

export function azure(over: Partial<AzureSettings> = {}): AzureSettings {
  return {
    tenantId: '11111111-2222-3333-4444-555555555555',
    clientId: '22222222-3333-4444-5555-666666666666',
    subscriptionId: '33333333-4444-5555-6666-777777777777',
    resourceGroup: 'homelab-zentrale',
    region: 'germanywestcentral',
    secretSet: true,
    tailscaleKeySet: true,
    budgetEurPerMonth: 20,
    status: 'ok',
    error: null,
    lastOkAt: '2026-11-26T21:00:00.000Z',
    ...over,
  };
}

export function machine(over: Partial<CloudMachine> = {}): CloudMachine {
  return {
    id: 'mach-00000001',
    provider: 'azure',
    name: 'hz-mc-freunde',
    size: 'Standard_B2ms',
    vcpus: 2,
    ramGb: 8,
    region: 'germanywestcentral',
    diskType: 'StandardSSD_LRS',
    diskGb: 32,
    publicIp: '20.79.1.23',
    serverId: 'srv-cloud001',
    state: 'running',
    stateText: 'Läuft',
    error: null,
    idleMinutes: 15,
    pendingGameName: null,
    gameIds: ['game-0001'],
    cost: {
      runningEurPerHour: 0.1027,
      sleepingEurPerMonth: 5.66,
      fullMonthEur: 74.97,
      source: 'live',
    },
    monthHours: 12.5,
    monthEur: 3.1,
    createdAt: '2026-11-20T18:00:00.000Z',
    ...over,
  };
}

export function overview(over: Partial<CloudOverview> = {}): CloudOverview {
  return {
    azure: azure(),
    machines: [machine()],
    budget: { limitEur: 20, monthEur: 3.1, projectedEur: 9.4, percent: 15.5, state: 'ok' },
    ...over,
  };
}
