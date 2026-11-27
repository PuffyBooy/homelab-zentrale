import { randomBytes } from 'node:crypto';
import { chmod, chown, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { agentEventSchema, rpcIdSchema, type AgentEvent } from '@hz/shared';

/**
 * M17: results of update.apply, persisted in the agent data dir (/data) before
 * they are sent. A result survives a core restart (core update), the agent being
 * replaced (agent update: the helper writes the file, the new or the restored old
 * agent sends it) and a lost connection. A file is deleted only after the event
 * went out; the core ignores runIds it does not know or already finished.
 *
 * File: <dataDir>/update-result-<runId>.json = { ts, event } (event kind update_result).
 * This module has no dependencies besides @hz/shared, so the updater helper uses it too.
 */

export type UpdateResultEvent = Extract<AgentEvent['event'], { kind: 'update_result' }>;

const PREFIX = 'update-result-';
const SUFFIX = '.json';
const MAX_FILES = 20;

export function resultFileName(runId: string): string {
  if (!rpcIdSchema.safeParse(runId).success) throw new Error('invalid run id');
  return `${PREFIX}${runId}${SUFFIX}`;
}

export function toEvent(event: UpdateResultEvent, ts = new Date().toISOString()): AgentEvent {
  return { type: 'event', ts, event };
}

/**
 * Writes `<dataDir>/<name>` atomically (exclusive temp file, fsync, rename), mode 0600,
 * owned like the data dir (best effort): files the root agent writes stay readable for
 * the updater helper, which runs as the owner of /data.
 */
export async function writeJsonAtomic(
  dataDir: string,
  name: string,
  value: unknown,
): Promise<void> {
  const target = path.join(dataDir, name);
  const tmp = path.join(dataDir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  const fh = await open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await fh.sync();
  } catch (err) {
    await fh.close();
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  await fh.close();
  await chmod(tmp, 0o600);
  try {
    const owner = await stat(dataDir);
    if (process.getuid?.() !== owner.uid) await chown(tmp, owner.uid, owner.gid);
  } catch {
    // not allowed (non-root): the file stays ours
  }
  await rename(tmp, target);
}

/** Writes the result atomically (writeJsonAtomic). */
export async function writeResult(dataDir: string, event: UpdateResultEvent): Promise<void> {
  const msg = agentEventSchema.parse(toEvent(event));
  await writeJsonAtomic(dataDir, resultFileName(event.runId), { ts: msg.ts, event: msg.event });
}

/** True when a result for `runId` is waiting in the data dir. */
export async function hasResult(dataDir: string, runId: string): Promise<boolean> {
  try {
    await stat(path.join(dataDir, resultFileName(runId)));
    return true;
  } catch {
    return false;
  }
}

export interface PendingResult {
  file: string;
  message: AgentEvent;
}

/** Valid pending results, oldest first. Invalid files are removed. */
export async function pendingResults(dataDir: string): Promise<PendingResult[]> {
  let names: string[];
  try {
    names = await readdir(dataDir);
  } catch {
    return [];
  }
  const files = names
    .filter((n) => n.startsWith(PREFIX) && n.endsWith(SUFFIX))
    .sort()
    .slice(0, MAX_FILES);
  const out: { file: string; message: AgentEvent }[] = [];
  for (const n of files) {
    const file = path.join(dataDir, n);
    let parsed: AgentEvent | null = null;
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as { ts?: unknown; event?: unknown };
      const r = agentEventSchema.safeParse({ type: 'event', ts: raw.ts, event: raw.event });
      if (
        r.success &&
        r.data.event.kind === 'update_result' &&
        n === resultFileName(r.data.event.runId)
      ) {
        parsed = r.data;
      }
    } catch {
      parsed = null;
    }
    if (parsed) out.push({ file, message: parsed });
    else await unlink(file).catch(() => undefined);
  }
  return out.sort((a, b) => a.message.ts.localeCompare(b.message.ts));
}

/** Sends every pending result; deletes a file only after `send` returned true. */
export async function flushResults(
  dataDir: string,
  send: (msg: AgentEvent) => boolean,
): Promise<number> {
  let sent = 0;
  for (const p of await pendingResults(dataDir)) {
    if (!send(p.message)) break;
    sent += 1;
    await unlink(p.file).catch(() => undefined);
  }
  return sent;
}
