import type {
  DnsFilterStatus,
  FritzStatus,
  IntegrationSettings,
  KumaMonitor,
  NotifyChannel,
  ProxmoxGuest,
} from '@hz/shared';
import { vi } from 'vitest';
import type { ProxmoxGuests } from './lib/proxmox.js';

/** Fixtures for M14 (Anbindungen) tests. */

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function mockFetch(...responses: Response[]) {
  const fn = vi.fn<typeof fetch>();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  vi.stubGlobal('fetch', fn);
  return fn;
}

export function bodyOf(fn: ReturnType<typeof mockFetch>, call = 0): unknown {
  const init = fn.mock.calls[call]?.[1];
  return typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
}

export function settings(over: Partial<IntegrationSettings> = {}): IntegrationSettings {
  return {
    url: 'https://pve.lan:8006',
    username: 'hz@pve!zentrale',
    secretSet: true,
    caSet: false,
    variant: null,
    status: 'ok',
    error: null,
    lastOkAt: '2026-11-26T22:04:00.000Z',
    ...over,
  };
}

export function guest(over: Partial<ProxmoxGuest> = {}): ProxmoxGuest {
  return {
    node: 'pve',
    type: 'qemu',
    vmid: 101,
    name: 'web01',
    status: 'running',
    cpu: 0.12,
    cpus: 4,
    memBytes: 2 * 1024 ** 3,
    maxMemBytes: 8 * 1024 ** 3,
    uptimeS: 3 * 86_400 + 4 * 3600,
    template: false,
    ...over,
  };
}

export function guests(list: ProxmoxGuest[], over: Partial<ProxmoxGuests> = {}): ProxmoxGuests {
  return {
    nodes: [
      {
        node: 'pve',
        online: true,
        cpu: 0.2,
        memBytes: 12 * 1024 ** 3,
        maxMemBytes: 32 * 1024 ** 3,
      },
    ],
    guests: list,
    fetchedAt: '2026-11-26T22:04:00.000Z',
    error: null,
    ...over,
  };
}

export function fritz(over: Partial<FritzStatus> = {}): FritzStatus {
  return {
    model: 'FRITZ!Box 7590',
    firmware: '7.57',
    internet: {
      connected: true,
      linkStatus: 'Up',
      externalIp: '203.0.113.7',
      uptimeS: 2 * 86_400 + 3600,
      maxDownBps: 250_000_000,
      maxUpBps: 40_500_000,
    },
    devices: [
      {
        name: 'pi-garage',
        ip: '192.168.178.40',
        mac: 'DC:A6:32:00:00:01',
        active: true,
        interface: 'lan',
      },
      {
        name: 'handy',
        ip: '192.168.178.52',
        mac: '3C:22:FB:00:00:02',
        active: false,
        interface: 'wlan',
      },
      {
        name: 'heimserver',
        ip: '192.168.178.10',
        mac: '00:1B:21:00:00:03',
        active: true,
        interface: 'lan',
      },
    ],
    fetchedAt: '2026-11-26T22:04:00.000Z',
    error: null,
    ...over,
  };
}

export function dns(over: Partial<DnsFilterStatus> = {}): DnsFilterStatus {
  return {
    variant: 'pihole',
    blocking: true,
    pausedUntil: null,
    queriesToday: 48_213,
    blockedToday: 4_050,
    percentBlocked: 8.4,
    domainsOnLists: 1_204_311,
    fetchedAt: '2026-11-26T22:04:00.000Z',
    error: null,
    ...over,
  };
}

export function monitor(over: Partial<KumaMonitor> = {}): KumaMonitor {
  return {
    name: 'example.at',
    type: 'http',
    url: 'https://example.at/',
    hostname: null,
    port: null,
    status: 'up',
    responseMs: 182.4,
    certDaysRemaining: 41,
    importAs: 'http',
    checkId: null,
    ...over,
  };
}

export function channel(over: Partial<NotifyChannel> = {}): NotifyChannel {
  return {
    id: 'discord',
    enabled: false,
    minLevel: 'warn',
    configured: false,
    server: null,
    tokenSet: false,
    lastSentAt: null,
    lastError: null,
    ...over,
  };
}
