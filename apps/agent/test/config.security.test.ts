import { describe, expect, it } from 'vitest';
import { ConfigError, isTrustedPlainHost, loadConfig } from '../src/config.js';
import { createLogger } from '../src/log.js';

const TOKEN = 'enroll_AAAAAAAAAAAAAAAAAAAAAAAA';
const base = { HZ_CORE_URL: 'wss://heimserver.tail1234.ts.net/agent', HZ_AGENT_NAME: 'oracle-a1' };

describe('config', () => {
  it('parses a valid environment', () => {
    const c = loadConfig({ ...base, HZ_AGENT_TOKEN: TOKEN, HZ_AGENT_ALLOW_TERMINAL: '1' });
    expect(c).toMatchObject({
      coreUrl: base.HZ_CORE_URL,
      name: 'oracle-a1',
      token: TOKEN,
      allowTerminal: true,
      dataDir: '/data',
      homelabRoot: '/opt/homelab/',
    });
  });

  it('terminal is off unless explicitly 1/true', () => {
    expect(loadConfig(base).allowTerminal).toBe(false);
    expect(loadConfig({ ...base, HZ_AGENT_ALLOW_TERMINAL: '0' }).allowTerminal).toBe(false);
    expect(() => loadConfig({ ...base, HZ_AGENT_ALLOW_TERMINAL: 'yes' })).toThrow(ConfigError);
  });

  it('rejects bad core URLs', () => {
    for (const url of [
      'https://heimserver.ts.net/agent',
      'wss://heimserver.ts.net/',
      'ws://203.0.113.5/agent',
      'ws://example.com/agent',
      'wss://user:pw@heimserver.ts.net/agent',
      'wss://heimserver.ts.net/agent?token=x',
      'not a url',
    ]) {
      expect(() => loadConfig({ ...base, HZ_CORE_URL: url }), url).toThrow(ConfigError);
    }
  });

  it('allows plain ws:// only for loopback and tailnet hosts', () => {
    for (const h of [
      '127.0.0.1',
      'localhost',
      '100.64.0.1',
      '100.127.255.1',
      'heimserver',
      'x.tail.ts.net',
    ]) {
      expect(isTrustedPlainHost(h), h).toBe(true);
    }
    for (const h of ['100.63.0.1', '100.128.0.1', '192.168.1.10', 'example.com', 'evil-ts.net']) {
      expect(isTrustedPlainHost(h), h).toBe(false);
    }
  });

  it('never echoes the token in config errors', () => {
    try {
      loadConfig({ ...base, HZ_AGENT_TOKEN: 'bad token with spaces SECRET123' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('SECRET123');
      expect((err as Error).message).toContain('HZ_AGENT_TOKEN');
    }
  });

  it('HZ_AGENT_HOMELAB_ROOT is only accepted in tests', () => {
    expect(() =>
      loadConfig({ ...base, HZ_AGENT_HOMELAB_ROOT: '/', NODE_ENV: 'production' }),
    ).toThrow(ConfigError);
    expect(
      loadConfig({ ...base, HZ_AGENT_HOMELAB_ROOT: '/tmp/x/', NODE_ENV: 'test' }).homelabRoot,
    ).toBe('/tmp/x/');
  });

  it('validates the agent name', () => {
    expect(() => loadConfig({ ...base, HZ_AGENT_NAME: 'Bad Name' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, HZ_AGENT_NAME: '-x' })).toThrow(ConfigError);
  });
});

describe('logger', () => {
  it('masks registered secrets and secret-looking fields', () => {
    const lines: string[] = [];
    const log = createLogger('debug', (l) => lines.push(l));
    log.addSecret(TOKEN);
    log.info(`hello with ${TOKEN}`, {
      token: 'abc',
      agentToken: 'def',
      nested: { message: `x${TOKEN}y`, password: 'pw' },
      err: new Error(`failed for ${TOKEN}`),
    });
    const out = lines.join('\n');
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('"abc"');
    expect(out).not.toContain('"def"');
    expect(out).not.toContain('"pw"');
    expect(out).toContain('[redacted]');
  });

  it('respects the level', () => {
    const lines: string[] = [];
    const log = createLogger('warn', (l) => lines.push(l));
    log.info('nope');
    log.warn('yes');
    expect(lines).toHaveLength(1);
  });
});
