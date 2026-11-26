import type { Inventory } from '@hz/shared';
import type { HostContext } from '../host.js';
import { dockerVersion, listContainers } from './docker.js';
import {
  collectFail2ban,
  collectPorts,
  collectSshFailures,
  collectUpdates,
  rebootRequired,
} from './security.js';
import type { SystemCollector } from './system.js';

const safe = <T>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);

/** Builds one `inventory` message. Each part fails soft. */
export async function collectInventory(
  ctx: HostContext,
  system: SystemCollector,
): Promise<Inventory> {
  const [version, containers, updates, reboot, ssh, f2b, ports] = await Promise.all([
    safe(dockerVersion(ctx.docker), undefined),
    safe(listContainers(ctx.docker), []),
    safe(collectUpdates(ctx), null),
    safe(rebootRequired(ctx), false),
    safe(collectSshFailures(ctx), null),
    safe(collectFail2ban(ctx), null),
    safe(collectPorts(ctx), []),
  ]);
  return {
    type: 'inventory',
    ts: new Date().toISOString(),
    system: await system.systemInfo(version),
    containers,
    updates,
    rebootRequired: reboot,
    sshFailed24h: ssh,
    fail2banBanned: f2b,
    listeningPorts: ports,
  };
}
