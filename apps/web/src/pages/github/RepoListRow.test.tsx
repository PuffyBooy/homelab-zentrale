import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { commit, repo, target } from '../../test-fixtures.js';
import { RepoListRow } from './RepoListRow.js';

const NOW = new Date('2026-11-25T22:04:00.000Z');

function html(el: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(el).replace(/<!-- -->/g, '');
}

const noop = (): void => undefined;

describe('RepoListRow', () => {
  const head = commit({ sha: '7be0d44'.padEnd(40, '0'), message: '3D ohne data:-Links' });

  it('renders RepoRow with CI shape and text, target, "2 neu" and the Deploy button', () => {
    const r = repo({
      fullName: 'PuffyBooy/novritsch-konfigurator',
      lastCommit: head,
      targets: [target({ behind: 2 })],
    });
    const out = html(<RepoListRow repo={r} now={NOW} onDeploy={noop} onOpen={noop} />);
    expect(out).toContain('class="hz-row hz-repo"');
    expect(out).toContain('PuffyBooy/novritsch-konfigurator');
    expect(out).toContain('hz-status hz-status-ok');
    expect(out).toContain('>CI ✓<');
    expect(out).toContain('7be0d44 3D ohne data:-Links · vor 2 Std');
    expect(out).toContain(' → heimserver');
    expect(out).toContain('>2 neu<');
    expect(out).toContain('hz-btn-primary');
    expect(out).toContain('>Deploy<');
    expect(out).toContain('aria-label="PuffyBooy/novritsch-konfigurator öffnen"');
  });

  it('has no Deploy button on red or running CI', () => {
    for (const ci of ['crit', 'busy'] as const) {
      const r = repo({ ci, targets: [target({ behind: 2 })] });
      const out = html(<RepoListRow repo={r} now={NOW} onDeploy={noop} />);
      expect(out).not.toContain('>Deploy<');
      expect(out).toContain(`hz-status-${ci}`);
    }
  });

  it('offers Deploy for a repo without CI and shows "kein CI"', () => {
    const r = repo({ ci: 'off', targets: [target({ behind: 1 })] });
    const out = html(<RepoListRow repo={r} now={NOW} onDeploy={noop} />);
    expect(out).toContain('>kein CI<');
    expect(out).toContain('>Deploy<');
  });

  it('shows "Deploy läuft" instead of the button while a deploy runs', () => {
    const r = repo({ targets: [target({ behind: 2, deploying: true })] });
    const out = html(<RepoListRow repo={r} now={NOW} onDeploy={noop} />);
    expect(out).toContain('Deploy läuft');
    expect(out).not.toContain('>Deploy<');
  });

  it('uses the short name in the overview and "aktuell" when nothing waits', () => {
    const r = repo({
      fullName: 'PuffyBooy/my-app',
      targets: [target({ serverName: 'pi' })],
    });
    const out = html(<RepoListRow repo={r} now={NOW} compact onDeploy={noop} onOpen={noop} />);
    expect(out).toContain('<span class="hz-row-name">my-app<');
    expect(out).toContain('>aktuell<');
    expect(out).not.toContain('Details');
    expect(out).not.toContain('>Deploy<');
  });

  it('says "nicht deployt" without target', () => {
    const out = html(<RepoListRow repo={repo()} now={NOW} onDeploy={noop} />);
    expect(out).toContain(' · nicht deployt');
  });
});
