import { QueryClient } from '@tanstack/react-query';
import { isApiError } from './api.js';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        retry: (count, err) => {
          // Auth and input errors do not get better by retrying.
          if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
          return count < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}
