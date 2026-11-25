import { describe, expect, it } from 'vitest';
import { activeNavId, navItems } from './nav.js';

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
    ]);
  });

  it('marks the matching item active', () => {
    expect(activeNavId('/')).toBe('overview');
    expect(activeNavId('/servers/heimserver')).toBe('servers');
    expect(activeNavId('/alerts')).toBe('alerts');
    expect(activeNavId('/unknown')).toBe('overview');
  });
});
