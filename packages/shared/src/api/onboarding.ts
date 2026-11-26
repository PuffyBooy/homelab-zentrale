import { z } from 'zod';
import { agentNameSchema, agentTokenSchema } from '../agent-protocol.js';
import { enrollRequestSchema } from './servers.js';

/**
 * M11: add a server in one step (ROADMAP M11, SPEC 5.3).
 *
 * 1. Admin: POST /api/servers/onboarding (session + step-up, like enroll)
 *    { name, location } -> 201 OnboardingCreateResponse. The code is shown once
 *    and stored only as HMAC-SHA-256 (key derived from HZ_SECRET_KEY; a plain
 *    SHA-256 of 40 bit would be cheap to reverse from a DB copy). Max
 *    ONBOARDING_MAX_PENDING open codes (409 conflict), name taken -> 409 conflict.
 * 2. On the new server: `curl -fsSL https://<hub>/install.sh | sudo sh -s -- <code>`.
 *    GET /install.sh is public inside the tailnet (no session, like /api/health),
 *    Content-Type INSTALL_SCRIPT_CONTENT_TYPE. The script is the same for every
 *    server and contains no secret and no code; only the hub URL is filled in.
 *    It validates the code locally (ONBOARDING_CODE_SHELL_RE), checks Docker
 *    and Tailscale, calls the exchange, pulls the image and starts the agent
 *    like deploy/docker-compose.agent.yml. It never prints the token.
 * 3. The script: POST /api/onboarding/exchange { code } (public in the tailnet,
 *    no session, no Origin check since curl sends none; rate-limited with
 *    ONBOARDING_EXCHANGE_RATE). Success: 200 text/plain, onboardingExchangeToEnv()
 *    of an OnboardingExchangeResponse. The code is consumed at once (one-time).
 *    Unknown, used, expired and wrong codes all get the same answer:
 *    400 { ok: false, error: 'invalid_credentials', message: ONBOARDING_INVALID_MESSAGE }.
 *    Malformed body: 400 invalid_input. Rate limit: 429 rate_limited + retryAfter.
 *    The code and the token are never logged (also not in the access log body).
 * 4. Admin page polls GET /api/servers/onboarding/:id every ONBOARDING_POLL_MS
 *    and shows "verbunden" when state is `connected`.
 *    DELETE /api/servers/onboarding/:id (session) cancels an open code -> { ok }.
 */

/** No 0/O, 1/I/L. 31 symbols, 8 chars: ~39,6 bit. */
export const ONBOARDING_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const ONBOARDING_CODE_LENGTH = 8;
export const ONBOARDING_TTL_MINUTES = 15;
/** Open (not exchanged, not expired) onboarding codes at the same time. */
export const ONBOARDING_MAX_PENDING = 10;
export const ONBOARDING_POLL_MS = 2000;
export const INSTALL_SCRIPT_PATH = '/install.sh';
export const INSTALL_SCRIPT_CONTENT_TYPE = 'text/x-shellscript; charset=utf-8';
export const ONBOARDING_EXCHANGE_PATH = '/api/onboarding/exchange';
/** Fixed German message for every refused code (no hint which case it was). */
export const ONBOARDING_INVALID_MESSAGE = 'Code ungültig oder abgelaufen.';

/**
 * Brute-force limit of POST /api/onboarding/exchange: at most `perIp` attempts
 * per IP and window (successful ones count too), and at most `globalFailures`
 * failed attempts over all IPs per window; when that is hit every exchange is
 * refused (429) until the window ends. With 31^8 codes and <= 10 open ones a
 * guess succeeds with p < 10^-9 per window.
 */
export const ONBOARDING_EXCHANGE_RATE = {
  perIp: 5,
  globalFailures: 30,
  windowMs: 15 * 60_000,
} as const;

const CODE_CHARS = `[${ONBOARDING_CODE_ALPHABET}]`;
/** Canonical stored/compared form: 8 chars, upper case, no dash. */
export const ONBOARDING_CODE_RE = new RegExp(`^${CODE_CHARS}{${ONBOARDING_CODE_LENGTH}}$`);
/** Display form XXXX-XXXX (UI and one-liner). */
export const ONBOARDING_CODE_DISPLAY_RE = new RegExp(`^${CODE_CHARS}{4}-${CODE_CHARS}{4}$`);
/** What install.sh accepts before it sends anything (POSIX ERE, case-insensitive input). */
export const ONBOARDING_CODE_SHELL_RE =
  '^[2-9A-HJKMNP-Za-hjkmnp-z]{4}-?[2-9A-HJKMNP-Za-hjkmnp-z]{4}$';

/** Trim, upper case, drop one dash between the two halves. Does not validate. */
export function normalizeOnboardingCode(input: string): string {
  const s = input.trim().toUpperCase();
  return /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(s) ? s.replace('-', '') : s;
}

/** Canonical 8 chars -> XXXX-XXXX. */
export function formatOnboardingCode(canonical: string): string {
  return `${canonical.slice(0, 4)}-${canonical.slice(4)}`;
}

/**
 * Accepts `ABCD-EFGH`, `abcdefgh`, ` abcd-efgh ` and returns the canonical
 * `ABCDEFGH`. Rejects 0/O/1/I/L, other lengths, other separators.
 */
export const onboardingCodeSchema = z
  .string()
  .max(16)
  .transform(normalizeOnboardingCode)
  .pipe(z.string().regex(ONBOARDING_CODE_RE));

/** https origin of the hub (HZ_BASE_URL), no path, no query. */
export const hubOriginSchema = z
  .url({ protocol: /^https$/ })
  .max(253)
  .refine((u) => new URL(u).origin === u.replace(/\/$/, ''), { message: 'origin only' });

/** The one-liner shown in the UI. `code` in display form. */
export function buildOneLiner(hubOrigin: string, code: string): string {
  return `curl -fsSL ${hubOrigin.replace(/\/$/, '')}${INSTALL_SCRIPT_PATH} | sudo sh -s -- ${code}`;
}

export const onboardingIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export const onboardingIdParamsSchema = z.strictObject({ id: onboardingIdSchema });

// POST /api/servers/onboarding (step-up)
export const onboardingCreateRequestSchema = enrollRequestSchema;
export type OnboardingCreateRequest = z.infer<typeof onboardingCreateRequestSchema>;
export const onboardingCreateResponseSchema = z.strictObject({
  id: onboardingIdSchema,
  name: agentNameSchema,
  /** Display form XXXX-XXXX. Shown once. */
  code: z.string().regex(ONBOARDING_CODE_DISPLAY_RE),
  /** now + ONBOARDING_TTL_MINUTES. */
  expiresAt: z.iso.datetime(),
  /** buildOneLiner(HZ_BASE_URL, code). */
  oneLiner: z.string().max(400),
});
export type OnboardingCreateResponse = z.infer<typeof onboardingCreateResponseSchema>;

/**
 * waiting: code not used yet. installing: code exchanged, agent not connected
 * yet (its enrollment token is valid ONBOARDING_TTL_MINUTES from the exchange).
 * connected: the agent enrolled (serverId set). expired: code or enrollment
 * token expired unused, or cancelled.
 */
export const onboardingStateSchema = z.enum(['waiting', 'installing', 'connected', 'expired']);
export type OnboardingState = z.infer<typeof onboardingStateSchema>;

// GET /api/servers/onboarding/:id (session) -> 404 not_found when unknown
export const onboardingStatusResponseSchema = z.strictObject({
  id: onboardingIdSchema,
  name: agentNameSchema,
  state: onboardingStateSchema,
  expiresAt: z.iso.datetime(),
  /** Only when connected. */
  serverId: z.string().max(64).nullable(),
});
export type OnboardingStatusResponse = z.infer<typeof onboardingStatusResponseSchema>;

// POST /api/onboarding/exchange (public in the tailnet, rate-limited)
export const onboardingExchangeRequestSchema = z.strictObject({ code: onboardingCodeSchema });
export type OnboardingExchangeRequest = z.infer<typeof onboardingExchangeRequestSchema>;

/** Same rule as HZ_AGENT_IMAGE in the core config. */
export const agentImageSchema = z.string().regex(/^[a-z0-9][a-z0-9._/:@-]{0,254}$/);
/** HZ_CORE_URL of the agent: wss://<hub>/agent (ws:// only for 127.0.0.1 in development). */
export const agentCoreUrlSchema = z
  .string()
  .max(300)
  .regex(/^(wss:\/\/[A-Za-z0-9.-]+(:\d{1,5})?|ws:\/\/127\.0\.0\.1:\d{1,5})\/agent$/);

export const onboardingExchangeResponseSchema = z.strictObject({
  /** Fresh one-time enrollment token (stored hashed, 15 min). Secret: never logged. */
  enrollToken: agentTokenSchema,
  /** Agent WebSocket URL (HZ_CORE_URL). */
  hubUrl: agentCoreUrlSchema,
  /** HZ_AGENT_IMAGE of the core (GHCR or own registry). */
  agentImage: agentImageSchema,
  /** HZ_AGENT_NAME. */
  name: agentNameSchema,
});
export type OnboardingExchangeResponse = z.infer<typeof onboardingExchangeResponseSchema>;

/**
 * Body of a successful exchange (text/plain): four `KEY=value` lines in this
 * order. All values match strict patterns (no spaces, quotes or `$`), so the
 * script can read them with `sed`/`case` without eval.
 */
export const ONBOARDING_ENV_KEYS = [
  'HZ_CORE_URL',
  'HZ_AGENT_NAME',
  'HZ_AGENT_TOKEN',
  'HZ_AGENT_IMAGE',
] as const;

export function onboardingExchangeToEnv(r: OnboardingExchangeResponse): string {
  const v = onboardingExchangeResponseSchema.parse(r);
  return (
    [
      `HZ_CORE_URL=${v.hubUrl}`,
      `HZ_AGENT_NAME=${v.name}`,
      `HZ_AGENT_TOKEN=${v.enrollToken}`,
      `HZ_AGENT_IMAGE=${v.agentImage}`,
    ].join('\n') + '\n'
  );
}

/** Inverse of onboardingExchangeToEnv (tests, agent-side checks). Null if anything is off. */
export function parseOnboardingEnv(text: string): OnboardingExchangeResponse | null {
  const lines = text.replace(/\n$/, '').split('\n');
  if (lines.length !== ONBOARDING_ENV_KEYS.length) return null;
  const vals: string[] = [];
  for (const [i, key] of ONBOARDING_ENV_KEYS.entries()) {
    const line = lines[i];
    if (!line?.startsWith(`${key}=`)) return null;
    vals.push(line.slice(key.length + 1));
  }
  const parsed = onboardingExchangeResponseSchema.safeParse({
    hubUrl: vals[0],
    name: vals[1],
    enrollToken: vals[2],
    agentImage: vals[3],
  });
  return parsed.success ? parsed.data : null;
}
