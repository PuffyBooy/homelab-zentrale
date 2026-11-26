import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { check, server } from '../../test-fixtures.js';
import { CheckRow } from './CheckRow.js';

const NOW = new Date('2026-11-25T22:04:00.000Z');

function html(el: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(el).replace(/<!-- -->/g, '');
}

describe('CheckRow', () => {
  const home = server({ id: 'srv-home0001', name: 'heimserver' });

  it('renders WebCheckRow with status shape and text, code, ms, SSL and sparkline', () => {
    const c = check({
      def: { url: 'https://lernen.hoebe.at/', runFrom: home.id },
      status: 'crit',
      reason: 'HTTP 503',
      lastCode: 503,
      lastMs: null,
      sslExpiresAt: '2026-11-29T22:04:00.000Z',
    });
    const out = html(<CheckRow check={c} servers={[home]} now={NOW} />);
    expect(out).toContain('class="hz-row hz-web"');
    expect(out).toContain('hz-status hz-status-crit');
    expect(out).toContain('>DOWN<');
    expect(out).toContain('<span class="hz-row-name">lernen.hoebe.at</span>');
    expect(out).toContain('HTTP 503 · ');
    expect(out).toContain('von heimserver');
    expect(out).toContain('hz-web-code hz-t-crit">503<');
    expect(out).toContain('hz-web-ssl hz-t-crit">SSL 4d<');
    expect(out).toContain('class="hz-spark hz-spark-muted"');
    expect(out).toContain('aria-label="lernen.hoebe.at jetzt prüfen"');
    expect(out).toContain('>Details<');
  });

  it('shows TCP checks without SSL and paused checks as OFF, read-only without buttons', () => {
    const c = check({
      def: { kind: 'tcp', host: '127.0.0.1', port: 1, enabled: false } as never,
      lastMs: 3.4,
      spark: [],
    });
    const out = html(<CheckRow check={c} servers={[]} now={NOW} readOnly />);
    expect(out).toContain('>OFF<');
    expect(out).toContain('hz-web-code">TCP<');
    expect(out).toContain('hz-web-ms">3 ms<');
    expect(out).toContain('>SSL —<');
    expect(out).not.toContain('hz-spark');
    expect(out).not.toContain('<button');
  });
});
