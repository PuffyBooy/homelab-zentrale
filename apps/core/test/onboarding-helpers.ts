import type { LightMyRequestResponse } from 'fastify';
import type { OnboardingCreateResponse } from '@hz/shared';
import { withStepUp } from './agent-helpers.js';
import { authHeaders, completeSetup, makeApp, type TestApp } from './helpers.js';

export const HUB = 'https://hz.test';

/** App with HZ_BASE_URL set and an admin session. */
export async function onboardingApp(
  opts: Parameters<typeof makeApp>[0] = {},
): Promise<{ t: TestApp; cookie: string; secret: string }> {
  const t = await makeApp({ ...opts, env: { HZ_BASE_URL: HUB, ...opts.env } });
  const { cookie, secret } = await completeSetup(t);
  return { t, cookie, secret };
}

export function createOnboardingRaw(
  t: TestApp,
  cookie: string,
  payload: unknown = { name: 'pi', location: 'home' },
): Promise<LightMyRequestResponse> {
  return withStepUp(t, () =>
    t.app.inject({
      method: 'POST',
      url: '/api/servers/onboarding',
      headers: authHeaders(cookie),
      payload: payload as object,
    }),
  );
}

export async function createOnboarding(
  t: TestApp,
  cookie: string,
  name = 'pi',
): Promise<OnboardingCreateResponse> {
  const res = await createOnboardingRaw(t, cookie, { name, location: 'home' });
  if (res.statusCode !== 201) throw new Error(`onboarding ${res.statusCode}`);
  return res.json<OnboardingCreateResponse>();
}

/** POST /api/onboarding/exchange as curl would (no Origin, no cookie). */
export function exchange(
  t: TestApp,
  code: unknown,
  ip = '100.64.0.9',
): Promise<LightMyRequestResponse> {
  return t.app.inject({
    method: 'POST',
    url: '/api/onboarding/exchange',
    headers: { host: 'hz.test', 'x-forwarded-for': ip, 'content-type': 'application/json' },
    payload: JSON.stringify({ code }),
  });
}

export async function onboardingState(
  t: TestApp,
  cookie: string,
  id: string,
): Promise<{ state: string; serverId: string | null; expiresAt: string }> {
  const res = await t.app.inject({
    method: 'GET',
    url: `/api/servers/onboarding/${id}`,
    headers: authHeaders(cookie),
  });
  if (res.statusCode !== 200) throw new Error(`status ${res.statusCode}`);
  return res.json();
}
