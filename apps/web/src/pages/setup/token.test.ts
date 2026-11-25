import { describe, expect, it } from 'vitest';
import { groupSecret, setupTokenFromHash, svgDataUrl } from './token.js';

describe('setup link', () => {
  it('reads the token from the hash', () => {
    expect(setupTokenFromHash('#token=e2e-setup-token-0123456789abcdef')).toBe(
      'e2e-setup-token-0123456789abcdef',
    );
    expect(setupTokenFromHash('token=abcdefghijklmnopqrstuvwxyz')).toBe(
      'abcdefghijklmnopqrstuvwxyz',
    );
  });

  it('rejects missing or malformed tokens', () => {
    expect(setupTokenFromHash('')).toBeNull();
    expect(setupTokenFromHash('#token=short')).toBeNull();
    expect(setupTokenFromHash('#token=<script>alert(1)</script>xxxxxxxxxxxx')).toBeNull();
  });

  it('groups the secret and encodes the QR as data URL', () => {
    expect(groupSecret('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
    expect(groupSecret('ABCDE')).toBe('ABCD E');
    const url = svgDataUrl('<svg onload="x"><path d="M0 0"/></svg>');
    expect(url.startsWith('data:image/svg+xml;charset=utf-8,%3Csvg')).toBe(true);
    expect(url).not.toContain('<');
  });
});
