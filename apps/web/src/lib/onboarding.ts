import {
  ONBOARDING_POLL_MS,
  onboardingCreateResponseSchema,
  onboardingStatusResponseSchema,
  type OnboardingCreateRequest,
  type OnboardingCreateResponse,
  type OnboardingState,
  type OnboardingStatusResponse,
} from '@hz/shared';
import type { Status } from '@hz/ui';
import { api } from './api.js';

export { ONBOARDING_POLL_MS };

export const onboardingKey = (id: string) => ['onboarding', id] as const;

const enc = encodeURIComponent;
const okSchema = { parse: (d: unknown): unknown => d };

/** Step-up comes from api() like for the manual enroll token. 201 with the code (shown once). */
export function createOnboarding(body: OnboardingCreateRequest): Promise<OnboardingCreateResponse> {
  return api('/api/servers/onboarding', {
    method: 'POST',
    body,
    schema: onboardingCreateResponseSchema,
  });
}

export function fetchOnboarding(
  id: string,
  signal?: AbortSignal,
): Promise<OnboardingStatusResponse> {
  return api(`/api/servers/onboarding/${enc(id)}`, {
    schema: onboardingStatusResponseSchema,
    signal,
  });
}

/** Cancels an open code. */
export async function cancelOnboarding(id: string): Promise<void> {
  await api(`/api/servers/onboarding/${enc(id)}`, { method: 'DELETE', schema: okSchema });
}

// ---------------------------------------------------------------------------
// Presentation helpers (pure, unit tested)

/** waiting/installing poll on; connected/expired are final. */
export function onboardingFinal(state: OnboardingState): boolean {
  return state === 'connected' || state === 'expired';
}

/**
 * The state the dialog shows: the poll answer, but a waiting code past its expiry is
 * already "Abgelaufen" (the next poll says the same).
 */
export function effectiveState(
  state: OnboardingState,
  expiresAt: string,
  now: Date,
): OnboardingState {
  if (state === 'waiting' && new Date(expiresAt).getTime() <= now.getTime()) return 'expired';
  return state;
}

export interface OnboardingView {
  status: Status;
  /** Short tag text next to the dot. */
  label: string;
}

export function onboardingView(state: OnboardingState): OnboardingView {
  switch (state) {
    case 'waiting':
      return { status: 'busy', label: 'Wartet auf den Server …' };
    case 'installing':
      return { status: 'busy', label: 'Installiert …' };
    case 'connected':
      return { status: 'ok', label: 'Verbunden' };
    case 'expired':
      return { status: 'off', label: 'Abgelaufen' };
  }
}

/** Countdown "14:32" (mm:ss) until `expiresAt`; "0:00" when over. */
export function countdown(expiresAt: string, now: Date): string {
  const left = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now.getTime()) / 1000));
  const m = Math.floor(left / 60);
  const s = left % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
