import { describe, expect, it } from 'vitest';
import { WebCheckRow } from './WebCheckRow.js';
import { html } from './test-utils.js';

describe('WebCheckRow', () => {
  it('renders code, ms and ssl in neutral tone when fine', () => {
    const out = html(<WebCheckRow url="example.at" status="ok" code={200} ms={312} sslDays={61} />);
    expect(out).toContain('class="hz-row hz-web"');
    expect(out).toContain('<span class="hz-web-code">200</span>');
    expect(out).toContain('<span class="hz-web-ms">312 ms</span>');
    expect(out).toContain('<span class="hz-web-ssl">SSL 61d</span>');
    expect(out).toContain('>UP<');
  });

  it('marks slow responses (>800 ms) and SSL < 14 days as warn', () => {
    const out = html(<WebCheckRow url="x" status="warn" code={200} ms={1240} sslDays={9} />);
    expect(out).toContain('hz-web-ms hz-t-warn');
    expect(out).toContain('hz-web-ssl hz-t-warn');
    expect(html(<WebCheckRow url="x" ms={800} sslDays={14} />)).not.toContain('hz-t-');
  });

  it('marks HTTP >= 400 and SSL < 5 days as crit, dashes for missing', () => {
    const out = html(<WebCheckRow url="x" status="crit" code={503} ms={null} sslDays={4} />);
    expect(out).toContain('hz-web-code hz-t-crit');
    expect(out).toContain('hz-web-ssl hz-t-crit');
    expect(out).toContain('>—<');
    expect(out).toContain('>DOWN<');
    expect(html(<WebCheckRow url="x" />)).toContain('>---<');
    expect(html(<WebCheckRow url="x" />)).toContain('>SSL —<');
  });

  it('accepts non-HTTP codes', () => {
    const out = html(<WebCheckRow url="mc.example.org" code="TCP" ms={28} />);
    expect(out).toContain('<span class="hz-web-code">TCP</span>');
  });
});
