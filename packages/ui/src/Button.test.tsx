import { describe, expect, it } from 'vitest';
import { Button } from './Button.js';
import { html } from './test-utils.js';

describe('Button', () => {
  it('defaults to secondary md type=button', () => {
    expect(html(<Button>Starten</Button>)).toBe(
      '<button class="hz-btn hz-btn-secondary hz-btn-md" type="button"><span>Starten</span></button>',
    );
  });

  it('renders variant, size, icon and passes HTML attributes through', () => {
    const out = html(
      <Button variant="primary" size="sm" icon="refresh" disabled type="submit">
        Deploy
      </Button>,
    );
    expect(out).toContain('class="hz-btn hz-btn-primary hz-btn-sm"');
    expect(out).toContain('type="submit"');
    expect(out).toContain('disabled=""');
    expect(out).toContain('width="12"');
  });

  it('marks icon-only buttons and keeps aria-label', () => {
    const out = html(<Button variant="ghost" icon="terminal" aria-label="Logs" />);
    expect(out).toContain('hz-btn-iconly');
    expect(out).toContain('aria-label="Logs"');
    expect(out).toContain('width="14"');
    expect(out).not.toContain('<span>');
  });
});
