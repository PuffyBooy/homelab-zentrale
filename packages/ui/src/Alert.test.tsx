import { describe, expect, it } from 'vitest';
import { Alert } from './Alert.js';
import { html } from './test-utils.js';

describe('Alert', () => {
  it('crit is an alert with level CRIT, time and body', () => {
    const out = html(
      <Alert tone="crit" title="web-vps nicht erreichbar" time="23:02" action={<b>a</b>}>
        kein Ping seit 22 Min.
      </Alert>,
    );
    expect(out).toMatch(/^<div class="hz-alert hz-alert-crit" role="alert">/);
    expect(out).toContain('<span class="hz-alert-time">23:02</span>');
    expect(out).toContain('<span class="hz-alert-lvl">CRIT</span>');
    expect(out).toContain('<span class="hz-alert-title">web-vps nicht erreichbar</span>');
    expect(out).toContain('<span class="hz-alert-body">kein Ping seit 22 Min.</span>');
    expect(out).toContain('<b>a</b>');
  });

  it.each([
    ['ok', 'OK'],
    ['warn', 'WARN'],
    ['info', 'INFO'],
  ] as const)('%s is a status with level %s', (tone, lvl) => {
    const out = html(<Alert tone={tone} title="t" />);
    expect(out).toContain('role="status"');
    expect(out).toContain(`>${lvl}<`);
    expect(out).not.toContain('hz-alert-time');
    expect(out).not.toContain('hz-alert-body');
  });

  it('defaults to info and supports floating', () => {
    expect(html(<Alert title="t" floating />)).toContain(
      'class="hz-alert hz-alert-info hz-alert-floating"',
    );
  });
});
