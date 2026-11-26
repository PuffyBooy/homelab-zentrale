import {
  availableRepoListResponseSchema,
  branchSchema,
  commitListResponseSchema,
  deployDetailResponseSchema,
  deployListResponseSchema,
  deployLogChunkSchema,
  deployResponseSchema,
  deploySchema,
  deployTargetResponseSchema,
  githubSettingsSchema,
  homelabPathSchema,
  okResponseSchema,
  repoListResponseSchema,
  repoResponseSchema,
  type CiStatus,
  type CommitInfo,
  type Deploy,
  type DeployTarget,
  type GithubSettings,
  type RepoSummary,
} from '@hz/shared';
import type { Status, TerminalLine } from '@hz/ui';
import { api } from './api.js';
import { formatAgo, formatNumber, formatWhen, plural } from './format.js';
import type { StatusSentence } from './servers.js';

// ---------------------------------------------------------------------------
// Query keys and REST calls (routes from packages/shared/src/api/github.ts)

export const githubKey = ['github'] as const;
export const githubSettingsKey = ['github', 'settings'] as const;
export const reposKey = ['github', 'repos'] as const;
export const availableKey = ['github', 'available'] as const;
export const commitsKey = (repoId: string, branch?: string) =>
  ['github', 'commits', repoId, branch ?? ''] as const;
export const deploysKey = (targetId?: string) => ['github', 'deploys', targetId ?? 'all'] as const;
export const deployKey = (id: string) => ['github', 'deploy', id] as const;
export const deployLogKey = (id: string) => ['deploy-log', id] as const;

export type CommitEntry = CommitInfo & { liveOn: string[]; deployedBefore: string[] };
export type AvailableRepo = { fullName: string; private: boolean; tracked: boolean };
export type DeployDetail = { deploy: Deploy; log: string };

const enc = encodeURIComponent;

export function fetchGithubSettings(signal?: AbortSignal): Promise<GithubSettings> {
  return api('/api/github/settings', { schema: githubSettingsSchema, signal });
}

/** Step-up route: api() asks for the TOTP code and retries once. */
export function setGithubToken(token: string): Promise<GithubSettings> {
  return api('/api/github/token', {
    method: 'PUT',
    body: { token },
    schema: githubSettingsSchema,
  });
}

export async function deleteGithubToken(): Promise<void> {
  await api('/api/github/token', { method: 'DELETE', schema: okResponseSchema });
}

export async function fetchRepos(signal?: AbortSignal): Promise<RepoSummary[]> {
  const res = await api('/api/github/repos', { schema: repoListResponseSchema, signal });
  return res.repos;
}

export async function fetchAvailable(signal?: AbortSignal): Promise<AvailableRepo[]> {
  const res = await api('/api/github/available', {
    schema: availableRepoListResponseSchema,
    signal,
  });
  return res.repos;
}

export async function addRepo(fullName: string): Promise<RepoSummary> {
  const res = await api('/api/github/repos', {
    method: 'POST',
    body: { fullName },
    schema: repoResponseSchema,
  });
  return res.repo;
}

export async function removeRepo(id: string): Promise<void> {
  await api(`/api/github/repos/${enc(id)}`, { method: 'DELETE', schema: okResponseSchema });
}

export async function fetchCommits(
  repoId: string,
  branch: string | undefined,
  signal?: AbortSignal,
): Promise<CommitEntry[]> {
  const q = branch ? `?branch=${enc(branch)}` : '';
  const res = await api(`/api/github/repos/${enc(repoId)}/commits${q}`, {
    schema: commitListResponseSchema,
    signal,
  });
  return res.commits;
}

export interface TargetRequest {
  serverId: string;
  path: string;
  branch: string;
  method: 'compose' | 'script';
  autoDeploy: boolean;
}

export async function createTarget(repoId: string, body: TargetRequest): Promise<DeployTarget> {
  const res = await api(`/api/github/repos/${enc(repoId)}/targets`, {
    method: 'POST',
    body,
    schema: deployTargetResponseSchema,
  });
  return res.target;
}

export async function updateTarget(id: string, body: TargetRequest): Promise<DeployTarget> {
  const res = await api(`/api/github/targets/${enc(id)}`, {
    method: 'PUT',
    body,
    schema: deployTargetResponseSchema,
  });
  return res.target;
}

export async function deleteTarget(id: string): Promise<void> {
  await api(`/api/github/targets/${enc(id)}`, { method: 'DELETE', schema: okResponseSchema });
}

export async function createDeployKey(targetId: string): Promise<DeployTarget> {
  const res = await api(`/api/github/targets/${enc(targetId)}/deploy-key`, {
    method: 'POST',
    body: {},
    schema: deployTargetResponseSchema,
  });
  return res.target;
}

export async function startDeploy(
  targetId: string,
  opts: { sha?: string | undefined; rollback?: boolean | undefined } = {},
): Promise<Deploy> {
  const body: { sha?: string; rollback: boolean } = { rollback: !!opts.rollback };
  if (opts.sha) body.sha = opts.sha;
  const res = await api(`/api/github/targets/${enc(targetId)}/deploy`, {
    method: 'POST',
    body,
    schema: deployResponseSchema,
  });
  return res.deploy;
}

export async function fetchDeploys(
  targetId: string | undefined,
  limit = 20,
  signal?: AbortSignal,
): Promise<Deploy[]> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (targetId) q.set('targetId', targetId);
  const res = await api(`/api/github/deploys?${q.toString()}`, {
    schema: deployListResponseSchema,
    signal,
  });
  return res.deploys;
}

export function fetchDeploy(id: string, signal?: AbortSignal): Promise<DeployDetail> {
  return api(`/api/github/deploys/${enc(id)}`, { schema: deployDetailResponseSchema, signal });
}

// ---------------------------------------------------------------------------
// Presentation helpers (pure, unit tested)

/** Badge shows at most "30 neu"; the core caps `behind` at 30. */
export const MAX_BEHIND = 30;

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** "PuffyBooy/soundos" -> "soundos". */
export function repoShortName(fullName: string): string {
  const i = fullName.indexOf('/');
  return i === -1 ? fullName : fullName.slice(i + 1);
}

/** Commits on GitHub that no target runs yet (max over all deployed targets). */
export function repoBehind(r: Pick<RepoSummary, 'targets'>): number {
  let max = 0;
  for (const t of r.targets) if (t.liveSha && t.behind > max) max = t.behind;
  return Math.min(max, MAX_BEHIND);
}

/** "soundos-pi" or "heimserver, oracle-a1"; null when nothing runs anywhere. */
export function deployedTo(r: Pick<RepoSummary, 'targets'>): string | null {
  const names = r.targets.filter((t) => t.liveSha).map((t) => t.serverName);
  return names.length ? [...new Set(names)].join(', ') : null;
}

export function isDeploying(r: Pick<RepoSummary, 'targets'>): boolean {
  return r.targets.some((t) => t.deploying);
}

/** Repos with a deploy target on this server (ServerSwitch filter). */
export function repoOnServer(r: Pick<RepoSummary, 'targets'>, serverId: string): boolean {
  return r.targets.some((t) => t.serverId === serverId);
}

/** The target runs an older commit or none at all. */
export function needsDeploy(t: Pick<DeployTarget, 'liveSha' | 'behind'>): boolean {
  return t.liveSha === null || t.behind > 0;
}

export type DeployBlock = 'ok' | 'no_commit' | 'ci_crit' | 'ci_busy' | 'deploying';

/**
 * Deploy rule (SPEC 7, RepoRow.md): green CI, or no CI at all (`off`, repo without
 * workflows; decided in docs/QUESTIONS.md, manual deploys only). Red or running CI and a
 * running deploy on that target (lock per target) block the button.
 */
export function deployBlock(
  r: Pick<RepoSummary, 'ci' | 'lastCommit'>,
  t: Pick<DeployTarget, 'deploying'>,
): DeployBlock {
  if (t.deploying) return 'deploying';
  if (!r.lastCommit) return 'no_commit';
  if (r.ci === 'crit') return 'ci_crit';
  if (r.ci === 'busy') return 'ci_busy';
  return 'ok';
}

export const DEPLOY_BLOCK_TEXT: Record<Exclude<DeployBlock, 'ok'>, string> = {
  no_commit: 'Noch kein Commit bekannt.',
  ci_crit: 'CI ist rot. Erst den Build reparieren.',
  ci_busy: 'CI läuft noch. Deploy geht, sobald es grün ist.',
  deploying: 'Deploy läuft.',
};

/** Targets the "Deploy" button of a RepoRow deploys to: outdated and not blocked. */
export function deployableTargets(r: RepoSummary): DeployTarget[] {
  if (isDeploying(r)) return [];
  return r.targets.filter((t) => needsDeploy(t) && deployBlock(r, t) === 'ok');
}

/** Show the primary "Deploy" button in the RepoRow. */
export function showDeployButton(r: RepoSummary): boolean {
  return deployableTargets(r).length > 0;
}

const CI_RANK: Record<CiStatus, number> = { crit: 0, busy: 1, ok: 2, off: 3 };

/**
 * GitHub list order (SPEC 4 and 7): repos with new commits first (most first), then
 * red CI, running deploys, then by last commit (newest first), then by name.
 */
export function sortRepos<T extends RepoSummary>(list: readonly T[]): T[] {
  const at = (r: T): number => (r.lastCommit ? Date.parse(r.lastCommit.at) : 0);
  return [...list].sort((a, b) => {
    const nb = repoBehind(b) - repoBehind(a);
    if (nb) return nb;
    const ci = CI_RANK[a.ci] - CI_RANK[b.ci];
    if (ci) return ci;
    const dep = Number(isDeploying(b)) - Number(isDeploying(a));
    if (dep) return dep;
    const t = at(b) - at(a);
    if (t) return t;
    return a.fullName.localeCompare(b.fullName, 'de');
  });
}

/** Long German CI state, for tooltips, the detail page and screen readers. */
export const CI_TEXT: Record<CiStatus, string> = {
  ok: 'CI grün',
  crit: 'CI rot',
  busy: 'CI läuft',
  off: 'kein CI',
};

/** Short CI tag next to the status form, same as RepoRow. */
export const CI_ROW_LABEL: Record<CiStatus, string> = {
  ok: 'CI ✓',
  crit: 'CI ✗',
  busy: 'CI …',
  off: 'kein CI',
};

/** Branches worth a history: the default branch first, then the target branches. */
export function repoBranches(r: Pick<RepoSummary, 'defaultBranch' | 'targets'>): string[] {
  return [...new Set([r.defaultBranch, ...r.targets.map((t) => t.branch)])];
}

/**
 * Targets that can go back to this commit: it was deployed there successfully before
 * and is not live there now. Rollback skips the CI rule (core contract).
 */
export function rollbackTargets(
  r: Pick<RepoSummary, 'targets'>,
  c: { liveOn: readonly string[]; deployedBefore: readonly string[] },
): DeployTarget[] {
  return r.targets.filter((t) => c.deployedBefore.includes(t.id) && !c.liveOn.includes(t.id));
}

/** "a3f9c21 Lyrics-Sync · vor 2 Std", as in Dashboard.html. */
export function commitLine(c: CommitInfo | null, now: Date = new Date()): string {
  if (!c) return 'noch kein Commit';
  return `${shortSha(c.sha)} ${c.message} · ${formatAgo(new Date(c.at), now)}`;
}

/** Statussatz for /github: problems (red CI) first, then waiting commits. */
export function githubSentence(repos: readonly RepoSummary[]): StatusSentence {
  if (repos.length === 0) return { em: null, rest: 'Noch keine Repos.' };
  const total = plural(repos.length, 'Repo', 'Repos');
  const red = repos.filter((r) => r.ci === 'crit');
  if (red.length) {
    const em =
      red.length === 1 && red[0]
        ? `CI rot bei ${repoShortName(red[0].fullName)}`
        : `CI rot bei ${plural(red.length, 'Repo', 'Repos')}`;
    return { em, rest: ` · ${total}` };
  }
  const running = repos.filter(isDeploying);
  if (running.length) {
    const names = running.map((r) => repoShortName(r.fullName)).join(', ');
    return { em: null, rest: `Deploy läuft für ${names} · ${total}` };
  }
  const news = repos.filter((r) => repoBehind(r) > 0);
  if (news.length === 1 && news[0]) {
    return {
      em: null,
      rest: `${repoShortName(news[0].fullName)}: ${repoBehind(news[0])} neu · ${total}`,
    };
  }
  if (news.length) {
    return {
      em: null,
      rest: `${plural(news.length, 'Repo', 'Repos')} mit neuen Commits · ${total}`,
    };
  }
  return { em: null, rest: `Alles aktuell · ${total}` };
}

/** Statussatz for one repo (detail page). */
export function repoSentence(r: RepoSummary): StatusSentence {
  const name = repoShortName(r.fullName);
  if (r.ci === 'crit') {
    return {
      em: `CI rot bei ${name}`,
      rest: r.lastCommit ? ` · ${shortSha(r.lastCommit.sha)} ${r.lastCommit.message}` : '',
    };
  }
  const running = r.targets.filter((t) => t.deploying);
  if (running.length) {
    return {
      em: null,
      rest: `Deploy von ${name} läuft auf ${running.map((t) => t.serverName).join(', ')}.`,
    };
  }
  if (!r.targets.length) return { em: null, rest: `${name} hat noch kein Deploy-Ziel.` };
  const behind = repoBehind(r);
  if (behind) return { em: null, rest: `${name}: ${behind} neu, noch nicht deployt.` };
  if (!deployedTo(r)) return { em: null, rest: `${name} ist noch nicht deployt.` };
  return { em: null, rest: `${name} ist aktuell.` };
}

/** Default target folder (SPEC 7): /opt/homelab/apps/<repo>. */
export function defaultTargetPath(fullName: string): string {
  return `/opt/homelab/apps/${repoShortName(fullName)}`;
}

/** Where the public deploy key goes: repo → Settings → Deploy keys → Add. */
export function deployKeyUrl(fullName: string): string {
  const [owner = '', name = ''] = fullName.split('/');
  return `https://github.com/${enc(owner)}/${enc(name)}/settings/keys/new`;
}

/** "heimserver · /opt/homelab/apps/soundos · main". */
export function targetLine(t: Pick<DeployTarget, 'serverName' | 'path' | 'branch'>): string {
  return `${t.serverName} · ${t.path} · ${t.branch}`;
}

/** Footer of the repo list: "Abgleich alle 60 s · zuletzt 23:04 · 4.812 Anfragen übrig". */
export function pollText(
  s: Pick<GithubSettings, 'lastPollAt' | 'rateRemaining'>,
  now: Date = new Date(),
): string {
  const parts = ['Abgleich alle 60 s'];
  parts.push(
    s.lastPollAt ? `zuletzt ${formatWhen(new Date(s.lastPollAt), now)}` : 'noch kein Abgleich',
  );
  if (s.rateRemaining != null) {
    parts.push(
      `${formatNumber(s.rateRemaining, 0)} ${s.rateRemaining === 1 ? 'Anfrage' : 'Anfragen'} übrig`,
    );
  }
  return parts.join(' · ');
}

// ---- deploys -------------------------------------------------------------------

export function isDeployRunning(d: Pick<Deploy, 'status'>): boolean {
  return d.status === 'queued' || d.status === 'running';
}

export const DEPLOY_STATUS: Record<Deploy['status'], { status: Status; label: string }> = {
  queued: { status: 'busy', label: 'Wartet' },
  running: { status: 'busy', label: 'Läuft' },
  ok: { status: 'ok', label: 'Erfolgreich' },
  failed: { status: 'crit', label: 'Fehlgeschlagen' },
  cancelled: { status: 'off', label: 'Abgebrochen' },
};

export const TRIGGER_LABEL: Record<Deploy['trigger'], string> = {
  manual: 'per Knopf',
  auto: 'automatisch',
  rollback: 'Rollback',
};

/** "42 s", "3 Min 5 s"; null while running. */
export function deployDuration(d: Pick<Deploy, 'startedAt' | 'finishedAt'>): string | null {
  if (!d.finishedAt) return null;
  const s = Math.max(0, Math.round((Date.parse(d.finishedAt) - Date.parse(d.startedAt)) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} Min ${rest} s` : `${m} Min`;
}

export interface DeployResult {
  tone: 'ok' | 'crit' | 'info' | 'warn';
  title: string;
  body: string;
}

/** Result as Alert text: title = what + where, body = commit, duration, summary. */
export function deployResult(d: Deploy, repoName: string, serverName: string): DeployResult {
  const what = d.trigger === 'rollback' ? 'Rollback' : 'Deploy';
  const dur = deployDuration(d);
  const parts = [shortSha(d.sha), dur ? `nach ${dur}` : null, d.summary].filter(Boolean);
  const body = parts.join(' · ');
  switch (d.status) {
    case 'ok':
      return {
        tone: 'ok',
        title:
          d.trigger === 'rollback'
            ? `${repoName} auf ${serverName} zurückgesetzt`
            : `${repoName} auf ${serverName} deployt`,
        body,
      };
    case 'failed':
      return {
        tone: 'crit',
        title: `${what} von ${repoName} auf ${serverName} fehlgeschlagen`,
        body,
      };
    case 'cancelled':
      return { tone: 'warn', title: `${what} von ${repoName} auf ${serverName} abgebrochen`, body };
    default:
      return { tone: 'info', title: `${what} von ${repoName} läuft auf ${serverName}`, body };
  }
}

// ---- live deploy log -------------------------------------------------------------

/** Lines kept per deploy log in the cache and in the DOM. */
export const MAX_DEPLOY_LINES = 2000;

export interface DeployLogBuffer {
  /** Chunk ids already applied (a repeated chunk never shows twice). */
  seen: string[];
  lines: TerminalLine[];
  /** True once a snapshot arrived; then the buffer is the full log so far. */
  complete: boolean;
}

export const emptyDeployLog: DeployLogBuffer = { seen: [], lines: [], complete: false };

type Channel = 'stdout' | 'stderr' | 'progress';

/** Stored log or chunk text -> Terminal lines. stderr is `err`, progress is `dim`. */
export function textToLines(text: string, channel: Channel = 'stdout'): TerminalLine[] {
  const kind = channel === 'stderr' ? 'err' : channel === 'progress' ? 'dim' : undefined;
  const parts = text.replace(/\r\n/g, '\n').split('\n');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((p) => (kind ? { text: p, kind } : { text: p }));
}

function cap(lines: TerminalLine[]): TerminalLine[] {
  return lines.length > MAX_DEPLOY_LINES ? lines.slice(-MAX_DEPLOY_LINES) : lines;
}

/**
 * Applies the items of topic `deploy:<id>`. Items are log chunks
 * ({ id, channel, text }); a snapshot may also be `{ log }` (stored log so far).
 * Anything else is ignored.
 */
export function applyDeployChunks(
  prev: DeployLogBuffer,
  items: readonly unknown[],
  snapshot = false,
): DeployLogBuffer {
  const seen = snapshot ? new Set<string>() : new Set(prev.seen);
  let lines = snapshot ? [] : [...prev.lines];
  for (const raw of items) {
    const chunk = deployLogChunkSchema.safeParse(raw);
    if (!chunk.success) continue;
    if (seen.has(chunk.data.id)) continue;
    seen.add(chunk.data.id);
    lines.push(...textToLines(chunk.data.text, chunk.data.channel));
  }
  lines = cap(lines);
  const ids = [...seen];
  return {
    seen: ids.length > MAX_DEPLOY_LINES ? ids.slice(-MAX_DEPLOY_LINES) : ids,
    lines,
    complete: prev.complete || snapshot,
  };
}

/** Snapshot data of `deploy:<id>`: a list of chunks, `{ chunks }`, or `{ log }`. */
export function deploySnapshotToBuffer(data: unknown): DeployLogBuffer | null {
  if (Array.isArray(data)) return applyDeployChunks(emptyDeployLog, data, true);
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    if (Array.isArray(o.chunks)) return applyDeployChunks(emptyDeployLog, o.chunks, true);
    if (typeof o.log === 'string') {
      return { seen: [], lines: cap(textToLines(o.log)), complete: true };
    }
  }
  return null;
}

/** An upsert item may carry the deploy itself (status change). */
export function parseDeployItem(raw: unknown): Deploy | null {
  const d = deploySchema.safeParse(raw);
  return d.success ? d.data : null;
}

/**
 * Lines to show: while the live buffer has content (or a snapshot) it wins; after the
 * deploy finished, the stored log from REST is complete and wins.
 */
export function shownDeployLines(
  detail: DeployDetail | undefined,
  live: DeployLogBuffer | undefined,
): TerminalLine[] {
  const stored = detail?.log ? textToLines(detail.log) : [];
  if (detail && !isDeployRunning(detail.deploy) && stored.length) return cap(stored);
  if (live && (live.complete || live.lines.length)) return live.lines;
  return cap(stored);
}

// ---- target form -----------------------------------------------------------------

export interface TargetForm {
  serverId: string;
  path: string;
  branch: string;
  method: 'compose' | 'script';
  autoDeploy: boolean;
}

export type TargetFormErrors = Partial<Record<keyof TargetForm, string>>;

export function emptyTargetForm(r: Pick<RepoSummary, 'fullName' | 'defaultBranch'>): TargetForm {
  return {
    serverId: '',
    path: defaultTargetPath(r.fullName),
    branch: r.defaultBranch,
    method: 'compose',
    autoDeploy: false,
  };
}

export function targetToForm(t: DeployTarget): TargetForm {
  return {
    serverId: t.serverId,
    path: t.path,
    branch: t.branch,
    method: t.method,
    autoDeploy: t.autoDeploy,
  };
}

export function formToTarget(
  f: TargetForm,
): { ok: true; body: TargetRequest } | { ok: false; errors: TargetFormErrors } {
  const errors: TargetFormErrors = {};
  const path = f.path.trim();
  const branch = f.branch.trim();
  if (!f.serverId) errors.serverId = 'Server auswählen.';
  if (!homelabPathSchema.safeParse(path).success) {
    errors.path = 'Pfad unter /opt/homelab/, ohne „..“ und doppelte Schrägstriche.';
  }
  if (!branchSchema.safeParse(branch).success) errors.branch = 'Branch-Name ungültig.';
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    body: { serverId: f.serverId, path, branch, method: f.method, autoDeploy: f.autoDeploy },
  };
}

/** Token format the core accepts (fine-grained PAT or classic). */
export function tokenError(token: string): string | null {
  const t = token.trim();
  if (!t) return 'Token eingeben.';
  if (!/^(github_pat_|ghp_)[A-Za-z0-9_]+$/.test(t) || t.length < 20 || t.length > 255) {
    return 'Das ist kein GitHub-Token. Er beginnt mit github_pat_ oder ghp_.';
  }
  return null;
}
