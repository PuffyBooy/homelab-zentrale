import { randomBytes } from 'node:crypto';
import { lstat, open, unlink } from 'node:fs/promises';
import { systemUpgradeDataSchema, type SystemUpgradeData } from '@hz/shared';
import { rebootRequired } from '../collect/security.js';
import { isMissingProgram, type RunResult } from '../exec.js';
import { hostPath } from '../host.js';
import { withHostLock } from './host-lock.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * system.upgrade (M17, OS packages): apt hosts only.
 *
 *   apt-get update -q
 *   apt-get -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade
 *
 * Fixed arguments, nothing from the core. Plain `upgrade` never removes a
 * package and never installs a new one (kept-back packages stay kept back);
 * confdef/confold keep locally changed configuration files. The environment
 * is CHILD_ENV (DEBIAN_FRONTEND=noninteractive, LANG=C, so the summary line
 * is English); nsenter passes it on to the host's apt-get.
 * The whole upgrade may take up to 40 min; the core waits that long.
 *
 * On systemd hosts apt runs in a transient unit (`systemd-run --unit=hz-upgrade-<rand>
 * --collect --wait`), i.e. in its own cgroup outside the agent container: when the
 * upgrade itself restarts docker/containerd/tailscaled (and with it the agent), dpkg
 * keeps running instead of dying halfway. Output goes to /run/hz-upgrade-<rand>.log
 * (not a pipe, so a dead agent cannot SIGPIPE apt); the agent reads the summary from
 * there. After 40 min the agent stops waiting but never stops the unit. Hosts without
 * systemd (or without systemd-run) run apt-get directly as before.
 */

export const UPGRADE_TIMEOUT_MS = 40 * 60_000;
export const APT_UPDATE_ARGS = ['update', '-q'] as const;
export const APT_UPGRADE_ARGS = [
  '-y',
  '-q',
  '-o',
  'Dpkg::Options::=--force-confdef',
  '-o',
  'Dpkg::Options::=--force-confold',
  'upgrade',
] as const;

/** "N upgraded, M newly installed, K to remove and H not upgraded." (last one wins). */
export function parseAptSummary(out: string): { upgraded: number; kept: number } | null {
  const re = /(\d+) upgraded, (\d+) newly installed, (\d+) to remove and (\d+) not upgraded/g;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(out); m !== null; m = re.exec(out)) last = m;
  if (!last) return null;
  return { upgraded: Number(last[1]), kept: Number(last[4]) };
}

export function systemUpgrade(_p: unknown, ctx: ActionContext): Promise<SystemUpgradeData> {
  return withHostLock('upgrade', () => runUpgrade(ctx));
}

/** Absolute path, so systemd-run never searches a PATH. */
export const APT_GET = '/usr/bin/apt-get';
const LOG_TAIL_BYTES = 256 * 1024;

/** argv of systemd-run for one apt-get call in unit `unit`, output to `logFile`. */
export function systemdRunArgs(
  unit: string,
  logFile: string,
  aptArgs: readonly string[],
): string[] {
  return [
    `--unit=${unit}`,
    '--collect',
    '--wait',
    '--quiet',
    '--service-type=exec',
    `--property=StandardOutput=file:${logFile}`,
    '--property=StandardError=inherit',
    '--setenv=DEBIAN_FRONTEND=noninteractive',
    '--setenv=LANG=C',
    '--setenv=LC_ALL=C',
    '--',
    APT_GET,
    ...aptArgs,
  ];
}

async function readTail(file: string): Promise<string> {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

async function canUseUnits(ctx: ActionContext): Promise<boolean> {
  try {
    // sd_booted(): systemd is PID 1 on the host.
    await lstat(hostPath(ctx.host, '/run/systemd/system'));
  } catch {
    return false;
  }
  const probe = await ctx.host.exec('systemd-run', ['--version'], { timeoutMs: 10_000 });
  return !isMissingProgram(probe) && probe.code === 0;
}

/** Runs apt-get with fixed args, in a transient unit when possible. */
async function runApt(
  ctx: ActionContext,
  units: boolean,
  args: readonly string[],
  timeoutMs: number,
): Promise<RunResult> {
  if (!units) return ctx.host.exec('apt-get', [...args], { timeoutMs });
  const unit = `hz-upgrade-${randomBytes(4).toString('hex')}`;
  const logFile = `/run/${unit}.log`;
  ctx.log.info('apt in transient unit', { unit });
  // On timeout nsenter/systemd-run is killed; the unit itself keeps running.
  const r = await ctx.host.exec('systemd-run', systemdRunArgs(unit, logFile, args), { timeoutMs });
  if (r.error === 'timeout') return r;
  const local = hostPath(ctx.host, logFile);
  const stdout = await readTail(local).catch(() => '');
  await unlink(local).catch(() => undefined);
  return { ...r, stdout };
}

async function runUpgrade(ctx: ActionContext): Promise<SystemUpgradeData> {
  const host = ctx.host;
  const probe = await host.exec('apt-get', ['--version'], { timeoutMs: 10_000 });
  if (isMissingProgram(probe) || probe.code !== 0) {
    throw new ActionError('failed', 'apt not available on this host', false);
  }
  const units = await canUseUnits(ctx);
  const started = Date.now();
  const left = () => Math.max(60_000, UPGRADE_TIMEOUT_MS - (Date.now() - started));

  ctx.log.info('os upgrade started', { transientUnit: units });
  const upd = await runApt(ctx, units, APT_UPDATE_ARGS, 10 * 60_000);
  if (upd.error === 'timeout') throw new ActionError('timeout', 'apt-get update timed out', false);
  if (upd.code !== 0) {
    throw new ActionError('failed', `apt-get update failed (exit ${upd.code ?? '?'})`, false);
  }
  const up = await runApt(ctx, units, APT_UPGRADE_ARGS, left());
  if (up.error === 'timeout') {
    throw new ActionError(
      'timeout',
      units
        ? 'apt-get upgrade still running after 40 min (left running in its own unit)'
        : 'apt-get upgrade timed out',
      false,
    );
  }
  if (up.code !== 0) {
    throw new ActionError('failed', `apt-get upgrade failed (exit ${up.code ?? '?'})`, false);
  }
  const summary = parseAptSummary(up.stdout) ?? { upgraded: 0, kept: 0 };
  const reboot = await rebootRequired(host).catch(() => false);
  ctx.log.info('os upgrade done', { upgraded: summary.upgraded, kept: summary.kept, reboot });
  return systemUpgradeDataSchema.parse({ ...summary, rebootRequired: reboot });
}
