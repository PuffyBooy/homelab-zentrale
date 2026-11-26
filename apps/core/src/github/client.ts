import { z } from 'zod';
import { branchSchema, repoFullNameSchema, shaSchema, type CiStatus } from '@hz/shared';
import type { Clock } from '../clock.js';
import { clockTime } from '../format.js';

/**
 * Minimal GitHub REST client over fetch (SPEC 7). The token is only ever put
 * into the Authorization header of requests to the configured API base URL;
 * it never appears in errors, logs or return values. Responses are reduced to
 * the few fields the core needs and cached with their ETag, so polling uses
 * conditional requests (304 does not count against the rate limit).
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const GITHUB_API = 'https://api.github.com';
const TIMEOUT_MS = 15_000;
const MAX_BODY_CHARS = 5 * 1024 * 1024;

/** Reads the body as text and aborts once it exceeds `max` bytes (checked before reading). */
async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error('too large');
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error('too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
const MAX_REPO_PAGES = 10;
/** Without a reset header, wait this long after a rate-limit answer. */
const DEFAULT_BACKOFF_MS = 60_000;
export const COMMITS_PER_BRANCH = 30;

export type GithubErrorKind =
  | 'no_token'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'network'
  | 'server'
  | 'invalid';

/** Expected failure with a short German reason (safe to show and store). */
export class GithubError extends Error {
  constructor(
    public readonly kind: GithubErrorKind,
    public readonly reason: string,
  ) {
    super(kind);
    this.name = 'GithubError';
  }
}

export interface EtagStore {
  get(url: string): { etag: string; data: unknown } | undefined;
  set(url: string, etag: string, data: unknown): void;
}

export interface RepoInfo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

export interface RawCommit {
  sha: string;
  message: string;
  author: string;
  at: string;
}

export interface WorkflowRun {
  id: number;
  workflowId: number;
  headSha: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
}

export interface RateInfo {
  remaining: number | null;
  /** Epoch ms of the next reset. */
  resetAt: number | null;
  /** Requests are held back until then (rate limit hit). */
  blockedUntil: number | null;
}

// ---- response schemas (GitHub returns many more fields; zod strips them) -------

const userSchema = z.object({ login: z.string().min(1).max(100) });

const repoSchema = z.object({
  full_name: repoFullNameSchema,
  private: z.boolean(),
  default_branch: branchSchema,
});

const commitItemSchema = z.object({
  sha: shaSchema,
  commit: z.object({
    message: z.string(),
    author: z.object({ name: z.string().nullish(), date: z.string().nullish() }).nullish(),
    committer: z.object({ date: z.string().nullish() }).nullish(),
  }),
  author: z.object({ login: z.string() }).nullish(),
});

const runsSchema = z.object({
  workflow_runs: z.array(
    z.object({
      id: z.number(),
      workflow_id: z.number(),
      head_sha: z.string(),
      status: z.string().nullish(),
      conclusion: z.string().nullish(),
      created_at: z.string(),
    }),
  ),
});

function firstLine(message: string): string {
  const line = (message.split('\n')[0] ?? '').trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

function isoOr(date: string | null | undefined, fallback: string): string {
  const ms = date ? Date.parse(date) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
}

export function reduceCommit(c: z.infer<typeof commitItemSchema>): RawCommit {
  const author = (c.commit.author?.name ?? c.author?.login ?? '').trim().slice(0, 100);
  return {
    sha: c.sha,
    message: firstLine(c.commit.message),
    author,
    at: isoOr(c.commit.committer?.date ?? c.commit.author?.date, new Date(0).toISOString()),
  };
}

const IGNORED_CONCLUSIONS = new Set(['neutral', 'skipped', 'stale']);

/**
 * CI status of one commit from its workflow runs: the latest run per workflow
 * counts. Any failure (failure, cancelled, timed_out, action_required,
 * startup_failure) is crit, else anything running is busy, else success is
 * ok. No runs (or only skipped/neutral) is off.
 */
export function ciOf(runs: readonly WorkflowRun[]): CiStatus {
  const latest = new Map<number, WorkflowRun>();
  for (const r of runs) {
    const prev = latest.get(r.workflowId);
    if (!prev || r.createdAt > prev.createdAt || (r.createdAt === prev.createdAt && r.id > prev.id))
      latest.set(r.workflowId, r);
  }
  let busy = false;
  let ok = false;
  for (const r of latest.values()) {
    if (r.status !== 'completed') {
      // queued, in_progress, waiting, requested, pending (and unknown states).
      busy = true;
      continue;
    }
    if (r.conclusion === 'success') ok = true;
    else if (r.conclusion !== null && IGNORED_CONCLUSIONS.has(r.conclusion)) continue;
    else return 'crit';
  }
  if (busy) return 'busy';
  return ok ? 'ok' : 'off';
}

/** CI status per head sha from a list of runs. */
export function ciBySha(runs: readonly WorkflowRun[]): Map<string, CiStatus> {
  const bySha = new Map<string, WorkflowRun[]>();
  for (const r of runs) {
    const list = bySha.get(r.headSha) ?? [];
    list.push(r);
    bySha.set(r.headSha, list);
  }
  const out = new Map<string, CiStatus>();
  for (const [sha, list] of bySha) out.set(sha, ciOf(list));
  return out;
}

export interface GithubClientDeps {
  token: () => string | null;
  etags: EtagStore;
  now: Clock;
  fetch?: FetchLike;
  baseUrl?: string;
}

function repoPath(fullName: string): string {
  const [owner = '', name = ''] = fullName.split('/');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

export function repoApiPrefix(fullName: string): string {
  return repoPath(fullName);
}

export class GithubClient {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  readonly rate: RateInfo = { remaining: null, resetAt: null, blockedUntil: null };

  constructor(private readonly deps: GithubClientDeps) {
    this.base = (deps.baseUrl ?? GITHUB_API).replace(/\/+$/, '');
    this.fetchImpl = deps.fetch ?? fetch;
  }

  /** Short German reason while rate-limited, else null. */
  rateLimitReason(): string | null {
    const until = this.rate.blockedUntil;
    if (until === null || until <= this.deps.now()) return null;
    return `Rate-Limit bis ${clockTime(until)}`;
  }

  /** Token check: GET /user. Returns the login. */
  async user(tokenOverride?: string): Promise<string> {
    const data = await this.get('/user', (j) => userSchema.parse(j).login, {
      etag: false,
      ...(tokenOverride !== undefined ? { token: tokenOverride } : {}),
    });
    return data;
  }

  /** Repos the token can see (owner, collaborator, organization member). */
  async repos(): Promise<RepoInfo[]> {
    const out: RepoInfo[] = [];
    for (let page = 1; page <= MAX_REPO_PAGES; page++) {
      const list = await this.get(
        `/user/repos?per_page=100&sort=full_name&page=${page}`,
        (j) => {
          const items = z.array(z.unknown()).parse(j);
          const repos: RepoInfo[] = [];
          for (const item of items) {
            const r = repoSchema.safeParse(item);
            if (r.success) repos.push(toRepoInfo(r.data));
          }
          return { repos, count: items.length };
        },
        { etag: true },
      );
      out.push(...list.repos);
      if (list.count < 100) break;
    }
    return out;
  }

  async repo(fullName: string): Promise<RepoInfo> {
    return this.get(repoPath(fullName), (j) => toRepoInfo(repoSchema.parse(j)), { etag: true });
  }

  /** Last 30 commits of a branch, newest first. */
  async commits(fullName: string, branch: string): Promise<RawCommit[]> {
    return this.get(
      `${repoPath(fullName)}/commits?sha=${encodeURIComponent(branch)}&per_page=${COMMITS_PER_BRANCH}`,
      (j) => z.array(commitItemSchema).parse(j).slice(0, COMMITS_PER_BRANCH).map(reduceCommit),
      { etag: true },
    );
  }

  /** Recent workflow runs of a branch (one request gives the CI of all its recent commits). */
  async branchRuns(fullName: string, branch: string): Promise<WorkflowRun[]> {
    return this.get(
      `${repoPath(fullName)}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=100`,
      reduceRuns,
      { etag: true },
    );
  }

  /** CI status of one commit (latest run per workflow for head_sha). */
  async ciForSha(fullName: string, sha: string): Promise<CiStatus> {
    const runs = await this.get(
      `${repoPath(fullName)}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`,
      reduceRuns,
      // One URL per sha: an ETag row per deploy would only grow the table.
      { etag: false },
    );
    return ciOf(runs.filter((r) => r.headSha === sha));
  }

  private async get<T>(
    path: string,
    reduce: (json: unknown) => T,
    opts: { etag: boolean; token?: string },
  ): Promise<T> {
    const token = opts.token ?? this.deps.token();
    if (!token) throw new GithubError('no_token', 'Kein Token gesetzt');
    const limited = this.rateLimitReason();
    if (limited) throw new GithubError('rate_limited', limited);

    const cached = opts.etag ? this.deps.etags.get(path) : undefined;
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'homelab-zentrale',
      authorization: `Bearer ${token}`,
    };
    if (cached) headers['if-none-match'] = cached.etag;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      // The fetch error may carry the URL or headers; only a fixed text leaves here.
      throw new GithubError('network', 'GitHub nicht erreichbar');
    }
    this.readRate(res);

    if (res.status === 304 && cached) {
      await res.body?.cancel().catch(() => undefined);
      return cached.data as T;
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      throw this.statusError(res);
    }
    let json: unknown;
    try {
      const text = await readCapped(res, MAX_BODY_CHARS);
      json = JSON.parse(text);
    } catch {
      throw new GithubError('invalid', 'Unerwartete Antwort von GitHub');
    }
    let data: T;
    try {
      data = reduce(json);
    } catch {
      throw new GithubError('invalid', 'Unerwartete Antwort von GitHub');
    }
    const etag = res.headers.get('etag');
    if (opts.etag && etag && etag.length <= 200) this.deps.etags.set(path, etag, data);
    return data;
  }

  private readRate(res: Response): void {
    const remaining = Number.parseInt(res.headers.get('x-ratelimit-remaining') ?? '', 10);
    const reset = Number.parseInt(res.headers.get('x-ratelimit-reset') ?? '', 10);
    if (Number.isFinite(remaining)) this.rate.remaining = remaining;
    if (Number.isFinite(reset)) this.rate.resetAt = reset * 1000;
    const now = this.deps.now();
    const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
    const limitedAnswer =
      (res.status === 403 || res.status === 429) &&
      (remaining === 0 || Number.isFinite(retryAfter) || res.status === 429);
    if (limitedAnswer || (res.status === 200 && remaining === 0)) {
      let until = Number.isFinite(retryAfter) ? now + retryAfter * 1000 : null;
      if (until === null && remaining === 0 && Number.isFinite(reset)) until = reset * 1000;
      if (until === null || until <= now) until = now + DEFAULT_BACKOFF_MS;
      this.rate.blockedUntil = until;
    } else if (this.rate.blockedUntil !== null && this.rate.blockedUntil <= now) {
      this.rate.blockedUntil = null;
    }
  }

  private statusError(res: Response): GithubError {
    const limited = this.rateLimitReason();
    if (limited) return new GithubError('rate_limited', limited);
    switch (res.status) {
      case 401:
        return new GithubError('unauthorized', 'Token ungültig oder abgelaufen');
      case 403:
        return new GithubError('forbidden', 'Keine Berechtigung, Token-Rechte prüfen');
      case 404:
      case 422:
        return new GithubError('not_found', 'Repo oder Branch nicht gefunden');
      default:
        return res.status >= 500
          ? new GithubError('server', `GitHub-Fehler (HTTP ${res.status})`)
          : new GithubError('invalid', `Unerwartete Antwort von GitHub (HTTP ${res.status})`);
    }
  }
}

function toRepoInfo(r: z.infer<typeof repoSchema>): RepoInfo {
  return { fullName: r.full_name, private: r.private, defaultBranch: r.default_branch };
}

function reduceRuns(j: unknown): WorkflowRun[] {
  return runsSchema.parse(j).workflow_runs.map((r) => ({
    id: r.id,
    workflowId: r.workflow_id,
    headSha: r.head_sha,
    status: r.status ?? '',
    conclusion: r.conclusion ?? null,
    createdAt: r.created_at,
  }));
}
