import { afterEach, describe, expect, it } from 'vitest';
import { deployResponseSchema } from '@hz/shared';
import { PUBLIC_API_ROUTES } from '../src/auth/guard.js';
import { auditLog, settings } from '../src/db/schema.js';
import { stepUp, until, WsClient } from './agent-helpers.js';
import {
  addRepo,
  addTarget,
  deployDone,
  deployRequest,
  OTHER_TOKEN,
  pollOnce,
  setToken,
  target,
  TOKEN,
  withGithub,
  type GithubSetup,
} from './github-helpers.js';
import { HOST, type TestApp } from './helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

const ROUTES = [
  ['GET', '/api/github/settings'],
  ['PUT', '/api/github/token'],
  ['DELETE', '/api/github/token'],
  ['GET', '/api/github/repos'],
  ['GET', '/api/github/available'],
  ['POST', '/api/github/repos'],
  ['DELETE', '/api/github/repos/:id'],
  ['GET', '/api/github/repos/:id/commits'],
  ['POST', '/api/github/repos/:id/targets'],
  ['PUT', '/api/github/targets/:id'],
  ['DELETE', '/api/github/targets/:id'],
  ['POST', '/api/github/targets/:id/deploy-key'],
  ['POST', '/api/github/targets/:id/deploy'],
  ['GET', '/api/github/deploys'],
  ['GET', '/api/github/deploys/:id'],
] as const;

const MUTATING = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

async function ready(opts: { captureLogs?: boolean; private?: boolean } = {}) {
  const s = await withGithub(clients, { token: true, ...opts });
  t = s.t;
  s.gh.addRepo('admin/blog', { private: opts.private ?? false });
  const sha = s.gh.push('admin/blog', 'Initial commit');
  s.gh.ci(sha, 'success');
  const repo = await addRepo(s, 'admin/blog');
  const tg = await addTarget(s, repo.id);
  return { s, repo, tg, sha };
}

function payloadFor(url: string, s: GithubSetup): Record<string, unknown> {
  if (url.endsWith('/token')) return { token: OTHER_TOKEN };
  if (url === '/api/github/repos') return { fullName: 'admin/other' };
  if (url.includes('/targets') && !url.includes('/deploy'))
    return { serverId: s.serverId, path: '/opt/homelab/apps/x', branch: 'main' };
  return {};
}

describe('github routes: auth', () => {
  it('are registered and not public', async () => {
    const s = await withGithub(clients);
    t = s.t;
    const routes = s.t.app.hzRoutes.map((r) => `${r.method} ${r.url}`);
    for (const [method, url] of ROUTES) {
      expect(routes).toContain(`${method} ${url}`);
      expect(PUBLIC_API_ROUTES).not.toContain(url);
    }
  });

  it('401 without a session or with a forged cookie; nothing reaches GitHub or the agent', async () => {
    const { s, repo, tg } = await ready();
    const ghBefore = s.gh.requests.length;
    const rpcBefore = s.rpcs.length;
    for (const cookie of [undefined, `hz_session=${'A'.repeat(43)}`]) {
      const headers = { host: HOST, origin: `https://${HOST}`, ...(cookie ? { cookie } : {}) };
      for (const [method, url] of ROUTES) {
        const u = url.replace(':id', url.includes('/repos/') ? repo.id : tg.id);
        const res = await s.t.app.inject({
          method,
          url: u,
          headers,
          ...(MUTATING.has(method) ? { payload: payloadFor(url, s) } : {}),
        });
        expect(res.statusCode, `${method} ${url}`).toBe(401);
        expect(res.json()).toEqual({ ok: false, error: 'unauthorized' });
      }
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(s.gh.requests.length).toBe(ghBefore);
    expect(s.rpcs.length).toBe(rpcBefore);
    expect(s.t.app.hzCore.github.deployList({ limit: 10 })).toEqual([]);
  });

  it('403 bad_origin for every changing route from a foreign or missing Origin', async () => {
    const { s, repo, tg } = await ready();
    await stepUp(s.t, s.secret, s.cookie);
    const cookie = `hz_session=${s.cookie}`;
    for (const [method, url] of ROUTES.filter(([m]) => MUTATING.has(m))) {
      const u = url.replace(':id', url.includes('/repos/') ? repo.id : tg.id);
      for (const headers of [
        { host: HOST, cookie, origin: 'https://evil.example' },
        { host: HOST, cookie, origin: 'null' },
        { host: HOST, cookie },
      ]) {
        const res = await s.t.app.inject({
          method,
          url: u,
          headers,
          payload: payloadFor(url, s),
        });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.json()).toEqual({ ok: false, error: 'bad_origin' });
      }
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(s.rpcs.filter((r) => String(r.action).startsWith('deploy'))).toEqual([]);
    expect(s.t.app.hzCore.github.summary(repo.id)?.targets).toHaveLength(1);
    expect(s.t.app.hzCore.github.settings().tokenSet).toBe(true);
  });

  it('setting and deleting the token need step-up', async () => {
    const s = await withGithub(clients);
    t = s.t;
    for (const [method, payload] of [
      ['PUT', { token: TOKEN }],
      ['DELETE', undefined],
    ] as const) {
      const res = await s.t.app.inject({
        method,
        url: '/api/github/token',
        headers: s.headers,
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ ok: false, error: 'step_up_required' });
    }
    expect(s.t.app.hzCore.github.settings().tokenSet).toBe(false);
    expect(s.gh.requests).toEqual([]);
    // Step-up expires after 15 minutes.
    await stepUp(s.t, s.secret, s.cookie);
    s.t.clock.advance(15 * 60_000 + 1);
    const late = await s.t.app.inject({
      method: 'PUT',
      url: '/api/github/token',
      headers: s.headers,
      payload: { token: TOKEN },
    });
    expect(late.statusCode).toBe(403);
  });
});

describe('github token never leaks', () => {
  it('not in responses, logs, audit, alerts, settings, live data, agent RPCs or errors', async () => {
    const { s, repo, tg } = await ready({ captureLogs: true });
    const bodies: string[] = [];
    const call = async (
      method: 'GET' | 'POST' | 'PUT' | 'DELETE',
      url: string,
      payload?: object,
    ) => {
      const res = await s.t.app.inject({
        method,
        url,
        headers: s.headers,
        ...(payload ? { payload } : {}),
      });
      bodies.push(res.body, JSON.stringify(res.headers));
      return res;
    };
    // Change the token once more (to the other one) and back.
    await setToken(s, OTHER_TOKEN);
    await setToken(s, TOKEN);
    await call('GET', '/api/github/settings');
    await call('GET', '/api/github/repos');
    await call('GET', '/api/github/available');
    await call('GET', `/api/github/repos/${repo.id}/commits`);
    await call('POST', `/api/github/targets/${tg.id}/deploy-key`);
    const d = await call('POST', `/api/github/targets/${tg.id}/deploy`);
    await deployDone(s, tg.id);
    const id = deployResponseSchema.parse(d.json()).deploy.id;
    await call('GET', `/api/github/deploys/${id}`);
    await call('GET', '/api/github/deploys');
    // Failures: network down, invalid token, 500.
    s.gh.down = true;
    await call('GET', '/api/github/available');
    await pollOnce(s);
    s.gh.down = false;
    s.gh.tokens.delete(TOKEN);
    await pollOnce(s);
    await call('GET', '/api/github/available');
    await call('GET', '/api/github/settings');
    await call('POST', '/api/github/repos', { fullName: 'admin/blog2' });
    await stepUp(s.t, s.secret, s.cookie);
    await call('PUT', '/api/github/token', { token: TOKEN });

    const haystacks = [
      ...bodies,
      ...s.t.logs,
      JSON.stringify(s.t.db.db.select().from(auditLog).all()),
      JSON.stringify(s.t.db.db.select().from(settings).all()),
      JSON.stringify(s.t.app.hzCore.alerts.list({ state: 'all', limit: 500 })),
      JSON.stringify(s.t.app.hzCore.github.list()),
      JSON.stringify(s.agent.received),
      JSON.stringify(s.rpcs),
    ];
    for (const secret of [TOKEN, OTHER_TOKEN, TOKEN.slice(11, 40)]) {
      for (const h of haystacks) expect(h).not.toContain(secret);
    }
    // It went to GitHub as Bearer header, and only there.
    expect(s.gh.requests.some((r) => r.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
    for (const r of s.gh.requests) expect(r.url.startsWith('https://api.github.com/')).toBe(true);
    expect(s.t.app.hzCore.github.settings().error).toBe('Token ungültig oder abgelaufen');
    // The stored value is ciphertext.
    const stored = s.t.db.db
      .select()
      .from(settings)
      .all()
      .find((x) => x.key === 'github.token');
    expect(stored?.valueJson).toMatch(/^"v1:/);
  });
});

describe('github input validation', () => {
  it('rejects invalid repo names, branches, paths, shas and ids', async () => {
    const { s, repo, tg } = await ready();
    const ghBefore = s.gh.requests.length;
    for (const fullName of [
      '../etc',
      'admin/../passwd',
      'admin/..',
      '-rf/blog',
      'admin/blog.git',
      'admin/.git',
      'admin',
      'admin/blog/extra',
      'admin/bl og',
      'admin/blog?x=1',
      'admin/blog%2F..',
      'admin/.hidden',
      'admin/-rf',
      'a'.repeat(40) + '/x',
      '',
    ]) {
      const res = await s.t.app.inject({
        method: 'POST',
        url: '/api/github/repos',
        headers: s.headers,
        payload: { fullName },
      });
      expect(res.statusCode, fullName).toBe(400);
    }
    expect(s.gh.requests.length).toBe(ghBefore);

    const tryTarget = (over: Record<string, unknown>) =>
      s.t.app.inject({
        method: 'POST',
        url: `/api/github/repos/${repo.id}/targets`,
        headers: s.headers,
        payload: { serverId: s.serverId, path: '/opt/homelab/apps/new', branch: 'main', ...over },
      });
    for (const branch of [
      '-rf',
      '--upload-pack=x',
      '../main',
      'main..dev',
      '.git',
      'a//b',
      'main/',
      'main.lock',
      'ma in',
      'main;rm -rf /',
      '',
    ]) {
      expect((await tryTarget({ branch })).statusCode, branch).toBe(400);
    }
    for (const path of [
      '/opt/homelab/../etc',
      '/opt/homelab/apps/../../etc',
      '/opt/homelab/',
      '/opt/homelab',
      '/etc/passwd',
      'opt/homelab/apps/x',
      '/opt/homelab/apps/./x',
      '/opt/homelab//apps',
      '/opt/homelab/apps/x\0y',
      '/opt/homelab/apps/x/.git',
      '/opt/homelab/apps/.git/hooks',
    ]) {
      expect((await tryTarget({ path })).statusCode, path).toBe(400);
    }
    expect((await tryTarget({ method: 'shell' })).statusCode).toBe(400);
    expect((await tryTarget({ extra: 1 })).statusCode).toBe(400);

    for (const sha of ['HEAD', '-rf', 'abc123', 'A'.repeat(40), `${'a'.repeat(40)} `, '--help']) {
      const res = await deployRequest(s, tg.id, { sha });
      expect(res.statusCode, sha).toBe(400);
    }
    expect((await deployRequest(s, tg.id, { cmd: 'ls' })).statusCode).toBe(400);
    for (const id of ['short', '../etc/passwd', 'a'.repeat(65), 'x;rm']) {
      const res = await s.t.app.inject({
        method: 'POST',
        url: `/api/github/targets/${encodeURIComponent(id)}/deploy`,
        headers: s.headers,
        payload: {},
      });
      expect([400, 404], id).toContain(res.statusCode);
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(s.rpcs.filter((r) => r.action === 'deploy.run')).toEqual([]);
  });

  it('refuses to deploy a sha that is not on the target branch', async () => {
    const { s, tg } = await ready();
    const foreign = s.gh.push('admin/blog', 'On another branch', 'evil');
    s.gh.ci(foreign, 'success', { branch: 'evil' });
    const res = await deployRequest(s, tg.id, { sha: foreign });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ ok: false, error: 'conflict' });
    expect(s.rpcs.filter((r) => r.action === 'deploy.run')).toEqual([]);
  });

  it('rollback only to a sha that was deployed successfully on this target', async () => {
    const { s, repo, tg, sha } = await ready();
    // Never deployed: refused.
    let res = await deployRequest(s, tg.id, { sha, rollback: true });
    expect(res.statusCode).toBe(409);
    // A failed deploy does not count.
    s.behaviour.deploy = { kind: 'fail', code: 1 };
    await deployRequest(s, tg.id);
    await deployDone(s, tg.id);
    res = await deployRequest(s, tg.id, { sha, rollback: true });
    expect(res.statusCode).toBe(409);
    // A successful deploy on another target of the same repo does not count either.
    s.behaviour.deploy = { kind: 'ok' };
    const other = await addTarget(s, repo.id, { path: '/opt/homelab/apps/blog2' });
    await deployRequest(s, other.id);
    await deployDone(s, other.id);
    res = await deployRequest(s, tg.id, { sha, rollback: true });
    expect(res.statusCode).toBe(409);
    // An arbitrary sha.
    res = await deployRequest(s, tg.id, { sha: 'f'.repeat(40), rollback: true });
    expect(res.statusCode).toBe(409);
    // Rollback without sha.
    res = await deployRequest(s, tg.id, { rollback: true });
    expect(res.statusCode).toBe(400);
    const runs = s.rpcs.filter((r) => r.action === 'deploy.run');
    expect(runs).toHaveLength(2);
    expect(target(s, repo.id, tg.id).liveSha).toBeNull();
    const refused = s.t.db.db
      .select()
      .from(auditLog)
      .all()
      .filter((a) => a.action === 'deploy.refused');
    expect(refused.length).toBeGreaterThanOrEqual(4);
  });

  it('accepts only an ed25519 public key from the agent', async () => {
    const { s, repo, tg } = await ready();
    for (const key of [
      { publicKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n' },
      { publicKey: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ' },
      { publicKey: 'ssh-ed25519 AAAA\nrm -rf /' },
      {
        publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGx0ZXN0a2V5 homelab-zentrale x',
        extra: 1,
      },
      { nothing: true },
      'ssh-ed25519 AAAA',
    ]) {
      s.behaviour.key = key;
      const res = await s.t.app.inject({
        method: 'POST',
        url: `/api/github/targets/${tg.id}/deploy-key`,
        headers: s.headers,
      });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ ok: false, error: 'agent_error' });
    }
    expect(target(s, repo.id, tg.id)).toMatchObject({ keyName: null, publicKey: null });
  });
});

describe('deploy lock', () => {
  it('only one deploy per target at a time; target changes wait', async () => {
    const { s, repo, tg } = await ready();
    s.behaviour.deploy = { kind: 'manual' };
    const [a, b, c] = await Promise.all([
      deployRequest(s, tg.id),
      deployRequest(s, tg.id),
      deployRequest(s, tg.id),
    ]);
    const codes = [a, b, c].map((r) => r.statusCode).sort();
    expect(codes).toEqual([202, 409, 409]);
    for (const r of [a, b, c].filter((x) => x.statusCode === 409)) {
      expect(r.json()).toEqual({ ok: false, error: 'busy' });
    }
    await until(() => s.rpcs.some((r) => r.action === 'deploy.run'));
    await new Promise((r) => setTimeout(r, 30));
    expect(s.rpcs.filter((r) => r.action === 'deploy.run')).toHaveLength(1);
    expect(target(s, repo.id, tg.id).deploying).toBe(true);

    for (const [method, url] of [
      ['PUT', `/api/github/targets/${tg.id}`],
      ['DELETE', `/api/github/targets/${tg.id}`],
      ['DELETE', `/api/github/repos/${repo.id}`],
    ] as const) {
      const res = await s.t.app.inject({
        method,
        url,
        headers: s.headers,
        ...(method === 'PUT'
          ? { payload: { serverId: s.serverId, path: '/opt/homelab/apps/x', branch: 'main' } }
          : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(409);
    }
    // Auto-deploy also respects the lock.
    const run = s.rpcs.find((r) => r.action === 'deploy.run');
    s.agent.send({ type: 'stream.end', streamId: run?.id, code: 0 });
    await deployDone(s, tg.id);
    expect(target(s, repo.id, tg.id).deploying).toBe(false);
    s.behaviour.deploy = { kind: 'ok' };
    const again = await deployRequest(s, tg.id);
    expect(again.statusCode).toBe(202);
    await deployDone(s, tg.id);
  });
});

describe('deploy log isolation', () => {
  it('agent log chunks go only to deploy:<id> as plain text', async () => {
    const { s, tg } = await ready();
    s.behaviour.deploy = { kind: 'manual' };
    const browser = await WsClient.connect(`${s.url}/live`, {
      cookie: `hz_session=${s.cookie}`,
      origin: s.url.replace('ws://', 'http://'),
    });
    clients.push(browser);
    browser.send({ type: 'subscribe', topics: ['alerts', 'github', 'servers'] });
    for (let i = 0; i < 3; i++) await browser.next((m) => m.type === 'snapshot');

    const res = await deployRequest(s, tg.id);
    const id = deployResponseSchema.parse(res.json()).deploy.id;
    await until(() => s.rpcs.some((r) => r.action === 'deploy.run'));
    const streamId = s.rpcs.find((r) => r.action === 'deploy.run')?.id as string;
    browser.send({ type: 'subscribe', topics: [`deploy:${id}`] });
    await browser.next((m) => m.type === 'snapshot' && m.topic === `deploy:${id}`);
    const seenBefore = browser.received.length;

    const evil = [
      '{"type":"snapshot","topic":"alerts","data":[{"id":"x"}]}\n',
      '"}],"topic":"github"}\n',
      '\u001b]0;title\u0007<script>alert(1)</script>\n',
    ];
    for (const chunk of evil) s.agent.send({ type: 'stream.data', streamId, chunk });
    // Data for another (unknown) stream and an invalid frame are dropped.
    s.agent.send({ type: 'stream.data', streamId: 'unknownStream01', chunk: 'INJECTED-OTHER\n' });
    s.agent.send({ type: 'stream.data', streamId, chunk: 'x', topic: 'alerts' });
    s.agent.send({ type: 'stream.data', streamId, chunk: 'tail\n' });
    await browser.next((m) => m.type === 'update' && JSON.stringify(m).includes('tail'));

    const later = browser.received.slice(seenBefore);
    for (const m of later) {
      if (JSON.stringify(m).includes('INJECTED') || JSON.stringify(m).includes('alert(1)')) {
        expect(m.topic).toBe(`deploy:${id}`);
      }
      if (m.topic !== `deploy:${id}`) {
        expect(JSON.stringify(m)).not.toContain('snapshot\\"');
      }
    }
    const texts = later
      .filter((m) => m.topic === `deploy:${id}`)
      .flatMap((m) => (m.upsert as { text: string; channel: string; id: string }[]) ?? []);
    expect(texts.map((x) => x.text).join('')).toBe(`${evil.join('')}tail\n`);
    expect(texts.every((x) => typeof x.id === 'string' && x.channel === 'stdout')).toBe(true);
    expect(JSON.stringify(later)).not.toContain('INJECTED-OTHER');
    expect(later.some((m) => m.type === 'snapshot' && m.topic === 'alerts')).toBe(false);

    s.agent.send({ type: 'stream.end', streamId, code: 0 });
    await deployDone(s, tg.id);
    // Unknown deploy topics are refused.
    browser.send({ type: 'subscribe', topics: ['deploy:AAAAAAAAAAAAAAAA'] });
    const err = await browser.next((m) => m.type === 'error');
    expect(err.code).toBe('unknown_topic');
  });
});
