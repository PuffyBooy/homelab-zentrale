import { and, desc, eq, gt, inArray, lte, ne } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import { randomToken, sha256Hex } from '../crypto.js';
import type { Db } from '../db/index.js';
import { sessions, users, type Session, type User } from '../db/schema.js';

export const SESSION_COOKIE = 'hz_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sliding expiry is written at most once per minute per session. */
export const SESSION_TOUCH_MS = 60_000;
const USER_AGENT_MAX = 256;
/** 32 random bytes as base64url. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export interface AuthContext {
  session: Session;
  user: User;
  /** True if expires_at was extended in this request (cookie gets re-sent). */
  touched: boolean;
}

export function tokenHash(token: string): string {
  return sha256Hex(`session:${token}`);
}

export class SessionStore {
  private readonly revokeListeners = new Set<() => void>();

  constructor(
    private readonly db: Db,
    private readonly now: Clock,
  ) {}

  /**
   * Called after sessions were deleted (logout, revoke, password or TOTP change),
   * so long-lived sockets (console) can close at once instead of on the next check.
   */
  onRevoke(fn: () => void): () => void {
    this.revokeListeners.add(fn);
    return () => this.revokeListeners.delete(fn);
  }

  private revoked(changes: number): void {
    if (changes === 0) return;
    for (const fn of this.revokeListeners) fn();
  }

  /** Ids of the given sessions that still exist and are not expired. */
  alive(ids: readonly string[]): Set<string> {
    if (ids.length === 0) return new Set();
    return new Set(
      this.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(inArray(sessions.id, [...ids]), gt(sessions.expiresAt, this.now())))
        .all()
        .map((r) => r.id),
    );
  }

  /** Creates a session. Returns the cookie value (only here, never stored). */
  create(userId: number, userAgent: string | undefined): { token: string; session: Session } {
    const now = this.now();
    const token = randomToken(32);
    const session: Session = {
      id: randomToken(16),
      tokenHash: tokenHash(token),
      userId,
      createdAt: now,
      lastSeen: now,
      expiresAt: now + SESSION_TTL_MS,
      userAgent: (userAgent ?? '').slice(0, USER_AGENT_MAX),
      stepUpUntil: null,
    };
    this.db.insert(sessions).values(session).run();
    return { token, session };
  }

  /** Resolves a cookie value to a live session and slides its expiry. */
  resolve(token: string | undefined): AuthContext | null {
    if (!token || !TOKEN_RE.test(token)) return null;
    const now = this.now();
    const row = this.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, tokenHash(token)), gt(sessions.expiresAt, now)))
      .get();
    if (!row) return null;
    let touched = false;
    if (now - row.session.lastSeen >= SESSION_TOUCH_MS) {
      row.session.lastSeen = now;
      row.session.expiresAt = now + SESSION_TTL_MS;
      this.db
        .update(sessions)
        .set({ lastSeen: now, expiresAt: row.session.expiresAt })
        .where(eq(sessions.id, row.session.id))
        .run();
      touched = true;
    }
    return { session: row.session, user: row.user, touched };
  }

  list(userId: number): Session[] {
    return this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, this.now())))
      .orderBy(desc(sessions.lastSeen))
      .all();
  }

  /** Returns true if a session of this user was revoked. */
  revoke(userId: number, id: string): boolean {
    const r = this.db
      .delete(sessions)
      .where(and(eq(sessions.id, id), eq(sessions.userId, userId)))
      .run();
    this.revoked(r.changes);
    return r.changes > 0;
  }

  revokeOthers(userId: number, keepId: string): number {
    const n = this.db
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), ne(sessions.id, keepId)))
      .run().changes;
    this.revoked(n);
    return n;
  }

  setStepUp(id: string, until: number): void {
    this.db.update(sessions).set({ stepUpUntil: until }).where(eq(sessions.id, id)).run();
  }

  pruneExpired(): number {
    return this.db.delete(sessions).where(lte(sessions.expiresAt, this.now())).run().changes;
  }
}
