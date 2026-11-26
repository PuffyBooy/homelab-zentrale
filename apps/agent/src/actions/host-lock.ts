import { ActionError } from './types.js';

/**
 * One package/cleanup job at a time per host: system.cleanup and system.upgrade
 * both run apt/dpkg, which would fight over the dpkg lock.
 */
let holder: string | null = null;

export async function withHostLock<T>(what: string, fn: () => Promise<T>): Promise<T> {
  if (holder !== null) throw new ActionError('busy', `${holder} already running`, false);
  holder = what;
  try {
    return await fn();
  } finally {
    holder = null;
  }
}
