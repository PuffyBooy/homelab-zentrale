import { modulesResponseSchema, type ModuleId, type Modules } from '@hz/shared';
import type { IconName, NavItem } from '@hz/ui';
import { api } from './api.js';

/**
 * Optional modules (decision 2026-11-26): github, homeassistant, games, the M14
 * Anbindungen proxmox, dnsfilter, fritzbox, uptimekuma, storage (M13), the M18
 * operations modules (api/ops.ts), tasks, selfheal, speedtest, domains (M20) and apps (M21).
 * Their nav items, overview tiles, palette entries and settings tiles are hidden while
 * switched off. A page that belongs to several modules (Automatik, Internet, Sicherheit,
 * Netzwerk) stays visible while at least one of them is on.
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
  proxmox: true,
  dnsfilter: true,
  fritzbox: true,
  uptimekuma: true,
  storage: true,
  logsearch: false,
  vulnscan: false,
  fail2ban: false,
  discordbot: false,
  voice: false,
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
  proxmox: 'Proxmox',
  dnsfilter: 'DNS-Filter (Pi-hole/AdGuard)',
  fritzbox: 'FRITZ!Box',
  uptimekuma: 'Uptime Kuma',
  storage: 'NAS und Speicher',
  logsearch: 'Log-Suche',
  vulnscan: 'Schwachstellen-Scan',
  fail2ban: 'Fail2ban',
  discordbot: 'Discord-Bot',
  voice: 'Sprachsteuerung',
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
  proxmox: 'VMs und LXC-Container auf Proxmox: Status, Starten, Herunterfahren.',
  dnsfilter: 'Pi-hole oder AdGuard Home: Anfragen, Blockierte, Blocken pausieren.',
  fritzbox: 'Internet-Status und Geräte im Netz über TR-064, Neustart der Box.',
  uptimekuma: 'Monitore aus Uptime Kuma anzeigen und als eigene Checks übernehmen.',
  storage:
    'RAID, Volumes und Festplatten (SMART, Temperatur) im Serverdetail, z. B. für ein UGREEN-NAS.',
  logsearch: 'Logs aller Container auf allen Servern durchsuchen',
  vulnscan: 'Nachts die Images laufender Container mit Trivy prüfen',
  fail2ban: 'Gesperrte IPs pro Server sehen und entsperren',
  discordbot: 'Freunde starten Gameserver mit /start, mit den Rechten ihres Benutzerlinks',
  voice: 'Echo Show und Alexa über Home Assistant',
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
  proxmox: 'VMs',
  dnsfilter: 'Netzwerk',
  fritzbox: 'Netzwerk',
  uptimekuma: 'Websites',
  storage: 'Server',
  logsearch: 'Log-Suche',
  vulnscan: 'Sicherheit',
  fail2ban: 'Sicherheit',
  discordbot: 'Einstellungen',
  voice: 'Einstellungen',
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
  proxmox: 'cloud',
  dnsfilter: 'lock',
  fritzbox: 'wifi',
  uptimekuma: 'globe',
  storage: 'server',
  logsearch: 'terminal',
  vulnscan: 'lock',
  fail2ban: 'lock',
  discordbot: 'users',
  voice: 'home',
  tasks: 'refresh',
  selfheal: 'refresh',
  speedtest: 'wifi',
  domains: 'wifi',
  apps: 'cloud',
};

/**
 * Nav item id -> modules that own it. The item is visible while at least one of them is
 * on ("Netzwerk" shows FRITZ!Box and DNS-Filter tiles, either is enough).
 */
const NAV_MODULES: Record<string, readonly ModuleId[]> = {
  games: ['games'],
  github: ['github'],
  home: ['homeassistant'],
  logs: ['logsearch'],
  security: ['vulnscan', 'fail2ban'],
  vms: ['proxmox'],
  network: ['fritzbox', 'dnsfilter'],
  apps: ['apps'],
  internet: ['speedtest', 'domains'],
  automation: ['tasks', 'selfheal'],
};

/** First path segment -> modules behind the page ("Netzwerk" gates itself, isNetworkOn). */
const PATH_MODULES: Record<string, readonly ModuleId[]> = {
  github: ['github'],
  home: ['homeassistant'],
  games: ['games'],
  vms: ['proxmox'],
  logs: ['logsearch'],
  security: ['vulnscan', 'fail2ban'],
  apps: ['apps'],
  internet: ['speedtest', 'domains'],
  automation: ['tasks', 'selfheal'],
};

/** First module of a nav item, if any. */
export function navModule(navId: string): ModuleId | undefined {
  return navModules(navId)[0];
}

export function navModules(navId: string): readonly ModuleId[] {
  return Object.hasOwn(NAV_MODULES, navId) ? (NAV_MODULES[navId] ?? []) : [];
}

/** All modules behind a path (`/github/…`, `/vms`, `/security`, `/automation` …). */
export function modulesOfPath(pathname: string): readonly ModuleId[] {
  const first = pathname.split('/')[1] ?? '';
  return Object.hasOwn(PATH_MODULES, first) ? (PATH_MODULES[first] ?? []) : [];
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

/** "Netzwerk" page and the overview tile "Heimnetz": FRITZ!Box or DNS-Filter is on. */
export function isNetworkOn(modules: Modules | undefined): boolean {
  return isModuleOn(modules, 'fritzbox') || isModuleOn(modules, 'dnsfilter');
}

/** Nav items without the ones of switched-off modules. */
export function visibleNavItems<T extends NavItem>(
  items: readonly T[],
  modules: Modules | undefined,
): T[] {
  return items.filter((it) => anyModuleOn(modules, navModules(it.id)));
}

export function fetchModules(signal?: AbortSignal): Promise<Modules> {
  return api('/api/settings/modules', { schema: modulesResponseSchema, signal });
}

/**
 * Step-up when switching GitHub, Home Assistant, Discord-Bot, Sprachsteuerung, tasks or
 * domains on (MODULES_ENABLE_STEP_UP); api() asks and retries.
 */
export function saveModules(body: Partial<Modules>): Promise<Modules> {
  return api('/api/settings/modules', {
    method: 'PUT',
    body,
    schema: modulesResponseSchema,
  });
}
