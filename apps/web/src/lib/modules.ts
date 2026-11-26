import { modulesResponseSchema, type ModuleId, type Modules } from '@hz/shared';
import type { IconName, NavItem } from '@hz/ui';
import { api } from './api.js';

/**
 * Optional modules (decision 2026-11-26): github, homeassistant, games, storage (M13),
 * tasks, selfheal, speedtest, domains (M20) and apps (M21). Their nav items, overview tiles,
 * palette entries and settings tiles are hidden while switched off. A page that belongs to
 * several modules (Automatik, Internet) stays visible while at least one of them is on.
 */

export const modulesKey = ['settings', 'modules'] as const;

/** Used while the auth state carries no modules (older core): show everything. */
export const ALL_MODULES_ON: Modules = {
  github: true,
  homeassistant: true,
  games: true,
  storage: true,
  tasks: true,
  selfheal: true,
  speedtest: true,
  domains: true,
  apps: true,
};

export const MODULE_LABEL: Record<ModuleId, string> = {
  github: 'GitHub',
  homeassistant: 'Home Assistant',
  games: 'Gameserver',
  storage: 'NAS und Speicher',
  tasks: 'Geplante Aufgaben',
  selfheal: 'Selbstheilung',
  speedtest: 'Speedtest',
  domains: 'Domains und Zertifikate',
  apps: 'App-Store',
};

export const MODULE_HINT: Record<ModuleId, string> = {
  github: 'Repos, CI, Deploy per Knopf. Braucht einen GitHub-Token.',
  homeassistant: 'Wohnung über Home Assistant: Schalter, Temperatur, Strom.',
  games: 'Gameserver aus Vorlagen und Benutzerlinks für Freunde.',
  storage:
    'RAID, Volumes und Festplatten (SMART, Temperatur) im Serverdetail, z. B. für ein UGREEN-NAS.',
  tasks:
    'Container neu starten, Stacks aktualisieren, Docker aufräumen nach Zeitplan. Befehle nur auf Servern mit Agent --tasks.',
  selfheal:
    'Startet hängende Container neu (unhealthy, Absturz, Website DOWN), höchstens 3-mal in 30 Min.',
  speedtest:
    'Misst Download, Upload und Ping gegen speed.cloudflare.com. Jede Messung verbraucht Datenvolumen.',
  domains: 'DNS-Einträge bei Cloudflare oder DuckDNS und Let’s-Encrypt-Zertifikate.',
  apps: 'Jellyfin, Nextcloud, Vaultwarden und Co. aus Vorlagen auf einem Server installieren.',
};

/** Page of the module, for the "Modul ausgeschaltet" note. */
export const MODULE_PAGE: Record<ModuleId, string> = {
  github: 'GitHub',
  homeassistant: 'Wohnung',
  games: 'Gameserver',
  storage: 'Server',
  tasks: 'Automatik',
  selfheal: 'Automatik',
  speedtest: 'Internet',
  domains: 'Internet',
  apps: 'Apps',
};

export const MODULE_ICON: Record<ModuleId, IconName> = {
  github: 'git',
  homeassistant: 'home',
  games: 'gamepad',
  storage: 'server',
  tasks: 'refresh',
  selfheal: 'refresh',
  speedtest: 'wifi',
  domains: 'wifi',
  apps: 'cloud',
};

/** Nav item id -> modules that own it (the item shows while any of them is on). */
const NAV_MODULES: Record<string, readonly ModuleId[]> = {
  games: ['games'],
  github: ['github'],
  home: ['homeassistant'],
  apps: ['apps'],
  internet: ['speedtest', 'domains'],
  automation: ['tasks', 'selfheal'],
};

/** First path segment -> nav item id, for pages of optional modules. */
const PATH_NAV: Record<string, string> = {
  github: 'github',
  home: 'home',
  games: 'games',
  apps: 'apps',
  internet: 'internet',
  automation: 'automation',
};

export function navModules(navId: string): readonly ModuleId[] | undefined {
  return Object.hasOwn(NAV_MODULES, navId) ? NAV_MODULES[navId] : undefined;
}

/** First module of a nav item (single-module pages). */
export function navModule(navId: string): ModuleId | undefined {
  return navModules(navId)?.[0];
}

/** Modules that own a path (`/github/…`, `/automation` …), if any. */
export function modulesOfPath(pathname: string): readonly ModuleId[] | undefined {
  const first = pathname.split('/')[1] ?? '';
  const nav = Object.hasOwn(PATH_NAV, first) ? PATH_NAV[first] : undefined;
  return nav ? navModules(nav) : undefined;
}

/** Module that owns a path (`/github/…`, `/home`, `/games/…`), if any. */
export function moduleOfPath(pathname: string): ModuleId | undefined {
  return modulesOfPath(pathname)?.[0];
}

export function isModuleOn(modules: Modules | undefined, id: ModuleId): boolean {
  return (modules ?? ALL_MODULES_ON)[id];
}

/** True while at least one of the modules is on. */
export function anyModuleOn(modules: Modules | undefined, ids: readonly ModuleId[]): boolean {
  return ids.some((id) => isModuleOn(modules, id));
}

/** "Geplante Aufgaben", "Geplante Aufgaben und Selbstheilung". */
export function modulesLabel(ids: readonly ModuleId[]): string {
  const labels = ids.map((id) => MODULE_LABEL[id]);
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} und ${labels[labels.length - 1] ?? ''}`;
}

/** Nav items without the ones of switched-off modules. */
export function visibleNavItems<T extends NavItem>(
  items: readonly T[],
  modules: Modules | undefined,
): T[] {
  return items.filter((it) => {
    const m = navModules(it.id);
    return !m || anyModuleOn(modules, m);
  });
}

export function fetchModules(signal?: AbortSignal): Promise<Modules> {
  return api('/api/settings/modules', { schema: modulesResponseSchema, signal });
}

/** Step-up when switching github, homeassistant, tasks or domains on; api() asks and retries. */
export function saveModules(body: Partial<Modules>): Promise<Modules> {
  return api('/api/settings/modules', {
    method: 'PUT',
    body,
    schema: modulesResponseSchema,
  });
}
