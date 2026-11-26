import { describe, expect, it } from 'vitest';
import { RepoRow } from './RepoRow.js';
import { html } from './test-utils.js';

describe('RepoRow', () => {
  it('shows branch, target, CI label and "aktuell"', () => {
    const out = html(<RepoRow repo="my-app" commit="a3f9c21 Lyrics" ci="ok" deployedTo="pi" />);
    expect(out).toContain('class="hz-row hz-repo"');
    expect(out).toContain('my-app<span class="hz-repo-branch">main</span>');
    expect(out).toContain('<span class="hz-repo-target"> → pi</span>');
    expect(out).toContain('>CI ✓<');
    expect(out).toContain('<span class="hz-badge hz-badge-ok">aktuell</span>');
  });

  it('shows new commits as accent badge', () => {
    const out = html(<RepoRow repo="r" commit="c" ci="busy" deployedTo="heimserver" behind={2} />);
    expect(out).toContain('<span class="hz-badge hz-badge-accent">2 neu</span>');
    expect(out).toContain('>CI …<');
    expect(out).toContain('hz-dot-pulse');
  });

  it('red CI and not deployed', () => {
    const out = html(<RepoRow repo="r" branch="dev" commit="c" ci="crit" deployedTo={null} />);
    expect(out).toContain('>CI ✗<');
    expect(out).toContain('hz-status-crit');
    expect(out).toContain(' · nicht deployt');
    expect(out).toContain('>dev<');
    expect(out).not.toContain('hz-badge');
    expect(html(<RepoRow repo="r" commit="c" ci="off" />)).toContain('>kein CI<');
  });
});
