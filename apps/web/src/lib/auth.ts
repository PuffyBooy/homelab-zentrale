import {
  authStateSchema,
  loginResponseSchema,
  okResponseSchema,
  recoveryCodesResponseSchema,
  sessionListResponseSchema,
  setupStartResponseSchema,
  stepUpResponseSchema,
  type AuthState,
  type LoginRequest,
  type RecoveryCodesResponse,
  type SessionListResponse,
  type SetupConfirmRequest,
  type SetupStartRequest,
  type SetupStartResponse,
  type StepUpResponse,
} from '@hz/shared';
import { api } from './api.js';

type OkResponse = { ok: true };

export const authStateKey = ['auth', 'state'] as const;
export const sessionsKey = ['auth', 'sessions'] as const;

export function fetchAuthState(signal?: AbortSignal): Promise<AuthState> {
  return api('/api/auth/state', { schema: authStateSchema, signal, quiet401: true });
}

export function setupStart(body: SetupStartRequest): Promise<SetupStartResponse> {
  return api('/api/setup/start', {
    method: 'POST',
    body,
    schema: setupStartResponseSchema,
    quiet401: true,
  });
}

export function setupConfirm(body: SetupConfirmRequest): Promise<RecoveryCodesResponse> {
  return api('/api/setup/confirm', {
    method: 'POST',
    body,
    schema: recoveryCodesResponseSchema,
    quiet401: true,
  });
}

/** Answers with the new auth state and sets the session cookie. */
export function login(body: LoginRequest): Promise<AuthState> {
  return api('/api/auth/login', {
    method: 'POST',
    body,
    schema: loginResponseSchema,
    quiet401: true,
  });
}

export function logout(): Promise<OkResponse> {
  return api('/api/auth/logout', { method: 'POST', schema: okResponseSchema, quiet401: true });
}

export function stepUp(code: string): Promise<StepUpResponse> {
  return api('/api/auth/step-up', {
    method: 'POST',
    body: { code },
    schema: stepUpResponseSchema,
    stepUp: false,
  });
}

export function fetchSessions(signal?: AbortSignal): Promise<SessionListResponse> {
  return api('/api/auth/sessions', { schema: sessionListResponseSchema, signal });
}

export function revokeSession(id: string): Promise<OkResponse> {
  return api(`/api/auth/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    schema: okResponseSchema,
  });
}

export function regenerateRecoveryCodes(): Promise<RecoveryCodesResponse> {
  return api('/api/auth/recovery-codes', { method: 'POST', schema: recoveryCodesResponseSchema });
}
