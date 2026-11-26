import { describe, expect, it } from 'vitest';
import { visibleNavItems } from './lib/modules.js';
import { activeNavId, isTypingTarget, navItems, shortcutAction, shortcutTarget } from './nav.js';

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
      'Gameserver',
      'GitHub',
      'Websites',
      'Wohnung',
      'Meldungen',
      'Konsole',
      'Log-Suche',
      'Sicherheit',
    ]);
  });

  it('marks the matching item active', () => {
    expect(activeNavId('/')).toBe('overview');
    expect(activeNavId('/servers/heimserver')).toBe('servers');
    expect(activeNavId('/alerts')).toBe('alerts');
    expect(activeNavId('/settings')).toBe('settings');
    expect(activeNavId('/homeassistant')).toBe('overview');
    expect(activeNavId('/unknown')).toBe('overview');
  });
});

describe('shortcuts', () => {
  it('maps 1–8 by position and 9 / ` to the console', () => {
    expect(shortcutTarget('1')).toBe('/');
    expect(shortcutTarget('2')).toBe('/servers');
    expect(shortcutTarget('8')).toBe('/alerts');
    expect(shortcutTarget('9')).toBe('/console');
    expect(shortcutTarget('`')).toBe('/console');
    expect(shortcutTarget('0')).toBeUndefined();
    expect(shortcutTarget('a')).toBeUndefined();
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
      storage: true,
      logsearch: false,
      vulnscan: false,
      fail2ban: false,
      discordbot: false,
      voice: false,
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
});
