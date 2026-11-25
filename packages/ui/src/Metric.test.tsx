import { describe, expect, it } from 'vitest';
import { Metric } from './Metric.js';
import { html } from './test-utils.js';

describe('Metric', () => {
  it('renders label, value, unit and hint', () => {
    const out = html(<Metric label="RAM" value="7,8" unit="GB" hint="von 16 GB" />);
    expect(out).toContain('<div class="hz-label">RAM</div>');
    expect(out).toContain('<span class="hz-num">7,8</span><span class="hz-unit">GB</span>');
    expect(out).toContain('<div class="hz-metric-hint"><span>von 16 GB</span></div>');
  });

  it('renders a toned delta and wall size', () => {
    const out = html(<Metric label="Strom" value="38" delta="+6 W" deltaTone="warn" size="wall" />);
    expect(out).toContain('class="hz-metric hz-metric-wall"');
    expect(out).toContain('<span class="hz-delta hz-delta-warn">+6 W</span>');
  });

  it('omits the hint row without delta and hint', () => {
    expect(html(<Metric label="CPU" value={23} />)).not.toContain('hz-metric-hint');
  });
});
