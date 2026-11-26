import { describe, expect, it } from 'vitest';
import { BlockBar, toneOf } from './BlockBar.js';
import { countClass, html } from './test-utils.js';

describe('BlockBar', () => {
  it('is a meter with 10 cells by default', () => {
    const out = html(<BlockBar value={50} label="CPU" />);
    expect(out).toContain('role="meter"');
    expect(out).toContain('aria-valuemin="0"');
    expect(out).toContain('aria-valuemax="100"');
    expect(out).toContain('aria-valuenow="50"');
    expect(out).toContain('aria-label="CPU"');
    expect(out.match(/<i/g)).toHaveLength(10);
    expect(countClass(out, 'hz-cell-on')).toBe(5);
  });

  it('switches tone at warnAt (75) and critAt (90)', () => {
    expect(html(<BlockBar value={74.9} />)).toContain('hz-blocks hz-blocks-ok');
    expect(html(<BlockBar value={75} />)).toContain('hz-blocks hz-blocks-warn');
    expect(html(<BlockBar value={89} />)).toContain('hz-blocks-warn');
    expect(html(<BlockBar value={90} />)).toContain('hz-blocks-crit');
    expect(html(<BlockBar value={50} warnAt={40} critAt={60} />)).toContain('hz-blocks-warn');
    expect(html(<BlockBar value={100} warnAt={101} critAt={101} />)).toContain('hz-blocks-ok');
  });

  it('clamps the value to 0..100', () => {
    const over = html(<BlockBar value={150} cells={6} />);
    expect(over).toContain('aria-valuenow="100"');
    expect(countClass(over, 'hz-cell-on')).toBe(6);
    const under = html(<BlockBar value={-5} cells={6} />);
    expect(under).toContain('aria-valuenow="0"');
    expect(countClass(under, 'hz-cell-on')).toBe(0);
    expect(html(<BlockBar value={Number.NaN} />)).toContain('aria-valuenow="0"');
  });

  it('toneOf matches the thresholds', () => {
    expect(toneOf(10, 75, 90)).toBe('ok');
    expect(toneOf(75, 75, 90)).toBe('warn');
    expect(toneOf(90, 75, 90)).toBe('crit');
  });
});
