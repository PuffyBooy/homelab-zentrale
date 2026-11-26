import { describe, expect, it } from 'vitest';
import { Badge } from './Badge.js';
import { html } from './test-utils.js';

describe('Badge', () => {
  it('defaults to neutral', () => {
    expect(html(<Badge>docker</Badge>)).toBe(
      '<span class="hz-badge hz-badge-neutral">docker</span>',
    );
  });

  it('renders tone and a 10 px icon', () => {
    const out = html(
      <Badge tone="warn" icon="alert">
        3 Updates
      </Badge>,
    );
    expect(out).toContain('class="hz-badge hz-badge-warn"');
    expect(out).toContain('width="10"');
    expect(out).toContain('3 Updates');
  });
});
