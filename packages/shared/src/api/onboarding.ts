import { z } from 'zod';
import { agentNameSchema, agentTokenSchema } from '../agent-protocol.js';
import { enrollRequestSchema } from './servers.js';
import { onboardingTailscaleModeSchema, TAILSCALE_AUTH_KEY_RE } from './tailscale.js';

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

/** Official Tailscale installer for Linux (public, works before the tailnet). */
export const TAILSCALE_INSTALL_URL = 'https://tailscale.com/install.sh';

const HUB_ORIGIN_SHAPE = /^(https?):\/\/([A-Za-z0-9.-]{1,253})(?::([0-9]{1,5}))?$/;
const HOSTNAME_SHAPE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface BootstrapInput {
  hubOrigin: string;
  /** Display form XXXX-XXXX. */
  code: string;
  /** Tailscale host name of the new server (the agent name). */
  hostname: string;
  /** Single-use auth key, or null for the interactive login. */
  authKey: string | null;
}

/**
 * The command for a fresh server (M11b). One `sudo sh -c '...'`:
 *  1. installs Tailscale with the official script if `tailscale` is missing,
 *  2. joins the tailnet unless already connected: with the single-use auth key, or
 *     interactively (tailscale prints a login link and waits),
 *  3. fetches install.sh of the hub over the tailnet into a temp file. For a *.ts.net
 *     hub the address comes from `tailscale ip` (curl --resolve), so a server whose
 *     MagicDNS is not ready yet (or switched off) still reaches the hub,
 *  4. runs it with the code (install.sh does Docker, DNS, the agent).
 * It starts with a space: bash with HISTCONTROL=ignorespace/ignoreboth (Debian and
 * Ubuntu default) keeps it out of the history. Every value is checked against a strict
 * pattern without quotes, spaces or `$`, so nothing can leave the single quotes.
 */
export function buildBootstrapCommand(input: BootstrapInput): string {
  const m = HUB_ORIGIN_SHAPE.exec(input.hubOrigin.replace(/\/$/, ''));
  if (!m) throw new Error('invalid hub origin');
  const [, proto, host = '', port] = m;
  if (!ONBOARDING_CODE_DISPLAY_RE.test(input.code)) throw new Error('invalid code');
  if (!HOSTNAME_SHAPE.test(input.hostname)) throw new Error('invalid hostname');
  if (input.authKey !== null && !TAILSCALE_AUTH_KEY_RE.test(input.authKey)) {
    throw new Error('invalid auth key');
  }
  const origin = `${proto}://${host}${port ? `:${port}` : ''}`;
  const up =
    input.authKey === null
      ? `tailscale up --hostname=${input.hostname}`
      : `tailscale up --auth-key=${input.authKey} --hostname=${input.hostname}`;
  const tsnet = proto === 'https' && host.endsWith('.ts.net');
  const short = host.split('.')[0] ?? '';
  const fetchHub = tsnet
    ? `ip=$(tailscale ip -4 ${short} 2>/dev/null | head -n 1); curl -fsS --proto =https \${ip:+--resolve ${host}:${port ?? '443'}:$ip} -o "$f" ${origin}${INSTALL_SCRIPT_PATH}`
    : `curl -fsS -o "$f" ${origin}${INSTALL_SCRIPT_PATH}`;
  const script = [
    `command -v tailscale >/dev/null 2>&1 || curl -fsSL ${TAILSCALE_INSTALL_URL} | sh`,
    `command -v tailscale >/dev/null 2>&1 || { echo "Fehler: Tailscale ließ sich nicht installieren." >&2; exit 1; }`,
    `tailscale status >/dev/null 2>&1 || ${up} || { echo "Fehler: Anmeldung bei Tailscale fehlgeschlagen. Bitte in der Zentrale einen neuen Code erzeugen." >&2; exit 1; }`,
    `f=$(mktemp)`,
    `${fetchHub} || { rm -f "$f"; echo "Fehler: Die Zentrale ist über Tailscale nicht erreichbar (${origin})." >&2; exit 1; }`,
    `sh "$f" ${input.code}`,
    `r=$?`,
    `rm -f "$f"`,
    `exit $r`,
  ].join('; ');
  return ` sudo sh -c '${script}'`;
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
  /** buildBootstrapCommand(...): joins Tailscale, then runs install.sh. Shown once. */
  oneLiner: z.string().max(1500),
  /** buildOneLiner(HZ_BASE_URL, code): for a server that is already in the tailnet. */
  plainOneLiner: z.string().max(400),
  /** auto: the command carries a single-use auth key; login: Tailscale shows a link. */
  tailscale: onboardingTailscaleModeSchema,
  /** Why it is `login` although a Tailscale client is stored (fixed German text). */
  tailscaleNote: z.string().max(200).nullable(),
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
