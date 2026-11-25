import type { AuthState } from '@hz/shared';

export type GuardArea = 'setup' | 'login' | 'protected';

export type GuardDecision =
  { kind: 'wait' } | { kind: 'render' } | { kind: 'redirect'; to: string };

/** Which screen to show for an auth state. Pure, so it can be tested without a router. */
export function decideGuard(state: AuthState | undefined, area: GuardArea): GuardDecision {
  if (!state) return { kind: 'wait' };
  if (state.setupRequired) {
    return area === 'setup' ? { kind: 'render' } : { kind: 'redirect', to: '/setup' };
  }
  if (area === 'setup' || area === 'login') {
    if (state.authenticated) return { kind: 'redirect', to: '/' };
    return area === 'login' ? { kind: 'render' } : { kind: 'redirect', to: '/login' };
  }
  return state.authenticated ? { kind: 'render' } : { kind: 'redirect', to: '/login' };
}

/** Only same-app paths are allowed as a post-login target (no open redirect). */
export function safeReturnPath(from: unknown): string {
  if (typeof from !== 'string') return '/';
  if (!from.startsWith('/') || from.startsWith('//') || from.startsWith('/\\')) return '/';
  if (from.startsWith('/login') || from.startsWith('/setup')) return '/';
  return from;
}
