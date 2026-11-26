import { readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { imageVersionSchema, rpcIdSchema, updateTargetSchema } from '@hz/shared';
import type { UpdateDocker } from '../actions/container-update.js';
import type { Logger } from '../log.js';
import { waitHealthy, type ReplaceStep, type WaitOptions } from './replace.js';
import { writeJsonAtomic, type UpdateResultEvent } from './results.js';

/**
 * M17 crash journal of a container swap: `<dataDir>/update-journal-<runId>.json`.
 *
 * Written before the swap starts and after every step (replaceContainer onStep), so
 * whoever runs next can finish or undo a swap that died halfway:
 * - the updater helper itself, when Docker restarts it (RestartPolicy on-failure),
 * - the agent at start (core swaps: the agent may die while the core is down),
 * - the agent after its welcome (agent swaps whose helper is gone).
 * Recovery keeps the new container only if it is healthy; otherwise the old one gets
 * its name back and runs again. Phase `done` = finished, the result file exists.
 */

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const journalSchema = z.strictObject({
  runId: rpcIdSchema,
  target: updateTargetSchema,
  phase: z.enum(['begin', 'renamed', 'created', 'stopped', 'started', 'done']),
  oldId: hex64,
  /** Name of the old container before the swap (without the leading slash). */
  oldName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
  newId: hex64.optional(),
  wasRunning: z.boolean(),
  from: imageVersionSchema.optional(),
  to: imageVersionSchema.optional(),
  ts: z.iso.datetime(),
});
export type Journal = z.infer<typeof journalSchema>;

const PREFIX = 'update-journal-';
const SUFFIX = '.json';

export function journalFileName(runId: string): string {
  if (!rpcIdSchema.safeParse(runId).success) throw new Error('invalid run id');
  return `${PREFIX}${runId}${SUFFIX}`;
}

export async function writeJournal(dataDir: string, j: Journal): Promise<void> {
  const value = journalSchema.parse({ ...j, ts: new Date().toISOString() });
  await writeJsonAtomic(dataDir, journalFileName(j.runId), value);
}

export async function readJournal(dataDir: string, runId: string): Promise<Journal | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(dataDir, journalFileName(runId)), 'utf8'));
    const r = journalSchema.safeParse(raw);
    return r.success && r.data.runId === runId ? r.data : null;
  } catch {
    return null;
  }
}

export async function listJournals(dataDir: string): Promise<Journal[]> {
  let names: string[];
  try {
    names = await readdir(dataDir);
  } catch {
    return [];
  }
  const out: Journal[] = [];
  for (const n of names.filter((x) => x.startsWith(PREFIX) && x.endsWith(SUFFIX)).slice(0, 20)) {
    const runId = n.slice(PREFIX.length, -SUFFIX.length);
    if (!rpcIdSchema.safeParse(runId).success) continue;
    const j = await readJournal(dataDir, runId);
    if (j) out.push(j);
    else await unlink(path.join(dataDir, n)).catch(() => undefined);
  }
  return out;
}

export async function removeJournal(dataDir: string, runId: string): Promise<void> {
  await unlink(path.join(dataDir, journalFileName(runId))).catch(() => undefined);
}

/** A replaceContainer onStep hook that keeps the journal current. */
export function journalStep(dataDir: string, j: Journal): (step: ReplaceStep) => Promise<void> {
  return async (step) => {
    j.phase = step.phase;
    if (step.phase === 'created') j.newId = step.newId;
    await writeJournal(dataDir, j);
  };
}

const statusOf = (err: unknown) => (err as { statusCode?: number } | null)?.statusCode;

/**
 * Finishes or undoes an interrupted swap. With a started new container, waits for it
 * to become healthy (keep it, remove the old one); otherwise removes the new one and
 * restores the old one (name back, started again if it ran before).
 */
export async function resumeSwap(
  docker: Pick<UpdateDocker, 'getContainer'>,
  j: Journal,
  o: { log: Logger; wait?: WaitOptions },
): Promise<UpdateResultEvent> {
  const base = {
    kind: 'update_result' as const,
    runId: j.runId,
    target: j.target,
    ...(j.from ? { from: j.from } : {}),
    ...(j.to ? { to: j.to } : {}),
  };
  if (j.newId && j.phase === 'started') {
    const ready = await waitHealthy(docker, j.newId, o.wait);
    if (ready.ok) {
      await docker
        .getContainer(j.oldId)
        .remove({ force: true, v: false })
        .catch(() => o.log.warn('resume: old container could not be removed'));
      return { ...base, outcome: 'updated', message: 'finished after an interruption' };
    }
  }
  o.log.warn('resume: rolling back an interrupted update', { runId: j.runId, phase: j.phase });
  const problems: string[] = [];
  if (j.newId) {
    await docker
      .getContainer(j.newId)
      .remove({ force: true, v: false })
      .catch((err: unknown) => {
        if (statusOf(err) !== 404) problems.push('removing the new container failed');
      });
  }
  const old = docker.getContainer(j.oldId);
  type OldInfo = { Name?: string; State?: { Running?: boolean } };
  let info: OldInfo | null = null;
  try {
    info = (await old.inspect()) as OldInfo;
  } catch {
    problems.push('old container is gone');
  }
  if (info) {
    if ((info.Name ?? '').replace(/^\//, '') !== j.oldName) {
      await old.rename({ name: j.oldName }).catch(() => problems.push('rename back failed'));
    }
    if (j.wasRunning && !info.State?.Running) {
      await old.start().catch((err: unknown) => {
        if (statusOf(err) !== 304) problems.push('starting the old container failed');
      });
    }
  }
  if (problems.length > 0) {
    return {
      ...base,
      outcome: 'failed',
      message: `rollback failed: update interrupted; ${problems.join(', ')}`.slice(0, 300),
    };
  }
  return { ...base, outcome: 'rolled_back', message: 'update interrupted; old container restored' };
}
