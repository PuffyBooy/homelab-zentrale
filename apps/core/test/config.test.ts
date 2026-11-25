import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const key = Buffer.alloc(32, 7).toString('base64');

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const c = loadConfig({ HZ_SECRET_KEY: key });
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(8080);
    expect(c.dataDir).toBe('./data');
    expect(c.demo).toBe(false);
    expect(c.secretKey.length).toBe(32);
  });

  it('refuses to start without HZ_SECRET_KEY', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => loadConfig({ HZ_SECRET_KEY: Buffer.alloc(16).toString('base64') })).toThrow(
      /HZ_SECRET_KEY/,
    );
  });

  it('rejects junk that would decode to 32 bytes', () => {
    expect(() => loadConfig({ HZ_SECRET_KEY: `${key.slice(0, 10)}!!${key.slice(10)}` })).toThrow(
      /HZ_SECRET_KEY/,
    );
  });

  it('never echoes the secret in the error', () => {
    const bad = 'c3VwZXItc2VjcmV0LXZhbHVl';
    try {
      loadConfig({ HZ_SECRET_KEY: bad });
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain(bad);
    }
  });

  it('validates host and port', () => {
    expect(() => loadConfig({ HZ_SECRET_KEY: key, HZ_HOST: 'example.com' })).toThrow(/HZ_HOST/);
    expect(() => loadConfig({ HZ_SECRET_KEY: key, HZ_PORT: '70000' })).toThrow(/HZ_PORT/);
    const c = loadConfig({ HZ_SECRET_KEY: key, HZ_HOST: '0.0.0.0', HZ_PORT: '9000', HZ_DEMO: '1' });
    expect(c).toMatchObject({ host: '0.0.0.0', port: 9000, demo: true });
  });

  it('accepts HZ_SETUP_TOKEN only with NODE_ENV=test', () => {
    const token = 'e2e-setup-token-0123456789abcdef';
    expect(
      loadConfig({ HZ_SECRET_KEY: key, NODE_ENV: 'test', HZ_SETUP_TOKEN: token }).setupToken,
    ).toBe(token);
    for (const env of ['production', 'development', undefined]) {
      expect(() =>
        loadConfig({
          HZ_SECRET_KEY: key,
          HZ_SETUP_TOKEN: token,
          ...(env ? { NODE_ENV: env } : {}),
        }),
      ).toThrow(/HZ_SETUP_TOKEN/);
    }
    expect(() =>
      loadConfig({ HZ_SECRET_KEY: key, NODE_ENV: 'test', HZ_SETUP_TOKEN: 'short' }),
    ).toThrow(/HZ_SETUP_TOKEN/);
    expect(loadConfig({ HZ_SECRET_KEY: key }).setupToken).toBeUndefined();
  });
});
