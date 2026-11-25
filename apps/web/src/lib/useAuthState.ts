import type { AuthState } from '@hz/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { authStateKey, fetchAuthState } from './auth.js';

export function useAuthState(): UseQueryResult<AuthState> {
  return useQuery({
    queryKey: authStateKey,
    queryFn: ({ signal }) => fetchAuthState(signal),
    staleTime: 60_000,
  });
}
