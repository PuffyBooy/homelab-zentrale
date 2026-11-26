import { modulesResponseSchema, type ModuleId, type Modules } from '@hz/shared';
import type { IconName, NavItem } from '@hz/ui';
import { api } from './api.js';

/**
 * Optional modules (decision 2026-11-26): github, homeassistant, games. Their nav items,
 * overview tiles, palette entries and settings tiles are hidden while switched off.
 */

export const modulesKey = ['settings', 'modules'] as const;

/** Used while the auth state carries no modules (older core): show everything. */
export const ALL_MODULES_ON: Modules = { github: true, homeassistant: true, games: true };

export const MODULE_LABEL: Record<ModuleId, string> = {
  github: 'GitHub',
  homeassistant: 'Home Assistant',
  games: 'Gameserver',
};

export const MODULE_HINT: Record<ModuleId, string> = {
  github: 'Repos, CI, Deploy per Knopf. Braucht einen GitHub-Token.',
  homeassistant: 'Wohnung über Home Assistant: Schalter, Temperatur, Strom.',
  games: 'Gameserver aus Vorlagen und Benutzerlinks für Freunde.',
};

/** Page of the module, for the "Modul ausgeschaltet" note. */
export const MODULE_PAGE: Record<ModuleId, string> = {
  github: 'GitHub',
  homeassistant: 'Wohnung',
  games: 'Gameserver',
};

export const MODULE_ICON: Record<ModuleId, IconName> = {
  github: 'git',
  homeassistant: 'home',
  games: 'gamepad',
};

/** Nav item id -> module that owns it. */
const NAV_MODULE: Record<string, ModuleId> = {
  games: 'games',
  github: 'github',
  home: 'homeassistant',
};

export function navModule(navId: string): ModuleId | undefined {
  return NAV_MODULE[navId];
}

/** Module that owns a path (`/github/…`, `/home`, `/games/…`), if any. */
export function moduleOfPath(pathname: string): ModuleId | undefined {
  const first = pathname.split('/')[1] ?? '';
  if (first === 'github') return 'github';
  if (first === 'home') return 'homeassistant';
  if (first === 'games') return 'games';
  return undefined;
}

export function isModuleOn(modules: Modules | undefined, id: ModuleId): boolean {
  return (modules ?? ALL_MODULES_ON)[id];
}

/** Nav items without the ones of switched-off modules. */
export function visibleNavItems<T extends NavItem>(
  items: readonly T[],
  modules: Modules | undefined,
): T[] {
  return items.filter((it) => {
    const m = navModule(it.id);
    return !m || isModuleOn(modules, m);
  });
}

export function fetchModules(signal?: AbortSignal): Promise<Modules> {
  return api('/api/settings/modules', { schema: modulesResponseSchema, signal });
}

/** Step-up when switching GitHub or Home Assistant on; api() asks and retries. */
export function saveModules(body: Partial<Modules>): Promise<Modules> {
  return api('/api/settings/modules', {
    method: 'PUT',
    body,
    schema: modulesResponseSchema,
  });
}
