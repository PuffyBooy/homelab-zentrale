import { describe, expect, it } from 'vitest';
import { UsageBar } from './UsageBar.js';
import { countClass, html } from './test-utils.js';

describe('UsageBar', () => {
  it('renders label, 20 cells and rounded percent', () => {
    const out = html(<UsageBar label="CPU" value={23.4} />);
    expect(out).toContain('<span class="hz-usage-label">CPU</span>');
    expect(out.match(/<i/g)).toHaveLength(20);
    expect(out).toContain('<span class="hz-usage-val">23%</span>');
    expect(out).toContain('aria-label="CPU"');
  });

  it('detail replaces the percent', () => {
    const out = html(<UsageBar label="Speicher /" value={81} detail="389 / 480 GB" />);
    expect(out).toContain('>389 / 480 GB<');
    expect(out).toContain('hz-blocks-warn');
  });

  it('uses warnAt and critAt boundaries', () => {
    expect(html(<UsageBar label="x" value={74} />)).toContain('hz-blocks-ok');
    expect(html(<UsageBar label="x" value={75} />)).toContain('hz-blocks-warn');
    expect(html(<UsageBar label="x" value={96} />)).toContain('hz-blocks-crit');
    expect(html(<UsageBar label="x" value={60} warnAt={50} critAt={95} />)).toContain(
      'hz-blocks-warn',
    );
  });

  it('clamps and honours cells', () => {
    const out = html(<UsageBar label="x" value={120} cells={12} />);
    expect(out).toContain('>100%<');
    expect(countClass(out, 'hz-cell-on')).toBe(12);
  });
});
