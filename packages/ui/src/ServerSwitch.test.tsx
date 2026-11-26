import { describe, expect, it } from 'vitest';
import { ServerSwitch } from './ServerSwitch.js';
import { html } from './test-utils.js';

describe('ServerSwitch', () => {
  const out = html(
    <ServerSwitch
      active="home"
      servers={[
        { id: 'all', name: 'alle' },
        { id: 'home', name: 'heimserver' },
        { id: 'oci', name: 'oracle-a1', status: 'warn' },
      ]}
    />,
  );

  it('is a labelled tablist with tabs', () => {
    expect(out).toMatch(/^<div class="hz-servers" role="tablist" aria-label="Server">/);
    expect(out.match(/role="tab"/g)).toHaveLength(3);
    expect(out).toContain('aria-selected="true" class="hz-server hz-server-on"');
    expect(out.match(/aria-selected="false"/g)).toHaveLength(2);
  });

  it('has no dot for "all" and screen-reader status for servers', () => {
    expect(out).toContain('class="hz-server"><span>alle</span></button>');
    expect(out).toContain('<span class="hz-sr">Läuft</span><');
    expect(out).toContain('<span class="hz-sr">Warnung</span>');
  });
});
