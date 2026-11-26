import { describe, expect, it } from 'vitest';
import { checkDefSchema, isValidCheckHost } from './checks.js';

describe('check host validation', () => {
  it.each([
    'heimserver',
    'mc.hoebe.at',
    'mc.hoebe.at.',
    '192.168.1.1',
    '::1',
    '[fd7a:115c::1]',
    'a-b.example',
  ])('accepts %s', (h) => expect(isValidCheckHost(h)).toBe(true));
  it.each([
    '-f',
    '--flood',
    '-x.example',
    'a..b',
    'host;rm',
    '$(id)',
    'a b',
    '1234',
    '999.1.1.1',
    '0x7f.1',
    '[1.2.3.4]',
    'ex[ample',
    '1:2:3',
    '',
    'x'.repeat(254),
  ])('rejects %j', (h) => expect(isValidCheckHost(h)).toBe(false));

  it('rejects such hosts in tcp and ping checks', () => {
    for (const host of ['-f', '1234', 'a]b']) {
      expect(checkDefSchema.safeParse({ kind: 'tcp', name: 'x', host, port: 22 }).success).toBe(
        false,
      );
      expect(
        checkDefSchema.safeParse({ kind: 'ping', name: 'x', host, runFrom: 'abcdefgh12' }).success,
      ).toBe(false);
    }
    expect(
      checkDefSchema.safeParse({ kind: 'tcp', name: 'x', host: 'mc.hoebe.at', port: 22 }).success,
    ).toBe(true);
  });
});
