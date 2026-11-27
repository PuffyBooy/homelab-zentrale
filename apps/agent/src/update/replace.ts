import {
  buildRecreatePlan,
  type ImageConfigLike,
  type UpdateDocker,
  type UpdateInspect,
} from '../actions/container-update.js';
import type { Logger } from '../log.js';

/**
 * M17: replaces one of the two protected containers (core, agent) with the same
 * configuration on a new image and waits for its Docker health check.
 *
 *   rename old -> create new (same name, same config) -> connect networks
 *   -> stop old -> start new -> wait until healthy (max 3 min) -> remove old
 *
 * Unlike container.update (updateContainer) this accepts compose containers:
 * the labels, including com.docker.compose.*, are carried over, so compose keeps
 * treating the new container as its own. It is only ever called for the target
 * of update.apply (core) and by the updater helper (agent); container.* keeps
 * refusing both.
 *
 * Outcomes: updated; rolled_back (the new container did not become healthy, the
 * old one runs again); failed (nothing started or a step before the health wait
 * failed; the message says whether the old container was restored).
 */

export const HEALTH_TIMEOUT_MS = 3 * 60_000;
export const HEALTH_POLL_MS = 2000;
/** Images without a health check count as healthy after running this long without a restart. */
export const NO_HEALTH_STABLE_MS = 30_000;

export interface ReplaceDocker extends UpdateDocker {
  listContainers(opts: { all: boolean; filters?: string }): Promise<unknown[]>;
}

export type Ready = { ok: true } | { ok: false; reason: string };

export interface WaitOptions {
  timeoutMs?: number;
  pollMs?: number;
  stableMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface StateLike {
  Status?: string;
  Running?: boolean;
  Restarting?: boolean;
  ExitCode?: number;
  Health?: { Status?: string } | null;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Polls `docker inspect` until the container is healthy. unhealthy, exited or
 * restarting fail at once; no answer within the timeout fails too. Without a
 * health check: running for `stableMs` with an unchanged RestartCount.
 */
export async function waitHealthy(
  docker: Pick<UpdateDocker, 'getContainer'>,
  id: string,
  o: WaitOptions = {},
): Promise<Ready> {
  const sleep = o.sleep ?? realSleep;
  const now = o.now ?? Date.now;
  const timeout = o.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const stable = o.stableMs ?? NO_HEALTH_STABLE_MS;
  const start = now();
  let restarts: number | null = null;
  let runningSince: number | null = null;
  for (;;) {
    let info: { State?: StateLike; RestartCount?: number };
    try {
      info = (await docker.getContainer(id).inspect()) as typeof info;
    } catch {
      return { ok: false, reason: 'new container disappeared' };
    }
    const st = info.State ?? {};
    const health = st.Health?.Status;
    if (health === 'healthy') return { ok: true };
    if (health === 'unhealthy') return { ok: false, reason: 'health check failed' };
    if (st.Restarting) return { ok: false, reason: 'new container keeps restarting' };
    if (!st.Running) {
      return { ok: false, reason: `new container exited (code ${st.ExitCode ?? '?'})` };
    }
    if (!health || health === 'none') {
      const rc = info.RestartCount ?? 0;
      if (restarts === null) restarts = rc;
      if (rc !== restarts) return { ok: false, reason: 'new container restarted' };
      runningSince ??= now();
      if (now() - runningSince >= stable) return { ok: true };
    }
    if (now() - start >= timeout) {
      return { ok: false, reason: `not healthy within ${Math.round(timeout / 60_000)} min` };
    }
    await sleep(o.pollMs ?? HEALTH_POLL_MS);
  }
}

/** Progress of replaceContainer, for the crash journal (journal.ts). */
export type ReplaceStep =
  | { phase: 'renamed' }
  | { phase: 'created'; newId: string }
  | { phase: 'stopped' }
  | { phase: 'started' };

export interface ReplaceOptions {
  log: Logger;
  /** Called after each step; a throw rolls back like a failed step. */
  onStep?: (step: ReplaceStep) => Promise<void>;
  /** Waits for the started new container (default: waitHealthy). */
  waitReady?: (id: string) => Promise<Ready>;
  now?: () => number;
}

export interface ReplaceResult {
  outcome: 'updated' | 'rolled_back' | 'failed';
  message?: string;
  oldRemoved?: boolean;
}

const statusOf = (err: unknown) => (err as { statusCode?: number } | null)?.statusCode;

/**
 * Recreates `info` from `imageRef` (the tag it already uses; the caller pulled it).
 * Never throws for docker errors; the result says what happened.
 */
export async function replaceContainer(
  docker: UpdateDocker,
  info: UpdateInspect,
  imageRef: string,
  opts: ReplaceOptions,
): Promise<ReplaceResult> {
  const log = opts.log;
  const oldImage = (await docker
    .getImage(info.Image)
    .inspect()
    .catch(() => null)) as ImageConfigLike | null;
  const plan = buildRecreatePlan(info, oldImage, imageRef);
  const name = plan.create.name as string;
  const now = opts.now ?? Date.now;
  const tmpName = `${name}-hz-old-${now().toString(36)}`.slice(0, 120);
  const wasRunning = info.State.Running || info.State.Restarting === true;
  const old = docker.getContainer(info.Id);
  const waitReady = opts.waitReady ?? ((id: string) => waitHealthy(docker, id));

  try {
    await old.rename({ name: tmpName });
  } catch {
    return { outcome: 'failed', message: 'update failed at rename, nothing changed' };
  }

  let step = 'journal';
  let createdId: string | null = null;
  let reason = '';
  const onStep = opts.onStep ?? (async () => undefined);
  try {
    await onStep({ phase: 'renamed' });
    step = 'create';
    const created = await docker.createContainer(plan.create);
    createdId = created.id;
    await onStep({ phase: 'created', newId: createdId });
    step = 'network';
    for (const [net, ep] of plan.extraNetworks) {
      await docker.getNetwork(net).connect({ Container: createdId, EndpointConfig: ep });
    }
    if (wasRunning) {
      step = 'stop';
      try {
        await old.stop({ t: 30 });
      } catch (err) {
        if (statusOf(err) !== 304) throw err;
      }
      await onStep({ phase: 'stopped' });
      step = 'start';
      await docker.getContainer(createdId).start();
      await onStep({ phase: 'started' });
      step = 'health';
      const ready = await waitReady(createdId);
      if (!ready.ok) {
        reason = ready.reason;
        throw new Error(ready.reason);
      }
    }
  } catch {
    log.warn('replace failed, rolling back', { container: name, step });
    if (createdId) {
      await docker
        .getContainer(createdId)
        .remove({ force: true, v: false })
        .catch(() => log.error('rollback: removing the new container failed', { container: name }));
    }
    const problems: string[] = [];
    await old.rename({ name }).catch(() => {
      problems.push(`rename back failed (old container: ${tmpName})`);
    });
    if (wasRunning) {
      await old.start().catch((err: unknown) => {
        if (statusOf(err) !== 304) problems.push('starting the old container failed');
      });
    }
    if (problems.length > 0) {
      log.error('rollback incomplete', { container: name, step });
      return {
        outcome: 'failed',
        message: `rollback failed: update failed at ${step}; ${problems.join(', ')}`.slice(0, 300),
      };
    }
    if (step === 'health') {
      return {
        outcome: 'rolled_back',
        message: `${reason}; old container restored`.slice(0, 300),
      };
    }
    return {
      outcome: 'failed',
      message: `update failed at ${step}; old container restored`,
    };
  }

  let oldRemoved = true;
  try {
    await old.remove({ v: false, force: true });
  } catch {
    oldRemoved = false;
    log.warn('old container could not be removed', { container: tmpName });
  }
  return { outcome: 'updated', oldRemoved };
}
