import { describe, expect, it } from 'vitest';
import { NavRail } from './NavRail.js';
import { html } from './test-utils.js';

describe('NavRail', () => {
  const out = html(
    <NavRail
      active="servers"
      items={[
        { id: 'overview', label: 'Übersicht', icon: 'cpu', href: '/' },
        { id: 'servers', label: 'Server', icon: 'server', count: 2 },
        { id: 'shell', label: 'Konsole', icon: 'terminal', key: '`' },
      ]}
    />,
  );

  it('is the labelled main navigation with brand', () => {
    expect(out).toMatch(/^<nav class="hz-nav" aria-label="Hauptnavigation">/);
    expect(out).toContain(
      '<span class="hz-mark" aria-hidden="true"><span></span></span><span>homelab</span>',
    );
  });

  it('marks the active item and shows keys and counts', () => {
    expect(out).toContain('<a href="/" class="hz-nav-item"><span class="hz-nav-key">1</span>');
    expect(out).toContain('class="hz-nav-item hz-nav-active" aria-current="page"');
    expect(out).toContain('<span class="hz-nav-count">2</span>');
    expect(out).toContain('<span class="hz-nav-key">`</span>');
    expect(out.match(/aria-current/g)).toHaveLength(1);
  });

  it('leaves the key cap empty for an empty key', () => {
    const empty = html(
      <NavRail items={[{ id: 'apps', label: 'Apps', icon: 'cloud', href: '/apps', key: '' }]} />,
    );
    expect(empty).toContain('<span class="hz-nav-key" aria-hidden="true"></span><span>Apps</span>');
  });
});
