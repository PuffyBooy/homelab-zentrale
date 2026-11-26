import os from 'node:os';
import { ActionError } from './types.js';

/** Containers with this label (agent, core) are never stopped, restarted or replaced. */
export const ROLE_LABEL = 'hz.role';
const PROTECTED_ROLES = new Set(['agent', 'core']);
const COMPOSE_DIR_LABEL = 'com.docker.compose.project.working_dir';

interface InspectLike {
  Id: string;
  Config?: { Labels?: Record<string, string> | null } | null;
}
interface ListedLike {
  Id: string;
  Labels?: Record<string, string> | null;
}
export interface ProtectDocker {
  getContainer(id: string): { inspect(): Promise<unknown> };
  listContainers(opts: { all: boolean; filters: string }): Promise<unknown[]>;
}

/** Docker sets the hostname of a container to its short id (unless overridden). */
function ownIdPrefix(hostname = os.hostname()): string | null {
  return /^[0-9a-f]{12}$/.test(hostname) ? hostname : null;
}

export function isProtectedContainer(
  c: { id: string; labels: Record<string, string> | null | undefined },
  hostname?: string,
): boolean {
  const role = c.labels?.[ROLE_LABEL];
  if (role && PROTECTED_ROLES.has(role)) return true;
  const own = ownIdPrefix(hostname);
  return own !== null && c.id.startsWith(own);
}

const refuse = () =>
  new ActionError('not_allowed', 'the agent and the core cannot be controlled from the UI');

/** Throws not_allowed for the agent's own container and the core. Missing containers pass (the action reports 404). */
export async function assertNotProtected(docker: ProtectDocker, ref: string): Promise<void> {
  let info: InspectLike;
  try {
    info = (await docker.getContainer(ref).inspect()) as InspectLike;
  } catch {
    return;
  }
  if (isProtectedContainer({ id: info.Id, labels: info.Config?.Labels })) throw refuse();
}

/** Throws not_allowed if a protected container belongs to the compose project in `dir`. */
export async function assertProjectNotProtected(docker: ProtectDocker, dir: string): Promise<void> {
  const list = (await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: [`${COMPOSE_DIR_LABEL}=${dir}`] }),
  })) as ListedLike[];
  if (list.some((c) => isProtectedContainer({ id: c.Id, labels: c.Labels }))) throw refuse();
}
