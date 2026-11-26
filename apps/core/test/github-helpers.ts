import { createHash } from 'node:crypto';
import {
  deployTargetResponseSchema,
  repoResponseSchema,
  type DeployTarget,
  type RepoSummary,
} from '@hz/shared';
import type { FetchLike } from '../src/github/client.js';
import {
  enrollAgent,
  listen,
  stepUp,
  until,
  type Received,
  type WsClient,
} from './agent-helpers.js';
import { authHeaders, completeSetup, makeApp, type TestApp } from './helpers.js';

export const GH_BASE = 'https://api.github.com';
export const TOKEN = 'github_pat_11AAAAAAA0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ';
// Split so secret scanners do not flag the fake token.
export const OTHER_TOKEN = `ghp_${'ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210'}`;
export const PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGx0ZXN0a2V5dGVzdGtleXRlc3RrZXl0ZXN0a2V5 homelab-zentrale deploy-key';

export interface FakeCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
}
export interface FakeRun {
  id: number;
  workflowId: number;
  headSha: string;
  branch: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
}
interface FakeRepo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  branches: Map<string, FakeCommit[]>;
}

export interface FakeRequest {
  url: string;
  path: string;
  headers: Record<string, string>;
  status: number;
}

let shaCounter = 0;
export function nextSha(label = ''): string {
  shaCounter += 1;
  return createHash('sha1').update(`commit-${shaCounter}-${label}`).digest('hex');
}

/**
 * In-memory GitHub REST API (the endpoints the core uses) with ETags and rate
 * limit headers. Plugged into the core as `githubFetch`.
 */
export class FakeGithub {
  readonly tokens = new Set<string>([TOKEN, OTHER_TOKEN]);
  readonly repos = new Map<string, FakeRepo>();
  readonly runs: FakeRun[] = [];
  readonly requests: FakeRequest[] = [];
  remaining = 5000;
  /** Epoch seconds of the reset. */
  resetAt: number;
  /** Answer every request with 403 + remaining 0 (primary rate limit hit). */
  limited = false;
  /** Fail every request at the network level. */
  down = false;
  private runId = 0;

  constructor(private readonly now: () => number) {
    this.resetAt = Math.floor(now() / 1000) + 3600;
  }

  addRepo(fullName: string, opts: { private?: boolean; defaultBranch?: string } = {}): void {
    const defaultBranch = opts.defaultBranch ?? 'main';
    this.repos.set(fullName.toLowerCase(), {
      fullName,
      private: opts.private ?? false,
      defaultBranch,
      branches: new Map([[defaultBranch, []]]),
    });
  }

  /** Pushes a commit on top of the branch. Returns its sha. */
  push(fullName: string, message: string, branch = 'main'): string {
    const repo = this.repos.get(fullName.toLowerCase());
    if (!repo) throw new Error('no repo');
    const list = repo.branches.get(branch) ?? [];
    const sha = nextSha(message);
    list.unshift({
      sha,
      message: `${message}\n\nbody line`,
      author: 'Alex',
      date: new Date(this.now()).toISOString(),
    });
    repo.branches.set(branch, list);
    return sha;
  }

  /** Records a workflow run for a commit (status completed + conclusion, or in_progress). */
  ci(
    sha: string,
    result: 'success' | 'failure' | 'cancelled' | 'in_progress' | 'queued' | 'skipped',
    opts: { workflowId?: number; branch?: string } = {},
  ): void {
    const done = result !== 'in_progress' && result !== 'queued';
    this.runId += 1;
    this.runs.unshift({
      id: this.runId,
      workflowId: opts.workflowId ?? 1,
      headSha: sha,
      branch: opts.branch ?? 'main',
      status: done ? 'completed' : result,
      conclusion: done ? result : null,
      createdAt: new Date(this.now() + this.runId).toISOString(),
    });
  }

  countPath(prefix: string): number {
    return this.requests.filter((r) => r.path.startsWith(prefix)).length;
  }

  readonly fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const record = (status: number): void => {
      this.requests.push({ url, path: `${u.pathname}${u.search}`, headers, status });
    };
    if (this.down) {
      record(0);
      throw new TypeError(`fetch failed for ${url} with ${headers.authorization ?? ''}`);
    }
    if (u.origin !== GH_BASE) throw new Error('unexpected host');
    const rateHeaders = (): Record<string, string> => ({
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': String(this.remaining),
      'x-ratelimit-reset': String(this.resetAt),
    });
    const auth = headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!this.tokens.has(token)) {
      record(401);
      return json(401, { message: 'Bad credentials' }, rateHeaders());
    }
    if (this.limited) {
      this.remaining = 0;
      record(403);
      return json(403, { message: 'API rate limit exceeded' }, rateHeaders());
    }
    const body = this.route(u);
    if (body === null) {
      this.remaining = Math.max(0, this.remaining - 1);
      record(404);
      return json(404, { message: 'Not Found' }, rateHeaders());
    }
    const text = JSON.stringify(body);
    const etag = `W/"${createHash('sha1').update(text).digest('hex')}"`;
    if (headers['if-none-match'] === etag) {
      // Conditional hit: does not count against the rate limit.
      record(304);
      return new Response(null, { status: 304, headers: { etag, ...rateHeaders() } });
    }
    this.remaining = Math.max(0, this.remaining - 1);
    record(200);
    return json(200, body, { etag, ...rateHeaders() });
  };

  private route(u: URL): unknown {
    const p = u.pathname;
    if (p === '/user') return { login: 'alex-hz', id: 1 };
    if (p === '/user/repos') {
      const page = Number(u.searchParams.get('page') ?? '1');
      if (page > 1) return [];
      return [...this.repos.values()].map((r) => this.repoJson(r));
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(p);
    if (!m) return null;
    const repo = this.repos.get(
      `${decodeURIComponent(m[1] ?? '')}/${decodeURIComponent(m[2] ?? '')}`.toLowerCase(),
    );
    if (!repo) return null;
    const rest = m[3] ?? '';
    if (rest === '') return this.repoJson(repo);
    if (rest === '/commits') {
      const list = repo.branches.get(u.searchParams.get('sha') ?? repo.defaultBranch);
      if (!list) return null;
      const n = Number(u.searchParams.get('per_page') ?? '30');
      return list.slice(0, n).map((c) => ({
        sha: c.sha,
        node_id: 'x',
        commit: {
          message: c.message,
          author: { name: c.author, email: 'alex@example.invalid', date: c.date },
          committer: { name: c.author, date: c.date },
        },
        author: { login: 'alex-hz' },
        html_url: `https://github.com/${repo.fullName}/commit/${c.sha}`,
      }));
    }
    if (rest === '/actions/runs') {
      const branch = u.searchParams.get('branch');
      const headSha = u.searchParams.get('head_sha');
      const runs = this.runs.filter(
        (r) =>
          (branch === null || r.branch === branch) && (headSha === null || r.headSha === headSha),
      );
      return {
        total_count: runs.length,
        workflow_runs: runs.map((r) => ({
          id: r.id,
          workflow_id: r.workflowId,
          head_sha: r.headSha,
          head_branch: r.branch,
          status: r.status,
          conclusion: r.conclusion,
          created_at: r.createdAt,
          name: 'CI',
        })),
      };
    }
    return null;
  }

  private repoJson(r: FakeRepo): Record<string, unknown> {
    return {
      id: 1,
      full_name: r.fullName,
      private: r.private,
      default_branch: r.defaultBranch,
      html_url: `https://github.com/${r.fullName}`,
      owner: { login: r.fullName.split('/')[0] },
    };
  }
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** How the simulated agent answers deploy.run. */
export type DeployBehaviour =
  | { kind: 'ok'; lines?: string[] }
  | { kind: 'fail'; code: number; error?: string; lines?: string[] }
  /** The agent refuses deploy.run with an rpc error. */
  | { kind: 'refuse'; code: string; message: string }
  /** The test drives the stream itself (stream.data / stream.end). */
  | { kind: 'manual' };

export interface GithubSetup {
  t: TestApp;
  gh: FakeGithub;
  url: string;
  cookie: string;
  secret: string;
  agent: WsClient;
  serverId: string;
  rpcs: Received[];
  behaviour: { deploy: DeployBehaviour; key: unknown };
  headers: Record<string, string>;
  /** Agent ping/pong at the current fake time, so the hub does not drop it as stale. */
  keepAlive: () => Promise<void>;
}

/**
 * App + admin + enrolled agent + fake GitHub. The agent answers deploy.key with
 * PUBLIC_KEY and deploy.run according to `behaviour.deploy`. With `token`, the
 * token is set (step-up first).
 */
export async function withGithub(
  clients: WsClient[],
  opts: { token?: boolean; captureLogs?: boolean } = {},
): Promise<GithubSetup> {
  let clockRef: TestApp['clock'] | null = null;
  const gh = new FakeGithub(() => clockRef?.t ?? Date.now());
  const t = await makeApp({
    githubFetch: gh.fetch,
    liveOptions: { throttleMs: 10, appendThrottleMs: 5 },
    ...(opts.captureLogs ? { captureLogs: true } : {}),
  });
  clockRef = t.clock;
  gh.resetAt = Math.floor(t.clock.t / 1000) + 3600;
  const admin = await completeSetup(t);
  const url = await listen(t);
  const e = await enrollAgent(t, url, admin.cookie);
  clients.push(e.agent);
  const rpcs: Received[] = [];
  const behaviour: { deploy: DeployBehaviour; key: unknown } = {
    deploy: { kind: 'ok' },
    key: { publicKey: PUBLIC_KEY },
  };
  const pongs = { n: 0 };
  e.agent.ws.on('message', (data) => {
    const m = JSON.parse(String(data)) as Received;
    if (m.type === 'pong') pongs.n += 1;
    if (m.type === 'ping') e.agent.send({ type: 'pong', ts: m.ts });
    if (m.type !== 'rpc') return;
    rpcs.push(m);
    const id = m.id as string;
    if (m.action === 'deploy.key') {
      e.agent.send({ type: 'rpc.result', id, ok: true, data: behaviour.key });
      return;
    }
    if (m.action === 'deploy.run') {
      const b = behaviour.deploy;
      if (b.kind === 'manual') return;
      if (b.kind === 'refuse') {
        e.agent.send({
          type: 'rpc.result',
          id,
          ok: false,
          error: { code: b.code, message: b.message },
        });
        return;
      }
      for (const line of b.lines ?? ['git fetch\n', 'docker compose up -d --build\n']) {
        e.agent.send({ type: 'stream.data', streamId: id, channel: 'stdout', chunk: line });
      }
      e.agent.send({
        type: 'stream.end',
        streamId: id,
        code: b.kind === 'ok' ? 0 : b.code,
        ...(b.kind === 'fail' && b.error ? { error: b.error } : {}),
      });
      return;
    }
    e.agent.send({ type: 'rpc.result', id, ok: true, data: null });
  });
  const setup: GithubSetup = {
    t,
    gh,
    url,
    ...admin,
    agent: e.agent,
    serverId: e.serverId,
    rpcs,
    behaviour,
    headers: authHeaders(admin.cookie),
    keepAlive: async () => {
      const before = pongs.n;
      e.agent.send({ type: 'ping', ts: new Date(t.clock.t).toISOString() });
      await until(() => pongs.n > before);
    },
  };
  if (opts.token) await setToken(setup);
  return setup;
}

export async function setToken(s: GithubSetup, token = TOKEN): Promise<void> {
  await stepUp(s.t, s.secret, s.cookie);
  const res = await s.t.app.inject({
    method: 'PUT',
    url: '/api/github/token',
    headers: s.headers,
    payload: { token },
  });
  if (res.statusCode !== 200) throw new Error(`token ${res.statusCode}`);
  await s.t.app.hzCore.github.idle();
}

export async function addRepo(s: GithubSetup, fullName: string): Promise<RepoSummary> {
  const res = await s.t.app.inject({
    method: 'POST',
    url: '/api/github/repos',
    headers: s.headers,
    payload: { fullName },
  });
  if (res.statusCode !== 200) throw new Error(`repo ${res.statusCode} ${res.body}`);
  return repoResponseSchema.parse(res.json()).repo;
}

export async function addTarget(
  s: GithubSetup,
  repoId: string,
  over: Record<string, unknown> = {},
): Promise<DeployTarget> {
  const res = await s.t.app.inject({
    method: 'POST',
    url: `/api/github/repos/${repoId}/targets`,
    headers: s.headers,
    payload: { serverId: s.serverId, path: '/opt/homelab/apps/blog', branch: 'main', ...over },
  });
  if (res.statusCode !== 200) throw new Error(`target ${res.statusCode} ${res.body}`);
  await s.t.app.hzCore.github.idle();
  return deployTargetResponseSchema.parse(res.json()).target;
}

/** One polling interval: move the clock 60 s, run the scheduler, wait for GitHub and deploys. */
export async function pollOnce(s: GithubSetup): Promise<void> {
  s.t.clock.advance(60_000);
  await s.keepAlive();
  await s.t.app.hzCore.scheduler.tick();
  await s.t.app.hzCore.github.idle();
}

export function deployRequest(
  s: GithubSetup,
  targetId: string,
  payload: Record<string, unknown> = {},
) {
  return s.t.app.inject({
    method: 'POST',
    url: `/api/github/targets/${targetId}/deploy`,
    headers: s.headers,
    payload,
  });
}

/** Waits until no deploy of the target is running. */
export async function deployDone(s: GithubSetup, targetId: string): Promise<void> {
  await until(() => !s.t.app.hzCore.github.deployer.isBusy(targetId));
  await s.t.app.hzCore.github.idle();
}

export function target(s: GithubSetup, repoId: string, targetId: string): DeployTarget {
  const t = s.t.app.hzCore.github.summary(repoId)?.targets.find((x) => x.id === targetId);
  if (!t) throw new Error('no target');
  return t;
}
