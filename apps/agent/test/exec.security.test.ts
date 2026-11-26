import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ExecPolicyError, PROGRAMS, makeHostExec, runFile } from '../src/exec.js';

describe('exec wrapper', () => {
  it('passes shell metacharacters literally (no shell)', async () => {
    const evil = [
      '; rm -rf /tmp/hz-should-not-exist',
      '$(id)',
      '`id`',
      '| cat /etc/passwd',
      '&&',
      '*',
    ];
    const r = await runFile('printf', ['%s\\n', ...evil]);
    expect(r.code).toBe(0);
    expect(r.stdout.split('\n').slice(0, -1)).toEqual(evil);
  });

  it('refuses programs outside the allowlist', () => {
    expect(() => runFile('sh', ['-c', 'id'])).toThrow(ExecPolicyError);
    expect(() => runFile('bash', [])).toThrow(ExecPolicyError);
    expect(() => runFile('/bin/sh', [])).toThrow(ExecPolicyError);
    expect(() => runFile('rm', ['-rf', '/'])).toThrow(ExecPolicyError);
    expect(PROGRAMS.has('sh')).toBe(false);
  });

  it('refuses NUL in arguments', () => {
    expect(() => runFile('printf', ['a\0b'])).toThrow(ExecPolicyError);
  });

  it('never uses a shell in the source', async () => {
    const src = await readFile(new URL('../src/exec.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/shell: false/);
    expect(src).not.toMatch(/shell:\s*true/);
    expect(src).not.toMatch(/\bexec\(|execSync|spawnSync|\bspawn\(/);
  });

  it('is the only module that imports child_process', async () => {
    const { readdir } = await import('node:fs/promises');
    const dir = new URL('../src/', import.meta.url);
    const files = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith('.ts'));
    const offenders: string[] = [];
    for (const f of files) {
      const src = await readFile(new URL(f, dir), 'utf8');
      if (/child_process/.test(src) && f !== 'exec.ts') offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it('reports missing programs and timeouts without throwing', async () => {
    const host = makeHostExec('none');
    expect((await host('apt', ['list'])).error).toBe('not_found');
    const t = await runFile('ping', ['-c', '50', '-i', '0.2', '127.0.0.1'], { timeoutMs: 200 });
    // Either ping is missing in the test environment or it was killed by the timeout.
    expect(['timeout', 'not_found', undefined]).toContain(t.error);
    if (t.error === undefined) expect(t.code).not.toBe(0);
  });

  it('host exec refuses nested nsenter and disallowed programs', () => {
    const host = makeHostExec('nsenter');
    expect(() => host('nsenter', ['-t', '1'])).toThrow(ExecPolicyError);
    expect(() => host('sh', ['-c', 'reboot'])).toThrow(ExecPolicyError);
  });
});
