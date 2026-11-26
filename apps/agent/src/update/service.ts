import { stat } from 'node:fs/promises';
import {
  updateCheckDataSchema,
  type AgentEvent,
  type ImageVersion,
  type UpdateCheckData,
  type UpdateTarget,
} from '@hz/shared';
import {
  hiddenDuringUpdate,
  pullImage,
  pullableRef,
  type UpdateInspect,
} from '../actions/container-update.js';
import { ActionError } from '../actions/types.js';
import type { Logger } from '../log.js';
import { ROLE_LABEL } from '../actions/protected.js';
import { buildHelperCreate } from './helper.js';
import {
  journalStep,
  listJournals,
  removeJournal,
  resumeSwap,
  writeJournal,
  type Journal,
} from './journal.js';
import { replaceContainer, waitHealthy, type ReplaceDocker, type WaitOptions } from './replace.js';
import { flushResults, writeResult, type UpdateResultEvent } from './results.js';
import { findOwnContainer, findTarget, type TargetOptions } from './target.js';
import { imageVersion, type ImageMetaLike } from './versions.js';

/**
 * M17 update.check / update.apply on the agent.
 *
 * check: pull the tag the target container already runs (Config.Image; refused
 * when it is an image id), compare the new image id with the running one.
 * apply: answers { accepted: true } at once and runs in the background; one
 * update at a time (busy). The outcome is written to /data first and then sent
 * as event update_result (results.ts); flush() resends after every welcome.
 * - core: replaceContainer with a 3 min health wait, rollback on failure.
 * - agent: start the updater helper (helper.ts, updater.ts) from the current image.
 */

export const PULL_TIMEOUT_MS = 10 * 60_000;
/** The agent busy flag clears by itself if the helper never replaced us. */
export const AGENT_BUSY_MS = 10 * 60_000;
/** Cleanup of the exited helper after its result went out. */
export const RECONCILE_AFTER_MS = 30_000;

export interface UpdateServiceOptions {
  docker: ReplaceDocker;
  dataDir: string;
  dockerSocket: string;
  log: Logger;
  /** Sends an event to the core; false when offline. */
  emit: (msg: AgentEvent) => boolean;
  target?: TargetOptions;
  wait?: WaitOptions;
  pullTimeoutMs?: number;
  now?: () => number;
  /** stat() of data dir / socket (tests). */
  statPath?: (p: string) => Promise<{ uid: number; gid: number; mode: number }>;
  /** Schedules the clearing of the agent busy flag (tests). */
  setTimer?: (fn: () => void, ms: number) => void;
}

type Pulled = { ok: true; image: ImageMetaLike } | { ok: false };

export class UpdateService {
  private busy: UpdateTarget | null = null;
  /** Background job of the last apply (tests await it). */
  lastRun: Promise<void> = Promise.resolve();
  private flushing: Promise<number> = Promise.resolve(0);

  constructor(private readonly o: UpdateServiceOptions) {}

  private async target(target: UpdateTarget): Promise<{ info: UpdateInspect; ref: string }> {
    const info = await findTarget(this.o.docker, target, this.o.target);
    const ref = info.Config.Image;
    if (!pullableRef(ref)) {
      throw new ActionError('failed', 'the container runs an image id, not a tag', false);
    }
    return { info, ref };
  }

  private async imageMeta(ref: string): Promise<ImageMetaLike | null> {
    try {
      return (await this.o.docker.getImage(ref).inspect()) as ImageMetaLike;
    } catch {
      return null;
    }
  }

  private current(info: UpdateInspect, img: ImageMetaLike | null): ImageVersion {
    const v = imageVersion(img) ?? imageVersion({ Id: info.Image });
    if (!v) throw new ActionError('failed', 'unexpected image id format', false);
    return v;
  }

  /** Pulls exactly `ref` (the container's own tag) and inspects what it points to now. */
  private async pull(ref: string): Promise<Pulled> {
    try {
      await pullImage(this.o.docker, ref, this.o.pullTimeoutMs ?? PULL_TIMEOUT_MS);
    } catch {
      this.o.log.warn('update: image pull failed', { image: ref });
      return { ok: false };
    }
    const image = await this.imageMeta(ref);
    return image ? { ok: true, image } : { ok: false };
  }

  async check(target: UpdateTarget): Promise<UpdateCheckData> {
    const { info, ref } = await this.target(target);
    const current = this.current(info, await this.imageMeta(info.Image));
    const pulled = await this.pull(ref);
    let available: ImageVersion | null = null;
    if (pulled.ok && pulled.image.Id !== info.Image) {
      available = imageVersion(pulled.image);
    }
    return updateCheckDataSchema.parse({ target, ref, current, available, pulled: pulled.ok });
  }

  async apply(target: UpdateTarget, runId: string): Promise<{ accepted: true }> {
    if (this.busy !== null) throw new ActionError('busy', 'an update is already running', false);
    // Find the target before answering: not_found/failed go back as the rpc error.
    const { info, ref } = await this.target(target);
    if (this.busy !== null) throw new ActionError('busy', 'an update is already running', false);
    this.busy = target;
    this.o.log.info('update accepted', { target, runId });
    this.lastRun = this.run(target, runId, info, ref).catch((err: unknown) => {
      this.o.log.error('update failed unexpectedly', { target, error: err });
      this.busy = null;
      return this.record({
        kind: 'update_result',
        runId,
        target,
        outcome: 'failed',
        message: 'unexpected error',
      });
    });
    return { accepted: true };
  }

  private async run(
    target: UpdateTarget,
    runId: string,
    info: UpdateInspect,
    ref: string,
  ): Promise<void> {
    const from = this.current(info, await this.imageMeta(info.Image));
    const base = { kind: 'update_result' as const, runId, target, from };
    const pulled = await this.pull(ref);
    if (!pulled.ok) {
      this.busy = null;
      return this.record({
        ...base,
        outcome: 'failed',
        message: 'image pull failed (registry unreachable?)',
      });
    }
    const to = imageVersion(pulled.image) ?? undefined;
    if (pulled.image.Id === info.Image) {
      this.busy = null;
      return this.record({ ...base, outcome: 'up_to_date' });
    }
    if (!to) {
      this.busy = null;
      return this.record({ ...base, outcome: 'failed', message: 'unexpected image id format' });
    }
    if (target === 'core') {
      hiddenDuringUpdate.add(info.Id);
      // Journal first: if this agent dies while the core is down, the next agent start
      // finishes or undoes the swap (recoverAtStart) before it even connects.
      const journal: Journal = {
        runId,
        target: 'core',
        phase: 'begin',
        oldId: info.Id,
        oldName: info.Name.replace(/^\//, ''),
        wasRunning: info.State.Running || info.State.Restarting === true,
        from,
        to,
        ts: new Date().toISOString(),
      };
      try {
        try {
          await writeJournal(this.o.dataDir, journal);
        } catch {
          return await this.record({
            ...base,
            to,
            outcome: 'failed',
            message: 'could not write the update journal',
          });
        }
        const r = await replaceContainer(this.o.docker, info, ref, {
          log: this.o.log,
          onStep: journalStep(this.o.dataDir, journal),
          waitReady: (id) => waitHealthy(this.o.docker, id, this.o.wait),
          ...(this.o.now ? { now: this.o.now } : {}),
        });
        await this.record({
          ...base,
          to,
          outcome: r.outcome,
          ...(r.message ? { message: r.message } : {}),
        });
        await removeJournal(this.o.dataDir, runId);
        return;
      } finally {
        hiddenDuringUpdate.delete(info.Id);
        this.busy = null;
      }
    }
    return this.startHelper(runId, info, to, base);
  }

  private async startHelper(
    runId: string,
    info: UpdateInspect,
    to: ImageVersion,
    base: Omit<UpdateResultEvent, 'outcome'>,
  ): Promise<void> {
    const st = this.o.statPath ?? stat;
    let create;
    try {
      const [data, sock] = await Promise.all([st(this.o.dataDir), st(this.o.dockerSocket)]);
      create = buildHelperCreate({
        runId,
        agent: info,
        newImageId: to.imageId,
        dockerSocket: this.o.dockerSocket,
        dataDir: this.o.dataDir,
        dataOwner: { uid: data.uid, gid: data.gid },
        socket: { gid: sock.gid, mode: sock.mode },
      });
    } catch (err) {
      this.busy = null;
      const message = err instanceof Error ? err.message : 'helper setup failed';
      return this.record({ ...base, to, outcome: 'failed', message: message.slice(0, 300) });
    }
    let helperId: string | null = null;
    try {
      helperId = (await this.o.docker.createContainer(create)).id;
      await this.o.docker.getContainer(helperId).start();
    } catch {
      if (helperId) {
        await this.o.docker
          .getContainer(helperId)
          .remove({ force: true })
          .catch(() => undefined);
      }
      this.busy = null;
      return this.record({
        ...base,
        to,
        outcome: 'failed',
        message: 'could not start the updater helper',
      });
    }
    this.o.log.info('updater helper started; it replaces this agent', { runId });
    // The helper stops this process soon. If it does not, allow a new attempt later.
    (this.o.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref()))(() => {
      if (this.busy === 'agent') this.busy = null;
    }, AGENT_BUSY_MS);
  }

  /** Persists first, then sends; the file stays until a send succeeded. */
  private async record(event: UpdateResultEvent): Promise<void> {
    try {
      await writeResult(this.o.dataDir, event);
    } catch (err) {
      this.o.log.error('update result could not be saved', { error: err });
      this.o.emit({ type: 'event', ts: new Date().toISOString(), event });
      return;
    }
    this.o.log.info('update result', {
      runId: event.runId,
      target: event.target,
      outcome: event.outcome,
    });
    await this.flush();
  }

  /** Sends all saved results (after every welcome and periodically while connected). */
  async flush(): Promise<number> {
    // One flush at a time, so a result is not sent twice by overlapping calls.
    const prev = this.flushing;
    const next = prev.then(() => flushResults(this.o.dataDir, this.o.emit));
    this.flushing = next.catch(() => 0);
    const sent = await next;
    // The helper exits right after writing its result: tidy up a little later.
    if (sent > 0)
      this.timer(() => void this.reconcile().catch(() => undefined), RECONCILE_AFTER_MS);
    return sent;
  }

  private timer(fn: () => void, ms: number): void {
    (this.o.setTimer ?? ((f, t) => setTimeout(f, t).unref()))(fn, ms);
  }

  /**
   * At agent start, before connecting: a core swap that died with the previous agent
   * process is finished (new core healthy) or undone (old core back). Agent swaps wait
   * for reconcile() after the welcome (healthy = connected).
   */
  async recoverAtStart(): Promise<void> {
    for (const j of await listJournals(this.o.dataDir)) {
      if (j.target !== 'core' || j.phase === 'done') continue;
      this.o.log.warn('core update was interrupted, recovering', {
        runId: j.runId,
        phase: j.phase,
      });
      const event = await resumeSwap(this.o.docker, j, {
        log: this.o.log,
        ...(this.o.wait ? { wait: this.o.wait } : {}),
      });
      await this.saveOnly(event);
      await removeJournal(this.o.dataDir, j.runId);
    }
  }

  /** After the welcome: clean up helpers and finish agent swaps whose helper is gone. */
  async onReady(): Promise<void> {
    await this.reconcile().catch((err: unknown) =>
      this.o.log.warn('update reconcile failed', { error: err }),
    );
    await this.flush();
  }

  /**
   * Removes exited updater helpers and finished journals. A journal of an agent swap
   * whose helper is gone for good (crashed 3 times, removed): if this process runs in
   * the new container, it is connected (we are past the welcome), so the update counts
   * and the old container goes; if it runs in the old one, the new container goes and
   * this one gets its name back.
   */
  async reconcile(): Promise<void> {
    const docker = this.o.docker;
    const helpers = (await docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: [`${ROLE_LABEL}=updater`] }),
    })) as { Id: string; State?: string; Labels?: Record<string, string> | null }[];
    const active = new Set<string>();
    for (const h of helpers) {
      if (h.Labels?.[ROLE_LABEL] !== 'updater') continue;
      const run = h.Labels['hz.update.run'] ?? '';
      if (h.State === 'running' || h.State === 'restarting') {
        active.add(run);
        continue;
      }
      await docker
        .getContainer(h.Id)
        .remove({ force: true, v: false })
        .catch(() => this.o.log.warn('exited updater helper could not be removed'));
    }
    for (const j of await listJournals(this.o.dataDir)) {
      if (active.has(j.runId) || j.target !== 'agent') continue;
      if (j.phase === 'done') {
        await removeJournal(this.o.dataDir, j.runId);
        continue;
      }
      const own = await findOwnContainer(docker, this.o.target).catch(() => null);
      const base = {
        kind: 'update_result' as const,
        runId: j.runId,
        target: 'agent' as const,
        ...(j.from ? { from: j.from } : {}),
        ...(j.to ? { to: j.to } : {}),
      };
      if (own && own.Id === j.newId) {
        await docker
          .getContainer(j.oldId)
          .remove({ force: true, v: false })
          .catch(() => undefined);
        await this.saveOnly({ ...base, outcome: 'updated', message: 'finished by the new agent' });
      } else if (own && own.Id === j.oldId) {
        if (j.newId) {
          await docker
            .getContainer(j.newId)
            .remove({ force: true, v: false })
            .catch(() => undefined);
        }
        if (own.Name.replace(/^\//, '') !== j.oldName) {
          await docker
            .getContainer(own.Id)
            .rename({ name: j.oldName })
            .catch(() => this.o.log.warn('could not rename the agent back'));
        }
        await this.saveOnly({
          ...base,
          outcome: 'failed',
          message: 'update interrupted (updater gone); old agent kept',
        });
      } else {
        this.o.log.warn('stale update journal dropped', { runId: j.runId });
      }
      await removeJournal(this.o.dataDir, j.runId);
    }
  }

  /** Persists a result without sending (sent by the next flush). */
  private async saveOnly(event: UpdateResultEvent): Promise<void> {
    try {
      await writeResult(this.o.dataDir, event);
    } catch (err) {
      this.o.log.error('update result could not be saved', { error: err });
    }
  }
}
