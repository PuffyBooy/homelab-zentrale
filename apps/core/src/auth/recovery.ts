import { randomBytes } from 'node:crypto';
import { RECOVERY_CODE_COUNT } from '@hz/shared';
import { sha256Hex } from '../crypto.js';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** 10 characters from a 32-symbol alphabet (50 bit), shown as `xxxxx-xxxxx`. */
function oneCode(): string {
  const bytes = randomBytes(10);
  let s = '';
  // 256 is a multiple of 32, so `& 31` is unbiased.
  for (const b of bytes) s += ALPHABET[b & 31];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(oneCode());
  return [...codes];
}

export function normalizeRecoveryCode(code: string): string {
  return code.trim().toLowerCase().replace('-', '');
}

export function hashRecoveryCode(code: string): string {
  return sha256Hex(`recovery:${normalizeRecoveryCode(code)}`);
}

export function isTotpCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}
