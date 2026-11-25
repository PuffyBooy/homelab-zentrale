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
});
