import { describe, expect, it } from 'vitest';
import { Toggle } from './Toggle.js';
import { html } from './test-utils.js';

describe('Toggle', () => {
  it('is a labelled switch, AUS selected when off', () => {
    const out = html(<Toggle label="Licht Wohnzimmer" />);
    expect(out).toContain('role="switch"');
    expect(out).toContain('aria-checked="false"');
    expect(out).toContain('aria-label="Licht Wohnzimmer"');
    expect(out).toContain('<span class="hz-switch-opt hz-switch-sel">AUS</span>');
    expect(out).toContain('<span class="hz-switch-opt">AN</span>');
    expect(out).not.toContain('disabled');
  });

  it('AN selected when on, with hint', () => {
    const out = html(<Toggle label="Steckdose" hint="38 W" checked />);
    expect(out).toContain('aria-checked="true"');
    expect(out).toContain('class="hz-switch hz-switch-on"');
    expect(out).toContain('<span class="hz-switch-opt hz-switch-sel">AN</span>');
    expect(out).toContain('Steckdose<small>38 W</small>');
  });

  it('disabled', () => {
    const out = html(<Toggle label="Türöffner" disabled />);
    expect(out).toContain('class="hz-toggle hz-toggle-disabled"');
    expect(out).toContain('disabled=""');
  });
});
