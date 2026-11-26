import { describe, expect, it } from 'vitest';
import { CommitRow } from './CommitRow.js';
import { html } from './test-utils.js';

describe('CommitRow', () => {
  it('shortens the hash and shows repo/branch and time', () => {
    const out = html(
      <CommitRow message="Lyrics" repo="my-app" hash="a3f9c21e" time="vor 2 Std" live />,
    );
    expect(out).toContain('<code class="hz-hash">a3f9c21</code>');
    expect(out).toContain('<span class="hz-row-sub">my-app/main · vor 2 Std</span>');
    expect(out).toContain('<span class="hz-badge hz-badge-accent">LIVE</span>');
    expect(out).toContain('>UP<');
  });

  it('shows the action when not live and uses statusLabel', () => {
    const out = html(
      <CommitRow
        message="Login"
        repo="lernplattform"
        branch="dev"
        hash="11cd0e9f"
        time="gestern"
        status="crit"
        statusLabel="Build fehlgeschlagen"
        action={<em>Rollback</em>}
      />,
    );
    expect(out).toContain('lernplattform/dev · gestern');
    expect(out).toContain('title="Build fehlgeschlagen"');
    expect(out).toContain('<em>Rollback</em>');
    expect(out).not.toContain('LIVE');
  });
});
