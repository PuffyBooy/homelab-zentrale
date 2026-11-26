import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  availableRepoListResponseSchema,
  commitListResponseSchema,
  deployListResponseSchema,
  deployResponseSchema,
  deployTargetResponseSchema,
  githubSettingsSchema,
  repoListResponseSchema,
} from '@hz/shared';
import { weeklyReportText } from '../src/alerts/weekly-report.js';
import { openDatabase } from '../src/db/index.js';
import { auditLog, deploys } from '../src/db/schema.js';
import { DEPLOY_LOG_MAX_BYTES } from '../src/github/deploys.js';
import { enrollAgent, stepUp, until, WsClient } from './agent-helpers.js';
import {
  addRepo,
  addTarget,
  deployDone,
  deployRequest,
  pollOnce,
  PUBLIC_KEY,
  setToken,
  target,
  TOKEN,
  withGithub,
  type GithubSetup,
} from './github-helpers.js';
import { emptyDir, makeApp, type TestApp } from './helpers.js';

let t: TestApp | undefined;
const extra: TestApp[] = [];
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
  for (const a of extra.splice(0)) await a.app.close();
});

async function setup(opts: { token?: boolean } = { token: true }): Promise<GithubSetup> {
  const s = await withGithub(clients, opts);
  t = s.t;
  return s;
}

async function blog(s: GithubSetup, opts: { private?: boolean } = {}) {
  s.gh.addRepo('alex/blog', opts);
  const sha = s.gh.push('alex/blog', 'Initial commit');
  s.gh.ci(sha, 'success');
  const repo = await addRepo(s, 'alex/blog');
  return { repo, sha };
}

const get = (s: GithubSetup, url: string) => s.t.app.inject({ url, headers: s.headers });

describe('token and settings', () => {
  it('starts without a token and stores a checked token encrypted', async () => {
    const s = await setup({ token: false });
    const empty = githubSettingsSchema.parse((await get(s, '/api/github/settings')).json());
    expect(empty).toEqual({
      tokenSet: false,
      login: null,
      lastPollAt: null,
      error: null,
      rateRemaining: null,
    });
    await setToken(s);
    const set = githubSettingsSchema.parse((await get(s, '/api/github/settings')).json());
    expect(set).toMatchObject({ tokenSet: true, login: 'alex-hz', error: null });
    expect(set.rateRemaining).toBeGreaterThan(0);
    // The poll after setting the token ran.
    expect(set.lastPollAt).not.toBeNull();
    const audit = s.t.db.db.select().from(auditLog).all();
    expect(audit.some((a) => a.action === 'github.token_set')).toBe(true);
  });

  it('refuses a token GitHub rejects and keeps the old state', async () => {
    const s = await setup({ token: false });
    await stepUp(s.t, s.secret, s.cookie);
    const res = await s.t.app.inject({
      method: 'PUT',
      url: '/api/github/token',
      headers: s.headers,
      payload: { token: 'ghp_ThisTokenIsNotKnownToGitHub000000000' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ ok: false, error: 'invalid_credentials' });
    expect(s.t.app.hzCore.github.settings().tokenSet).toBe(false);
  });

  it('rejects malformed tokens (400) and deletes the token (step-up)', async () => {
    const s = await setup();
    await stepUp(s.t, s.secret, s.cookie);
    for (const token of ['short', 'xyz_0123456789012345678901234', `${TOKEN} `.repeat(10), 42]) {
      const res = await s.t.app.inject({
        method: 'PUT',
        url: '/api/github/token',
        headers: s.headers,
        payload: { token },
      });
      expect(res.statusCode).toBe(400);
    }
    const del = await s.t.app.inject({
      method: 'DELETE',
      url: '/api/github/token',
      headers: s.headers,
    });
    expect(del.statusCode).toBe(200);
    expect(s.t.app.hzCore.github.settings()).toMatchObject({ tokenSet: false, login: null });
    // Polling stops without a token.
    const n = s.gh.requests.length;
    await pollOnce(s);
    expect(s.gh.requests.length).toBe(n);
  });

  it('stores the token even if GitHub is unreachable and shows the reason', async () => {
    const s = await setup({ token: false });
    s.gh.down = true;
    await setToken(s);
    expect(s.t.app.hzCore.github.settings()).toMatchObject({
      tokenSet: true,
      login: null,
      error: 'GitHub nicht erreichbar',
    });
  });
});

describe('repos', () => {
  it('lists available repos, tracks and untracks a repo', async () => {
    const s = await setup();
    s.gh.addRepo('alex/blog');
    s.gh.addRepo('alex/infra', { private: true });
    const { repo, sha } = await blog(s);
    expect(repo).toMatchObject({
      fullName: 'alex/blog',
      private: false,
      defaultBranch: 'main',
      htmlUrl: 'https://github.com/alex/blog',
      ci: 'ok',
      targets: [],
    });
    expect(repo.lastCommit).toMatchObject({ sha, message: 'Initial commit', ci: 'ok' });

    const avail = availableRepoListResponseSchema.parse(
      (await get(s, '/api/github/available')).json(),
    );
    expect(avail.repos).toEqual([
      { fullName: 'alex/blog', private: false, tracked: true },
      { fullName: 'alex/infra', private: true, tracked: false },
    ]);

    const dup = await s.t.app.inject({
      method: 'POST',
      url: '/api/github/repos',
      headers: s.headers,
      payload: { fullName: 'Alex/Blog' },
    });
    expect(dup.statusCode).toBe(409);
    const missing = await s.t.app.inject({
      method: 'POST',
      url: '/api/github/repos',
      headers: s.headers,
      payload: { fullName: 'alex/nope' },
    });
    expect(missing.statusCode).toBe(404);

    const list = repoListResponseSchema.parse((await get(s, '/api/github/repos')).json());
    expect(list.repos.map((r) => r.fullName)).toEqual(['alex/blog']);

    const del = await s.t.app.inject({
      method: 'DELETE',
      url: `/api/github/repos/${repo.id}`,
      headers: s.headers,
    });
    expect(del.statusCode).toBe(200);
    expect(repoListResponseSchema.parse((await get(s, '/api/github/repos')).json()).repos).toEqual(
      [],
    );
    const again = await s.t.app.inject({
      method: 'DELETE',
      url: `/api/github/repos/${repo.id}`,
      headers: s.headers,
    });
    expect(again.statusCode).toBe(404);
  });

  it('needs a token for available repos and adding (409)', async () => {
    const s = await setup({ token: false });
    expect((await get(s, '/api/github/available')).statusCode).toBe(409);
    const res = await s.t.app.inject({
      method: 'POST',
      url: '/api/github/repos',
      headers: s.headers,
      payload: { fullName: 'alex/blog' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('GitHub errors on available repos are 502 github_error with the reason in settings', async () => {
    const s = await setup();
    s.gh.down = true;
    const res = await get(s, '/api/github/available');
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ ok: false, error: 'github_error' });
    expect(s.t.app.hzCore.github.settings().error).toBe('GitHub nicht erreichbar');
  });

  it('lists commits of other branches live and 30 at most', async () => {
    const s = await setup();
    const { repo } = await blog(s);
    for (let i = 0; i < 35; i++) s.gh.push('alex/blog', `feature ${i}`, 'dev');
    const res = await get(s, `/api/github/repos/${repo.id}/commits?branch=dev`);
    expect(res.statusCode).toBe(200);
    const commits = commitListResponseSchema.parse(res.json()).commits;
    expect(commits).toHaveLength(30);
    expect(commits[0]).toMatchObject({ message: 'feature 34', ci: 'off', liveOn: [] });
    expect((await get(s, `/api/github/repos/${repo.id}/commits?branch=-rf`)).statusCode).toBe(400);
    expect((await get(s, '/api/github/repos/AAAAAAAAAAAA/commits')).statusCode).toBe(404);
  });

  it('polls with ETags: an unchanged repo costs no rate limit', async () => {
    const s = await setup();
    await blog(s);
    const remaining = s.gh.remaining;
    const before = s.gh.requests.length;
    await pollOnce(s);
    const round = s.gh.requests.slice(before);
    expect(round.length).toBeGreaterThanOrEqual(3);
    expect(round.every((r) => r.status === 304)).toBe(true);
    expect(round.every((r) => r.headers['if-none-match'] !== undefined)).toBe(true);
    expect(s.gh.remaining).toBe(remaining);
  });

  it('backs off while rate-limited and reports it in the settings', async () => {
    const s = await setup();
    await blog(s);
    s.gh.limited = true;
    s.gh.resetAt = Math.floor(s.t.clock.t / 1000) + 30 * 60;
    await pollOnce(s);
    const settings = s.t.app.hzCore.github.settings();
    expect(settings.error).toMatch(/^Rate-Limit bis \d\d:\d\d$/);
    expect(settings.rateRemaining).toBe(0);
    s.gh.limited = false;
    const n = s.gh.requests.length;
    await pollOnce(s);
    await pollOnce(s);
    expect(s.gh.requests.length).toBe(n);
    // After the reset, polling resumes.
    s.t.clock.advance(30 * 60_000);
    s.gh.remaining = 5000;
    await pollOnce(s);
    expect(s.gh.requests.length).toBeGreaterThan(n);
    expect(s.t.app.hzCore.github.settings().error).toBeNull();
  });

  it('publishes the topic github: snapshot and upserts after a poll', async () => {
    const s = await setup();
    const { repo } = await blog(s);
    const browser = await WsClient.connect(`${s.url}/live`, {
      cookie: `hz_session=${s.cookie}`,
      origin: s.url.replace('ws://', 'http://'),
    });
    clients.push(browser);
    browser.send({ type: 'subscribe', topics: ['github'] });
    const snap = await browser.next((m) => m.type === 'snapshot');
    expect((snap.data as { id: string }[]).map((r) => r.id)).toEqual([repo.id]);
    const sha = s.gh.push('alex/blog', 'Live update');
    await pollOnce(s);
    const upd = await browser.next((m) => m.type === 'update' && m.topic === 'github');
    expect((upd.upsert as { lastCommit: { sha: string } }[])[0]?.lastCommit.sha).toBe(sha);
  });
});

describe('deploy targets', () => {
  it('creates, updates and deletes targets with validation', async () => {
    const s = await setup();
    const { repo } = await blog(s);
    const tg = await addTarget(s, repo.id);
    expect(tg).toMatchObject({
      serverName: 'heimserver',
      path: '/opt/homelab/apps/blog',
      method: 'compose',
      autoDeploy: false,
      keyName: null,
      liveSha: null,
      behind: 0,
      deploying: false,
    });
    const post = (payload: Record<string, unknown>) =>
      s.t.app.inject({
        method: 'POST',
        url: `/api/github/repos/${repo.id}/targets`,
        headers: s.headers,
        payload: { serverId: s.serverId, branch: 'main', ...payload },
      });
    expect((await post({ path: '/opt/homelab/apps/blog' })).statusCode).toBe(409);
    expect((await post({ path: '/opt/homelab/apps/blog/sub' })).statusCode).toBe(409);
    expect((await post({ path: '/opt/homelab/apps' })).statusCode).toBe(409);
    expect((await post({ path: '/opt/homelab/apps/shop', serverId: 'nope0000' })).statusCode).toBe(
      400,
    );
    expect(
      (
        await s.t.app.inject({
          method: 'POST',
          url: '/api/github/repos/AAAAAAAAAAAA/targets',
          headers: s.headers,
          payload: { serverId: s.serverId, path: '/opt/homelab/apps/x', branch: 'main' },
        })
      ).statusCode,
    ).toBe(404);

    const put = await s.t.app.inject({
      method: 'PUT',
      url: `/api/github/targets/${tg.id}`,
      headers: s.headers,
      payload: {
        serverId: s.serverId,
        path: '/opt/homelab/apps/blog',
        branch: 'dev',
        method: 'script',
        autoDeploy: true,
      },
    });
    expect(put.statusCode).toBe(200);
    expect(deployTargetResponseSchema.parse(put.json()).target).toMatchObject({
      branch: 'dev',
      method: 'script',
      autoDeploy: true,
    });

    const del = await s.t.app.inject({
      method: 'DELETE',
      url: `/api/github/targets/${tg.id}`,
      headers: s.headers,
    });
    expect(del.statusCode).toBe(200);
    expect(s.t.app.hzCore.github.summary(repo.id)?.targets).toEqual([]);
  });

  it('creates a deploy key on the agent and keeps only the public key', async () => {
    const s = await setup();
    const { repo } = await blog(s, { private: true });
    const tg = await addTarget(s, repo.id);
    const res = await s.t.app.inject({
      method: 'POST',
      url: `/api/github/targets/${tg.id}/deploy-key`,
      headers: s.headers,
    });
    expect(res.statusCode).toBe(200);
    const updated = deployTargetResponseSchema.parse(res.json()).target;
    expect(updated).toMatchObject({ keyName: `deploy-${tg.id}`, publicKey: PUBLIC_KEY });
    expect(s.rpcs.find((r) => r.action === 'deploy.key')?.params).toEqual({
      name: `deploy-${tg.id}`,
    });

    await deployRequest(s, tg.id);
    await deployDone(s, tg.id);
    expect(s.rpcs.find((r) => r.action === 'deploy.run')?.params).toEqual({
      dir: '/opt/homelab/apps/blog',
      repoUrl: 'git@github.com:alex/blog.git',
      sha: repo.lastCommit?.sha,
      method: 'compose',
      keyName: `deploy-${tg.id}`,
    });
  });

  it('a private repo without deploy key fails fast with a hint', async () => {
    const s = await setup();
    const { repo } = await blog(s, { private: true });
    const tg = await addTarget(s, repo.id);
    const res = await deployRequest(s, tg.id);
    expect(res.statusCode).toBe(202);
    expect(deployResponseSchema.parse(res.json()).deploy).toMatchObject({
      status: 'failed',
      summary: 'Kein Deploy-Key: zuerst erzeugen und bei GitHub eintragen',
    });
    expect(s.rpcs.filter((r) => r.action === 'deploy.run')).toEqual([]);
  });

  it('changing the server forgets key and live sha', async () => {
    const s = await setup();
    const { repo } = await blog(s);
    const tg = await addTarget(s, repo.id);
    await s.t.app.inject({
      method: 'POST',
      url: `/api/github/targets/${tg.id}/deploy-key`,
      headers: s.headers,
    });
    await deployRequest(s, tg.id);
    await deployDone(s, tg.id);
    const other = await enrollAgent(s.t, s.url, s.cookie, 'pi');
    clients.push(other.agent);
    const res = await s.t.app.inject({
      method: 'PUT',
      url: `/api/github/targets/${tg.id}`,
      headers: s.headers,
      payload: { serverId: other.serverId, path: '/opt/homelab/apps/blog', branch: 'main' },
    });
    expect(deployTargetResponseSchema.parse(res.json()).target).toMatchObject({
      serverName: 'pi',
      keyName: null,
      publicKey: null,
      liveSha: null,
    });
  });
});

describe('deploys', () => {
  it('agent offline: the deploy fails fast with a crit alert', async () => {
    const s = await setup();
    const { repo } = await blog(s);
    const tg = await addTarget(s, repo.id);
    s.agent.ws.terminate();
    await until(() => !s.t.app.hzCore.hub.isConnected(s.serverId));
    const res = await deployRequest(s, tg.id);
    expect(res.statusCode).toBe(202);
    expect(deployResponseSchema.parse(res.json()).deploy).toMatchObject({
      status: 'failed',
      summary: 'Agent offline',
    });
    expect(target(s, repo.id, tg.id).deploying).toBe(false);
    expect(s.t.app.hzCore.alerts.active(`deploy:${tg.id}:failed`)?.body).toMatch(/^Agent offline/);
  });

  it('a failure raises crit, the next success resolves it with an OK entry', async () => {
    const s = await setup();
    const { repo, sha } = await blog(s);
    const tg = await addTarget(s, repo.id);
    s.behaviour.deploy = { kind: 'fail', code: 1, error: 'compose up: service web failed' };
    await deployRequest(s, tg.id);
    await deployDone(s, tg.id);
    const crit = s.t.app.hzCore.alerts.active(`deploy:${tg.id}:failed`);
    expect(crit?.body).toMatch(/^compose up: service web failed \(Exit 1\)/);
    expect(target(s, repo.id, tg.id).liveSha).toBeNull();
    s.behaviour.deploy = { kind: 'ok' };
    await deployRequest(s, tg.id);
    await deployDone(s, tg.id);
    expect(s.t.app.hzCore.alerts.active(`deploy:${tg.id}:failed`)).toBeNull();
    const ok = s.t.app.hzCore.alerts.list({ state: 'all', limit: 1, level: 'ok' })[0];
    expect(ok?.title).toBe(`alex/blog auf heimserver deployt (${sha.slice(0, 7)})`);
    const actions = s.t.db.db
      .select()
      .from(auditLog)
      .all()
      .map((a) => a.action);
    expect(actions.filter((a) => a === 'deploy.started')).toHaveLength(2);
    expect(actions.filter((a) => a === 'deploy.finished')).toHaveLength(2);
  });

  it('lists deploys and shows one with its log', async () => {
    const s = await setup();
    const { repo } = await blog(s);
    const tg = await addTarget(s, repo.id);
    const res = await deployRequest(s, tg.id);
    const id = deployResponseSchema.parse(res.json()).deploy.id;
    await deployDone(s, tg.id);
    const list = deployListResponseSchema.parse(
      (await get(s, `/api/github/deploys?targetId=${tg.id}&limit=5`)).json(),
    );
    expect(list.deploys.map((d) => d.id)).toEqual([id]);
    expect((await get(s, '/api/github/deploys?targetId=AAAAAAAAAAAA')).statusCode).toBe(404);
    expect((await get(s, '/api/github/deploys?limit=0')).statusCode).toBe(400);
    const detail = await get(s, `/api/github/deploys/${id}`);
    expect(detail.json<{ log: string }>().log).toContain('docker compose up -d --build');
    expect((await get(s, '/api/github/deploys/AAAAAAAAAAAA')).statusCode).toBe(404);
  });

  it('keeps only the last 256 KB of the log', async () => {
    const s = await setup();
    const { repo } = await blog(s);
    const tg = await addTarget(s, repo.id);
    const line = `${'y'.repeat(1023)}\n`;
    s.behaviour.deploy = { kind: 'ok', lines: [...Array(40)].map(() => line.repeat(10)) };
    const res = await deployRequest(s, tg.id);
    const id = deployResponseSchema.parse(res.json()).deploy.id;
    await deployDone(s, tg.id);
    const row = s.t.db.db.select().from(deploys).all().find((d) => d.id === id);
    expect(Buffer.byteLength(row?.logText ?? '')).toBeLessThanOrEqual(DEPLOY_LOG_MAX_BYTES);
    expect(row?.logText.length).toBeGreaterThan(200 * 1024);
    expect(row?.logText.endsWith('Deploy erfolgreich (' + row.sha.slice(0, 7) + ')\n')).toBe(true);
  });

  it('cancels a deploy after 20 minutes', async () => {
    const s = await setup();
    const { repo } = await blog(s);
    const tg = await addTarget(s, repo.id);
    s.behaviour.deploy = { kind: 'manual' };
    const res = await deployRequest(s, tg.id);
    const id = deployResponseSchema.parse(res.json()).deploy.id;
    await until(() => s.rpcs.some((r) => r.action === 'deploy.run'));
    // Move the core clock without waiting for the (still running) deploy.
    const step = async (ms: number): Promise<void> => {
      s.t.clock.advance(ms);
      await s.keepAlive();
      await s.t.app.hzCore.scheduler.tick();
    };
    for (let i = 0; i < 19; i++) await step(60_000);
    expect(s.t.app.hzCore.github.deployer.row(id)?.status).toBe('running');
    await step(60_000);
    await deployDone(s, tg.id);
    expect(s.t.app.hzCore.github.deployer.row(id)).toMatchObject({
      status: 'failed',
      summary: 'Zeitüberschreitung nach 20 Min',
    });
    await until(() =>
      s.agent.received.some((m) => m.type === 'stream.cancel'),
    );
  });

  it('agent disconnect during a deploy: failed, lock released', async () => {
    const s = await setup();
    const { repo } = await blog(s);
    const tg = await addTarget(s, repo.id);
    s.behaviour.deploy = { kind: 'manual' };
    const res = await deployRequest(s, tg.id);
    const id = deployResponseSchema.parse(res.json()).deploy.id;
    await until(() => s.rpcs.some((r) => r.action === 'deploy.run'));
    s.agent.ws.terminate();
    await deployDone(s, tg.id);
    expect(s.t.app.hzCore.github.deployer.row(id)).toMatchObject({
      status: 'failed',
      summary: 'Verbindung zum Agent verloren',
    });
  });

  it('marks running deploys failed after a core restart', async () => {
    const file = join(emptyDir(), 'hz.sqlite');
    const s = await withGithub(clients, { token: true });
    // Replace the in-memory app by one with a file database.
    await s.t.app.close();
    const first = await makeApp({ db: openDatabase(file), githubFetch: s.gh.fetch });
    extra.push(first);
    const now = first.clock.t;
    first.db.sqlite.exec(`
      INSERT INTO servers (id, name, location, thresholds_json, allow_terminal, created_at)
        VALUES ('srv00001', 'heimserver', 'Wien', '{}', 0, ${now});
      INSERT INTO github_repos (id, full_name, private, default_branch, ci_status, created_at)
        VALUES ('repo0001', 'alex/blog', 0, 'main', 'ok', ${now});
      INSERT INTO deploy_targets (id, repo_id, server_id, path, branch, method, auto_deploy, created_at, updated_at)
        VALUES ('tgt00001', 'repo0001', 'srv00001', '/opt/homelab/apps/blog', 'main', 'compose', 0, ${now}, ${now});
      INSERT INTO deploys (id, target_id, sha, status, triggered_by, started_at)
        VALUES ('dep00001', 'tgt00001', '${'a'.repeat(40)}', 'running', 'manual', ${now});
    `);
    await first.app.close();
    extra.splice(0);
    const second = await makeApp({ db: openDatabase(file), githubFetch: s.gh.fetch });
    extra.push(second);
    expect(second.app.hzCore.github.deployer.row('dep00001')).toMatchObject({
      status: 'failed',
      summary: 'Zentrale neu gestartet',
    });
    expect(second.app.hzCore.alerts.active('deploy:tgt00001:failed')?.level).toBe('crit');
    expect(second.app.hzCore.github.deployer.isBusy('tgt00001')).toBe(false);
  });

  it('counts deploys of the week in the weekly report', async () => {
    const s = await setup();
    const { repo } = await blog(s);
    const tg = await addTarget(s, repo.id);
    await deployRequest(s, tg.id);
    await deployDone(s, tg.id);
    expect(s.t.app.hzCore.github.deployStats(7 * 24 * 3600_000)).toEqual({ ok: 1, failed: 0 });
    const base = { openAlerts: 0, checks: [], serversOffline: 0, serversTotal: 1 };
    expect(weeklyReportText({ ...base, deploys: { ok: 3, failed: 1 } }).body).toContain(
      '4 Deploys (1 fehlgeschlagen).',
    );
    expect(weeklyReportText({ ...base, deploys: { ok: 0, failed: 0 } }).body).toContain(
      'Keine Deploys.',
    );
    expect(weeklyReportText({ ...base, deploys: null }).body).not.toContain('Deploy');

    const core = s.t.app.hzCore;
    s.t.clock.t = core.scheduler.nextRunOf('report.weekly') ?? 0;
    await s.keepAlive();
    await core.scheduler.tick();
    const report = core.alerts.list({ state: 'all', limit: 5, source: 'system' })[0];
    expect(report?.body).toContain('1 Deploy.');
  });
});
