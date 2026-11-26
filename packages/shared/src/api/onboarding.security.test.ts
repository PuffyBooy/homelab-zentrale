import { describe, expect, it } from 'vitest';
import {
  buildOneLiner,
  formatOnboardingCode,
  hubOriginSchema,
  ONBOARDING_CODE_ALPHABET,
  ONBOARDING_CODE_SHELL_RE,
  ONBOARDING_EXCHANGE_RATE,
  onboardingCodeSchema,
  onboardingCreateRequestSchema,
  onboardingCreateResponseSchema,
  onboardingExchangeRequestSchema,
  onboardingExchangeResponseSchema,
  onboardingExchangeToEnv,
  parseOnboardingEnv,
  type OnboardingExchangeResponse,
} from './onboarding.js';

const TOKEN = 'A'.repeat(32);
const exchange: OnboardingExchangeResponse = {
  enrollToken: TOKEN,
  hubUrl: 'wss://zentrale.tail1234.ts.net/agent',
  agentImage: 'ghcr.io/example/homelab-agent:1.2.0',
  name: 'pi-garage',
};

describe('onboarding code', () => {
  it('alphabet has no ambiguous characters', () => {
    expect(ONBOARDING_CODE_ALPHABET).toHaveLength(31);
    for (const c of '01OIL') expect(ONBOARDING_CODE_ALPHABET).not.toContain(c);
    expect(new Set(ONBOARDING_CODE_ALPHABET).size).toBe(31);
  });

  it('normalises case, whitespace and one dash', () => {
    expect(onboardingCodeSchema.parse('ABCD-EFGH')).toBe('ABCDEFGH');
    expect(onboardingCodeSchema.parse('abcdefgh')).toBe('ABCDEFGH');
    expect(onboardingCodeSchema.parse('  abcd-efgh \n')).toBe('ABCDEFGH');
    expect(formatOnboardingCode('ABCDEFGH')).toBe('ABCD-EFGH');
  });

  it('rejects ambiguous characters, wrong lengths and other separators', () => {
    const bad: unknown[] = [
      'ABCD-EFG0',
      'ABCD-EFGO',
      'ABCD-EFG1',
      'ABCD-EFGI',
      'ABCD-EFGL',
      'ABCDEFG',
      'ABCDEFGHJ',
      'ABCD--EFGH',
      'AB-CDEFGH',
      'ABCD EFGH',
      'ABCD_EFGH',
      "ABCD';rm",
      '',
      'A'.repeat(17),
      12345678,
      null,
    ];
    for (const b of bad) expect(onboardingCodeSchema.safeParse(b).success, String(b)).toBe(false);
  });

  it('shell pattern matches the same codes as the schema', () => {
    const re = new RegExp(ONBOARDING_CODE_SHELL_RE);
    expect(re.test('ABCD-EFGH')).toBe(true);
    expect(re.test('abcdefgh')).toBe(true);
    for (const c of '01OILoil') expect(re.test(`ABCD-EFG${c}`), c).toBe(false);
    expect(re.test('ABCD-EFGH;id')).toBe(false);
  });

  it('exchange request is strict', () => {
    expect(onboardingExchangeRequestSchema.safeParse({ code: 'ABCD-EFGH' }).success).toBe(true);
    expect(
      onboardingExchangeRequestSchema.safeParse({ code: 'ABCD-EFGH', name: 'x' }).success,
    ).toBe(false);
    expect(onboardingExchangeRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rate limit allows only a few guesses', () => {
    expect(ONBOARDING_EXCHANGE_RATE.perIp).toBeLessThanOrEqual(10);
    expect(ONBOARDING_EXCHANGE_RATE.globalFailures).toBeLessThanOrEqual(50);
    expect(ONBOARDING_EXCHANGE_RATE.windowMs).toBeGreaterThanOrEqual(15 * 60_000);
  });
});

describe('onboarding create', () => {
  it('uses the enroll name rules', () => {
    expect(onboardingCreateRequestSchema.parse({ name: 'pi-garage' })).toEqual({
      name: 'pi-garage',
      location: '',
    });
    expect(onboardingCreateRequestSchema.safeParse({ name: 'Pi Garage' }).success).toBe(false);
    expect(onboardingCreateRequestSchema.safeParse({ name: 'x; rm -rf /' }).success).toBe(false);
  });

  it('one-liner has the documented shape and no token', () => {
    const line = buildOneLiner('https://zentrale.tail1234.ts.net', 'ABCD-EFGH');
    expect(line).toBe(
      'curl -fsSL https://zentrale.tail1234.ts.net/install.sh | sudo sh -s -- ABCD-EFGH',
    );
    const res = onboardingCreateResponseSchema.parse({
      id: 'onb_12345678',
      name: 'pi-garage',
      code: 'ABCD-EFGH',
      expiresAt: '2026-11-26T10:15:00.000Z',
      oneLiner: line,
    });
    expect(Object.keys(res)).not.toContain('token');
    expect(onboardingCreateResponseSchema.safeParse({ ...res, code: 'ABCDEFGH' }).success).toBe(
      false,
    );
  });

  it('hub origin must be https without path', () => {
    expect(hubOriginSchema.safeParse('https://zentrale.tail1234.ts.net').success).toBe(true);
    expect(hubOriginSchema.safeParse('http://zentrale.tail1234.ts.net').success).toBe(false);
    expect(hubOriginSchema.safeParse('https://x.ts.net/a$(id)').success).toBe(false);
  });
});

describe('onboarding exchange response', () => {
  it('round-trips through the env format', () => {
    const env = onboardingExchangeToEnv(exchange);
    expect(env.split('\n')[0]).toBe('HZ_CORE_URL=wss://zentrale.tail1234.ts.net/agent');
    expect(parseOnboardingEnv(env)).toEqual(exchange);
  });

  it('values cannot carry shell syntax', () => {
    const bad: Partial<OnboardingExchangeResponse>[] = [
      { agentImage: 'img;id' },
      { agentImage: 'img $(id)' },
      { hubUrl: 'wss://x.ts.net/agent\nHZ_X=1' },
      { hubUrl: 'ws://zentrale.ts.net/agent' },
      { hubUrl: 'https://x.ts.net/agent' },
      { enrollToken: 'short' },
      { enrollToken: `${'A'.repeat(30)}'"` },
      { name: 'a b' },
    ];
    for (const b of bad) {
      expect(onboardingExchangeResponseSchema.safeParse({ ...exchange, ...b }).success).toBe(false);
      expect(() => onboardingExchangeToEnv({ ...exchange, ...b })).toThrow();
    }
  });

  it('parseOnboardingEnv rejects extra, missing or reordered lines', () => {
    const env = onboardingExchangeToEnv(exchange);
    const lines = env.trimEnd().split('\n');
    expect(parseOnboardingEnv(`${env}HZ_EXTRA=1\n`)).toBeNull();
    expect(parseOnboardingEnv(lines.slice(1).join('\n'))).toBeNull();
    expect(parseOnboardingEnv([lines[1], lines[0], lines[2], lines[3]].join('\n'))).toBeNull();
  });
});
