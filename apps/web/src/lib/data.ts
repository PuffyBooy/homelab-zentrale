import type { Alert, CheckSummary, ContainerSummary, ServerSummary } from '@hz/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useSearchParams } from 'react-router';
import { alertsKey, fetchAlerts } from './alerts.js';
import { checksKey, fetchChecks } from './checks.js';
import { containersKey, fetchContainers } from './containers.js';
import { useLiveState } from './live.js';
import { ALL_SERVERS, fetchServers, serversKey } from './servers.js';

/**
 * Shared queries. While the live socket is open the cache is fed by lib/live.ts,
 * so REST is only the first load and the fallback (polling while disconnected).
 */
export function useServers(): UseQueryResult<ServerSummary[]> {
  const live = useLiveState();
  return useQuery({
    queryKey: serversKey,
    queryFn: ({ signal }) => fetchServers(signal),
    staleTime: live === 'open' ? Infinity : 15_000,
    refetchInterval: live === 'open' ? false : 15_000,
  });
}

/** All containers of all servers. Callers subscribe to the live topic `containers`. */
export function useContainers(enabled = true): UseQueryResult<ContainerSummary[]> {
  const live = useLiveState();
  return useQuery({
    queryKey: containersKey,
    queryFn: ({ signal }) => fetchContainers(signal),
    enabled,
    staleTime: live === 'open' ? Infinity : 10_000,
    refetchInterval: live === 'open' ? false : 15_000,
  });
}

/** All checks. Callers subscribe to the live topic `checks`. */
export function useChecks(enabled = true): UseQueryResult<CheckSummary[]> {
  const live = useLiveState();
  return useQuery({
    queryKey: checksKey,
    queryFn: ({ signal }) => fetchChecks(signal),
    enabled,
    staleTime: live === 'open' ? Infinity : 15_000,
    refetchInterval: live === 'open' ? false : 30_000,
  });
}

export function useActiveAlerts(): UseQueryResult<Alert[]> {
  const live = useLiveState();
  return useQuery({
    queryKey: alertsKey,
    queryFn: ({ signal }) => fetchAlerts('active', signal),
    staleTime: live === 'open' ? Infinity : 15_000,
    refetchInterval: live === 'open' ? false : 30_000,
  });
}

/** Server filter of the ServerSwitch, kept in `?server=<id>` so it survives reloads. */
export function useServerFilter(): [string, (id: string) => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get('server') ?? ALL_SERVERS;
  const set = useCallback(
    (id: string) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id === ALL_SERVERS) next.delete('server');
          else next.set('server', id);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  return [value, set];
}
