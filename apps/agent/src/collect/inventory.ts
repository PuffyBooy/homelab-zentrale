import type { Inventory } from '@hz/shared';
import type { HostContext } from '../host.js';
import { ContainerCollector, dockerVersion } from './docker.js';
import {
  collectFail2ban,
  collectPorts,
  collectSshFailures,
  collectUpdates,
  rebootRequired,
} from './security.js';
import { collectStorage, type StorageOptions } from './storage.js';
import type { SystemCollector } from './system.js';

const safe = <T>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);

/** Builds one `inventory` message. Each part fails soft. */
export async function collectInventory(
  ctx: HostContext,
  system: SystemCollector,
  collector: ContainerCollector = new ContainerCollector(ctx.docker),
  storageOpts: StorageOptions = { smart: false },
): Promise<Inventory> {
  const [version, containers, updates, reboot, ssh, f2b, ports, storage] = await Promise.all([
    safe(dockerVersion(ctx.docker), undefined),
    safe(collector.list(), []),
    safe(collectUpdates(ctx), null),
    safe(rebootRequired(ctx), false),
    safe(collectSshFailures(ctx), null),
    safe(collectFail2ban(ctx), null),
    safe(collectPorts(ctx), []),
    safe(collectStorage(ctx, storageOpts), undefined),
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
    ...(storage ? { storage } : {}),
  };
}
