import type { Modules } from '@hz/shared';
import { ALL_MODULES_ON } from './modules.js';
import { useAuthState } from './useAuthState.js';

/** Modules from GET /api/auth/state (all on while unknown). */
export function useModules(): Modules {
  const { data } = useAuthState();
  return data?.modules ?? ALL_MODULES_ON;
}
