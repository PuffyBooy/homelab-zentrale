import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, count, eq, gt, isNull, lt } from 'drizzle-orm';
import {
  agentCoreUrlSchema,
  buildOneLiner,
  formatOnboardingCode,
  hubOriginSchema,
  ONBOARDING_CODE_ALPHABET,
  ONBOARDING_CODE_LENGTH,
  ONBOARDING_CODE_SHELL_RE,
  ONBOARDING_EXCHANGE_PATH,
  ONBOARDING_EXCHANGE_RATE,
  ONBOARDING_MAX_PENDING,
  ONBOARDING_TTL_MINUTES,
  type OnboardingCreateResponse,
  type OnboardingExchangeResponse,
  type OnboardingState,
  type OnboardingStatusResponse,
} from '@hz/shared';
import { NameTakenError, type AgentTokens } from '../agents/tokens.js';
import type { Clock } from '../clock.js';
import type { Config } from '../config.js';
import { deriveSubkey, hmacSha256Hex, randomToken } from '../crypto.js';
import type { Db } from '../db/index.js';
import { onboardingCodes, type OnboardingCodeRow } from '../db/schema.js';

export const ONBOARDING_TTL_MS = ONBOARDING_TTL_MINUTES * 60_000;
/** Finished onboarding rows are kept this long (status page, audit has the rest). */
export const ONBOARDING_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Where the hub is reached: the https origin for curl and the agent WebSocket URL. */
export interface OnboardingHub {
  origin: string;
  coreUrl: string;
}

const LOOPBACK_DEV_HOST = '127.0.0.1';

/**
 * The hub address used in the one-liner, install.sh and the exchange. Only from
 * the configuration (HZ_BASE_URL), never from the request Host header. Outside
 * production, without an https HZ_BASE_URL, the local core on 127.0.0.1 is used
 * (development, e2e with a simulated agent). Production without an https
 * HZ_BASE_URL has no onboarding (null).
 */
export function onboardingHub(
  config: Pick<Config, 'baseUrl' | 'port' | 'env'>,
): OnboardingHub | null {
  if (config.baseUrl?.startsWith('https://')) {
    const origin = new URL(config.baseUrl).origin;
    if (!hubOriginSchema.safeParse(origin).success) return null;
    const coreUrl = `wss://${new URL(origin).host}/agent`;
    return agentCoreUrlSchema.safeParse(coreUrl).success ? { origin, coreUrl } : null;
  }
  if (config.env === 'production') return null;
  return {
    origin: `http://${LOOPBACK_DEV_HOST}:${config.port}`,
    coreUrl: `ws://${LOOPBACK_DEV_HOST}:${config.port}/agent`,
  };
}

/** Strict form of everything substituted into install.sh (no quotes, spaces, `$`). */
const SCRIPT_ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/;

const here = dirname(fileURLToPath(import.meta.url));
/** apps/core/templates/install.sh, seen from apps/core/src/servers or apps/core/dist/servers. */
export const INSTALL_TEMPLATE_PATH = resolve(here, '../../templates/install.sh');

let templateCache: string | null = null;

/**
 * install.sh for this hub. The same for every server: only the hub origin,
 * the code pattern and the exchange path are filled in. No secret, no code.
 */
export function renderInstallScript(hub: OnboardingHub): string {
  if (!SCRIPT_ORIGIN_RE.test(hub.origin)) throw new Error('invalid hub origin');
  templateCache ??= readFileSync(INSTALL_TEMPLATE_PATH, 'utf8');
  const values: Record<string, string> = {
    HZ_HUB_ORIGIN: hub.origin,
    HZ_CODE_RE: ONBOARDING_CODE_SHELL_RE,
    HZ_EXCHANGE_PATH: ONBOARDING_EXCHANGE_PATH,
  };
  return templateCache.replace(/@@([A-Z_]+)@@/g, (_m, key: string) => {
    const v = values[key];
    if (v === undefined) throw new Error('unknown template key');
    return v;
  });
}

/** Uniform random code over ONBOARDING_CODE_ALPHABET (canonical form). */
export function generateOnboardingCode(): string {
  let s = '';
  for (let i = 0; i < ONBOARDING_CODE_LENGTH; i++) {
    s += ONBOARDING_CODE_ALPHABET[randomInt(ONBOARDING_CODE_ALPHABET.length)];
  }
  return s;
}

export class OnboardingError extends Error {
  constructor(public readonly reason: 'name_taken' | 'too_many' | 'not_configured') {
    super(reason);
    this.name = 'OnboardingError';
  }
}

export type ExchangeResult =
  { ok: true; id: string; response: OnboardingExchangeResponse } | { ok: false };

/**
 * Onboarding codes: create, exchange once for an enrollment token, status.
 * Codes are stored only as HMAC-SHA-256 with a subkey of HZ_SECRET_KEY; plain
 * codes and tokens exist only in the create and exchange responses.
 */
export class OnboardingService {
  private readonly hmacKey: Buffer;

  constructor(
    private readonly deps: {
      db: Db;
      now: Clock;
      tokens: AgentTokens;
      config: Pick<Config, 'baseUrl' | 'port' | 'env' | 'agentImage' | 'secretKey'>;
    },
  ) {
    this.hmacKey = deriveSubkey(deps.config.secretKey, 'hz:onboarding-code:v1');
  }

  hub(): OnboardingHub | null {
    return onboardingHub(this.deps.config);
  }

  private codeHash(canonical: string): string {
    return hmacSha256Hex(this.hmacKey, canonical);
  }

  private row(id: string): OnboardingCodeRow | undefined {
    return this.deps.db.select().from(onboardingCodes).where(eq(onboardingCodes.id, id)).get();
  }

  /** Open: not exchanged, not cancelled, not expired. */
  private pendingCount(now: number): number {
    const r = this.deps.db
      .select({ n: count() })
      .from(onboardingCodes)
      .where(
        and(
          isNull(onboardingCodes.exchangedAt),
          isNull(onboardingCodes.cancelledAt),
          gt(onboardingCodes.expiresAt, now),
        ),
      )
      .get();
    return r?.n ?? 0;
  }

  /** Another onboarding for this name that is waiting or installing. */
  private nameBusy(name: string): boolean {
    const rows = this.deps.db
      .select()
      .from(onboardingCodes)
      .where(and(eq(onboardingCodes.name, name), isNull(onboardingCodes.cancelledAt)))
      .all();
    return rows.some((r) => {
      const s = this.stateOf(r).state;
      return s === 'waiting' || s === 'installing';
    });
  }

  create(name: string, location: string): OnboardingCreateResponse {
    const hub = this.hub();
    if (!hub) throw new OnboardingError('not_configured');
    const now = this.deps.now();
    if (this.deps.tokens.nameTaken(name) || this.nameBusy(name)) {
      throw new OnboardingError('name_taken');
    }
    if (this.pendingCount(now) >= ONBOARDING_MAX_PENDING) throw new OnboardingError('too_many');
    const id = randomToken(16);
    const expiresAt = now + ONBOARDING_TTL_MS;
    // A collision of two open codes is astronomically unlikely; the UNIQUE index
    // would reject it, so retry a few times with a new code.
    for (let attempt = 0; ; attempt++) {
      const code = generateOnboardingCode();
      try {
        this.deps.db
          .insert(onboardingCodes)
          .values({
            id,
            name,
            location,
            codeHash: this.codeHash(code),
            createdAt: now,
            expiresAt,
          })
          .run();
        const display = formatOnboardingCode(code);
        return {
          id,
          name,
          code: display,
          expiresAt: new Date(expiresAt).toISOString(),
          oneLiner: buildOneLiner(hub.origin, display),
        };
      } catch (err) {
        if (attempt >= 4) throw err;
      }
    }
  }

  /**
   * Swaps a canonical code for a fresh enrollment token. The code is consumed
   * at once (also if the enrollment then fails). Every refusal is the same `{ ok: false }`.
   */
  exchange(canonical: string): ExchangeResult {
    const hub = this.hub();
    if (!hub) return { ok: false };
    const now = this.deps.now();
    const consumed = this.deps.db
      .update(onboardingCodes)
      .set({ exchangedAt: now })
      .where(
        and(
          eq(onboardingCodes.codeHash, this.codeHash(canonical)),
          isNull(onboardingCodes.exchangedAt),
          isNull(onboardingCodes.cancelledAt),
          gt(onboardingCodes.expiresAt, now),
        ),
      )
      .returning()
      .get();
    if (!consumed) return { ok: false };
    let enrollment: { id: string; token: string };
    try {
      enrollment = this.deps.tokens.createEnrollment(consumed.name, consumed.location);
    } catch (err) {
      if (err instanceof NameTakenError) return { ok: false };
      throw err;
    }
    this.deps.db
      .update(onboardingCodes)
      .set({ enrollTokenId: enrollment.id })
      .where(eq(onboardingCodes.id, consumed.id))
      .run();
    return {
      ok: true,
      id: consumed.id,
      response: {
        enrollToken: enrollment.token,
        hubUrl: hub.coreUrl,
        agentImage: this.deps.config.agentImage,
        name: consumed.name,
      },
    };
  }

  private stateOf(r: OnboardingCodeRow): {
    state: OnboardingState;
    expiresAt: number;
    serverId: string | null;
  } {
    const now = this.deps.now();
    if (r.exchangedAt === null) {
      if (r.cancelledAt !== null || r.expiresAt <= now) {
        return { state: 'expired', expiresAt: r.expiresAt, serverId: null };
      }
      return { state: 'waiting', expiresAt: r.expiresAt, serverId: null };
    }
    const e = r.enrollTokenId ? this.deps.tokens.enrollment(r.enrollTokenId) : undefined;
    if (!e) return { state: 'expired', expiresAt: r.expiresAt, serverId: null };
    if (e.serverId !== null)
      return { state: 'connected', expiresAt: e.expiresAt, serverId: e.serverId };
    if (r.cancelledAt !== null || e.usedAt !== null || e.expiresAt <= now) {
      return { state: 'expired', expiresAt: e.expiresAt, serverId: null };
    }
    return { state: 'installing', expiresAt: e.expiresAt, serverId: null };
  }

  status(id: string): OnboardingStatusResponse | null {
    const r = this.row(id);
    if (!r) return null;
    const s = this.stateOf(r);
    return {
      id: r.id,
      name: r.name,
      state: s.state,
      expiresAt: new Date(s.expiresAt).toISOString(),
      serverId: s.serverId,
    };
  }

  /**
   * Cancels a waiting or installing onboarding (the enrollment token stops
   * working). Expired ones are left as they are. Null: unknown id; 'connected':
   * nothing to cancel.
   */
  cancel(id: string): OnboardingState | 'connected' | null {
    const r = this.row(id);
    if (!r) return null;
    const { state } = this.stateOf(r);
    if (state === 'connected') return 'connected';
    if (state === 'waiting' || state === 'installing') {
      this.deps.db
        .update(onboardingCodes)
        .set({ cancelledAt: this.deps.now() })
        .where(eq(onboardingCodes.id, id))
        .run();
      if (r.enrollTokenId) this.deps.tokens.cancelEnrollment(r.enrollTokenId);
    }
    return state;
  }

  /** Drops rows that ended more than ONBOARDING_RETENTION_MS ago. */
  prune(): number {
    const cutoff = this.deps.now() - ONBOARDING_RETENTION_MS;
    return this.deps.db.delete(onboardingCodes).where(lt(onboardingCodes.expiresAt, cutoff)).run()
      .changes;
  }
}

/**
 * Brute-force limit of the exchange (ONBOARDING_EXCHANGE_RATE): every attempt
 * counts per client IP; failed attempts also count globally, and when the
 * global cap is hit all exchanges are refused until that window ends.
 * In memory: a restart resets it, which an attacker cannot trigger.
 */
export class ExchangeLimiter {
  private readonly perIp = new Map<string, number[]>();
  private globalFailures: number[] = [];
  private globalBlockedUntil = 0;

  constructor(
    private readonly now: Clock,
    private readonly rate: {
      perIp: number;
      globalFailures: number;
      windowMs: number;
    } = ONBOARDING_EXCHANGE_RATE,
  ) {}

  /** Seconds to wait, or 0 if the attempt may proceed. Records the attempt when allowed. */
  attempt(ip: string): number {
    const now = this.now();
    if (this.globalBlockedUntil > now) return Math.ceil((this.globalBlockedUntil - now) / 1000);
    const list = (this.perIp.get(ip) ?? []).filter((t) => now - t < this.rate.windowMs);
    if (list.length >= this.rate.perIp) {
      this.perIp.set(ip, list);
      const oldest = list[0] ?? now;
      return Math.max(1, Math.ceil((oldest + this.rate.windowMs - now) / 1000));
    }
    list.push(now);
    this.perIp.set(ip, list);
    if (this.perIp.size > 1000) this.prune(now);
    return 0;
  }

  failure(): void {
    const now = this.now();
    this.globalFailures = this.globalFailures.filter((t) => now - t < this.rate.windowMs);
    this.globalFailures.push(now);
    if (this.globalFailures.length >= this.rate.globalFailures) {
      this.globalBlockedUntil = now + this.rate.windowMs;
      this.globalFailures = [];
    }
  }

  private prune(now: number): void {
    for (const [ip, list] of this.perIp) {
      if (list.every((t) => now - t >= this.rate.windowMs)) this.perIp.delete(ip);
    }
  }
}
