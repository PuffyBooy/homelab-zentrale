import { describe, expect, it } from 'vitest';
import { ServiceRow } from './ServiceRow.js';
import { html } from './test-utils.js';

describe('ServiceRow', () => {
  it('renders status, name, host, meta and actions', () => {
    const out = html(
      <ServiceRow
        name="lernplattform"
        host="heimserver · :3000"
        status="crit"
        meta="exit 1"
        actions={<button type="button">x</button>}
      />,
    );
    expect(out).toMatch(/^<div class="hz-row"><span class="hz-status hz-status-crit"/);
    expect(out).toContain('>DOWN<');
    expect(out).toContain('<span class="hz-row-name">lernplattform</span>');
    expect(out).toContain('<span class="hz-row-sub">heimserver · :3000</span>');
    expect(out).toContain('<div class="hz-row-meta">exit 1</div>');
    expect(out).toContain('<div class="hz-row-actions">');
  });

  it('defaults to ok and omits empty slots', () => {
    const out = html(<ServiceRow name="homeassistant" host="heimserver" />);
    expect(out).toContain('>UP<');
    expect(out).not.toContain('hz-row-meta');
    expect(out).not.toContain('hz-row-actions');
  });
});
