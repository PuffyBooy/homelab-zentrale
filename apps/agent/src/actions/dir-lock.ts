import { ActionError } from './types.js';

/**
 * One action per project directory at a time (compose.up/down/pull/write and
 * deploy.run share this lock). Keys are the resolved real paths the dispatcher
 * passes, so two spellings of the same directory cannot run in parallel.
 */
const locks = new Set<string>();

/** Takes the lock for `dir` or throws `busy`. Returns the release function (idempotent). */
export function acquireDirLock(dir: string): () => void {
  if (locks.has(dir)) throw new ActionError('busy', 'another action runs in this directory');
  locks.add(dir);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    locks.delete(dir);
  };
}

export async function withDirLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const release = acquireDirLock(dir);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** For tests. */
export function isDirLocked(dir: string): boolean {
  return locks.has(dir);
}
