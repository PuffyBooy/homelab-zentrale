import { modulesResponseSchema, type ModuleId, type Modules } from '@hz/shared';
import type { IconName, NavItem } from '@hz/ui';
import { api } from './api.js';

/**
 * Optional modules (decision 2026-11-26): github, homeassistant, games, and the M14
 * Anbindungen proxmox, dnsfilter, fritzbox, uptimekuma. Their nav items, overview tiles,
 * palette entries and settings tiles are hidden while switched off. M13 adds storage.
 */

export const modulesKey = ['settings', 'modules'] as const;

/** Used while the auth state carries no modules (older core): show everything. */
export const ALL_MODULES_ON: Modules = {
  github: true,
  homeassistant: true,
  games: true,
  proxmox: true,
  dnsfilter: true,
  fritzbox: true,
  uptimekuma: true,
  storage: true,
};

export const MODULE_LABEL: Record<ModuleId, string> = {
  github: 'GitHub',
  homeassistant: 'Home Assistant',
  games: 'Gameserver',
  proxmox: 'Proxmox',
  dnsfilter: 'DNS-Filter (Pi-hole/AdGuard)',
  fritzbox: 'FRITZ!Box',
  uptimekuma: 'Uptime Kuma',
  storage: 'NAS und Speicher',
};

export const MODULE_HINT: Record<ModuleId, string> = {
  github: 'Repos, CI, Deploy per Knopf. Braucht einen GitHub-Token.',
  homeassistant: 'Wohnung über Home Assistant: Schalter, Temperatur, Strom.',
  games: 'Gameserver aus Vorlagen und Benutzerlinks für Freunde.',
  proxmox: 'VMs und LXC-Container auf Proxmox: Status, Starten, Herunterfahren.',
  dnsfilter: 'Pi-hole oder AdGuard Home: Anfragen, Blockierte, Blocken pausieren.',
  fritzbox: 'Internet-Status und Geräte im Netz über TR-064, Neustart der Box.',
  uptimekuma: 'Monitore aus Uptime Kuma anzeigen und als eigene Checks übernehmen.',
  storage:
    'RAID, Volumes und Festplatten (SMART, Temperatur) im Serverdetail, z. B. für ein UGREEN-NAS.',
};

/** Page of the module, for the "Modul ausgeschaltet" note. */
export const MODULE_PAGE: Record<ModuleId, string> = {
  github: 'GitHub',
  homeassistant: 'Wohnung',
  games: 'Gameserver',
  proxmox: 'VMs',
  dnsfilter: 'Netzwerk',
  fritzbox: 'Netzwerk',
  uptimekuma: 'Websites',
  storage: 'Server',
};

export const MODULE_ICON: Record<ModuleId, IconName> = {
  github: 'git',
  homeassistant: 'home',
  games: 'gamepad',
  proxmox: 'cloud',
  dnsfilter: 'lock',
  fritzbox: 'wifi',
  uptimekuma: 'globe',
  storage: 'server',
};

/**
 * Nav item id -> modules that own it. The item is visible while at least one of them is
 * on ("Netzwerk" shows FRITZ!Box and DNS-Filter tiles, either is enough).
 */
const NAV_MODULES: Record<string, readonly ModuleId[]> = {
  games: ['games'],
  github: ['github'],
  home: ['homeassistant'],
  vms: ['proxmox'],
  network: ['fritzbox', 'dnsfilter'],
};

/** First module of a nav item (single-module items), if any. */
export function navModule(navId: string): ModuleId | undefined {
  return NAV_MODULES[navId]?.[0];
}

export function navModules(navId: string): readonly ModuleId[] {
  return NAV_MODULES[navId] ?? [];
}

/** Module that owns a path (`/github/…`, `/home`, `/games/…`, `/vms`), if any. */
export function moduleOfPath(pathname: string): ModuleId | undefined {
  const first = pathname.split('/')[1] ?? '';
  if (first === 'github') return 'github';
  if (first === 'home') return 'homeassistant';
  if (first === 'games') return 'games';
  if (first === 'vms') return 'proxmox';
  return undefined;
}

export function isModuleOn(modules: Modules | undefined, id: ModuleId): boolean {
  return (modules ?? ALL_MODULES_ON)[id];
}

/** "Netzwerk" page and the overview tile "Heimnetz": FRITZ!Box or DNS-Filter is on. */
export function isNetworkOn(modules: Modules | undefined): boolean {
  return isModuleOn(modules, 'fritzbox') || isModuleOn(modules, 'dnsfilter');
}

/** Nav items without the ones of switched-off modules. */
export function visibleNavItems<T extends NavItem>(
  items: readonly T[],
  modules: Modules | undefined,
): T[] {
  return items.filter((it) => {
    const ms = navModules(it.id);
    return ms.length === 0 || ms.some((m) => isModuleOn(modules, m));
  });
}

export function fetchModules(signal?: AbortSignal): Promise<Modules> {
  return api('/api/settings/modules', { schema: modulesResponseSchema, signal });
}

/** Step-up when switching a module with tokens on (MODULES_ENABLE_STEP_UP); api() asks and retries. */
export function saveModules(body: Partial<Modules>): Promise<Modules> {
  return api('/api/settings/modules', {
    method: 'PUT',
    body,
    schema: modulesResponseSchema,
  });
}
