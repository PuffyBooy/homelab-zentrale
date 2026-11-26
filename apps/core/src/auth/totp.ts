import QRCode from 'qrcode';
import { Secret, TOTP } from 'otpauth';

/** RFC 6238 defaults that every authenticator app supports. */
const PERIOD = 30;
const DIGITS = 6;
const ALGORITHM = 'SHA1';
const ISSUER = 'Homelab-Zentrale';

export function newTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

function totp(secretBase32: string, label = 'admin'): TOTP {
  return new TOTP({
    issuer: ISSUER,
    label,
    secret: Secret.fromBase32(secretBase32),
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: PERIOD,
  });
}

export function totpUri(secretBase32: string, username: string): string {
  return totp(secretBase32, username).toString();
}

export function totpQrSvg(uri: string): Promise<string> {
  return QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
}

/** Generates the code for a timestamp (tests and the dev helper only). */
export function totpCode(secretBase32: string, now: number): string {
  return totp(secretBase32).generate({ timestamp: now });
}

/**
 * Checks a code with +-1 window. Returns the accepted time step, or null.
 * Codes at or before `lastStep` are rejected, so a code is never accepted twice.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  now: number,
  lastStep: number | null,
): number | null {
  const t = totp(secretBase32);
  const delta = t.validate({ token: code, timestamp: now, window: 1 });
  if (delta === null) return null;
  const step = t.counter({ timestamp: now }) + delta;
  if (lastStep !== null && step <= lastStep) return null;
  return step;
}
