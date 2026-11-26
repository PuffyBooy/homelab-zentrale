import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual as nodeTimingSafeEqual,
} from 'node:crypto';

/**
 * Secrets at rest (GitHub token, HA token, TOTP secret, RCON passwords, ...).
 *
 * Format: `v1:<base64 nonce>:<base64 ciphertext+tag>`, AES-256-GCM with a fresh
 * random 96-bit nonce per value. An optional AAD binds a value to its context
 * (e.g. `users.totp_secret:1`), so a ciphertext cannot be moved to another column.
 * Error messages never contain key, plaintext or ciphertext.
 */
const VERSION = 'v1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class DecryptError extends Error {
  constructor() {
    super('decrypt_failed');
    this.name = 'DecryptError';
  }
}

export interface SecretBox {
  encrypt(plaintext: string, aad?: string): string;
  decrypt(payload: string, aad?: string): string;
}

export function createSecretBox(key: Buffer): SecretBox {
  if (key.length !== 32) throw new Error('secret key must be 32 bytes');
  const k = Buffer.from(key);
  return {
    encrypt(plaintext, aad) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', k, nonce, { authTagLength: TAG_BYTES });
      if (aad !== undefined) cipher.setAAD(Buffer.from(aad, 'utf8'));
      const ct = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      return `${VERSION}:${nonce.toString('base64')}:${ct.toString('base64')}`;
    },
    decrypt(payload, aad) {
      const parts = payload.split(':');
      if (parts.length !== 3 || parts[0] !== VERSION) throw new DecryptError();
      const nonce = Buffer.from(parts[1] ?? '', 'base64');
      const data = Buffer.from(parts[2] ?? '', 'base64');
      if (nonce.length !== NONCE_BYTES || data.length < TAG_BYTES) throw new DecryptError();
      try {
        const decipher = createDecipheriv('aes-256-gcm', k, nonce, { authTagLength: TAG_BYTES });
        if (aad !== undefined) decipher.setAAD(Buffer.from(aad, 'utf8'));
        decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
        return Buffer.concat([
          decipher.update(data.subarray(0, data.length - TAG_BYTES)),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        throw new DecryptError();
      }
    },
  };
}

/** SHA-256 hex digest. Enough for random tokens with >= 128 bit (docs/SECURITY.md). */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** URL-safe random token (base64url, no padding). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time string comparison, also for inputs of different length. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return nodeTimingSafeEqual(ha, hb) && a.length === b.length;
}
