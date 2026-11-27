import { readFile } from 'node:fs/promises';
import os from 'node:os';
import type { UpdateTarget } from '@hz/shared';
import { ROLE_LABEL } from '../actions/protected.js';
import type { UpdateInspect } from '../actions/container-update.js';
import { ActionError } from '../actions/types.js';
import type { ReplaceDocker } from './replace.js';

/**
 * M17: which container an update replaces. Only these two; the image always
 * comes from the container itself (Config.Image), never from the request.
 *
 * - agent: the agent's own container. Its id comes from /proc/self/mountinfo
 *   (Docker bind-mounts /var/lib/docker/containers/<id>/hostname, hosts and
 *   resolv.conf into every container, also with network_mode: host, where the
 *   hostname is the host's and not the short id), else from a short-id
 *   hostname, else the only running container labelled hz.role=agent.
 * - core: the only container labelled hz.role=core on this host.
 */

interface Listed {
  Id: string;
  Names?: string[];
  State?: string;
  Labels?: Record<string, string> | null;
}

/** The container id from a mountinfo text, if the process runs in a Docker container. */
export function containerIdFromMountinfo(text: string): string | null {
  const counts = new Map<string, number>();
  for (const line of text.split('\n')) {
    const m = /\/containers\/([0-9a-f]{64})\/(?:hostname|hosts|resolv\.conf)\s/.exec(line);
    if (m?.[1]) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  // Exactly one id: a nested bind of another container's dir must not confuse us.
  return counts.size === 1 ? ([...counts.keys()][0] ?? null) : null;
}

export interface TargetOptions {
  readMountinfo?: () => Promise<string>;
  hostname?: string;
}

const isLeftover = (c: Listed) => (c.Names ?? []).some((n) => n.includes('-hz-old-'));

async function listByRole(docker: ReplaceDocker, role: string): Promise<Listed[]> {
  const list = (await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: [`${ROLE_LABEL}=${role}`] }),
  })) as Listed[];
  return list.filter((c) => c.Labels?.[ROLE_LABEL] === role && !isLeftover(c));
}

async function inspect(docker: ReplaceDocker, id: string): Promise<UpdateInspect | null> {
  try {
    return (await docker.getContainer(id).inspect()) as UpdateInspect;
  } catch {
    return null;
  }
}

export async function findOwnContainer(
  docker: ReplaceDocker,
  o: TargetOptions = {},
): Promise<UpdateInspect> {
  const mountinfo = await (o.readMountinfo ?? (() => readFile('/proc/self/mountinfo', 'utf8')))()
    .then(containerIdFromMountinfo)
    .catch(() => null);
  if (mountinfo) {
    const info = await inspect(docker, mountinfo);
    if (info) return info;
  }
  const host = o.hostname ?? os.hostname();
  if (/^[0-9a-f]{12}$/.test(host)) {
    const info = await inspect(docker, host);
    if (info?.Id.startsWith(host)) return info;
  }
  const agents = (await listByRole(docker, 'agent')).filter((c) => c.State === 'running');
  if (agents.length === 1 && agents[0]) {
    const info = await inspect(docker, agents[0].Id);
    if (info) return info;
  }
  throw new ActionError('not_found', 'the agent does not run in a Docker container', false);
}

export async function findCoreContainer(docker: ReplaceDocker): Promise<UpdateInspect> {
  const cores = await listByRole(docker, 'core');
  if (cores.length === 0) {
    throw new ActionError('not_found', 'no core container (hz.role=core) on this host', false);
  }
  if (cores.length > 1) {
    throw new ActionError('failed', 'more than one core container on this host', false);
  }
  const info = cores[0] ? await inspect(docker, cores[0].Id) : null;
  if (!info) throw new ActionError('not_found', 'core container vanished', false);
  return info;
}

export function findTarget(
  docker: ReplaceDocker,
  target: UpdateTarget,
  o: TargetOptions = {},
): Promise<UpdateInspect> {
  return target === 'agent' ? findOwnContainer(docker, o) : findCoreContainer(docker);
}
