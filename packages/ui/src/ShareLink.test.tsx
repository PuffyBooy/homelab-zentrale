import { describe, expect, it } from 'vitest';
import { ShareLink } from './ShareLink.js';
import { html } from './test-utils.js';

describe('ShareLink', () => {
  const perms = [
    { id: 'start', label: 'Starten/Stoppen', on: true },
    { id: 'console', label: 'Konsole', on: false },
  ];

  it('renders user, url, perms and revoke', () => {
    const out = html(
      <ShareLink
        server="survival"
        user="Lukas"
        url="https://example.ts.net/g/k7Qm2xPa9"
        expires="läuft ab in 14 Tagen"
        lastUsed="gestern 20:41"
        perms={perms}
      />,
    );
    expect(out).toContain('<div class="hz-label">Benutzerlink für survival</div>');
    expect(out).toContain('Lukas</div>');
    expect(out).toContain('<span class="hz-badge hz-badge-neutral">läuft ab in 14 Tagen</span>');
    expect(out).toContain('<code>https://example.ts.net/g/k7Qm2xPa9</code>');
    expect(out).toContain('<span class="hz-perm hz-perm-on">[x] Starten/Stoppen</span>');
    expect(out).toContain('<span class="hz-perm">[ ] Konsole</span>');
    expect(out).toContain('zuletzt benutzt gestern 20:41');
    expect(out).toContain('hz-btn hz-btn-danger hz-btn-sm');
  });

  it('shows expiry as crit and "noch nie benutzt"', () => {
    const out = html(
      <ShareLink server="s" user="u" url="x" expires="abgelaufen" expired perms={[]} />,
    );
    expect(out).toContain('hz-badge hz-badge-crit');
    expect(out).toContain('noch nie benutzt');
  });
});
