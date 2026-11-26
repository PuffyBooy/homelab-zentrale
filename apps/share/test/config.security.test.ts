import { describe, expect, it } from 'vitest';
import { coreUrlProblem, loadConfig } from '../src/config.js';
import { GATEWAY_TOKEN } from './helpers.js';

const base = {
  HZ_SHARE_CORE_URL: 'https://heimserver.tail1234.ts.net',
  HZ_SHARE_GATEWAY_TOKEN: GATEWAY_TOKEN,
};

describe('config', () => {
  it('defaults: loopback host, port 8090', () => {
    const c = loadConfig(base);
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(8090);
    expect(c.coreUrl).toBe('https://heimserver.tail1234.ts.net');
    expect(c.uiDir).toMatch(/ui$/);
  });

  it.each([
    'https://heimserver.tail1234.ts.net/',
    'http://127.0.0.1:8080',
    'http://localhost:8080',
    'http://[::1]:8080',
  ])('accepts core URL %s', (url) => {
    expect(coreUrlProblem(url)).toBeNull();
  });

  it.each([
    'http://heimserver.tail1234.ts.net',
    'https://zentrale.example.com',
    'https://heimserver.tail1234.ts.net.evil.com',
    'https://user:pw@heimserver.tail1234.ts.net',
    'https://heimserver.tail1234.ts.net/api',
    'https://heimserver.tail1234.ts.net?x=1',
    'http://100.64.0.1:8080',
    'ftp://127.0.0.1',
    'not a url',
  ])('refuses core URL %s', (url) => {
    expect(coreUrlProblem(url)).not.toBeNull();
  });

  it.each(['', 'short', GATEWAY_TOKEN + 'x', GATEWAY_TOKEN.slice(1) + '='])(
    'refuses gateway token %j without echoing it',
    (token) => {
      let msg = '';
      try {
        loadConfig({ ...base, HZ_SHARE_GATEWAY_TOKEN: token });
      } catch (err) {
        msg = (err as Error).message;
      }
      expect(msg).toContain('HZ_SHARE_GATEWAY_TOKEN');
      if (token.length > 0) expect(msg).not.toContain(token);
    },
  );

  it('missing values are reported by name', () => {
    expect(() => loadConfig({})).toThrow(
      /HZ_SHARE_CORE_URL.*HZ_SHARE_GATEWAY_TOKEN|HZ_SHARE_GATEWAY_TOKEN.*HZ_SHARE_CORE_URL/,
    );
  });

  it('host must be an IP, port in range', () => {
    expect(() => loadConfig({ ...base, HZ_SHARE_HOST: 'example.com' })).toThrow(/HZ_SHARE_HOST/);
    expect(() => loadConfig({ ...base, HZ_SHARE_PORT: '70000' })).toThrow(/HZ_SHARE_PORT/);
    expect(loadConfig({ ...base, HZ_SHARE_HOST: '0.0.0.0', HZ_SHARE_PORT: '9000' })).toMatchObject({
      host: '0.0.0.0',
      port: 9000,
    });
  });
});
