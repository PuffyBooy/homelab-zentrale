import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Deploy, RpcParamsInput, deployLogChunkSchema, deployTriggerSchema } from '@hz/shared';
import type { z } from 'zod';
import { RpcError, type AgentHub, type RpcStream, type StreamChunk } from '../agents/hub.js';
import type { AlertService } from '../alerts/service.js';
import { sanitizeReason } from '../checks/service.js';
import type { Clock } from '../clock.js';
import { randomToken } from '../crypto.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import {
  deploys,
  deployTargets,
  githubRepos,
  servers,
  type DeployRow,
  type DeployTargetRow,
  type GithubRepoRow,
} from '../db/schema.js';
import { clockTime } from '../format.js';

export type DeployTrigger = z.infer<typeof deployTriggerSchema>;
export type DeployLogChunk = z.infer<typeof deployLogChunkSchema>;

/** A deploy that runs longer is cancelled and marked failed. */
export const DEPLOY_TIMEOUT_MS = 20 * 60_000;
/** Stored log tail per deploy. */
export const DEPLOY_LOG_MAX_BYTES = 256 * 1024;
const CHUNK_MAX_CHARS = 64 * 1024;
const RESTART_SUMMARY = 'Zentrale neu gestartet';

const TOPIC_RE = /^deploy:([A-Za-z0-9_-]{1,64})$/;
export const deployTopic = (id: string): string => `deploy:${id}`;

export const shortSha = (sha: string): string => sha.slice(0, 7);

/** Keeps the last `max` UTF-8 bytes of a text (no broken character at the start). */
export function tailBytes(text: string, max = DEPLOY_LOG_MAX_BYTES): string {
  if (text.length * 3 <= max || Buffer.byteLength(text, 'utf8') <= max) return text;
  const buf = Buffer.from(text, 'utf8');
  return buf
    .subarray(buf.length - max)
    .toString('utf8')
    .replace(/^�+/, '');
}

function splitText(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_MAX_CHARS)
    out.push(text.slice(i, i + CHUNK_MAX_CHARS));
  return out;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

export function toDeploy(row: DeployRow): Deploy {
  return {
    id: row.id,
    targetId: row.targetId,
    sha: row.sha,
    status: row.status as Deploy['status'],
    trigger: row.triggeredBy as DeployTrigger,
    startedAt: new Date(row.startedAt).toISOString(),
    finishedAt: iso(row.finishedAt),
    summary: row.summary,
  };
}

/** Short German summary of a failed stream end. */
export function failureSummary(
  method: string,
  end: { code: number; error?: string; detail?: string },
  timedOut: boolean,
): string {
  if (timedOut) return 'Zeitüberschreitung nach 20 Min';
  const detail = end.detail ?? '';
  // Refusals of deploy.run by the agent (rpc error not_allowed with a message).
  if (/not empty and not a git repository/i.test(detail))
    return 'Zielordner ist nicht leer und kein Git-Repo';
  if (/origin\b.*does not match/i.test(detail)) return 'Zielordner gehört zu einem anderen Repo';
  if (end.code === 124) return 'Zeitüberschreitung im Agent (Exit 124)';
  if (end.code === 127) return 'Programm fehlt auf dem Server (Exit 127)';
  switch (end.error) {
    case 'disconnected':
      return 'Verbindung zum Agent verloren';
    case 'cancelled':
      return 'Abgebrochen';
    case 'not_allowed':
      return 'Vom Agent abgelehnt (Agent aktualisieren)';
    case 'invalid_params':
      return 'Vom Agent abgelehnt (ungültige Parameter)';
    case 'bad_path':
      return 'Pfad vom Agent abgelehnt';
    case 'busy':
      return 'Ordner ist gerade gesperrt';
    case 'timeout':
      return 'Zeitüberschreitung im Agent';
    case 'not_found':
      return 'Nicht gefunden (Repo, Commit oder deploy.sh)';
    case undefined:
    case '':
    case 'failed':
      break;
    default: {
      const reason = sanitizeReason(end.error);
      if (reason !== '') return end.code > 0 ? `${reason} (Exit ${end.code})` : reason;
    }
  }
  const what = method === 'script' ? 'deploy.sh' : 'compose up';
  return end.code > 0 ? `${what} fehlgeschlagen (Exit ${end.code})` : `${what} fehlgeschlagen`;
}

interface Running {
  deployId: string;
  targetId: string;
  repoId: string;
  sha: string;
  startedAt: number;
  stream: RpcStream | null;
  chunks: DeployLogChunk[];
  bytes: number;
  seq: number;
  timedOut: boolean;
}

export interface DeployStart {
  target: DeployTargetRow;
  repo: GithubRepoRow;
  sha: string;
  trigger: DeployTrigger;
  actor: 'admin' | 'system';
  /** First line of the commit message, for the alert. */
  message?: string;
}

/** What the deployer needs from the live hub. */
export interface DeployPublisher {
  append(topic: string, items: DeployLogChunk[]): void;
}

export interface DeployerDeps {
  db: Db;
  now: Clock;
  hub: Pick<AgentHub, 'stream' | 'isConnected'>;
  alerts: AlertService;
  log: FastifyBaseLogger;
  /** A target changed (deploying flag, liveSha). */
  onTargetChange: (repoId: string) => void;
}

/**
 * Runs `deploy.run` on the target's agent as a stream: one deploy per target
 * at a time (lock), log chunks to the live topic `deploy:<id>` and the tail
 * (256 KB) into the database, result as alert and audit entry.
 */
export class Deployer {
  /** Targets with a deploy being prepared or running (the lock). */
  private readonly locked = new Set<string>();
  private readonly runs = new Map<string, Running>();
  private readonly background = new Set<Promise<void>>();
  private publisher: DeployPublisher | null = null;

  constructor(private readonly deps: DeployerDeps) {}

  setPublisher(p: DeployPublisher): void {
    this.publisher = p;
  }

  isBusy(targetId: string): boolean {
    return this.locked.has(targetId);
  }

  /** Takes the lock of a target. False if a deploy is already being prepared or running. */
  reserve(targetId: string): boolean {
    if (this.locked.has(targetId)) return false;
    this.locked.add(targetId);
    return true;
  }

  release(targetId: string): void {
    this.locked.delete(targetId);
  }

  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  /** Deploys that were running when the core stopped are failed now. */
  recoverAfterRestart(): void {
    const rows = this.deps.db
      .select()
      .from(deploys)
      .where(inArray(deploys.status, ['queued', 'running']))
      .all();
    const now = this.deps.now();
    for (const row of rows) {
      this.deps.db
        .update(deploys)
        .set({ status: 'failed', summary: RESTART_SUMMARY, finishedAt: now })
        .where(eq(deploys.id, row.id))
        .run();
      writeAudit(this.deps.db, now, {
        actor: 'system',
        action: 'deploy.finished',
        target: row.id,
        details: {
          targetId: row.targetId,
          sha: row.sha,
          status: 'failed',
          summary: RESTART_SUMMARY,
        },
      });
      const ctx = this.context(row.targetId);
      if (ctx) this.failureAlert(ctx.target, ctx.repo, ctx.serverName, row.sha, RESTART_SUMMARY);
    }
  }

  /** Cancels deploys that run longer than 20 min (scheduler, fake clock in tests). */
  checkTimeouts(): void {
    const now = this.deps.now();
    for (const run of this.runs.values()) {
      if (run.timedOut || now - run.startedAt < DEPLOY_TIMEOUT_MS) continue;
      run.timedOut = true;
      run.stream?.cancel();
    }
  }

  /** Stops all streams (core shutdown). The rows stay `running` and are failed on the next start. */
  shutdown(): void {
    for (const run of this.runs.values()) {
      const s = run.stream;
      run.stream = null;
      s?.removeAllListeners();
    }
  }

  // ---- read side -------------------------------------------------------------

  row(id: string): DeployRow | undefined {
    return this.deps.db.select().from(deploys).where(eq(deploys.id, id)).get();
  }

  list(q: { targetId?: string | undefined; limit: number }): Deploy[] {
    const base = this.deps.db.select().from(deploys);
    const rows = (q.targetId ? base.where(eq(deploys.targetId, q.targetId)) : base)
      .orderBy(desc(deploys.startedAt), desc(sql`rowid`))
      .limit(q.limit)
      .all();
    return rows.map(toDeploy);
  }

  /** Stored log, or the live tail of a running deploy. */
  logOf(id: string): string | null {
    const run = this.runByDeploy(id);
    if (run) return tailBytes(run.chunks.map((c) => c.text).join(''));
    return this.row(id)?.logText ?? null;
  }

  /** Whether `sha` had a successful deploy on this target (rollback rule). */
  hadSuccess(targetId: string, sha: string): boolean {
    return (
      this.deps.db
        .select({ id: deploys.id })
        .from(deploys)
        .where(and(eq(deploys.targetId, targetId), eq(deploys.sha, sha), eq(deploys.status, 'ok')))
        .get() !== undefined
    );
  }

  /** Shas with a successful deploy per target. */
  successfulShas(targetIds: readonly string[]): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    if (targetIds.length === 0) return out;
    const rows = this.deps.db
      .selectDistinct({ targetId: deploys.targetId, sha: deploys.sha })
      .from(deploys)
      .where(and(inArray(deploys.targetId, [...targetIds]), eq(deploys.status, 'ok')))
      .all();
    for (const r of rows) {
      const set = out.get(r.targetId) ?? new Set<string>();
      set.add(r.sha);
      out.set(r.targetId, set);
    }
    return out;
  }

  countSince(since: number): { ok: number; failed: number } {
    const rows = this.deps.db
      .select({ status: deploys.status, n: sql<number>`count(*)` })
      .from(deploys)
      .where(gte(deploys.startedAt, since))
      .groupBy(deploys.status)
      .all();
    let ok = 0;
    let failed = 0;
    for (const r of rows) {
      if (r.status === 'ok') ok += r.n;
      else if (r.status === 'failed') failed += r.n;
    }
    return { ok, failed };
  }

  // ---- live topic deploy:<id> --------------------------------------------------

  matches(topic: string): boolean {
    return TOPIC_RE.test(topic);
  }

  has(topic: string): boolean {
    const id = TOPIC_RE.exec(topic)?.[1];
    return id !== undefined && this.row(id) !== undefined;
  }

  /** Snapshot: the chunks so far (running) or the stored log in chunks (finished). */
  snapshot(topic: string): DeployLogChunk[] | undefined {
    const id = TOPIC_RE.exec(topic)?.[1];
    if (id === undefined) return undefined;
    const run = this.runByDeploy(id);
    if (run) return [...run.chunks];
    const row = this.row(id);
    if (!row) return undefined;
    return splitText(row.logText).map((text, i) => ({ id: `log-${i}`, channel: 'stdout', text }));
  }

  private runByDeploy(id: string): Running | undefined {
    for (const r of this.runs.values()) if (r.deployId === id) return r;
    return undefined;
  }

  // ---- running a deploy --------------------------------------------------------

  /**
   * Starts a deploy. The caller holds the target lock (reserve); from here the
   * deployer owns it and releases it when the deploy ends. Fails fast (status
   * failed, summary) if the agent is offline or a private repo has no deploy key.
   */
  start(s: DeployStart): Deploy {
    const { target, repo, sha } = s;
    const now = this.deps.now();
    const row: DeployRow = {
      id: randomToken(12),
      targetId: target.id,
      sha,
      status: 'running',
      triggeredBy: s.trigger,
      summary: null,
      logText: '',
      startedAt: now,
      finishedAt: null,
    };
    this.locked.add(target.id);
    this.deps.db.insert(deploys).values(row).run();
    writeAudit(this.deps.db, now, {
      actor: s.actor,
      action: 'deploy.started',
      target: row.id,
      details: {
        targetId: target.id,
        repo: repo.fullName,
        serverId: target.serverId,
        sha,
        trigger: s.trigger,
      },
    });
    const run: Running = {
      deployId: row.id,
      targetId: target.id,
      repoId: repo.id,
      sha,
      startedAt: now,
      stream: null,
      chunks: [],
      bytes: 0,
      seq: 0,
      timedOut: false,
    };
    this.runs.set(target.id, run);
    this.deps.onTargetChange(repo.id);

    const serverName = this.serverName(target.serverId);
    const finishWith = (status: 'ok' | 'failed', summary: string): void =>
      this.finish(run, s, serverName, status, summary);

    let params: RpcParamsInput<'deploy.run'>;
    if (repo.private) {
      if (!target.keyName) {
        finishWith('failed', 'Kein Deploy-Key: zuerst erzeugen und bei GitHub eintragen');
        return this.result(row.id);
      }
      params = {
        dir: target.path,
        repoUrl: `git@github.com:${repo.fullName}.git`,
        sha,
        method: target.method as 'compose' | 'script',
        keyName: target.keyName,
      };
    } else {
      params = {
        dir: target.path,
        repoUrl: `https://github.com/${repo.fullName}.git`,
        sha,
        method: target.method as 'compose' | 'script',
      };
    }
    if (!this.deps.hub.isConnected(target.serverId)) {
      finishWith('failed', 'Agent offline');
      return this.result(row.id);
    }
    let stream: RpcStream;
    try {
      // Real-time safety net; the 20-min rule itself runs on the core clock (checkTimeouts).
      stream = this.deps.hub.stream(target.serverId, 'deploy.run', params, {
        timeoutMs: DEPLOY_TIMEOUT_MS + 5 * 60_000,
      });
    } catch (err) {
      const code = err instanceof RpcError ? err.code : 'failed';
      finishWith(
        'failed',
        code === 'offline'
          ? 'Agent offline'
          : failureSummary(target.method, { code: -1, error: code }, false),
      );
      return this.result(row.id);
    }
    run.stream = stream;
    this.progress(run, `Deploy ${shortSha(sha)} auf ${serverName} gestartet`);
    stream.on('data', (c: StreamChunk) => {
      if (this.runs.get(target.id) === run && run.stream === stream) this.ingest(run, c);
    });
    const done = stream.done.then((end) => {
      if (this.runs.get(target.id) !== run || run.stream !== stream) return;
      if (end.code === 0 && !run.timedOut) finishWith('ok', 'Erfolgreich deployt');
      else finishWith('failed', failureSummary(target.method, end, run.timedOut));
    });
    this.track(done);
    return this.result(row.id);
  }

  private result(id: string): Deploy {
    const row = this.row(id);
    if (!row) throw new Error('deploy vanished');
    return toDeploy(row);
  }

  private track(p: Promise<void>): void {
    const tracked = p.catch((err: unknown) => {
      this.deps.log.error(
        { err: err instanceof Error ? { name: err.name, stack: err.stack } : 'error' },
        'deploy failed internally',
      );
    });
    this.background.add(tracked);
    void tracked.finally(() => this.background.delete(tracked));
  }

  private ingest(run: Running, c: StreamChunk): void {
    // Only the text is taken from the agent; the topic comes from the deploy id.
    for (const text of splitText(c.chunk)) this.push(run, c.channel, text);
  }

  private progress(run: Running, text: string): void {
    this.push(run, 'progress', `${text}\n`);
  }

  private push(run: Running, channel: DeployLogChunk['channel'], text: string): void {
    if (text === '') return;
    const chunk: DeployLogChunk = { id: String(run.seq++), channel, text };
    run.chunks.push(chunk);
    run.bytes += Buffer.byteLength(text, 'utf8');
    while (run.bytes > DEPLOY_LOG_MAX_BYTES && run.chunks.length > 1) {
      const old = run.chunks.shift();
      if (old) run.bytes -= Buffer.byteLength(old.text, 'utf8');
    }
    this.publisher?.append(deployTopic(run.deployId), [chunk]);
  }

  private finish(
    run: Running,
    s: DeployStart,
    serverName: string,
    status: 'ok' | 'failed',
    summary: string,
  ): void {
    if (this.runs.get(run.targetId) !== run) return;
    const { target, repo, sha } = s;
    const now = this.deps.now();
    this.progress(
      run,
      status === 'ok'
        ? `Deploy erfolgreich (${shortSha(sha)})`
        : `Deploy fehlgeschlagen: ${summary}`,
    );
    run.stream?.removeAllListeners('data');
    run.stream = null;
    const logText = tailBytes(run.chunks.map((c) => c.text).join(''));
    this.deps.db
      .update(deploys)
      .set({ status, summary, logText, finishedAt: now })
      .where(eq(deploys.id, run.deployId))
      .run();
    if (status === 'ok') {
      this.deps.db
        .update(deployTargets)
        .set({ liveSha: sha, updatedAt: now })
        .where(eq(deployTargets.id, target.id))
        .run();
    }
    writeAudit(this.deps.db, now, {
      actor: 'system',
      action: 'deploy.finished',
      target: run.deployId,
      details: { targetId: target.id, repo: repo.fullName, sha, status, summary },
    });
    if (status === 'ok') this.okAlert(target, repo, serverName, sha, s.message);
    else this.failureAlert(target, repo, serverName, sha, summary);
    this.runs.delete(run.targetId);
    this.locked.delete(run.targetId);
    this.deps.onTargetChange(repo.id);
  }

  private okAlert(
    target: DeployTargetRow,
    repo: GithubRepoRow,
    serverName: string,
    sha: string,
    message: string | undefined,
  ): void {
    const title = `${repo.fullName} auf ${serverName} deployt (${shortSha(sha)})`;
    const body = message
      ? `„${message}“ läuft seit ${clockTime(this.deps.now())} in ${target.path}.`
      : `Läuft seit ${clockTime(this.deps.now())} in ${target.path}.`;
    const failedKey = `deploy:${target.id}:failed`;
    if (this.deps.alerts.active(failedKey)) this.deps.alerts.resolve(failedKey, { title, body });
    else
      this.deps.alerts.log(`deploy:${target.id}`, 'info', title, body, target.serverId, 'github');
  }

  private failureAlert(
    target: DeployTargetRow,
    repo: GithubRepoRow,
    serverName: string,
    sha: string,
    reason: string,
  ): void {
    this.deps.alerts.raise(
      `deploy:${target.id}:failed`,
      'crit',
      `Deploy von ${repo.fullName} auf ${serverName} fehlgeschlagen`,
      `${reason} (${shortSha(sha)}, ${clockTime(this.deps.now())}). Log unter GitHub ansehen. Als LIVE gilt weiter ${target.liveSha ? shortSha(target.liveSha) : 'nichts'}; der Ordner kann schon den neuen Stand haben, ein Rollback stellt den alten sicher her.`,
      target.serverId,
      'github',
    );
  }

  private serverName(serverId: string): string {
    return (
      this.deps.db
        .select({ name: servers.name })
        .from(servers)
        .where(eq(servers.id, serverId))
        .get()?.name ?? serverId
    );
  }

  private context(
    targetId: string,
  ): { target: DeployTargetRow; repo: GithubRepoRow; serverName: string } | null {
    const target = this.deps.db
      .select()
      .from(deployTargets)
      .where(eq(deployTargets.id, targetId))
      .get();
    if (!target) return null;
    const repo = this.deps.db
      .select()
      .from(githubRepos)
      .where(eq(githubRepos.id, target.repoId))
      .get();
    if (!repo) return null;
    return { target, repo, serverName: this.serverName(target.serverId) };
  }
}
