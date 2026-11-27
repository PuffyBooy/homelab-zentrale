import { describe, expect, it } from 'vitest';
import {
  ACME_DIRECTORIES,
  certAlertKey,
  certificateCreateSchema,
  certificateSchema,
  dnsAlertKey,
  dnsProviderCreateSchema,
  dnsProviderSchema,
  dnsProviderUpdateSchema,
  dnsRecordCreateSchema,
  dnsRecordUpdateSchema,
  DOMAINS_ALLOWED_HOSTS,
  domainSettingsSchema,
  nameInZone,
} from './domains.js';

/** Fake tokens, assembled so secret scanners do not flag them. */
const TOKEN = ['fake', 'token', 'abcdefghijklmnop', '0123'].join('_');
const ID = 'abcdefgh12345678';

describe('domains schema: providers', () => {
  it('accepts Cloudflare and DuckDNS', () => {
    expect(
      dnsProviderCreateSchema.safeParse({ kind: 'cloudflare', label: 'CF', token: TOKEN }).success,
    ).toBe(true);
    expect(
      dnsProviderCreateSchema.safeParse({
        kind: 'duckdns',
        label: 'Duck',
        token: TOKEN,
        subdomains: ['meinheim'],
      }).success,
    ).toBe(true);
  });

  it.each([
    ['unknown provider', { kind: 'route53', label: 'x', token: TOKEN }],
    ['short token', { kind: 'cloudflare', label: 'x', token: 'short' }],
    ['token with spaces', { kind: 'cloudflare', label: 'x', token: `${TOKEN} x` }],
    ['token with newline', { kind: 'cloudflare', label: 'x', token: `${TOKEN}\n` }],
    ['token too long', { kind: 'cloudflare', label: 'x', token: 'a'.repeat(201) }],
    [
      'api url injected',
      { kind: 'cloudflare', label: 'x', token: TOKEN, apiUrl: 'https://evil.example' },
    ],
    ['duckdns without subdomains', { kind: 'duckdns', label: 'x', token: TOKEN, subdomains: [] }],
    [
      'duckdns full name',
      { kind: 'duckdns', label: 'x', token: TOKEN, subdomains: ['a.duckdns.org'] },
    ],
    [
      'duckdns six subdomains',
      { kind: 'duckdns', label: 'x', token: TOKEN, subdomains: ['a', 'b', 'c', 'd', 'e', 'f'] },
    ],
    ['label markup', { kind: 'cloudflare', label: '<x>', token: TOKEN }],
  ])('rejects %s', (_n, v) => expect(dnsProviderCreateSchema.safeParse(v).success).toBe(false));

  it('update needs a field; responses never carry the token', () => {
    expect(dnsProviderUpdateSchema.safeParse({}).success).toBe(false);
    expect(dnsProviderUpdateSchema.safeParse({ token: TOKEN }).success).toBe(true);
    const p = {
      id: ID,
      kind: 'cloudflare',
      label: 'CF',
      tokenHint: '0123',
      zones: ['example.com'],
      createdAt: 1,
      lastOkAt: null,
      lastError: null,
    };
    expect(dnsProviderSchema.safeParse(p).success).toBe(true);
    expect(dnsProviderSchema.safeParse({ ...p, token: TOKEN }).success).toBe(false);
    expect(dnsProviderSchema.safeParse({ ...p, tokenHint: TOKEN }).success).toBe(false);
  });

  it('only the documented outside hosts, https ACME directories on them', () => {
    expect([...DOMAINS_ALLOWED_HOSTS].sort()).toEqual(
      [
        'acme-staging-v02.api.letsencrypt.org',
        'acme-v02.api.letsencrypt.org',
        'api.cloudflare.com',
        'www.duckdns.org',
      ].sort(),
    );
    for (const url of Object.values(ACME_DIRECTORIES)) {
      const u = new URL(url);
      expect(u.protocol).toBe('https:');
      expect(DOMAINS_ALLOWED_HOSTS).toContain(u.hostname);
    }
  });
});

describe('domains schema: records', () => {
  const rec = {
    providerId: ID,
    name: 'home.example.com',
    type: 'A',
    target: { kind: 'server', serverId: ID },
  };
  it('defaults: ttl 300, not proxied, no adopt', () => {
    expect(dnsRecordCreateSchema.parse(rec)).toMatchObject({
      ttl: 300,
      proxied: false,
      adopt: false,
    });
    expect(
      dnsRecordCreateSchema.safeParse({
        ...rec,
        type: 'CNAME',
        target: { kind: 'static', value: 'x.example.org' },
      }).success,
    ).toBe(true);
  });
  it.each([
    ['wildcard record', { ...rec, name: '*.example.com' }],
    ['CNAME to a server', { ...rec, type: 'CNAME' }],
    ['TXT record', { ...rec, type: 'TXT' }],
    ['ttl too small', { ...rec, ttl: 59 }],
    ['ttl too large', { ...rec, ttl: 86_401 }],
    ['static value with spaces', { ...rec, target: { kind: 'static', value: '1.2.3.4 evil' } }],
    ['static value url', { ...rec, target: { kind: 'static', value: 'https://x.example' } }],
    ['upper-case name', { ...rec, name: 'Home.example.com' }],
    ['owner set by the client', { ...rec, owner: 'relay' }],
    ['provider record id set by the client', { ...rec, providerRecordId: 'x' }],
  ])('rejects %s', (_n, v) => expect(dnsRecordCreateSchema.safeParse(v).success).toBe(false));

  it('update cannot change name, type or owner', () => {
    expect(dnsRecordUpdateSchema.safeParse({ ttl: 120 }).success).toBe(true);
    for (const bad of [{}, { name: 'a.example.com' }, { type: 'AAAA' }, { owner: 'admin' }]) {
      expect(dnsRecordUpdateSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('nameInZone', () => {
    expect(nameInZone('relay.example.com', 'example.com')).toBe(true);
    expect(nameInZone('*.example.com', 'example.com')).toBe(true);
    expect(nameInZone('example.com', 'example.com')).toBe(true);
    expect(nameInZone('badexample.com', 'example.com')).toBe(false);
    expect(nameInZone('example.com.evil.org', 'example.com')).toBe(false);
  });
});

describe('domains schema: certificates', () => {
  const cert = { providerId: ID, names: ['example.com', '*.example.com'] };
  it('defaults to Let’s Encrypt production with auto-renew', () => {
    expect(certificateCreateSchema.parse(cert)).toMatchObject({
      ca: 'letsencrypt',
      autoRenew: true,
      deploy: [],
    });
  });
  it.each([
    ['no names', { ...cert, names: [] }],
    ['duplicate names', { ...cert, names: ['example.com', 'example.com'] }],
    ['eleven names', { ...cert, names: Array.from({ length: 11 }, (_, i) => `a${i}.example.com`) }],
    ['other CA', { ...cert, ca: 'zerossl' }],
    ['directory url from the client', { ...cert, directoryUrl: 'https://evil.example/dir' }],
    ['deploy path traversal', { ...cert, deploy: [{ serverId: ID, name: '../etc' }] }],
    ['deploy absolute path', { ...cert, deploy: [{ serverId: ID, name: '/etc/ssl' }] }],
    ['private key from the client', { ...cert, privkeyPem: 'x' }],
  ])('rejects %s', (_n, v) => expect(certificateCreateSchema.safeParse(v).success).toBe(false));

  it('the certificate response has no private key', () => {
    const c = {
      id: ID,
      providerId: ID,
      names: ['example.com'],
      ca: 'letsencrypt',
      status: 'valid',
      issuedAt: 1,
      notAfter: 2,
      autoRenew: true,
      deploy: [],
      lastError: null,
      nextAttemptAt: null,
    };
    expect(certificateSchema.safeParse(c).success).toBe(true);
    expect(certificateSchema.safeParse({ ...c, privkeyPem: 'x' }).success).toBe(false);
    expect(certificateSchema.safeParse({ ...c, keyEnc: 'x' }).success).toBe(false);
  });

  it('settings and alert keys', () => {
    expect(domainSettingsSchema.safeParse({ acmeEmail: null }).success).toBe(true);
    expect(domainSettingsSchema.safeParse({ acmeEmail: 'not-an-email' }).success).toBe(false);
    expect(certAlertKey(ID)).toBe(`cert:${ID}`);
    expect(dnsAlertKey(ID)).toBe(`dns:${ID}`);
  });
});
