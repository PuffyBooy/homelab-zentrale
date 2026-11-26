import { describe, expect, it, vi } from 'vitest';

const calls: { file: string; args: string[]; opts: Record<string, unknown> }[] = [];

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    opts: Record<string, unknown>,
    cb: (err: null, stdout: string, stderr: string) => void,
  ) => {
    calls.push({ file, args, opts });
    cb(null, '', '');
  },
}));

const { makeHostExec, runFile } = await import('../src/exec.js');

describe('exec options', () => {
  it('uses shell:false, a timeout, a buffer limit and a minimal env without the token', async () => {
    process.env.HZ_AGENT_TOKEN = 'tok_SHOULD_NOT_LEAK_1234567890abc';
    try {
      await runFile('journalctl', ['--disk-usage']);
    } finally {
      delete process.env.HZ_AGENT_TOKEN;
    }
    const c = calls.at(-1);
    if (!c) throw new Error('no call');
    expect(c.file).toBe('journalctl');
    expect(c.args).toEqual(['--disk-usage']);
    expect(c.opts.shell).toBe(false);
    expect(c.opts.timeout).toBeGreaterThan(0);
    expect(c.opts.maxBuffer).toBeGreaterThan(0);
    const env = c.opts.env as Record<string, string>;
    expect(Object.keys(env).sort()).toEqual(['DEBIAN_FRONTEND', 'LANG', 'LC_ALL', 'PATH']);
    expect(JSON.stringify(env)).not.toContain('tok_SHOULD_NOT_LEAK');
  });

  it('host exec wraps the program in nsenter with a -- separator', async () => {
    await makeHostExec('nsenter')('apt-get', ['clean']);
    const c = calls.at(-1);
    if (!c) throw new Error('no call');
    expect(c.file).toBe('nsenter');
    const sep = c.args.indexOf('--');
    expect(c.args.slice(0, 2)).toEqual(['--target', '1']);
    expect(c.args.slice(sep + 1)).toEqual(['apt-get', 'clean']);
  });

  it('direct mode runs the program itself', async () => {
    await makeHostExec('direct')('systemctl', ['--version']);
    expect(calls.at(-1)).toMatchObject({ file: 'systemctl', args: ['--version'] });
  });
});
