import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INSTALL_TEMPLATE_PATH } from '../src/servers/onboarding.js';

const DEPLOY_SMART = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../deploy/docker-compose.agent.smart.yml',
);

const yamlBody = (text: string): string =>
  text
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'))
    .join('\n');

function inlineSmart(): string {
  const tpl = readFileSync(INSTALL_TEMPLATE_PATH, 'utf8');
  const m = /docker-compose\.smart\.yml" <<'COMPOSE'\n([\s\S]*?)\nCOMPOSE\n/.exec(tpl);
  if (!m?.[1]) throw new Error('smart override not found in install.sh');
  return m[1];
}

describe('SMART override (security)', () => {
  it('install.sh writes the same override as deploy/docker-compose.agent.smart.yml', () => {
    expect(yamlBody(inlineSmart())).toBe(yamlBody(readFileSync(DEPLOY_SMART, 'utf8')));
  });

  it('grants read-only block device access and only SYS_RAWIO', () => {
    const body = yamlBody(readFileSync(DEPLOY_SMART, 'utf8'));
    const rules = [...body.matchAll(/- '(b \d+:\* [a-z]+)'/g)].map((x) => x[1] ?? '');
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) expect(r).toMatch(/^b \d+:\* r$/);
    expect(body).not.toMatch(/\bc \d+:/); // no character devices
    const caps = [...body.matchAll(/^\s+- ([A-Z_]+)$/gm)].map((x) => x[1]);
    expect(caps).toEqual(['SYS_RAWIO']);
    expect(body).not.toMatch(/privileged|devices:|\/dev:/);
  });

  it('install.sh accepts only `<code>` with --smart / --tasks / --allow-relay', () => {
    const tpl = readFileSync(INSTALL_TEMPLATE_PATH, 'utf8');
    for (const args of [
      ['ABCD-EFGH', '--evil'],
      ['ABCD-EFGH', '--smart', 'x'],
      ['ABCD-EFGH', '--tasks', '--smart', '--tasks'],
      ['ABCD-EFGH', '--tasks=1'],
      ['ABCD-EFGH', '--allow-relay', '--smart', '--smart'],
      ['ABCD-EFGH', '--allow-relay=1'],
      [],
    ]) {
      let status = 0;
      let stderr = '';
      try {
        execFileSync('sh', ['-s', '--', ...args], { input: tpl, stdio: 'pipe' });
      } catch (e) {
        const err = e as { status: number; stderr: Buffer };
        status = err.status;
        stderr = err.stderr.toString();
      }
      expect(status, args.join(' ')).toBe(1);
      expect(stderr).toContain('Aufruf:');
    }
  });

  it('install.sh takes --allow-relay (M15) and writes HZ_AGENT_ALLOW_RELAY', () => {
    const tpl = readFileSync(INSTALL_TEMPLATE_PATH, 'utf8');
    for (const args of [
      ['ABCD-EFGH', '--allow-relay'],
      ['ABCD-EFGH', '--smart', '--allow-relay'],
    ]) {
      let stderr = '';
      try {
        execFileSync('sh', ['-s', '--', ...args], { input: tpl, stdio: 'pipe' });
      } catch (e) {
        stderr = (e as { stderr: Buffer }).stderr.toString();
      }
      // Past the argument check (the unrendered code pattern fails afterwards).
      expect(stderr, args.join(' ')).not.toContain('Aufruf:');
    }
    expect(tpl).toContain(`printf 'HZ_AGENT_ALLOW_RELAY=%s\\n' "$allow_relay"`);
  });
});
