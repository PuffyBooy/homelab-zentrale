import { randomToken, sha256Hex, timingSafeEqual } from '../crypto.js';

interface Pending {
  username: string;
  passwordHash: string;
  totpSecret: string;
}

/**
 * One-time setup state, in memory only. While no user exists the core creates a
 * random setup token at start and logs the link once. Only its hash is kept.
 */
export class SetupState {
  private tokenHash: string | null = null;
  private pending: Pending | null = null;

  /** Arms setup. Returns the token so the caller can log the link. */
  arm(fixedToken?: string): string {
    const token = fixedToken ?? randomToken(32);
    this.tokenHash = sha256Hex(`setup:${token}`);
    this.pending = null;
    return token;
  }

  get armed(): boolean {
    return this.tokenHash !== null;
  }

  checkToken(token: string): boolean {
    if (this.tokenHash === null) return false;
    return timingSafeEqual(sha256Hex(`setup:${token}`), this.tokenHash);
  }

  setPending(p: Pending): void {
    this.pending = p;
  }

  getPending(): Pending | null {
    return this.pending;
  }

  /** Called once the admin exists: the token is dead for good. */
  finish(): void {
    this.tokenHash = null;
    this.pending = null;
  }
}
