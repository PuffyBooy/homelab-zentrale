import { describe, expect, it } from 'vitest';
import {
  ciOf,
  GithubClient,
  GithubError,
  type EtagStore,
  type FetchLike,
  type WorkflowRun,
} from '../src/github/client.js';
import { behindCount } from '../src/github/service.js';
import { failureSummary, tailBytes } from '../src/github/deploys.js';
import { FakeGithub, TOKEN } from './github-helpers.js';
import { T0 } from './helpers.js';

function memoryEtags(): EtagStore & { map: Map<string, { etag: string; data: unknown }> } {
  const map = new Map<string, { etag: string; data: unknown }>();
  return { map, get: (u) => map.get(u), set: (u, etag, data) => map.set(u, { etag, data }) };
}

function setup(token: string | null = TOKEN) {
  const clock = { t: T0 };
  const gh = new FakeGithub(() => clock.t);
  const etags = memoryEtags();
  const client = new GithubClient({
    token: () => token,
    etags,
    now: () => clock.t,
    fetch: gh.fetch,
  });
  return { clock, gh, etags, client };
}

const run = (over: Partial<WorkflowRun>): WorkflowRun => ({
  id: 1,
  workflowId: 1,
  headSha: 'a'.repeat(40),
  status: 'completed',
  conclusion: 'success',
  createdAt: '2026-11-25T12:00:00Z',
  ...over,
});

describe('CI status from workflow runs', () => {
  it('maps the latest run per workflow', () => {
    expect(ciOf([])).toBe('off');
    expect(ciOf([run({})])).toBe('ok');
    for (const c of ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure']) {
      expect(ciOf([run({ conclusion: c })]), c).toBe('crit');
    }
    for (const st of ['in_progress', 'queued', 'waiting', 'requested', 'pending']) {
      expect(ciOf([run({ status: st, conclusion: null })]), st).toBe('busy');
    }
    expect(ciOf([run({ conclusion: 'skipped' })])).toBe('off');
    // A re-run that succeeded replaces the failed run of the same workflow.
    expect(
      ciOf([
        run({ id: 1, conclusion: 'failure', createdAt: '2026-11-25T12:00:00Z' }),
        run({ id: 2, conclusion: 'success', createdAt: '2026-11-25T12:05:00Z' }),
      ]),
    ).toBe('ok');
    // Two workflows: one red makes the commit red, one running makes it busy.
    expect(
      ciOf([run({ workflowId: 1 }), run({ id: 2, workflowId: 2, conclusion: 'failure' })]),
    ).toBe('crit');
    expect(
      ciOf([
        run({ workflowId: 1 }),
        run({ id: 2, workflowId: 2, status: 'queued', conclusion: null }),
      ]),
    ).toBe('busy');
  });
});

describe('GitHub client', () => {
  it('sends the token only as Bearer header to the API and parses commits', async () => {
    const { gh, client } = setup();
    gh.addRepo('admin/blog');
    const sha = gh.push('admin/blog', 'Hello world');
    expect(await client.user()).toBe('admin-hz');
    const commits = await client.commits('admin/blog', 'main');
    expect(commits).toEqual([
      { sha, message: 'Hello world', author: 'Admin', at: new Date(T0).toISOString() },
    ]);
    for (const r of gh.requests) {
      expect(r.url.startsWith('https://api.github.com/')).toBe(true);
      expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(r.url).not.toContain(TOKEN);
      expect(r.headers['x-github-api-version']).toBe('2022-11-28');
    }
  });

  it('uses ETags: the second request is conditional and a 304 returns the cached data', async () => {
    const { gh, client, etags } = setup();
    gh.addRepo('admin/blog');
    gh.push('admin/blog', 'one');
    const first = await client.commits('admin/blog', 'main');
    const remaining = gh.remaining;
    const second = await client.commits('admin/blog', 'main');
    expect(second).toEqual(first);
    const [a, b] = gh.requests;
    expect(a?.headers['if-none-match']).toBeUndefined();
    expect(b?.headers['if-none-match']).toBe(etags.map.values().next().value?.etag);
    expect(b?.status).toBe(304);
    // 304 is free: the rate limit did not go down.
    expect(gh.remaining).toBe(remaining);
    expect(client.rate.remaining).toBe(remaining);

    gh.push('admin/blog', 'two');
    const third = await client.commits('admin/blog', 'main');
    expect(gh.requests.at(-1)?.status).toBe(200);
    expect(third.map((c) => c.message)).toEqual(['two', 'one']);
  });

  it('backs off when the rate limit is used up and resumes after the reset', async () => {
    const { gh, client, clock } = setup();
    gh.addRepo('admin/blog');
    gh.remaining = 1;
    gh.resetAt = Math.floor(clock.t / 1000) + 600;
    await client.repo('admin/blog'); // the last request: remaining 0
    expect(client.rate.remaining).toBe(0);
    expect(client.rateLimitReason()).toBe('Rate-Limit bis 13:10');
    const before = gh.requests.length;
    await expect(client.repo('admin/blog')).rejects.toMatchObject({ kind: 'rate_limited' });
    // Held back in the core: GitHub was not asked.
    expect(gh.requests.length).toBe(before);

    clock.t += 601_000;
    gh.remaining = 5000;
    await expect(client.repo('admin/blog')).resolves.toMatchObject({ fullName: 'admin/blog' });
    expect(client.rateLimitReason()).toBeNull();
  });

  it('a 403 rate-limit answer blocks until the reset header', async () => {
    const { gh, client, clock } = setup();
    gh.addRepo('admin/blog');
    gh.limited = true;
    gh.resetAt = Math.floor(clock.t / 1000) + 120;
    await expect(client.repo('admin/blog')).rejects.toMatchObject({
      kind: 'rate_limited',
      reason: 'Rate-Limit bis 13:02',
    });
    gh.limited = false;
    const n = gh.requests.length;
    await expect(client.repo('admin/blog')).rejects.toBeInstanceOf(GithubError);
    expect(gh.requests.length).toBe(n);
  });

  it('turns failures into short German reasons without the token', async () => {
    const bad = setup('ghp_notavalidtokenatall0000000000000000');
    await expect(bad.client.user()).rejects.toMatchObject({
      kind: 'unauthorized',
      reason: 'Token ungültig oder abgelaufen',
    });
    const { gh, client } = setup();
    await expect(client.repo('admin/nope')).rejects.toMatchObject({
      kind: 'not_found',
      reason: 'Repo oder Branch nicht gefunden',
    });
    gh.down = true;
    const err = await client.user().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubError);
    expect((err as GithubError).reason).toBe('GitHub nicht erreichbar');
    expect(JSON.stringify(err)).not.toContain(TOKEN);
    expect(String((err as Error).message)).not.toContain(TOKEN);
    expect(String((err as Error).stack)).not.toContain(TOKEN);
    await expect(setup(null).client.user()).rejects.toMatchObject({ kind: 'no_token' });
  });

  it('rejects malformed answers and server errors', async () => {
    const clock = { t: T0 };
    const answers: Response[] = [
      new Response('not json', { status: 200 }),
      new Response(JSON.stringify([{ sha: '../../etc', commit: { message: 'x' } }]), {
        status: 200,
      }),
      new Response('{}', { status: 502 }),
    ];
    const f: FetchLike = () =>
      Promise.resolve(answers.shift() ?? new Response('', { status: 500 }));
    const client = new GithubClient({
      token: () => TOKEN,
      etags: memoryEtags(),
      now: () => clock.t,
      fetch: f,
    });
    await expect(client.user()).rejects.toMatchObject({ kind: 'invalid' });
    await expect(client.commits('admin/blog', 'main')).rejects.toMatchObject({ kind: 'invalid' });
    await expect(client.user()).rejects.toMatchObject({
      kind: 'server',
      reason: 'GitHub-Fehler (HTTP 502)',
    });
  });

  it('encodes branch names in the query', async () => {
    const { gh, client } = setup();
    gh.addRepo('admin/blog');
    await client.commits('admin/blog', 'feature/a+b').catch(() => undefined);
    expect(gh.requests.at(-1)?.path).toBe(
      '/repos/admin/blog/commits?sha=feature%2Fa%2Bb&per_page=30',
    );
  });
});

describe('deploy helpers', () => {
  it('counts commits behind the live sha (max 30)', () => {
    const list = ['c', 'b', 'a'].map((sha) => ({ sha }));
    expect(behindCount(list, 'c')).toBe(0);
    expect(behindCount(list, 'a')).toBe(2);
    expect(behindCount(list, 'zzz')).toBe(30);
    expect(behindCount(list, null)).toBe(0);
  });

  it('keeps the last 256 KB of a log', () => {
    const big = `${'x'.repeat(300 * 1024)}END`;
    const tail = tailBytes(big);
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(256 * 1024);
    expect(tail.endsWith('END')).toBe(true);
    const umlauts = 'ä'.repeat(200 * 1024);
    const t2 = tailBytes(umlauts);
    expect(Buffer.byteLength(t2)).toBeLessThanOrEqual(256 * 1024);
    expect(t2).toMatch(/^ä+$/);
  });

  it('writes short German failure summaries', () => {
    expect(failureSummary('compose', { code: 1 }, false)).toBe(
      'compose up fehlgeschlagen (Exit 1)',
    );
    expect(failureSummary('script', { code: 2 }, false)).toBe('deploy.sh fehlgeschlagen (Exit 2)');
    expect(failureSummary('compose', { code: -1, error: 'disconnected' }, false)).toBe(
      'Verbindung zum Agent verloren',
    );
    expect(failureSummary('compose', { code: -1, error: 'cancelled' }, true)).toBe(
      'Zeitüberschreitung nach 20 Min',
    );
    expect(
      failureSummary(
        'compose',
        { code: 128, error: 'git fetch https://user:pw@github.com/x failed' },
        false,
      ),
    ).toBe('git fetch https://github.com/x failed (Exit 128)');
  });
});
