import { describe, expect, it } from 'vitest';
import { Sparkline } from './Sparkline.js';
import { countClass, html } from './test-utils.js';

describe('Sparkline', () => {
  it('renders nothing for fewer than two points', () => {
    expect(Sparkline({ data: [] })).toBeNull();
    expect(Sparkline({ data: [5] })).toBeNull();
  });

  it('draws one bar per value and highlights the last', () => {
    const out = html(<Sparkline data={[12, 18, 15, 22]} />);
    expect(out).toContain('class="hz-spark hz-spark-accent"');
    expect(out).toContain('width="120" height="24" viewBox="0 0 120 24"');
    expect(out).toContain('aria-hidden="true"');
    expect(countClass(out, 'hz-spark-bar')).toBe(3);
    expect(countClass(out, 'hz-spark-last')).toBe(1);
  });

  it('scales min to 2 px and max to full height', () => {
    const out = html(<Sparkline data={[0, 10]} width={20} height={10} tone="ok" />);
    expect(out).toContain('hz-spark-ok');
    expect(out).toContain('<rect x="0" y="8" width="9" height="2" class="hz-spark-bar"></rect>');
    expect(out).toContain('<rect x="10" y="0" width="9" height="10" class="hz-spark-last"></rect>');
  });

  it('handles flat data without dividing by zero', () => {
    const out = html(<Sparkline data={[3, 3, 3]} />);
    expect(out).not.toContain('NaN');
  });
});
