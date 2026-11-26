import { describe, expect, it } from 'vitest';
import { commit, deploy, repo, target } from '../test-fixtures.js';
import {
  applyDeployChunks,
  commitLine,
  deployBlock,
  deployDuration,
  deployKeyUrl,
  deployResult,
  deploySnapshotToBuffer,
  deployableTargets,
  deployedTo,
  emptyDeployLog,
  emptyTargetForm,
  formToTarget,
  githubSentence,
  pollText,
  repoBehind,
  repoBranches,
  repoOnServer,
  repoSentence,
  repoShortName,
  rollbackTargets,
  showDeployButton,
  shownDeployLines,
  sortRepos,
  textToLines,
  tokenError,
} from './github.js';

const NOW = new Date('2026-11-25T22:04:00.000Z');

describe('repo labels', () => {
  it('shortens names, joins targets and caps behind at 30', () => {
    expect(repoShortName('PuffyBooy/my-app')).toBe('my-app');
    const r = repo({
      targets: [
        target({ serverName: 'heimserver', behind: 2 }),
        target({ serverName: 'oracle-a1', behind: 45 }),
        target({ serverName: 'pi', liveSha: null, behind: 3 }),
      ],
    });
    expect(repoBehind(r)).toBe(30);
    expect(deployedTo(r)).toBe('heimserver, oracle-a1');
    expect(deployedTo(repo())).toBeNull();
    expect(repoBehind(repo())).toBe(0);
  });

  it('writes the commit line as in Dashboard.html', () => {
    const c = commit({ sha: 'a3f9c21'.padEnd(40, '0'), message: 'Lyrics-Sync' });
    expect(commitLine(c, NOW)).toBe('a3f9c21 Lyrics-Sync · vor 2 Std');
    expect(commitLine(null, NOW)).toBe('noch kein Commit');
  });

  it('builds the deploy key link and the default path', () => {
    expect(deployKeyUrl('PuffyBooy/my-app')).toBe(
      'https://github.com/PuffyBooy/my-app/settings/keys/new',
    );
    expect(emptyTargetForm({ fullName: 'PuffyBooy/my-app', defaultBranch: 'dev' })).toEqual({
      serverId: '',
      path: '/opt/homelab/apps/my-app',
      branch: 'dev',
      method: 'compose',
      autoDeploy: false,
    });
  });

  it('lists branches and filters by server', () => {
    const r = repo({ targets: [target({ branch: 'prod', serverId: 'srv-oci00001' })] });
    expect(repoBranches(r)).toEqual(['main', 'prod']);
    expect(repoOnServer(r, 'srv-oci00001')).toBe(true);
    expect(repoOnServer(r, 'srv-home0001')).toBe(false);
  });
});

describe('deploy button rule', () => {
  const behind = (over: Parameters<typeof target>[0] = {}): ReturnType<typeof target> =>
    target({ behind: 2, ...over });

  it('offers deploy with green CI and a target that is behind', () => {
    const r = repo({ ci: 'ok', targets: [behind(), target({ behind: 0 })] });
    expect(showDeployButton(r)).toBe(true);
    expect(deployableTargets(r)).toHaveLength(1);
  });

  it('offers deploy for a target that never ran', () => {
    expect(showDeployButton(repo({ targets: [target({ liveSha: null })] }))).toBe(true);
  });

  it('offers deploy for a repo without CI (off)', () => {
    const r = repo({ ci: 'off', targets: [behind()] });
    expect(showDeployButton(r)).toBe(true);
    expect(deployBlock(r, r.targets[0] ?? target())).toBe('ok');
  });

  it('never offers deploy on red or running CI', () => {
    for (const ci of ['crit', 'busy'] as const) {
      const r = repo({ ci, targets: [behind()] });
      expect(showDeployButton(r)).toBe(false);
      expect(deployBlock(r, r.targets[0] ?? target())).toBe(`ci_${ci}`);
    }
  });

  it("follows the CI of the target's own branch, not the default branch", () => {
    const head = 'b'.repeat(40);
    const red = repo({
      ci: 'ok',
      targets: [behind({ branch: 'prod', headSha: head, headCi: 'crit' })],
    });
    expect(showDeployButton(red)).toBe(false);
    const green = repo({
      ci: 'crit',
      targets: [behind({ branch: 'prod', headSha: head, headCi: 'ok' })],
    });
    expect(showDeployButton(green)).toBe(true);
  });

  it('never offers deploy while a deploy runs or without target or commit', () => {
    expect(showDeployButton(repo({ targets: [behind(), target({ deploying: true })] }))).toBe(
      false,
    );
    expect(showDeployButton(repo({ targets: [] }))).toBe(false);
    expect(showDeployButton(repo({ lastCommit: null, targets: [behind()] }))).toBe(false);
    expect(showDeployButton(repo({ targets: [target({ behind: 0 })] }))).toBe(false);
  });

  it('allows rollback only to earlier deploys that are not live there', () => {
    const a = target();
    const b = target();
    const r = repo({ targets: [a, b] });
    expect(rollbackTargets(r, { liveOn: [a.id], deployedBefore: [a.id, b.id] })).toEqual([b]);
    expect(rollbackTargets(r, { liveOn: [], deployedBefore: [] })).toEqual([]);
  });
});

describe('sortRepos', () => {
  it('puts new commits first, then red CI, then newest commit', () => {
    const quiet = repo({ fullName: 'a/quiet', lastCommit: commit({ at: '2026-11-25T21:00:00Z' }) });
    const older = repo({ fullName: 'a/older', lastCommit: commit({ at: '2026-11-20T21:00:00Z' }) });
    const red = repo({ fullName: 'a/red', ci: 'crit' });
    const two = repo({ fullName: 'a/two', targets: [target({ behind: 2 })] });
    const five = repo({ fullName: 'a/five', targets: [target({ behind: 5 })] });
    expect(sortRepos([older, quiet, red, two, five]).map((r) => r.fullName)).toEqual([
      'a/five',
      'a/two',
      'a/red',
      'a/quiet',
      'a/older',
    ]);
  });
});

describe('sentences', () => {
  it('names red CI first', () => {
    const s = githubSentence([
      repo({ fullName: 'a/my-app', ci: 'crit' }),
      repo({ targets: [target({ behind: 1 })] }),
    ]);
    expect(s).toEqual({ em: 'CI rot bei my-app', rest: ' · 2 Repos' });
  });

  it('reports waiting commits and the quiet state', () => {
    expect(
      githubSentence([repo({ fullName: 'a/my-app', targets: [target({ behind: 2 })] }), repo()]),
    ).toEqual({ em: null, rest: 'my-app: 2 neu · 2 Repos' });
    expect(githubSentence([repo()])).toEqual({ em: null, rest: 'Alles aktuell · 1 Repo' });
    expect(githubSentence([])).toEqual({ em: null, rest: 'Noch keine Repos.' });
  });

  it('describes one repo', () => {
    expect(repoSentence(repo({ fullName: 'a/x', targets: [] })).rest).toBe(
      'x hat noch kein Deploy-Ziel.',
    );
    expect(
      repoSentence(repo({ fullName: 'a/x', targets: [target({ deploying: true })] })).rest,
    ).toBe('Deploy von x läuft auf heimserver.');
    expect(repoSentence(repo({ fullName: 'a/x', targets: [target()] })).rest).toBe(
      'x ist aktuell.',
    );
  });

  it('writes the poll footer', () => {
    expect(pollText({ lastPollAt: '2026-11-25T22:03:00.000Z', rateRemaining: 4812 }, NOW)).toMatch(
      /^Abgleich alle 60 s · zuletzt \d\d:\d\d · 4.?812 Anfragen übrig$/u,
    );
    expect(pollText({ lastPollAt: null, rateRemaining: null }, NOW)).toBe(
      'Abgleich alle 60 s · noch kein Abgleich',
    );
  });
});

describe('target form', () => {
  const base = {
    serverId: 'srv-home0001',
    path: '/opt/homelab/apps/my-app',
    branch: 'main',
    method: 'compose' as const,
    autoDeploy: true,
  };

  it('accepts a valid target', () => {
    expect(formToTarget({ ...base, path: ' /opt/homelab/apps/my-app ' })).toEqual({
      ok: true,
      body: base,
    });
  });

  it('rejects paths outside /opt/homelab, traversal and bad branches', () => {
    for (const path of ['/etc/my-app', '/opt/homelab/../etc', '/opt/homelab//x', '/opt/homelab/']) {
      const res = formToTarget({ ...base, path });
      expect(res.ok).toBe(false);
    }
    const res = formToTarget({ ...base, serverId: '', branch: '-x' });
    expect(res).toEqual({
      ok: false,
      errors: { serverId: 'Server auswählen.', branch: 'Branch-Name ungültig.' },
    });
  });

  it('checks the token format', () => {
    expect(tokenError('')).toBe('Token eingeben.');
    expect(tokenError('hunter2')).toMatch(/kein GitHub-Token/);
    expect(tokenError(`github_pat_${'A'.repeat(30)}`)).toBeNull();
    expect(tokenError(`ghp_${'a'.repeat(36)}`)).toBeNull();
  });
});

describe('deploy log and result', () => {
  it('splits chunks into Terminal lines and drops repeats', () => {
    expect(textToLines('a\nb\n', 'stderr')).toEqual([
      { text: 'a', kind: 'err' },
      { text: 'b', kind: 'err' },
    ]);
    let buf = applyDeployChunks(emptyDeployLog, [
      { id: '1', channel: 'stdout', text: 'git fetch\n' },
      { id: '2', channel: 'progress', text: 'Step 1/4' },
      { bogus: true },
    ]);
    buf = applyDeployChunks(buf, [{ id: '2', channel: 'progress', text: 'Step 1/4' }]);
    expect(buf.lines).toEqual([{ text: 'git fetch' }, { text: 'Step 1/4', kind: 'dim' }]);
    expect(buf.complete).toBe(false);
  });

  it('accepts snapshot lists and stored logs', () => {
    expect(deploySnapshotToBuffer([{ id: '1', channel: 'stdout', text: 'x' }])?.lines).toEqual([
      { text: 'x' },
    ]);
    expect(deploySnapshotToBuffer({ log: 'a\nb' })?.lines).toHaveLength(2);
    expect(deploySnapshotToBuffer(42)).toBeNull();
  });

  it('shows live lines while running and the stored log after the end', () => {
    const live = applyDeployChunks(emptyDeployLog, [{ id: '1', channel: 'stdout', text: 'live' }]);
    const running = { deploy: deploy({ status: 'running', finishedAt: null }), log: 'old' };
    expect(shownDeployLines(running, live)).toEqual([{ text: 'live' }]);
    expect(shownDeployLines(running, undefined)).toEqual([{ text: 'old' }]);
    const done = { deploy: deploy(), log: 'full\nlog' };
    expect(shownDeployLines(done, live)).toEqual([{ text: 'full' }, { text: 'log' }]);
  });

  it('writes the result alert: what + where, then commit and duration', () => {
    const d = deploy({ sha: 'a3f9c21'.padEnd(40, '0') });
    expect(deployDuration(d)).toBe('42 s');
    expect(deployResult(d, 'my-app', 'pi')).toEqual({
      tone: 'ok',
      title: 'my-app auf pi deployt',
      body: 'a3f9c21 · nach 42 s',
    });
    const failed = deployResult(
      deploy({
        status: 'failed',
        summary: 'compose up fehlgeschlagen (Exit 1)',
        trigger: 'rollback',
      }),
      'my-app',
      'heimserver',
    );
    expect(failed.tone).toBe('crit');
    expect(failed.title).toBe('Rollback von my-app auf heimserver fehlgeschlagen');
    expect(failed.body).toContain('compose up fehlgeschlagen (Exit 1)');
    expect(
      deployDuration(
        deploy({ startedAt: '2026-11-25T22:00:00Z', finishedAt: '2026-11-25T22:03:05Z' }),
      ),
    ).toBe('3 Min 5 s');
  });
});
