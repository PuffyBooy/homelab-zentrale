import { constants } from 'node:fs';
import { open, rm } from 'node:fs/promises';

/**
 * M17: the agent image's Docker health check (apps/agent/Dockerfile) is healthy
 * only while this file exists. The agent writes it on welcome and removes it when
 * the connection closes, so "healthy" means "connected to the core". The updater
 * helper waits for exactly that before it removes the old agent container.
 * /tmp is a tmpfs in deploy/docker-compose.agent.yml.
 */
export const CONNECTED_FILE = '/tmp/hz-connected';

/** Recreates the marker exclusively (O_EXCL, 0600, never through a planted symlink). */
export async function markConnected(file = CONNECTED_FILE): Promise<void> {
  try {
    await rm(file, { force: true });
    const fh = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      await fh.writeFile(`${new Date().toISOString()}\n`);
    } finally {
      await fh.close();
    }
  } catch {
    // health stays unhealthy; the agent keeps working
  }
}

export function markDisconnected(file = CONNECTED_FILE): Promise<void> {
  return rm(file, { force: true }).catch(() => undefined);
}
