import { describe, expect, it } from 'vitest';
import {
  createSecretBox,
  DecryptError,
  randomToken,
  sha256Hex,
  timingSafeEqual,
} from '../src/crypto.js';

const key = Buffer.alloc(32, 9);
const box = createSecretBox(key);

describe('secret box (AES-256-GCM)', () => {
  it('round-trips, also unicode and empty strings', () => {
    for (const v of ['ghp_secret', 'äöü ß €', '', 'x'.repeat(10_000)]) {
      expect(box.decrypt(box.encrypt(v))).toBe(v);
    }
  });

  it('uses the versioned format and a fresh nonce per value', () => {
    const a = box.encrypt('same');
    const b = box.encrypt('same');
    expect(a).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    const nonces = new Set(Array.from({ length: 200 }, () => box.encrypt('same').split(':')[1]));
    expect(nonces.size).toBe(200);
    expect(Buffer.from(a.split(':')[1] ?? '', 'base64')).toHaveLength(12);
  });

  it('never contains the plaintext', () => {
    const v = 'super-secret-token-value';
    const enc = box.encrypt(v);
    expect(enc).not.toContain(v);
    expect(Buffer.from(enc.split(':')[2] ?? '', 'base64').toString('utf8')).not.toContain(v);
  });

  it('throws on a manipulated ciphertext, tag or nonce', () => {
    const enc = box.encrypt('hello world');
    const [v, n, c] = enc.split(':') as [string, string, string];
    const flip = (b64: string, i: number): string => {
      const buf = Buffer.from(b64, 'base64');
      buf[i] = (buf[i] ?? 0) ^ 1;
      return buf.toString('base64');
    };
    const ct = Buffer.from(c, 'base64');
    for (const bad of [
      `${v}:${n}:${flip(c, 0)}`,
      `${v}:${n}:${flip(c, ct.length - 1)}`,
      `${v}:${flip(n, 0)}:${c}`,
      `${v}:${n}:${ct.subarray(0, ct.length - 1).toString('base64')}`,
      `v2:${n}:${c}`,
      `${v}:${n}`,
      'garbage',
      '',
    ]) {
      expect(() => box.decrypt(bad), bad).toThrow(DecryptError);
    }
  });

  it('throws with a wrong key, without leaking anything in the message', () => {
    const enc = box.encrypt('top secret');
    const other = createSecretBox(Buffer.alloc(32, 8));
    try {
      other.decrypt(enc);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DecryptError);
      expect(String(err)).not.toContain('top secret');
      expect(String(err)).not.toContain(enc);
    }
  });

  it('binds a value to its AAD context', () => {
    const enc = box.encrypt('totp', 'users.totp_secret');
    expect(box.decrypt(enc, 'users.totp_secret')).toBe('totp');
    expect(() => box.decrypt(enc, 'settings.github_token')).toThrow(DecryptError);
    expect(() => box.decrypt(enc)).toThrow(DecryptError);
  });

  it('refuses keys that are not 32 bytes', () => {
    expect(() => createSecretBox(Buffer.alloc(16))).toThrow();
  });
});

describe('token helpers', () => {
  it('randomToken is URL-safe and has the requested entropy', () => {
    const t = randomToken(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(new Set(Array.from({ length: 100 }, () => randomToken())).size).toBe(100);
  });

  it('sha256Hex is the standard digest', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('timingSafeEqual compares correctly, also with different lengths', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });
});
