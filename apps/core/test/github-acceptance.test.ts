import { afterEach, describe, expect, it } from 'vitest';
import { commitListResponseSchema, deployResponseSchema, deploySchema } from '@hz/shared';
import { WsClient, until } from './agent-helpers.js';
import {
  addRepo,
  addTarget,
  deployDone,
  deployRequest,
  pollOnce,
  target,
  withGithub,
  type GithubSetup,
} from './github-helpers.js';
import type { TestApp } from './helpers.js';
import { deploys, githubEtags } from '../src/db/schema.js';
import { DEPLOY_LOGS_KEPT } from '../src/github/service.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

/** Repo admin/blog with one green commit, tracked, with a compose target on the agent. */
async function blogSetup(over: Record<string, unknown> = {}) {
  const s = await withGithub(clients, { token: true });
  t = s.t;
  s.gh.addRepo('admin/blog');
  const first = s.gh.push('admin/blog', 'Initial commit');
  s.gh.ci(first, 'success');
  const repo = await addRepo(s, 'admin/blog');
  const tg = await addTarget(s, repo.id, over);
  return { s, repo, tg, first };
}

async function deployAndWait(s: GithubSetup, targetId: string, payload = {}) {
  const res = await deployRequest(s, targetId, payload);
  expect(res.statusCode).toBe(202);
  const { deploy } = deployResponseSchema.parse(res.json());
  await deployDone(s, targetId);
  return deploy;
}

describe('M5 acceptance', () => {
  it('deploys via button, streams the log live and marks the commit LIVE', async () => {
    const { s, repo, tg, first } = await blogSetup();
    s.behaviour.deploy = { kind: 'manual' };
    const browser = await WsClient.connect(`${s.url}/live`, {
      cookie: `hz_session=${s.cookie}`,
      origin: s.url.replace('ws://', 'http://'),
    });
    clients.push(browser);

    const res = await deployRequest(s, tg.id);
    expect(res.statusCode).toBe(202);
    const { deploy } = deployResponseSchema.parse(res.json());
    expect(deploy).toMatchObject({ sha: first, status: 'running', trigger: 'manual' });
    expect(target(s, repo.id, tg.id).deploying).toBe(true);

    await until(() => s.rpcs.some((r) => r.action === 'deploy.run'));
    const rpc = s.rpcs.find((r) => r.action === 'deploy.run');
    expect(rpc?.params).toEqual({
      dir: '/opt/homelab/apps/blog',
      repoUrl: 'https://github.com/admin/blog.git',
      sha: first,
      method: 'compose',
    });

    browser.send({ type: 'subscribe', topics: [`deploy:${deploy.id}`] });
    const snap = await browser.next((m) => m.type === 'snapshot');
    expect(snap.topic).toBe(`deploy:${deploy.id}`);

    const streamId = rpc?.id as string;
    s.agent.send({ type: 'stream.data', streamId, channel: 'stdout', chunk: 'Cloning into…\n' });
    s.agent.send({
      type: 'stream.data',
      streamId,
      channel: 'stderr',
      chunk: ' Container blog Started\n',
    });
    const upd = await browser.next(
      (m) =>
        m.type === 'update' && JSON.stringify(m.upsert ?? []).includes('Container blog Started'),
    );
    expect(upd.topic).toBe(`deploy:${deploy.id}`);

    s.agent.send({ type: 'stream.end', streamId, code: 0 });
    await deployDone(s, tg.id);

    const after = target(s, repo.id, tg.id);
    expect(after).toMatchObject({ liveSha: first, behind: 0, deploying: false });
    const detail = await s.t.app.inject({
      url: `/api/github/deploys/${deploy.id}`,
      headers: s.headers,
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json<{ deploy: unknown; log: string }>();
    expect(deploySchema.parse(body.deploy)).toMatchObject({
      status: 'ok',
      summary: 'Erfolgreich deployt',
    });
    expect(body.log).toContain('Cloning into');
    expect(body.log).toContain('Container blog Started');

    const commits = commitListResponseSchema.parse(
      (
        await s.t.app.inject({ url: `/api/github/repos/${repo.id}/commits`, headers: s.headers })
      ).json(),
    ).commits;
    expect(commits[0]).toMatchObject({ sha: first, liveOn: [tg.id], deployedBefore: [] });

    const alert = s.t.app.hzCore.alerts.list({ state: 'all', limit: 5, source: 'github' })[0];
    expect(alert).toMatchObject({
      level: 'info',
      title: `admin/blog auf heimserver deployt (${first.slice(0, 7)})`,
    });
  });

  it('shows a new commit as behind=1 within one poll (60 s)', async () => {
    const { s, repo, tg } = await blogSetup();
    await deployAndWait(s, tg.id);
    expect(target(s, repo.id, tg.id).behind).toBe(0);

    const second = s.gh.push('admin/blog', 'Fix typo');
    await pollOnce(s);
    const after = s.t.app.hzCore.github.summary(repo.id);
    expect(after?.targets[0]?.behind).toBe(1);
    expect(after?.lastCommit?.sha).toBe(second);
    expect(after?.lastCommit?.message).toBe('Fix typo');
    expect(after?.ci).toBe('off');
  });

  it('rollback restores the previous commit', async () => {
    const { s, repo, tg, first } = await blogSetup();
    await deployAndWait(s, tg.id);
    const second = s.gh.push('admin/blog', 'Break everything');
    s.gh.ci(second, 'success');
    await pollOnce(s);
    await deployAndWait(s, tg.id);
    expect(target(s, repo.id, tg.id).liveSha).toBe(second);

    const commits = commitListResponseSchema.parse(
      (
        await s.t.app.inject({ url: `/api/github/repos/${repo.id}/commits`, headers: s.headers })
      ).json(),
    ).commits;
    expect(commits.find((c) => c.sha === first)?.deployedBefore).toEqual([tg.id]);
    expect(commits.find((c) => c.sha === second)?.liveOn).toEqual([tg.id]);

    // Even with red CI on the old commit, a rollback is allowed.
    s.gh.ci(first, 'failure');
    const rb = await deployAndWait(s, tg.id, { sha: first, rollback: true });
    expect(rb.trigger).toBe('rollback');
    const last = s.rpcs.filter((r) => r.action === 'deploy.run').at(-1);
    expect((last?.params as { sha: string }).sha).toBe(first);
    expect(target(s, repo.id, tg.id)).toMatchObject({ liveSha: first, behind: 1 });
  });

  it('red CI: 409 ci_not_green and no deploy is started', async () => {
    const { s, repo, tg } = await blogSetup();
    const red = s.gh.push('admin/blog', 'Tests fail');
    s.gh.ci(red, 'failure');
    await pollOnce(s);
    expect(s.t.app.hzCore.github.summary(repo.id)?.ci).toBe('crit');

    const res = await deployRequest(s, tg.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ ok: false, error: 'ci_not_green' });
    await new Promise((r) => setTimeout(r, 30));
    expect(s.rpcs.filter((r) => r.action === 'deploy.run')).toEqual([]);
    expect(s.t.app.hzCore.github.deployList({ limit: 10 })).toEqual([]);
    expect(target(s, repo.id, tg.id).deploying).toBe(false);
  });

  it('CI off (no workflow runs) may be deployed by hand, busy may not; auto-deploy only on ok', async () => {
    const { s, repo, tg } = await blogSetup();
    const running = s.gh.push('admin/blog', 'Still testing');
    s.gh.ci(running, 'in_progress');
    await pollOnce(s);
    expect(s.t.app.hzCore.github.summary(repo.id)?.ci).toBe('busy');
    const busy = await deployRequest(s, tg.id);
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toEqual({ ok: false, error: 'ci_not_green' });

    const noCi = s.gh.push('admin/blog', 'Docs only, no workflow');
    await pollOnce(s);
    expect(s.t.app.hzCore.github.summary(repo.id)?.ci).toBe('off');
    const d = await deployAndWait(s, tg.id);
    expect(d).toMatchObject({ sha: noCi, trigger: 'manual' });
    expect(target(s, repo.id, tg.id).liveSha).toBe(noCi);

    // Auto-deploy ignores a head without CI.
    const put = await s.t.app.inject({
      method: 'PUT',
      url: `/api/github/targets/${tg.id}`,
      headers: s.headers,
      payload: {
        serverId: s.serverId,
        path: '/opt/homelab/apps/blog',
        branch: 'main',
        autoDeploy: true,
      },
    });
    expect(put.statusCode).toBe(200);
    s.gh.push('admin/blog', 'Another commit without CI');
    await pollOnce(s);
    await pollOnce(s);
    expect(s.t.app.hzCore.github.deployList({ limit: 10 })).toHaveLength(1);
    expect(target(s, repo.id, tg.id).behind).toBe(1);
  });

  it('auto-deploys a new head once its CI is green, once per sha', async () => {
    const { s, repo, tg } = await blogSetup({ autoDeploy: true });
    // The first poll after creating the target deploys the green head.
    await pollOnce(s);
    const firstDeploys = s.t.app.hzCore.github.deployList({ limit: 10 });
    expect(firstDeploys).toHaveLength(1);
    expect(firstDeploys[0]).toMatchObject({ trigger: 'auto', status: 'ok' });

    const next = s.gh.push('admin/blog', 'New feature');
    s.gh.ci(next, 'in_progress');
    await pollOnce(s);
    expect(s.t.app.hzCore.github.deployList({ limit: 10 })).toHaveLength(1);
    expect(target(s, repo.id, tg.id).behind).toBe(1);

    s.gh.ci(next, 'success');
    await pollOnce(s);
    const list = s.t.app.hzCore.github.deployList({ limit: 10 });
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ sha: next, trigger: 'auto', status: 'ok' });
    expect(target(s, repo.id, tg.id)).toMatchObject({ liveSha: next, behind: 0 });

    // A failed auto-deploy is not retried for the same sha.
    const third = s.gh.push('admin/blog', 'Broken compose');
    s.gh.ci(third, 'success');
    s.behaviour.deploy = { kind: 'fail', code: 1 };
    await pollOnce(s);
    await pollOnce(s);
    await pollOnce(s);
    const all = s.t.app.hzCore.github.deployList({ limit: 10 });
    expect(all.filter((d) => d.sha === third)).toHaveLength(1);
    expect(all[0]).toMatchObject({
      status: 'failed',
      summary: 'compose up fehlgeschlagen (Exit 1)',
    });
    const crit = s.t.app.hzCore.alerts.active(`deploy:${tg.id}:failed`);
    expect(crit).toMatchObject({
      level: 'crit',
      title: 'Deploy von admin/blog auf heimserver fehlgeschlagen',
    });
    expect(target(s, repo.id, tg.id).liveSha).toBe(next);
  });
});

describe('M5 retention', () => {
  it('keeps the log of the newest deploys per target and drops stale ETags', async () => {
    const { s, tg } = await blogSetup();
    for (let i = 0; i < DEPLOY_LOGS_KEPT + 2; i++) {
      await deployAndWait(s, tg.id);
      s.t.clock.advance(1000);
    }
    const db = s.t.db.db;
    db.insert(githubEtags)
      .values({ url: '/old', etag: '"x"', dataJson: '{}', updatedAt: s.t.clock.t - 8 * 86_400_000 })
      .run();
    const r = s.t.app.hzCore.github.prune();
    expect(r.logs).toBe(2);
    expect(r.etags).toBeGreaterThanOrEqual(1);
    const rows = db.select().from(deploys).all();
    expect(rows).toHaveLength(DEPLOY_LOGS_KEPT + 2);
    expect(rows.filter((d) => d.logText !== '')).toHaveLength(DEPLOY_LOGS_KEPT);
    expect(
      db
        .select()
        .from(githubEtags)
        .all()
        .some((e) => e.url === '/old'),
    ).toBe(false);
  });
});
