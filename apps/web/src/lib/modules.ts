import { modulesResponseSchema, type ModuleId, type Modules } from '@hz/shared';
import type { IconName, NavItem } from '@hz/ui';
import { api } from './api.js';

/**
 * Optional modules (decision 2026-11-26): github, homeassistant, games, storage (M13) and the
 * operations modules (api/ops.ts). Their nav items, overview tiles, palette entries and
 * settings tiles are hidden while switched off.
 */

export const modulesKey = ['settings', 'modules'] as const;

/**
 * Used while the auth state carries no modules (older core): show everything that core
 * can have. The operations modules are newer than the module switch, so they stay off.
 */
export const ALL_MODULES_ON: Modules = {
  github: true,
  homeassistant: true,
  games: true,
  storage: true,
  logsearch: false,
  vulnscan: false,
  fail2ban: false,
  discordbot: false,
  voice: false,
};

export const MODULE_LABEL: Record<ModuleId, string> = {
  github: 'GitHub',
  homeassistant: 'Home Assistant',
  games: 'Gameserver',
  storage: 'NAS und Speicher',
  logsearch: 'Log-Suche',
  vulnscan: 'Schwachstellen-Scan',
  fail2ban: 'Fail2ban',
  discordbot: 'Discord-Bot',
  voice: 'Sprachsteuerung',
};

export const MODULE_HINT: Record<ModuleId, string> = {
  github: 'Repos, CI, Deploy per Knopf. Braucht einen GitHub-Token.',
  homeassistant: 'Wohnung über Home Assistant: Schalter, Temperatur, Strom.',
  games: 'Gameserver aus Vorlagen und Benutzerlinks für Freunde.',
  storage:
    'RAID, Volumes und Festplatten (SMART, Temperatur) im Serverdetail, z. B. für ein UGREEN-NAS.',
  logsearch: 'Logs aller Container auf allen Servern durchsuchen',
  vulnscan: 'Nachts die Images laufender Container mit Trivy prüfen',
  fail2ban: 'Gesperrte IPs pro Server sehen und entsperren',
  discordbot: 'Freunde starten Gameserver mit /start, mit den Rechten ihres Benutzerlinks',
  voice: 'Echo Show und Alexa über Home Assistant',
};

/** Page of the module, for the "Modul ausgeschaltet" note. */
export const MODULE_PAGE: Record<ModuleId, string> = {
  github: 'GitHub',
  homeassistant: 'Wohnung',
  games: 'Gameserver',
  storage: 'Server',
  logsearch: 'Log-Suche',
  vulnscan: 'Sicherheit',
  fail2ban: 'Sicherheit',
  discordbot: 'Einstellungen',
  voice: 'Einstellungen',
};

export const MODULE_ICON: Record<ModuleId, IconName> = {
  github: 'git',
  homeassistant: 'home',
  games: 'gamepad',
  storage: 'server',
  logsearch: 'terminal',
  vulnscan: 'lock',
  fail2ban: 'lock',
  discordbot: 'users',
  voice: 'home',
};

/** Nav item id -> modules that own it. The item shows while any of them is on. */
const NAV_MODULES: Record<string, readonly ModuleId[]> = {
  games: ['games'],
  github: ['github'],
  home: ['homeassistant'],
  logs: ['logsearch'],
  security: ['vulnscan', 'fail2ban'],
};

/** First module that owns the nav item, if any. */
export function navModule(navId: string): ModuleId | undefined {
  return NAV_MODULES[navId]?.[0];
}

/** All modules behind a path (`/github/…`, `/home`, `/games/…`, `/logs`, `/security`). */
export function modulesOfPath(pathname: string): readonly ModuleId[] {
  const first = pathname.split('/')[1] ?? '';
  if (first === 'github') return ['github'];
  if (first === 'home') return ['homeassistant'];
  if (first === 'games') return ['games'];
  if (first === 'logs') return ['logsearch'];
  if (first === 'security') return ['vulnscan', 'fail2ban'];
  return [];
}

/** Module that owns a path, if any (the first one for pages shared by two modules). */
export function moduleOfPath(pathname: string): ModuleId | undefined {
  return modulesOfPath(pathname)[0];
}

export function isModuleOn(modules: Modules | undefined, id: ModuleId): boolean {
  return (modules ?? ALL_MODULES_ON)[id];
}

/** True while at least one of `ids` is on (no ids: always). */
export function anyModuleOn(modules: Modules | undefined, ids: readonly ModuleId[]): boolean {
  return ids.length === 0 || ids.some((id) => isModuleOn(modules, id));
}

/** "GitHub", "Schwachstellen-Scan und Fail2ban". */
export function moduleLabels(ids: readonly ModuleId[]): string {
  return ids.map((id) => MODULE_LABEL[id]).join(' und ');
}

/** Nav items without the ones of switched-off modules. */
export function visibleNavItems<T extends NavItem>(
  items: readonly T[],
  modules: Modules | undefined,
): T[] {
  return items.filter((it) => anyModuleOn(modules, NAV_MODULES[it.id] ?? []));
}

export function fetchModules(signal?: AbortSignal): Promise<Modules> {
  return api('/api/settings/modules', { schema: modulesResponseSchema, signal });
}

/**
 * Step-up when switching GitHub, Home Assistant, Discord-Bot or Sprachsteuerung on
 * (MODULES_ENABLE_STEP_UP); api() asks and retries.
 */
export function saveModules(body: Partial<Modules>): Promise<Modules> {
  return api('/api/settings/modules', {
    method: 'PUT',
    body,
    schema: modulesResponseSchema,
  });
}
