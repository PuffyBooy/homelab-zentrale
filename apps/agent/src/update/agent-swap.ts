import { z } from 'zod';
import { imageVersionSchema, rpcIdSchema } from '@hz/shared';
import { pullableRef, type UpdateInspect } from '../actions/container-update.js';
import type { Logger } from '../log.js';
import { replaceContainer, waitHealthy, type ReplaceDocker, type WaitOptions } from './replace.js';
import { journalStep, readJournal, resumeSwap, writeJournal, type Journal } from './journal.js';
import { hasResult, writeResult, type UpdateResultEvent } from './results.js';
import { imageVersion, type ImageMetaLike } from './versions.js';

/**
 * M17, inside the updater helper container: replaces the agent container.
 *
 *   rename old agent -> create new (same config, same tag) -> stop old -> start new
 *   -> wait up to 3 min for "healthy" (the new agent is connected to the core;
 *      without a health check: running 30 s without a restart) -> remove old
 *   else: remove new, rename old back, start old (rollback).
 *
 * The result goes to /data (results.ts); whichever agent runs afterwards sends it
 * after its welcome. Every step is journaled (journal.ts) first: if the helper dies
 * midway, Docker restarts it (on-failure, max 3) and it finishes or undoes the swap;
 * if it is gone for good, the next agent does that after its welcome. Input comes only from the helper's environment, which the
 * agent built (helper.ts); everything is validated again here.
 */

export const helperEnvSchema = z.object({
  HZ_UPDATER_TARGET: z.string().regex(/^[0-9a-f]{64}$/),
  HZ_UPDATER_RUN_ID: rpcIdSchema,
  HZ_UPDATER_IMAGE: imageVersionSchema.shape.imageId,
  HZ_UPDATER_DATA: z
    .string()
    .regex(/^\/[A-Za-z0-9/_.-]{0,200}$/)
    .default('/data'),
});
export type HelperEnv = z.infer<typeof helperEnvSchema>;

export interface SwapOptions {
  log: Logger;
  wait?: WaitOptions;
  now?: () => number;
  /** Writes the result (tests replace it). */
  write?: (dataDir: string, event: UpdateResultEvent) => Promise<void>;
}

export async function swapAgent(
  docker: ReplaceDocker,
  env: HelperEnv,
  o: SwapOptions,
): Promise<UpdateResultEvent | null> {
  const write = o.write ?? writeResult;
  const dataDir = env.HZ_UPDATER_DATA;
  const runId = env.HZ_UPDATER_RUN_ID;
  const base = { kind: 'update_result' as const, runId, target: 'agent' as const };
  const done = async (event: UpdateResultEvent, journal?: Journal) => {
    try {
      await write(dataDir, event);
    } catch (err) {
      o.log.error('updater: result could not be saved', { error: err });
    }
    // `done` after the result: a restarted helper then knows there is nothing left to do.
    if (journal) {
      journal.phase = 'done';
      await writeJournal(dataDir, journal).catch(() => undefined);
    }
    return event;
  };

  // Restarted by Docker (on-failure) after a crash: finish or undo, never start over.
  const existing = await readJournal(dataDir, runId);
  if (existing?.phase === 'done' || (await hasResult(dataDir, runId))) {
    o.log.info('updater: run already finished', { runId });
    return null;
  }
  if (existing) {
    o.log.warn('updater: resuming an interrupted update', { runId, phase: existing.phase });
    return done(await resumeSwap(docker, existing, o), existing);
  }

  let info: UpdateInspect;
  try {
    info = (await docker.getContainer(env.HZ_UPDATER_TARGET).inspect()) as UpdateInspect;
  } catch {
    return done({ ...base, outcome: 'failed', message: 'agent container not found' });
  }
  const from = imageVersion({ Id: info.Image }) ?? undefined;
  const fromFull =
    imageVersion(
      (await docker
        .getImage(info.Image)
        .inspect()
        .catch(() => null)) as ImageMetaLike | null,
    ) ?? from;
  const withFrom = { ...base, ...(fromFull ? { from: fromFull } : {}) };
  // Never core or another protected container, even if the id was wrong.
  const role = info.Config.Labels?.['hz.role'];
  if (role !== undefined && role !== 'agent') {
    return done({ ...withFrom, outcome: 'failed', message: 'target is not the agent container' });
  }
  const ref = info.Config.Image;
  if (!pullableRef(ref)) {
    return done({
      ...withFrom,
      outcome: 'failed',
      message: 'the agent runs an image id, not a tag',
    });
  }
  const img = (await docker
    .getImage(ref)
    .inspect()
    .catch(() => null)) as ImageMetaLike | null;
  const to = imageVersion(img);
  if (!to || to.imageId !== env.HZ_UPDATER_IMAGE) {
    return done({ ...withFrom, outcome: 'failed', message: 'image tag changed during the update' });
  }
  if (to.imageId === info.Image) return done({ ...withFrom, to, outcome: 'up_to_date' });

  const journal: Journal = {
    runId,
    target: 'agent',
    phase: 'begin',
    oldId: info.Id,
    oldName: info.Name.replace(/^\//, ''),
    wasRunning: info.State.Running || info.State.Restarting === true,
    ...(fromFull ? { from: fromFull } : {}),
    to,
    ts: new Date().toISOString(),
  };
  try {
    await writeJournal(dataDir, journal);
  } catch {
    return done({
      ...withFrom,
      to,
      outcome: 'failed',
      message: 'could not write the update journal',
    });
  }
  o.log.info('updater: replacing the agent', { runId });
  const r = await replaceContainer(docker, info, ref, {
    log: o.log,
    onStep: journalStep(dataDir, journal),
    waitReady: (id) => waitHealthy(docker, id, o.wait),
    ...(o.now ? { now: o.now } : {}),
  });
  return done(
    { ...withFrom, to, outcome: r.outcome, ...(r.message ? { message: r.message } : {}) },
    journal,
  );
}
