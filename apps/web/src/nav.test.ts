import { describe, expect, it } from 'vitest';
import { visibleNavItems } from './lib/modules.js';
import { ALL_MODULES_ON } from './lib/modules.js';
import {
  activeNavId,
  isTypingTarget,
  navItems,
  shortcutAction,
  shortcutLabel,
  shortcutTarget,
  withShortcutKeys,
} from './nav.js';

const NONE_EXTRA = { proxmox: false, dnsfilter: false, fritzbox: false, uptimekuma: false };

const key = (k: string, extra: Partial<Parameters<typeof shortcutAction>[0]> = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  target: { tagName: 'BODY' },
  ...extra,
});

describe('navigation', () => {
  it('keeps the order from the design system', () => {
    expect(navItems.map((i) => i.label)).toEqual([
      'Übersicht',
      'Server',
      'Container',
      'VMs',
      'Gameserver',
      'GitHub',
      'Websites',
      'Netzwerk',
      'Wohnung',
      'Meldungen',
      'Apps',
      'Internet',
      'Automatik',
      'Konsole',
      'Log-Suche',
      'Sicherheit',
    ]);
  });

  it('marks the matching item active', () => {
    expect(activeNavId('/')).toBe('overview');
    expect(activeNavId('/servers/heimserver')).toBe('servers');
    expect(activeNavId('/alerts')).toBe('alerts');
    expect(activeNavId('/vms')).toBe('vms');
    expect(activeNavId('/network')).toBe('network');
    expect(activeNavId('/settings')).toBe('settings');
    expect(activeNavId('/homeassistant')).toBe('overview');
    expect(activeNavId('/unknown')).toBe('overview');
    expect(activeNavId('/automation')).toBe('automation');
    expect(activeNavId('/internet')).toBe('internet');
    expect(activeNavId('/apps')).toBe('apps');
  });
});

describe('shortcuts', () => {
  it('maps 1–9 by position and ` to the console with every module on', () => {
    expect(shortcutTarget('1')).toBe('/');
    expect(shortcutTarget('2')).toBe('/servers');
    expect(shortcutTarget('4')).toBe('/vms');
    expect(shortcutTarget('8')).toBe('/network');
    expect(shortcutTarget('9')).toBe('/home');
    expect(shortcutTarget('`')).toBe('/console');
    expect(shortcutTarget('0')).toBeUndefined();
    expect(shortcutTarget('a')).toBeUndefined();
    expect(shortcutTarget('\u00a0')).toBeUndefined();
  });

  it('gives items past the ninth no digit; the console keeps `', () => {
    const keyed = withShortcutKeys(navItems);
    expect(keyed.map((i) => i.key)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '',
      '',
      '',
      '',
      '`',
      'l',
      's',
    ]);
    expect(shortcutLabel({ id: 'x', label: 'X', icon: 'bell' }, 9)).toBe('');
    // Same targets with the keyed items as NavRail shows them.
    expect(shortcutTarget('9', keyed)).toBe('/home');
    expect(shortcutTarget('`', keyed)).toBe('/console');
    expect(shortcutTarget('', keyed)).toBeUndefined();
    expect(shortcutTarget('\u00a0', keyed)).toBeUndefined();
  });

  it('opens Log-Suche with l and Sicherheit with s', () => {
    expect(shortcutTarget('l')).toBe('/logs');
    expect(shortcutTarget('s')).toBe('/security');
    expect(activeNavId('/logs')).toBe('logs');
    expect(activeNavId('/security')).toBe('security');
  });

  it('ignores plain keys while typing', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'textarea' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(shortcutAction(key('2', { target: { tagName: 'INPUT' } }))).toBeNull();
    expect(shortcutAction(key('2'))).toEqual({ kind: 'navigate', to: '/servers' });
  });

  it('ignores digits with modifiers and opens the palette with Ctrl/⌘+K', () => {
    expect(shortcutAction(key('2', { ctrlKey: true }))).toBeNull();
    expect(shortcutAction(key('2', { altKey: true }))).toBeNull();
    expect(shortcutAction(key('k', { ctrlKey: true }))).toEqual({ kind: 'palette' });
    expect(shortcutAction(key('K', { metaKey: true }))).toEqual({ kind: 'palette' });
    expect(shortcutAction(key('k', { metaKey: true, target: { tagName: 'INPUT' } }))).toEqual({
      kind: 'palette',
    });
    expect(shortcutAction(key('k'))).toBeNull();
  });

  it('numbers only the visible items when modules are off', () => {
    const items = visibleNavItems(navItems, {
      github: false,
      homeassistant: false,
      games: true,
      ...NONE_EXTRA,
      storage: true,
      logsearch: false,
      vulnscan: false,
      fail2ban: false,
      discordbot: false,
      voice: false,
      tasks: false,
      selfheal: false,
      speedtest: false,
      domains: false,
      apps: false,
    });
    expect(items.map((i) => i.id)).toEqual([
      'overview',
      'servers',
      'containers',
      'games',
      'websites',
      'alerts',
      'console',
    ]);
    expect(shortcutTarget('5', items)).toBe('/websites');
    expect(shortcutTarget('`', items)).toBe('/console');
    expect(shortcutAction(key('6'), items)).toEqual({ kind: 'navigate', to: '/alerts' });
  });

  it('fresh install: 9 still opens the console (new modules are off)', () => {
    const items = visibleNavItems(navItems, {
      github: true,
      homeassistant: true,
      games: true,
      ...NONE_EXTRA,
      storage: true,
      logsearch: false,
      vulnscan: false,
      fail2ban: false,
      discordbot: false,
      voice: false,
      tasks: false,
      selfheal: false,
      speedtest: false,
      domains: false,
      apps: false,
    });
    expect(shortcutTarget('9', items)).toBe('/console');
  });

  it('shows Netzwerk when FRITZ!Box or DNS-Filter is on, VMs only with Proxmox', () => {
    const base = { ...ALL_MODULES_ON, ...NONE_EXTRA };
    const ids = (m: typeof base) => visibleNavItems(navItems, m).map((i) => i.id);
    expect(ids(base)).not.toContain('network');
    expect(ids(base)).not.toContain('vms');
    expect(ids({ ...base, fritzbox: true })).toContain('network');
    expect(ids({ ...base, dnsfilter: true })).toContain('network');
    const withVms = visibleNavItems(navItems, { ...base, proxmox: true });
    expect(withVms.map((i) => i.id).slice(0, 5)).toEqual([
      'overview',
      'servers',
      'containers',
      'vms',
      'games',
    ]);
    expect(shortcutTarget('4', withVms)).toBe('/vms');
  });
});
