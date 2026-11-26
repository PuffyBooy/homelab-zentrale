import { describe, expect, it } from 'vitest';
import { encodeQr, qrPath } from './qr.js';

/**
 * Rows of "hello world" (version 1, mask 2, level M) as produced by the `qrcode`
 * package, which apps/core uses for the TOTP QR. Our encoder must match it bit for bit.
 */
const HELLO_M_MASK2 = [
  '111111100101101111111',
  '100000100010001000001',
  '101110101111001011101',
  '101110101110101011101',
  '101110101010101011101',
  '100000101001001000001',
  '111111101010101111111',
  '000000001010000000000',
  '101111100101001111100',
  '011011010101111111101',
  '101011110110111001110',
  '101001000101110011100',
  '000101111100111000001',
  '000000001010100011001',
  '111111100001001000110',
  '100000101000010101111',
  '101110101001001100001',
  '101110101100111111000',
  '101110101100100100100',
  '100000100110110011100',
  '111111101101101010010',
];

describe('qr', () => {
  it('matches the reference encoder', () => {
    const qr = encodeQr('hello world', { forceMask: 2 });
    expect(qr.version).toBe(1);
    expect(qr.modules.map((r) => r.map((d) => (d ? '1' : '0')).join(''))).toEqual(HELLO_M_MASK2);
  });

  it('picks the smallest version for a wall device link', () => {
    const url = `https://zentrale.tail1234.ts.net/wall?t=${'A'.repeat(43)}`;
    const qr = encodeQr(url);
    expect(qr.version).toBe(5);
    expect(qr.size).toBe(37);
    // Finder pattern in all three corners.
    for (const [x, y] of [
      [0, 0],
      [30, 0],
      [0, 30],
    ] as const) {
      expect(qr.modules[y]?.[x]).toBe(true);
      expect(qr.modules[y + 1]?.[x + 1]).toBe(false);
      expect(qr.modules[y + 3]?.[x + 3]).toBe(true);
    }
  });

  it('refuses text beyond version 10', () => {
    expect(() => encodeQr('x'.repeat(300))).toThrow('too long');
  });

  it('draws one square per dark module with a quiet zone', () => {
    const qr = encodeQr('a');
    const dark = qr.modules.flat().filter(Boolean).length;
    const path = qrPath(qr);
    expect(path.match(/M/g)).toHaveLength(dark);
    expect(path.startsWith('M4 4h1v1h-1z')).toBe(true);
  });
});
