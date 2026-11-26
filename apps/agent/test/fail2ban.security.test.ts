import { describe, expect, it } from 'vitest';
import { fail2banStatusDataSchema, type AgentEvent, type RpcEnvelope } from '@hz/shared';
import { Dispatcher } from '../src/actions/index.js';
import { fail2banStatus, fail2banUnban, parseFail2banJailStatus } from '../src/actions/fail2ban.js';
import type { RunResult } from '../src/exec.js';
import { makeCtx } from './game-helpers.js';

const STATUS = 'Status\n|- Number of jail:\t2\n`- Jail list:\tsshd, recidive\n';
const SSHD = [
  'Status for the jail: sshd',
  '|- Filter',
  '|  |- Currently failed:\t3',
  '|  |- Total failed:\t42',
  '|  `- File list:\t/var/log/auth.log',
  '`- Actions',
  '   |- Currently banned:\t3',
  '   |- Total banned:\t17',
  '   `- Banned IP list:\t203.0.113.5 2001:db8::1 $(id) 203.0.113.5 999.1.1.1 198.51.100.7',
  '',
].join('\n');

type Call = { file: string; args: readonly string[] };

function hostExec(answers: (args: readonly string[]) => RunResult) {
  const calls: Call[] = [];
  const exec = async (file: string, args: readonly string[]): Promise<RunResult> => {
    calls.push({ file, args });
    return answers(args);
  };
  return { calls, exec };
}

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });

function setup(answers: (args: readonly string[]) => RunResult) {
  const { calls, exec } = hostExec(answers);
  const { ctx } = makeCtx('/nonexistent');
  ctx.host.exec = exec;
  return { ctx, calls };
}

const defaultAnswers = (args: readonly string[]): RunResult => {
  if (args.length === 1 && args[0] === 'status') return ok(STATUS);
  if (args[0] === 'status' && args[1] === 'sshd') return ok(SSHD);
  if (args[0] === 'status' && args[1] === 'recidive')
    return ok('`- Actions\n   |- Currently banned:\t0\n   `- Banned IP list:\t\n');
  return ok('1');
};

describe('fail2ban parsers', () => {
  it('parses counters and keeps only valid, unique IPs', () => {
    expect(parseFail2banJailStatus('sshd', SSHD)).toEqual({
      name: 'sshd',
      currentlyFailed: 3,
      totalFailed: 42,
      currentlyBanned: 3,
      totalBanned: 17,
      bannedIps: ['203.0.113.5', '2001:db8::1', '198.51.100.7'],
    });
  });

  it('missing fields are 0 / empty; caps the IP list at 1000', () => {
    expect(parseFail2banJailStatus('x', 'garbage')).toEqual({
      name: 'x',
      currentlyFailed: 0,
      totalFailed: 0,
      currentlyBanned: 0,
      totalBanned: 0,
      bannedIps: [],
    });
    const ips = Array.from({ length: 1500 }, (_, i) => `10.0.${i >> 8}.${i & 255}`).join(' ');
    expect(parseFail2banJailStatus('x', `Banned IP list:\t${ips}`).bannedIps).toHaveLength(1000);
  });
});

describe('fail2ban.status', () => {
  it('reads every jail with fixed argument arrays', async () => {
    const { ctx, calls } = setup(defaultAnswers);
    const data = await fail2banStatus({}, ctx);
    expect(fail2banStatusDataSchema.safeParse(data).success).toBe(true);
    expect(data.installed).toBe(true);
    expect(data.jails.map((j) => [j.name, j.currentlyBanned])).toEqual([
      ['sshd', 3],
      ['recidive', 0],
    ]);
    expect(calls).toEqual([
      { file: 'fail2ban-client', args: ['status'] },
      { file: 'fail2ban-client', args: ['status', 'sshd'] },
      { file: 'fail2ban-client', args: ['status', 'recidive'] },
    ]);
  });

  it('a jail whose status call throws is skipped, the others are still reported', async () => {
    const { ctx } = setup((args) => {
      if (args[0] === 'status' && args[1] === 'sshd') throw new Error('timeout');
      return defaultAnswers(args);
    });
    const data = await fail2banStatus({}, ctx);
    expect(data.installed).toBe(true);
    expect(data.jails.map((j) => j.name)).toEqual(['recidive']);
  });

  it('fail2ban missing or not running -> installed:false', async () => {
    for (const r of [
      { code: null, stdout: '', stderr: '', error: 'not_found' as const },
      { code: 127, stdout: '', stderr: 'nsenter: failed to execute fail2ban-client' },
      { code: 255, stdout: '', stderr: 'Failed to access socket path' },
    ]) {
      const { ctx } = setup(() => r);
      expect(await fail2banStatus({}, ctx)).toEqual({ installed: false, jails: [] });
    }
  });
});

describe('fail2ban.unban', () => {
  it('unbans with exactly set <jail> unbanip <ip>', async () => {
    const { ctx, calls } = setup(defaultAnswers);
    expect(await fail2banUnban({ jail: 'sshd', ip: '203.0.113.5' }, ctx)).toBeNull();
    expect(calls.at(-1)).toEqual({
      file: 'fail2ban-client',
      args: ['set', 'sshd', 'unbanip', '203.0.113.5'],
    });
  });

  it('a jail that is not in the jail list -> not_found without audit, nothing set', async () => {
    const { ctx, calls } = setup(defaultAnswers);
    await expect(fail2banUnban({ jail: 'nginx', ip: '203.0.113.5' }, ctx)).rejects.toMatchObject({
      code: 'not_found',
      message: 'jail not found',
      audit: false,
    });
    expect(calls.some((c) => c.args[0] === 'set')).toBe(false);
  });

  it('refuses a jail starting with a dash even if listed', async () => {
    const { ctx, calls } = setup((args) =>
      args.length === 1 ? ok('`- Jail list:\t-h, sshd\n') : ok(''),
    );
    await expect(fail2banUnban({ jail: '-h', ip: '203.0.113.5' }, ctx)).rejects.toMatchObject({
      code: 'invalid_params',
    });
    expect(calls).toEqual([]);
  });

  it('non-zero exit -> failed', async () => {
    const { ctx } = setup((args) =>
      args[0] === 'set' ? { code: 1, stdout: '', stderr: 'x' } : defaultAnswers(args),
    );
    await expect(fail2banUnban({ jail: 'sshd', ip: '203.0.113.5' }, ctx)).rejects.toMatchObject({
      code: 'failed',
    });
  });

  it('fail2ban missing -> failed, nothing set', async () => {
    const { ctx, calls } = setup(() => ({
      code: null,
      stdout: '',
      stderr: '',
      error: 'not_found',
    }));
    await expect(fail2banUnban({ jail: 'sshd', ip: '203.0.113.5' }, ctx)).rejects.toMatchObject({
      code: 'failed',
    });
    expect(calls).toHaveLength(1);
  });

  it('the dispatcher rejects injected or option-like IPs and jails via the schema', async () => {
    const { ctx, calls } = setup(defaultAnswers);
    const events: AgentEvent[] = [];
    const d = new Dispatcher(ctx, (e) => events.push(e));
    const rpc = (params: unknown): RpcEnvelope => ({
      type: 'rpc',
      id: 'r1',
      action: 'fail2ban.unban',
      params,
    });
    for (const params of [
      { jail: 'sshd', ip: '1.2.3.4; rm -rf /' },
      { jail: 'sshd', ip: '-h' },
      { jail: 'sshd', ip: '1.2.3.4 5.6.7.8' },
      { jail: 'sshd', ip: '999.0.0.1' },
      { jail: 'ssh d', ip: '1.2.3.4' },
      { jail: 'sshd;id', ip: '1.2.3.4' },
      { jail: 'sshd', ip: '1.2.3.4', extra: 1 },
      { jail: 'sshd' },
    ]) {
      const r = await d.handle(rpc(params));
      expect(r.ok, JSON.stringify(params)).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('invalid_params');
    }
    expect(calls).toEqual([]);
    expect(events.every((e) => e.event.kind === 'denied')).toBe(true);
    expect(events).toHaveLength(8);

    const good = await d.handle(rpc({ jail: 'sshd', ip: '2001:db8::1' }));
    expect(good).toEqual({ type: 'rpc.result', id: 'r1', ok: true, data: null });
  });

  it('the dispatcher reports an unknown jail as not_found without a denied event', async () => {
    const { ctx, calls } = setup(defaultAnswers);
    const events: AgentEvent[] = [];
    const d = new Dispatcher(ctx, (e) => events.push(e));
    const r = await d.handle({
      type: 'rpc',
      id: 'r2',
      action: 'fail2ban.unban',
      params: { jail: 'nginx', ip: '203.0.113.5' },
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'not_found', message: 'jail not found' } });
    expect(events).toEqual([]);
    expect(calls.some((c) => c.args[0] === 'set')).toBe(false);
  });
});
