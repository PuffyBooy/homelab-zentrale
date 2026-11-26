import { describe, expect, it } from 'vitest';
import {
  collectFailedServices,
  isManageable,
  parseUnitList,
} from '../src/actions/system-services.js';
import { loadConfig, parseServiceList } from '../src/config.js';
import { ok, rpc, setupAdmin, type ExecFn } from './admin-helpers.js';

const LIST = [
  'cron.service             loaded active   running Regular background program processing daemon',
  '● nginx.service          loaded failed   failed  A high performance web server',
  'smbd.service             loaded inactive dead    Samba SMB Daemon',
  'ssh.service              loaded active   running OpenBSD Secure Shell server',
  'ghost.service            not-found inactive dead ghost.service',
  'getty@tty1.service       loaded active   running Getty on tty1',
  'garbage',
  'foo.socket loaded active listening Not a service',
].join('\n');

const systemd: ExecFn = (file, args) => {
  if (file !== 'systemctl') return { code: 127, stdout: '', stderr: '' };
  if (args[0] === '--version') return ok('systemd 252 (252.22-1)');
  if (args[0] === 'list-units')
    return ok(args.includes('--state=failed') ? LIST.split('\n')[1] : LIST);
  if (args[0] === 'is-active') return { code: 3, stdout: 'inactive\n', stderr: '' };
  if (args[0] === 'show') {
    const unit = args.at(-1) ?? '';
    const aliases: Record<string, string> = {
      'dbus-org.freedesktop.network1.service': 'systemd-networkd.service',
      'sshd.service': 'ssh.service',
      'web.service': 'nginx.service',
    };
    return ok(`${aliases[unit] ?? unit}\n`);
  }
  return ok();
};

describe('systemctl parser', () => {
  it('parses units, strips the failed marker, skips non-services', () => {
    const units = parseUnitList(LIST);
    expect(units.map((u) => u.name)).toEqual([
      'cron.service',
      'nginx.service',
      'smbd.service',
      'ssh.service',
      'ghost.service',
      'getty@tty1.service',
    ]);
    expect(units[1]).toEqual({
      name: 'nginx.service',
      load: 'loaded',
      active: 'failed',
      sub: 'failed',
      description: 'A high performance web server',
    });
    expect(units[4]).toMatchObject({ load: 'not-found', active: 'inactive' });
  });
});

describe('HZ_AGENT_SERVICES', () => {
  it('adds .service, drops invalid names and denied units', () => {
    const r = parseServiceList(
      ' nginx, smbd.service ,docker,ssh.service,systemd-journald,a b,../x, ,',
    );
    expect(r.units).toEqual(['nginx.service', 'smbd.service']);
    expect(r.ignored).toEqual(['docker', 'ssh.service', 'systemd-journald', 'a b', '../x']);
  });

  it('is read by loadConfig', () => {
    const c = loadConfig({
      HZ_CORE_URL: 'ws://127.0.0.1:8080/agent',
      HZ_AGENT_NAME: 'pi',
      HZ_AGENT_SERVICES: 'nginx,tailscaled',
    });
    expect(c.services).toEqual(['nginx.service']);
    expect(c.ignoredServices).toEqual(['tailscaled']);
    expect(
      loadConfig({ HZ_CORE_URL: 'ws://127.0.0.1:8080/agent', HZ_AGENT_NAME: 'pi' }).services,
    ).toEqual([]);
  });

  it('manageable needs the allowlist and never the deny list', () => {
    expect(isManageable('nginx.service', ['nginx.service'])).toBe(true);
    expect(isManageable('nginx.service', [])).toBe(false);
    expect(isManageable('nginx.service', undefined)).toBe(false);
    // Even if someone forced it into the list:
    expect(isManageable('docker.service', ['docker.service'])).toBe(false);
    expect(isManageable('systemd-networkd.service', ['systemd-networkd.service'])).toBe(false);
    expect(isManageable('getty@tty1.service', ['getty@tty1.service'])).toBe(false);
  });
});

describe('system.services', () => {
  it('lists failed first, then by name, with manageable flags', async () => {
    const { d } = setupAdmin(systemd, { services: ['smbd.service', 'ssh.service'] });
    const res = await d.handle(rpc('system.services', {}));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const data = res.data as { systemd: boolean; units: { name: string; manageable: boolean }[] };
    expect(data.systemd).toBe(true);
    expect(data.units[0]?.name).toBe('nginx.service');
    expect(data.units.map((u) => u.name).slice(1)).toEqual([
      'cron.service',
      'getty@tty1.service',
      'ghost.service',
      'smbd.service',
      'ssh.service',
    ]);
    expect(data.units.filter((u) => u.manageable).map((u) => u.name)).toEqual(['smbd.service']);
  });

  it('without systemd: systemd false, no units', async () => {
    const { d } = setupAdmin(() => ({ code: null, stdout: '', stderr: '', error: 'not_found' }));
    const res = await d.handle(rpc('system.services', {}));
    expect(res).toMatchObject({ ok: true, data: { systemd: false, units: [] } });
  });

  it('inventory: failed unit names only, undefined without systemd', async () => {
    const { ctx } = setupAdmin(systemd);
    expect(await collectFailedServices(ctx.host)).toEqual(['nginx.service']);
    const none = setupAdmin(() => ({ code: 127, stdout: '', stderr: '' }));
    expect(await collectFailedServices(none.ctx.host)).toBeUndefined();
  });
});

describe('system.service (security)', () => {
  it('refuses a unit that is not in HZ_AGENT_SERVICES, with a denied event', async () => {
    const { d, events, execCalls } = setupAdmin(systemd, { services: ['smbd.service'] });
    const res = await d.handle(rpc('system.service', { unit: 'nginx.service', op: 'restart' }));
    expect(res).toMatchObject({ ok: false, error: { code: 'not_allowed' } });
    expect(events[0]?.event).toMatchObject({ kind: 'denied', action: 'system.service' });
    expect(execCalls).toEqual([]);
  });

  it.each([
    'ssh.service',
    'tailscaled.service',
    'docker.service',
    'systemd-logind.service',
    'serial-getty@ttyS0.service',
  ])('refuses %s from the deny list even when allowlisted', async (unit) => {
    const { d, events, execCalls } = setupAdmin(systemd, { services: [unit] });
    const res = await d.handle(rpc('system.service', { unit, op: 'stop' }));
    expect(res).toMatchObject({ ok: false, error: { code: 'not_allowed' } });
    expect(events[0]?.event).toMatchObject({ kind: 'denied' });
    expect(execCalls).toEqual([]);
  });

  it.each([
    { unit: 'nginx', op: 'restart' },
    { unit: '--now.service', op: 'restart' },
    { unit: 'a;b.service', op: 'restart' },
    { unit: 'nginx.service', op: 'mask' },
    { unit: 'nginx.service', op: 'restart', extra: 1 },
  ])('schema refuses %j', async (params) => {
    const { d, execCalls } = setupAdmin(systemd, { services: ['nginx.service'] });
    const res = await d.handle(rpc('system.service', params));
    expect(res).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    expect(execCalls).toEqual([]);
  });

  it('runs systemctl <op> -- <unit> for an allowed unit and reports the new state', async () => {
    const { d, execCalls } = setupAdmin(systemd, { services: ['smbd.service'] });
    const res = await d.handle(rpc('system.service', { unit: 'smbd.service', op: 'stop' }));
    expect(res).toMatchObject({ ok: true, data: { ok: true, active: 'inactive' } });
    expect(execCalls.map((c) => [c.file, ...c.args])).toEqual([
      ['systemctl', '--version'],
      ['systemctl', 'show', '-p', 'Id', '--value', '--', 'smbd.service'],
      ['systemctl', 'stop', '--no-ask-password', '--', 'smbd.service'],
      ['systemctl', 'is-active', '--', 'smbd.service'],
    ]);
    expect(execCalls[2]?.opts?.timeoutMs).toBe(60_000);
  });

  it('an allowlisted alias of a denied unit is refused after resolving the real id', async () => {
    const unit = 'dbus-org.freedesktop.network1.service';
    const { d, events, execCalls } = setupAdmin(systemd, { services: [unit] });
    const res = await d.handle(rpc('system.service', { unit, op: 'restart' }));
    expect(res).toMatchObject({
      ok: false,
      error: { code: 'not_allowed', message: expect.stringMatching(/systemd-networkd\.service/) },
    });
    expect(events[0]?.event).toMatchObject({ kind: 'denied', action: 'system.service' });
    expect(execCalls.some((c) => c.args[0] === 'restart')).toBe(false);
  });

  it('an alias of an allowed, not denied unit works', async () => {
    const { d, execCalls } = setupAdmin(systemd, { services: ['web.service'] });
    const res = await d.handle(rpc('system.service', { unit: 'web.service', op: 'restart' }));
    expect(res).toMatchObject({ ok: true });
    expect(execCalls.some((c) => c.args[0] === 'restart' && c.args.at(-1) === 'web.service')).toBe(
      true,
    );
  });

  it('refuses when the real id cannot be read', async () => {
    const exec: ExecFn = (f, a) =>
      a[0] === 'show' ? { code: 1, stdout: '', stderr: '' } : systemd(f, a);
    const { d, execCalls } = setupAdmin(exec, { services: ['smbd.service'] });
    const res = await d.handle(rpc('system.service', { unit: 'smbd.service', op: 'restart' }));
    expect(res).toMatchObject({ ok: false, error: { code: 'failed' } });
    expect(execCalls.some((c) => c.args[0] === 'restart')).toBe(false);
  });

  it('a failing systemctl is failed, not denied', async () => {
    const exec: ExecFn = (f, a) =>
      a[0] === 'restart' ? { code: 1, stdout: '', stderr: 'x' } : systemd(f, a);
    const { d, events } = setupAdmin(exec, { services: ['smbd.service'] });
    const res = await d.handle(rpc('system.service', { unit: 'smbd.service', op: 'restart' }));
    expect(res).toMatchObject({ ok: false, error: { code: 'failed' } });
    expect(events).toEqual([]);
  });
});
