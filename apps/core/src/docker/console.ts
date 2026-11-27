import type { ContainerRow } from '../db/schema.js';
import type { ConsoleContainer } from '../terminal/service.js';
import { isProtected } from '../throttle/service.js';

/** M23: the console target of a container row (protected = hz.role core, agent, updater). */
export function consoleContainer(row: ContainerRow | undefined): ConsoleContainer | null {
  if (!row) return null;
  return {
    serverId: row.serverId,
    dockerId: row.dockerId,
    name: row.name,
    protected: isProtected(row),
  };
}
