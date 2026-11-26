import { and, count, eq, isNull, lt, or } from 'drizzle-orm';
import type { Modules } from '@hz/shared';
import type { Clock } from '../clock.js';
import type { SecretBox } from '../crypto.js';
import { writeAudit, type AuditEntry } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { recoveryCodes, users, type User } from '../db/schema.js';
import type { WallDeviceResolver } from './guard.js';
import { FailureLimiter, loginLimits } from './rate-limit.js';
import { generateRecoveryCodes, hashRecoveryCode } from './recovery.js';
import { SessionStore } from './sessions.js';
import { SetupState } from './setup.js';
import { verifyTotp } from './totp.js';

const TOTP_AAD = 'users.totp_secret';

export interface AuthDeps {
  db: Db;
  box: SecretBox;
  now: Clock;
}

/** Auth state and data access. Routes stay thin; all rules live here. */
export class AuthService {
  readonly sessions: SessionStore;
  readonly setup = new SetupState();
  readonly loginLimiter: FailureLimiter;
  readonly setupLimiter: FailureLimiter;
  readonly stepUpLimiter: FailureLimiter;
  readonly now: Clock;
  /** Wall cookie lookup for DEVICE_API_ROUTES (set by the wall module). */
  wallDevices: WallDeviceResolver | null = null;
  /** Extra fields of /api/auth/state for a signed-in admin (installed by app.ts). */
  bootstrap: (() => { modules: Modules; timeZone: string }) | null = null;
  private readonly db: Db;
  private readonly box: SecretBox;

  constructor(deps: AuthDeps) {
    this.db = deps.db;
    this.box = deps.box;
    this.now = deps.now;
    this.sessions = new SessionStore(deps.db, deps.now);
    this.loginLimiter = new FailureLimiter(loginLimits, deps.now);
    this.setupLimiter = new FailureLimiter({ ...loginLimits, max: 10 }, deps.now);
    this.stepUpLimiter = new FailureLimiter(loginLimits, deps.now);
  }

  hasUser(): boolean {
    const row = this.db.select({ n: count() }).from(users).get();
    return (row?.n ?? 0) > 0;
  }

  findUser(username: string): User | undefined {
    return this.db.select().from(users).where(eq(users.username, username)).get();
  }

  encryptTotpSecret(secret: string): string {
    return this.box.encrypt(secret, TOTP_AAD);
  }

  /**
   * Checks a TOTP code and records its time step atomically, so the same code
   * (or an older one) is never accepted twice, not even by parallel requests.
   */
  consumeTotp(user: User, code: string): boolean {
    const secret = this.box.decrypt(user.totpSecretEnc, TOTP_AAD);
    const step = verifyTotp(secret, code, this.now(), user.totpLastStep);
    if (step === null) return false;
    const r = this.db
      .update(users)
      .set({ totpLastStep: step })
      .where(
        and(eq(users.id, user.id), or(isNull(users.totpLastStep), lt(users.totpLastStep, step))),
      )
      .run();
    if (r.changes !== 1) return false;
    user.totpLastStep = step;
    return true;
  }

  /** Marks a matching unused recovery code as used. */
  consumeRecoveryCode(user: User, code: string): boolean {
    const r = this.db
      .update(recoveryCodes)
      .set({ usedAt: this.now() })
      .where(
        and(
          eq(recoveryCodes.userId, user.id),
          eq(recoveryCodes.codeHash, hashRecoveryCode(code)),
          isNull(recoveryCodes.usedAt),
        ),
      )
      .run();
    return r.changes === 1;
  }

  remainingRecoveryCodes(userId: number): number {
    const row = this.db
      .select({ n: count() })
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)))
      .get();
    return row?.n ?? 0;
  }

  /** Replaces all recovery codes. Returns the plain codes (shown once). */
  replaceRecoveryCodes(userId: number): string[] {
    const codes = generateRecoveryCodes();
    const now = this.now();
    this.db.transaction((tx) => {
      tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
      tx.insert(recoveryCodes)
        .values(codes.map((c) => ({ userId, codeHash: hashRecoveryCode(c), createdAt: now })))
        .run();
    });
    return codes;
  }

  /** Creates the single admin with recovery codes. Throws if a user already exists. */
  createAdmin(input: {
    username: string;
    passwordHash: string;
    totpSecret: string;
    totpStep: number;
  }): { user: User; recoveryCodes: string[] } {
    const now = this.now();
    const codes = generateRecoveryCodes();
    const user = this.db.transaction((tx) => {
      const n = tx.select({ n: count() }).from(users).get()?.n ?? 0;
      if (n > 0) throw new Error('admin exists');
      const u = tx
        .insert(users)
        .values({
          username: input.username,
          passwordHash: input.passwordHash,
          totpSecretEnc: this.encryptTotpSecret(input.totpSecret),
          totpLastStep: input.totpStep,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      tx.insert(recoveryCodes)
        .values(codes.map((c) => ({ userId: u.id, codeHash: hashRecoveryCode(c), createdAt: now })))
        .run();
      return u;
    });
    return { user, recoveryCodes: codes };
  }

  /** New TOTP secrets waiting for confirmation, per admin session (TOTP re-setup). */
  readonly pendingTotp = new Map<string, { secret: string; expiresAt: number }>();

  /** Replaces the TOTP secret; `step` is the step of the confirming code (no replay). */
  setTotpSecret(userId: number, secret: string, step: number): void {
    this.db
      .update(users)
      .set({
        totpSecretEnc: this.encryptTotpSecret(secret),
        totpLastStep: step,
        updatedAt: this.now(),
      })
      .where(eq(users.id, userId))
      .run();
  }

  setPassword(userId: number, passwordHash: string): void {
    this.db
      .update(users)
      .set({ passwordHash, updatedAt: this.now() })
      .where(eq(users.id, userId))
      .run();
  }

  audit(entry: AuditEntry): void {
    writeAudit(this.db, this.now(), entry);
  }
}
