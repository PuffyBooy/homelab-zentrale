import { rm, writeFile } from 'node:fs/promises';

/**
 * M17: the agent image's Docker health check (apps/agent/Dockerfile) is healthy
 * only while this file exists. The agent writes it on welcome and removes it when
 * the connection closes, so "healthy" means "connected to the core". The updater
 * helper waits for exactly that before it removes the old agent container.
 * /tmp is a tmpfs in deploy/docker-compose.agent.yml.
 */
export const CONNECTED_FILE = '/tmp/hz-connected';

export function markConnected(file = CONNECTED_FILE): Promise<void> {
  return writeFile(file, `${new Date().toISOString()}\n`, { mode: 0o644 }).catch(() => undefined);
}

export function markDisconnected(file = CONNECTED_FILE): Promise<void> {
  return rm(file, { force: true }).catch(() => undefined);
}
