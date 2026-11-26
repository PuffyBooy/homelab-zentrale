import type { DomainService } from '../domains/service.js';
import type { RelayDns } from './service.js';

/**
 * The game relay's DNS through the domains module (M20): one relay-owned A
 * record per game (ownerRef = game id) with a static target, the ingress IPv4.
 * The relay only sees this interface, never a provider or its token.
 */
export function relayDnsFrom(domains: DomainService): RelayDns {
  return {
    enabled: () => domains.isEnabled(),
    providerFor: (name) => domains.providerForName(name),
    conflict: (gameId, providerId, name) =>
      domains.relayNameConflict(gameId, providerId, name, 'A'),
    record: (gameId) => domains.relayRecord(gameId, 'A'),
    owners: () => domains.relayOwners(),
    ensure: async ({ gameId, providerId, name, ip }) => {
      await domains.ensureRecord({
        ownerRef: gameId,
        providerId,
        name,
        type: 'A',
        target: { kind: 'static', value: ip },
      });
    },
    remove: (gameId) => domains.removeRecord(gameId),
  };
}
