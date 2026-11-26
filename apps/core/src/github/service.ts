import { and, asc, eq, or, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import {
  commitInfoSchema,
  type CiStatus,
  type CommitInfo,
  type Deploy,
  type DeployTarget,
  type GithubSettings,
  type RepoSummary,
  type deployRequestSchema,
  type deployTargetRequestSchema,
} from '@hz/shared';
import type { AgentHub } from '../agents/hub.js';
import type { AlertService } from '../alerts/service.js';
import type { Clock } from '../clock.js';
import { DecryptError, randomToken, type SecretBox } from '../crypto.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import {
  deployTargets,
  githubBranches,
  githubEtags,
  githubRepos,
  servers,
  settings,
  type DeployTargetRow,
  type GithubRepoRow,
} from '../db/schema.js';
import { readSetting, writeSetting } from '../db/settings.js';
import { HttpError } from '../http/errors.js';
import type { Scheduler } from '../scheduler.js';
import {
  ciBySha,
  COMMITS_PER_BRANCH,
  GithubClient,
  GithubError,
  repoApiPrefix,
  type EtagStore,
  type FetchLike,
  type RawCommit,
} from './client.js';
import { Deployer, type DeployTrigger } from './deploys.js';

export const GITHUB_POLL_MS = 60_000;
const TOKEN_KEY = 'github.token';
const TOKEN_AAD = 'settings.github.token';
const STATUS_KEY = 'github.status';

type TargetRequest = z.output<typeof deployTargetRequestSchema>;
type DeployRequest = z.output<typeof deployRequestSchema>;
export type RepoListener = (id: string, deleted: boolean) => void;

const statusSchema = z.object({
  login: z.string().nullable().catch(null),
  lastPollAt: z.number().nullable().catch(null),
  error: z.string().nullable().catch(null),
});
type PollStatus = z.infer<typeof statusSchema>;

const commitsSchema = z.array(commitInfoSchema);

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** Commits on the branch after `liveSha` (newest first list), capped at 30. */
export function behindCount(commits: readonly { sha: string }[], liveSha: string | null): number {
  if (liveSha === null) return 0;
  const i = commits.findIndex((c) => c.sha === liveSha);
  // Not among the last 30: at least 30 behind ("30+" in the UI).
  return i === -1 ? COMMITS_PER_BRANCH : Math.min(i, COMMITS_PER_BRANCH);
}

/** True if one path equals the other or lies inside it. */
function pathsOverlap(a: string, b: string): boolean {
  const x = a.endsWith('/') ? a : `${a}/`;
  const y = b.endsWith('/') ? b : `${b}/`;
  return x.startsWith(y) || y.startsWith(x);
}

export interface GithubServiceDeps {
  db: Db;
  box: SecretBox;
  now: Clock;
  scheduler: Scheduler;
  alerts: AlertService;
  hub: Pick<AgentHub, 'call' | 'stream' | 'isConnected'>;
  log: FastifyBaseLogger;
  fetch?: FetchLike;
  baseUrl?: string;
}

/**
 * GitHub (SPEC 7): token, tracked repos, polling every 60 s with ETags, CI
 * status, deploy targets with deploy keys, deploys and auto-deploy.
 */
export class GithubService {
  readonly client: GithubClient;
  readonly deployer: Deployer;
  private readonly listeners = new Set<RepoListener>();
  private readonly background = new Set<Promise<void>>();
  private polling: Promise<void> | null = null;

  constructor(private readonly deps: GithubServiceDeps) {
    const etags: EtagStore = {
      get: (url) => {
        const row = deps.db.select().from(githubEtags).where(eq(githubEtags.url, url)).get();
        if (!row) return undefined;
        try {
          return { etag: row.etag, data: JSON.parse(row.dataJson) as unknown };
        } catch {
          return undefined;
        }
      },
      set: (url, etag, data) => {
        const dataJson = JSON.stringify(data);
        const updatedAt = deps.now();
        deps.db
          .insert(githubEtags)
          .values({ url, etag, dataJson, updatedAt })
          .onConflictDoUpdate({ target: githubEtags.url, set: { etag, dataJson, updatedAt } })
          .run();
      },
    };
    this.client = new GithubClient({
      token: () => this.token(),
      etags,
      now: deps.now,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
    });
    this.deployer = new Deployer({
      db: deps.db,
      now: deps.now,
      hub: deps.hub,
      alerts: deps.alerts,
      log: deps.log,
      onTargetChange: (repoId) => this.emit(repoId),
    });
  }

  onChange(fn: RepoListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(id: string, deleted = false): void {
    for (const fn of this.listeners) fn(id, deleted);
  }

  /** Emits every repo (e.g. a server was deleted, targets went with it). */
  emitAll(): void {
    for (const r of this.deps.db.select({ id: githubRepos.id }).from(githubRepos).all()) {
      this.emit(r.id);
    }
  }

  /** Fails deploys that were running before a restart; registers polling and timeouts. */
  start(): void {
    this.deployer.recoverAfterRestart();
    const s = this.deps.scheduler;
    s.every('github.poll', GITHUB_POLL_MS, () => this.poll());
    s.every('github.deployTimeouts', 10_000, () => this.deployer.checkTimeouts());
    if (this.token() !== null) this.track(this.poll());
  }

  async idle(): Promise<void> {
    while (this.background.size > 0 || this.polling) {
      await Promise.allSettled([...this.background, ...(this.polling ? [this.polling] : [])]);
    }
    await this.deployer.idle();
  }

  private track(p: Promise<unknown>): void {
    const tracked = p.then(
      () => undefined,
      (err: unknown) => this.logError(err),
    );
    this.background.add(tracked);
    void tracked.finally(() => this.background.delete(tracked));
  }

  private logError(err: unknown): void {
    if (err instanceof GithubError) {
      this.deps.log.info({ kind: err.kind }, 'github request failed');
      return;
    }
    this.deps.log.error(
      { err: err instanceof Error ? { name: err.name, stack: err.stack } : 'error' },
      'github job failed',
    );
  }

  // ---- token and settings ------------------------------------------------------

  private token(): string | null {
    const enc = readSetting(this.deps.db, TOKEN_KEY);
    if (typeof enc !== 'string') return null;
    try {
      return this.deps.box.decrypt(enc, TOKEN_AAD);
    } catch (err) {
      if (err instanceof DecryptError) return null;
      throw err;
    }
  }

  private status(): PollStatus {
    const parsed = statusSchema.safeParse(readSetting(this.deps.db, STATUS_KEY) ?? {});
    return parsed.success ? parsed.data : { login: null, lastPollAt: null, error: null };
  }

  private writeStatus(patch: Partial<PollStatus>): void {
    writeSetting(this.deps.db, STATUS_KEY, { ...this.status(), ...patch }, this.deps.now());
  }

  settings(): GithubSettings {
    const tokenSet = readSetting(this.deps.db, TOKEN_KEY) !== undefined;
    const st = this.status();
    const undecryptable = tokenSet && this.token() === null;
    return {
      tokenSet,
      login: tokenSet ? st.login : null,
      lastPollAt: tokenSet ? iso(st.lastPollAt) : null,
      error: !tokenSet
        ? null
        : undecryptable
          ? 'Token nicht lesbar, bitte neu eintragen'
          : (this.client.rateLimitReason() ?? st.error),
      rateRemaining: tokenSet ? this.client.rate.remaining : null,
    };
  }

  /**
   * Checks the token with GET /user and stores it encrypted. A token GitHub
   * rejects (401) is not stored. If GitHub is unreachable it is stored with the
   * reason, and the next poll checks again.
   */
  async setToken(token: string): Promise<GithubSettings> {
    let login: string | null = null;
    let error: string | null = null;
    try {
      login = await this.client.user(token);
    } catch (err) {
      if (!(err instanceof GithubError)) throw err;
      if (err.kind === 'unauthorized') throw new HttpError(400, 'invalid_credentials');
      error = err.reason;
    }
    const now = this.deps.now();
    writeSetting(this.deps.db, TOKEN_KEY, this.deps.box.encrypt(token, TOKEN_AAD), now);
    // Cached answers belong to the old token.
    this.deps.db.delete(githubEtags).run();
    this.writeStatus({ login, error, lastPollAt: null });
    this.track(this.poll());
    return this.settings();
  }

  clearToken(): void {
    this.deps.db.delete(settings).where(eq(settings.key, TOKEN_KEY)).run();
    this.deps.db.delete(githubEtags).run();
    writeSetting(
      this.deps.db,
      STATUS_KEY,
      { login: null, lastPollAt: null, error: null },
      this.deps.now(),
    );
  }

  private requireToken(): void {
    if (this.token() === null) throw new HttpError(409, 'conflict');
  }

  private githubHttpError(err: unknown): HttpError {
    if (err instanceof HttpError) return err;
    if (err instanceof GithubError) {
      if (err.kind === 'not_found') return new HttpError(404, 'not_found');
      if (err.kind === 'no_token') return new HttpError(409, 'conflict');
      this.writeStatus({ error: err.reason });
      return new HttpError(502, 'github_error');
    }
    this.logError(err);
    return new HttpError(500, 'internal');
  }

  // ---- repos ---------------------------------------------------------------------

  repoRow(id: string): GithubRepoRow | undefined {
    return this.deps.db.select().from(githubRepos).where(eq(githubRepos.id, id)).get();
  }

  private repoRows(): GithubRepoRow[] {
    return this.deps.db.select().from(githubRepos).orderBy(asc(githubRepos.fullName)).all();
  }

  list(): RepoSummary[] {
    return this.repoRows().map((r) => this.toSummary(r));
  }

  summary(id: string): RepoSummary | null {
    const row = this.repoRow(id);
    return row ? this.toSummary(row) : null;
  }

  private cachedCommits(repoId: string, branch: string): CommitInfo[] {
    const row = this.deps.db
      .select()
      .from(githubBranches)
      .where(and(eq(githubBranches.repoId, repoId), eq(githubBranches.branch, branch)))
      .get();
    if (!row) return [];
    try {
      const parsed = commitsSchema.safeParse(JSON.parse(row.commitsJson));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }

  private targetRows(repoId: string): DeployTargetRow[] {
    return this.deps.db
      .select()
      .from(deployTargets)
      .where(eq(deployTargets.repoId, repoId))
      .orderBy(asc(deployTargets.createdAt), asc(deployTargets.id))
      .all();
  }

  targetRow(id: string): DeployTargetRow | undefined {
    return this.deps.db.select().from(deployTargets).where(eq(deployTargets.id, id)).get();
  }

  private serverName(id: string): string {
    return (
      this.deps.db.select({ name: servers.name }).from(servers).where(eq(servers.id, id)).get()
        ?.name ?? ''
    );
  }

  toTarget(t: DeployTargetRow, commits?: CommitInfo[]): DeployTarget {
    const list = commits ?? this.cachedCommits(t.repoId, t.branch);
    return {
      id: t.id,
      repoId: t.repoId,
      serverId: t.serverId,
      serverName: this.serverName(t.serverId),
      path: t.path,
      branch: t.branch,
      method: t.method as DeployTarget['method'],
      autoDeploy: t.autoDeploy,
      keyName: t.keyName,
      publicKey: t.publicKey,
      liveSha: t.liveSha,
      behind: behindCount(list, t.liveSha),
      deploying: this.deployer.isBusy(t.id),
    };
  }

  private toSummary(r: GithubRepoRow): RepoSummary {
    const byBranch = new Map<string, CommitInfo[]>();
    const commitsOf = (branch: string): CommitInfo[] => {
      let list = byBranch.get(branch);
      if (!list) {
        list = this.cachedCommits(r.id, branch);
        byBranch.set(branch, list);
      }
      return list;
    };
    const head = commitsOf(r.defaultBranch)[0] ?? null;
    return {
      id: r.id,
      fullName: r.fullName,
      private: r.private,
      defaultBranch: r.defaultBranch,
      htmlUrl: `https://github.com/${r.fullName}`,
      lastCommit: head,
      ci: head?.ci ?? 'off',
      targets: this.targetRows(r.id).map((t) => this.toTarget(t, commitsOf(t.branch))),
      updatedAt: iso(r.updatedAt),
    };
  }

  async available(): Promise<{ fullName: string; private: boolean; tracked: boolean }[]> {
    this.requireToken();
    let repos;
    try {
      repos = await this.client.repos();
    } catch (err) {
      throw this.githubHttpError(err);
    }
    const tracked = new Set(this.repoRows().map((r) => r.fullName.toLowerCase()));
    return repos.map((r) => ({
      fullName: r.fullName,
      private: r.private,
      tracked: tracked.has(r.fullName.toLowerCase()),
    }));
  }

  async addRepo(fullName: string): Promise<RepoSummary> {
    this.requireToken();
    const exists = (name: string): boolean =>
      this.deps.db
        .select({ id: githubRepos.id })
        .from(githubRepos)
        .where(sql`${githubRepos.fullName} = ${name} COLLATE NOCASE`)
        .get() !== undefined;
    if (exists(fullName)) throw new HttpError(409, 'conflict');
    let info;
    try {
      info = await this.client.repo(fullName);
    } catch (err) {
      throw this.githubHttpError(err);
    }
    if (exists(info.fullName)) throw new HttpError(409, 'conflict');
    const row: GithubRepoRow = {
      id: randomToken(12),
      fullName: info.fullName,
      private: info.private,
      defaultBranch: info.defaultBranch,
      lastCommitSha: null,
      ciStatus: 'off',
      createdAt: this.deps.now(),
      updatedAt: null,
    };
    this.deps.db.insert(githubRepos).values(row).run();
    try {
      await this.pollRepo(row);
    } catch (err) {
      // The repo is tracked; the next poll fills in the commits.
      this.logError(err);
    }
    this.emit(row.id);
    const summary = this.summary(row.id);
    if (!summary) throw new HttpError(404, 'not_found');
    return summary;
  }

  removeRepo(id: string): boolean {
    const row = this.repoRow(id);
    if (!row) return false;
    const targets = this.targetRows(id);
    if (targets.some((t) => this.deployer.isBusy(t.id))) throw new HttpError(409, 'busy');
    for (const t of targets) this.deps.alerts.resolveAllWithPrefix(`deploy:${t.id}:`);
    this.deps.db.delete(githubRepos).where(eq(githubRepos.id, id)).run();
    const prefix = repoApiPrefix(row.fullName);
    this.deps.db
      .delete(githubEtags)
      .where(
        or(
          eq(githubEtags.url, prefix),
          sql`substr(${githubEtags.url}, 1, ${prefix.length + 1}) = ${`${prefix}/`}`,
        ),
      )
      .run();
    this.emit(id, true);
    return true;
  }

  /** Last 30 commits of a branch with LIVE markers and rollback candidates. */
  async commits(
    repoId: string,
    branch: string | undefined,
  ): Promise<(CommitInfo & { liveOn: string[]; deployedBefore: string[] })[]> {
    const repo = this.repoRow(repoId);
    if (!repo) throw new HttpError(404, 'not_found');
    const b = branch ?? repo.defaultBranch;
    const targets = this.targetRows(repoId);
    const tracked = b === repo.defaultBranch || targets.some((t) => t.branch === b);
    let list = tracked ? this.cachedCommits(repoId, b) : [];
    const cached = tracked && this.hasBranchRow(repoId, b);
    if (!cached && this.token() !== null) {
      try {
        list = await this.fetchBranch(repo, b);
        if (tracked) this.saveBranch(repoId, b, list);
      } catch (err) {
        throw this.githubHttpError(err);
      }
    }
    const ok = this.deployer.successfulShas(targets.map((t) => t.id));
    return list.map((c) => {
      const liveOn = targets.filter((t) => t.liveSha === c.sha).map((t) => t.id);
      const deployedBefore = targets
        .filter((t) => t.liveSha !== c.sha && ok.get(t.id)?.has(c.sha) === true)
        .map((t) => t.id);
      return { ...c, liveOn, deployedBefore };
    });
  }

  private hasBranchRow(repoId: string, branch: string): boolean {
    return (
      this.deps.db
        .select({ b: githubBranches.branch })
        .from(githubBranches)
        .where(and(eq(githubBranches.repoId, repoId), eq(githubBranches.branch, branch)))
        .get() !== undefined
    );
  }

  // ---- polling -------------------------------------------------------------------

  /** One polling round over all tracked repos (scheduler, every 60 s). */
  poll(): Promise<void> {
    this.polling ??= this.pollAll().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private async pollAll(): Promise<void> {
    if (this.token() === null) return;
    if (this.status().login === null) {
      // Token stored while GitHub was unreachable: check it first.
      try {
        this.writeStatus({ login: await this.client.user() });
      } catch (err) {
        if (!(err instanceof GithubError)) throw err;
        this.writeStatus({ lastPollAt: this.deps.now(), error: err.reason });
        return;
      }
    }
    let error: string | null = null;
    for (const repo of this.repoRows()) {
      try {
        await this.pollRepo(repo);
      } catch (err) {
        if (!(err instanceof GithubError)) {
          this.logError(err);
          continue;
        }
        error ??= err.kind === 'not_found' ? `${repo.fullName}: ${err.reason}` : err.reason;
        // Without a valid token or while rate-limited the other repos fail the same way.
        if (err.kind === 'unauthorized' || err.kind === 'rate_limited' || err.kind === 'no_token')
          break;
      }
    }
    this.writeStatus({ lastPollAt: this.deps.now(), error });
  }

  private async fetchBranch(repo: GithubRepoRow, branch: string): Promise<CommitInfo[]> {
    let raw: RawCommit[];
    try {
      raw = await this.client.commits(repo.fullName, branch);
    } catch (err) {
      // A target branch that does not exist (yet) has no commits.
      if (err instanceof GithubError && err.kind === 'not_found') return [];
      throw err;
    }
    let ci = new Map<string, CiStatus>();
    try {
      ci = ciBySha(await this.client.branchRuns(repo.fullName, branch));
    } catch (err) {
      // Without Actions (or the Actions permission) every commit shows CI off.
      if (!(err instanceof GithubError) || (err.kind !== 'not_found' && err.kind !== 'forbidden'))
        throw err;
    }
    return raw.map((c) => ({ ...c, ci: ci.get(c.sha) ?? 'off' }));
  }

  private saveBranch(repoId: string, branch: string, commits: CommitInfo[]): void {
    const commitsJson = JSON.stringify(commits);
    const headSha = commits[0]?.sha ?? null;
    const updatedAt = this.deps.now();
    this.deps.db
      .insert(githubBranches)
      .values({ repoId, branch, headSha, commitsJson, updatedAt })
      .onConflictDoUpdate({
        target: [githubBranches.repoId, githubBranches.branch],
        set: { headSha, commitsJson, updatedAt },
      })
      .run();
  }

  private async pollRepo(row: GithubRepoRow): Promise<void> {
    const info = await this.client.repo(row.fullName);
    let repo = row;
    if (info.private !== row.private || info.defaultBranch !== row.defaultBranch) {
      this.deps.db
        .update(githubRepos)
        .set({ private: info.private, defaultBranch: info.defaultBranch })
        .where(eq(githubRepos.id, row.id))
        .run();
      repo = { ...row, private: info.private, defaultBranch: info.defaultBranch };
    }
    const targets = this.targetRows(repo.id);
    const branches = [...new Set([repo.defaultBranch, ...targets.map((t) => t.branch)])];
    const byBranch = new Map<string, CommitInfo[]>();
    for (const branch of branches) {
      const commits = await this.fetchBranch(repo, branch);
      if (!this.repoRow(repo.id)) return; // removed meanwhile
      this.saveBranch(repo.id, branch, commits);
      byBranch.set(branch, commits);
    }
    // Branches nobody uses any more.
    this.deps.db
      .delete(githubBranches)
      .where(
        and(
          eq(githubBranches.repoId, repo.id),
          sql`${githubBranches.branch} NOT IN (${sql.join(
            branches.map((b) => sql`${b}`),
            sql`, `,
          )})`,
        ),
      )
      .run();
    const head = byBranch.get(repo.defaultBranch)?.[0] ?? null;
    this.deps.db
      .update(githubRepos)
      .set({
        lastCommitSha: head?.sha ?? null,
        ciStatus: head?.ci ?? 'off',
        updatedAt: this.deps.now(),
      })
      .where(eq(githubRepos.id, repo.id))
      .run();
    this.autoDeploy(repo, byBranch);
    this.emit(repo.id);
  }

  /** New head with green CI on a target with auto-deploy: deploy it, once per sha. */
  private autoDeploy(repo: GithubRepoRow, byBranch: Map<string, CommitInfo[]>): void {
    for (const t of this.targetRows(repo.id)) {
      if (!t.autoDeploy) continue;
      const head = byBranch.get(t.branch)?.[0];
      if (!head || head.ci !== 'ok') continue;
      if (head.sha === t.liveSha || head.sha === t.autoSha) continue;
      if (!this.deployer.reserve(t.id)) continue; // busy: try again on the next poll
      this.deps.db
        .update(deployTargets)
        .set({ autoSha: head.sha })
        .where(eq(deployTargets.id, t.id))
        .run();
      try {
        this.deployer.start({
          target: t,
          repo,
          sha: head.sha,
          trigger: 'auto',
          actor: 'system',
          message: head.message,
        });
      } catch (err) {
        this.deployer.release(t.id);
        this.logError(err);
      }
    }
  }

  // ---- targets -------------------------------------------------------------------

  private checkTarget(req: TargetRequest, exceptId: string | null): void {
    const server = this.deps.db
      .select({ id: servers.id })
      .from(servers)
      .where(eq(servers.id, req.serverId))
      .get();
    if (!server) throw new HttpError(400, 'invalid_input');
    const others = this.deps.db
      .select({ id: deployTargets.id, path: deployTargets.path })
      .from(deployTargets)
      .where(eq(deployTargets.serverId, req.serverId))
      .all()
      .filter((o) => o.id !== exceptId);
    // One target per directory; nested directories would overwrite each other.
    if (others.some((o) => pathsOverlap(o.path, req.path))) throw new HttpError(409, 'conflict');
  }

  createTarget(repoId: string, req: TargetRequest): DeployTarget {
    const repo = this.repoRow(repoId);
    if (!repo) throw new HttpError(404, 'not_found');
    this.checkTarget(req, null);
    const now = this.deps.now();
    const row: DeployTargetRow = {
      id: randomToken(12),
      repoId,
      serverId: req.serverId,
      path: req.path,
      branch: req.branch,
      method: req.method,
      autoDeploy: req.autoDeploy,
      keyName: null,
      publicKey: null,
      liveSha: null,
      autoSha: null,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.db.insert(deployTargets).values(row).run();
    this.afterTargetChange(repo, row.branch);
    return this.toTarget(row);
  }

  updateTarget(id: string, req: TargetRequest): DeployTarget {
    const row = this.targetRow(id);
    if (!row) throw new HttpError(404, 'not_found');
    if (this.deployer.isBusy(id)) throw new HttpError(409, 'busy');
    this.checkTarget(req, id);
    const moved = req.serverId !== row.serverId || req.path !== row.path;
    const patch: Partial<DeployTargetRow> = {
      serverId: req.serverId,
      path: req.path,
      branch: req.branch,
      method: req.method,
      autoDeploy: req.autoDeploy,
      updatedAt: this.deps.now(),
    };
    // Another server or directory: nothing of ours runs there yet, and the key
    // lives on the old server.
    if (moved) Object.assign(patch, { liveSha: null, autoSha: null });
    if (req.serverId !== row.serverId) Object.assign(patch, { keyName: null, publicKey: null });
    this.deps.db.update(deployTargets).set(patch).where(eq(deployTargets.id, id)).run();
    const repo = this.repoRow(row.repoId);
    if (repo) this.afterTargetChange(repo, req.branch);
    const updated = this.targetRow(id);
    if (!updated) throw new HttpError(404, 'not_found');
    return this.toTarget(updated);
  }

  private afterTargetChange(repo: GithubRepoRow, branch: string): void {
    this.emit(repo.id);
    // A new branch needs its commits; fetched in the background.
    if (!this.hasBranchRow(repo.id, branch) && this.token() !== null) {
      this.track(
        (async () => {
          const commits = await this.fetchBranch(repo, branch);
          if (this.repoRow(repo.id)) {
            this.saveBranch(repo.id, branch, commits);
            this.emit(repo.id);
          }
        })(),
      );
    }
  }

  removeTarget(id: string): DeployTargetRow | null {
    const row = this.targetRow(id);
    if (!row) return null;
    if (this.deployer.isBusy(id)) throw new HttpError(409, 'busy');
    this.deps.db.delete(deployTargets).where(eq(deployTargets.id, id)).run();
    this.deps.alerts.resolveAllWithPrefix(`deploy:${id}:`);
    this.emit(row.repoId);
    return row;
  }

  /** Asks the agent of the target server for the deploy key (created once, then reused). */
  async createDeployKey(id: string): Promise<DeployTarget> {
    const row = this.targetRow(id);
    if (!row) throw new HttpError(404, 'not_found');
    const keyName = `deploy-${row.id}`;
    const data = await this.deps.hub.call(
      row.serverId,
      'deploy.key',
      { name: keyName },
      { timeoutMs: 30_000 },
    );
    const parsed = deployKeyDataSchema.safeParse(data);
    if (!parsed.success) throw new HttpError(502, 'agent_error');
    this.deps.db
      .update(deployTargets)
      .set({ keyName, publicKey: parsed.data.publicKey, updatedAt: this.deps.now() })
      .where(eq(deployTargets.id, id))
      .run();
    this.emit(row.repoId);
    const updated = this.targetRow(id);
    if (!updated) throw new HttpError(404, 'not_found');
    return this.toTarget(updated);
  }

  // ---- deploys -------------------------------------------------------------------

  /**
   * Starts a deploy (button or rollback). Lock per target (409 busy). A normal
   * deploy needs a commit from the branch (default: head) with green CI (409
   * ci_not_green); a rollback needs a sha that was deployed successfully on
   * this target before (409 conflict) and skips the CI rule.
   */
  async deploy(targetId: string, req: DeployRequest): Promise<Deploy> {
    const target = this.targetRow(targetId);
    if (!target) throw new HttpError(404, 'not_found');
    if (!this.deployer.reserve(target.id)) throw new HttpError(409, 'busy');
    let started = false;
    try {
      const repo = this.repoRow(target.repoId);
      if (!repo) throw new HttpError(404, 'not_found');
      const commits = this.cachedCommits(repo.id, target.branch);
      let sha = req.sha;
      let trigger: DeployTrigger = 'manual';
      let message: string | undefined;
      if (req.rollback) {
        if (sha === undefined) throw new HttpError(400, 'invalid_input');
        if (!this.deployer.hadSuccess(target.id, sha)) throw new HttpError(409, 'conflict');
        trigger = 'rollback';
        message = commits.find((c) => c.sha === sha)?.message;
      } else {
        sha ??= commits[0]?.sha;
        const known = sha === undefined ? undefined : commits.find((c) => c.sha === sha);
        // Only commits of the target branch can be deployed.
        if (sha === undefined || !known) throw new HttpError(409, 'conflict');
        message = known.message;
        let ci = known.ci;
        if (ci !== 'ok' && this.token() !== null) {
          // The cache may be up to 60 s old: ask GitHub once more.
          try {
            ci = await this.client.ciForSha(repo.fullName, sha);
          } catch (err) {
            this.logError(err);
          }
        }
        if (ci !== 'ok') throw new HttpError(409, 'ci_not_green');
      }
      const current = this.targetRow(target.id);
      if (!current) throw new HttpError(404, 'not_found');
      const deploy = this.deployer.start({
        target: current,
        repo,
        sha,
        trigger,
        actor: 'admin',
        ...(message !== undefined ? { message } : {}),
      });
      started = true;
      return deploy;
    } finally {
      if (!started) this.deployer.release(target.id);
    }
  }

  /** Deploys of repos (for the list route), optionally of one target. */
  deployList(q: { targetId?: string | undefined; limit: number }): Deploy[] {
    return this.deployer.list(q);
  }

  /** Number of deploys in the last `ms` (weekly report); null if GitHub is not used. */
  deployStats(sinceMs: number): { ok: number; failed: number } | null {
    const any = this.deps.db.select({ id: deployTargets.id }).from(deployTargets).limit(1).get();
    if (!any) return null;
    return this.deployer.countSince(this.deps.now() - sinceMs);
  }
}

/** deploy.key result from the agent: only an ed25519 public key is accepted. */
export const deployKeyDataSchema = z.object({
  publicKey: z
    .string()
    .max(200)
    .regex(/^ssh-ed25519 [A-Za-z0-9+/]{20,100}={0,3}( [A-Za-z0-9@._-]{1,60})?$/),
});
