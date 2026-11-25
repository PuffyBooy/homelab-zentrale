import { describe, expect, it } from 'vitest';
import { StatusDot } from './StatusDot.js';
import type { Status } from './types.js';
import { html } from './test-utils.js';

const cases: Array<[Status, string, string]> = [
  ['ok', 'UP', 'Läuft'],
  ['warn', 'WARN', 'Warnung'],
  ['crit', 'DOWN', 'Ausgefallen'],
  ['off', 'OFF', 'Gestoppt'],
  ['info', 'INFO', 'Info'],
  ['busy', 'BOOT', 'Startet'],
];

describe('StatusDot', () => {
  it.each(cases)('%s shows tag %s and long form %s as title', (status, tag, long) => {
    const out = html(<StatusDot status={status} />);
    expect(out).toContain(`class="hz-status hz-status-${status}"`);
    expect(out).toContain(`title="${long}"`);
    expect(out).toContain(`<span class="hz-status-label">${tag}</span>`);
    expect(out).toContain('aria-hidden="true"');
  });

  it('defaults to ok', () => {
    expect(html(<StatusDot />)).toContain('>UP<');
  });

  it('pulses only crit and busy, unless pulse=false', () => {
    expect(html(<StatusDot status="crit" />)).toContain('hz-dot hz-dot-pulse');
    expect(html(<StatusDot status="busy" />)).toContain('hz-dot hz-dot-pulse');
    expect(html(<StatusDot status="warn" />)).not.toContain('hz-dot-pulse');
    expect(html(<StatusDot status="crit" pulse={false} />)).not.toContain('hz-dot-pulse');
  });

  it('hideLabel reads the long form to screen readers', () => {
    const out = html(<StatusDot status="crit" hideLabel />);
    expect(out).toContain('<span class="hz-sr">Ausgefallen</span>');
    expect(out).not.toContain('hz-status-label');
  });

  it('label overrides tag and title', () => {
    const out = html(<StatusDot status="crit" label="Nicht erreichbar" />);
    expect(out).toContain('title="Nicht erreichbar"');
    expect(out).toContain('>Nicht erreichbar</span>');
  });
});
