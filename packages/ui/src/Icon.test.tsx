import { describe, expect, it } from 'vitest';
import { Icon, iconNames } from './Icon.js';
import { html } from './test-utils.js';

describe('Icon', () => {
  it('has the 25 reference icons in order', () => {
    expect(iconNames).toHaveLength(25);
    expect(iconNames[0]).toBe('server');
    expect(iconNames.at(-1)).toBe('plus');
    expect(Icon.names).toBe(iconNames);
  });

  it('is decorative without a label and defaults to 14 px', () => {
    const out = html(<Icon name="server" />);
    expect(out).toContain('class="hz-icon"');
    expect(out).toContain('width="14"');
    expect(out).toContain('aria-hidden="true"');
    expect(out).toContain('stroke-width="1.75"');
    expect(out).not.toContain('role=');
  });

  it('becomes an image with a label', () => {
    const out = html(<Icon name="git" size={20} label="GitHub" className="x" />);
    expect(out).toContain('role="img"');
    expect(out).toContain('aria-label="GitHub"');
    expect(out).toContain('class="hz-icon x"');
    expect(out).toContain('width="20"');
    expect(out).not.toContain('aria-hidden');
  });
});
