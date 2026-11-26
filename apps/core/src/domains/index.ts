import { nextWallClock } from '../calendar.js';
import type { FeatureContext, FeatureHandle } from '../features.js';
import { domainsRoutes } from './routes.js';
import { DomainService, type DomainsDeps } from './service.js';

export { DomainService, type DomainsDeps, type EnsureRecordInput } from './service.js';

export interface DomainsHandle extends FeatureHandle {
  /** Internal interface for the game relay (M15): ensureRecord / removeRecord. */
  service: DomainService;
}

const DNS_JOB = 'domains.dns';
const CERT_JOB = 'domains.certs';
const RENEW_JOB = 'domains.renew';

/**
 * Module `domains` (M20): DNS providers, records with dynamic DNS, ACME
 * certificates. Jobs run only while the module is on: DNS sync every minute,
 * certificate retries every minute, renewal check daily at 04:00 HZ_TIMEZONE.
 */
export function setupDomains(ctx: FeatureContext, deps: DomainsDeps = {}): DomainsHandle {
  const service = new DomainService(ctx, deps);
  let unjobs: (() => void)[] = [];

  const startJobs = (): void => {
    if (unjobs.length > 0) return;
    unjobs = [
      ctx.scheduler.every(DNS_JOB, 60_000, () => service.syncAll(), { align: true }),
      ctx.scheduler.every(CERT_JOB, 60_000, () => service.certTick(), { align: true }),
      ctx.scheduler.at(
        RENEW_JOB,
        (from) => nextWallClock(from, { hour: 4, minute: 0 }),
        () => service.dailyRenew(),
      ),
    ];
  };
  const stopJobs = (): void => {
    for (const fn of unjobs) fn();
    unjobs = [];
  };

  if (service.isEnabled()) startJobs();
  const offModules = ctx.modules.onChange((id, on) => {
    if (id !== 'domains') return;
    service.setEnabled(on);
    if (on) startJobs();
    else stopJobs();
  });
  const offConnect = ctx.servers.onAgentConnected((serverId) =>
    service.onServerConnected(serverId),
  );

  return {
    service,
    routes: async (app) => {
      await app.register(domainsRoutes, { db: ctx.db, now: ctx.now, domains: service });
    },
    idle: () => service.idle(),
    stop: () => {
      stopJobs();
      offModules();
      offConnect();
      service.stop();
    },
  };
}
