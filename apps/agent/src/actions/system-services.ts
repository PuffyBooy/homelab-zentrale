import {
  isDeniedServiceUnit,
  serviceUnitSchema,
  servicesDataSchema,
  type RpcParams,
  type ServiceUnitInfo,
  type ServicesData,
} from '@hz/shared';
import { isMissingProgram } from '../exec.js';
import type { HostContext } from '../host.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * system.services / system.service and the `failedServices` of the inventory.
 *
 * Listing is read-only (`systemctl list-units ... --plain --no-legend`).
 * Controlling a unit needs two things on the agent, whatever the core sends:
 * the unit is listed in HZ_AGENT_SERVICES and it is not on SERVICE_DENYLIST
 * (tailscaled, docker, ssh, systemd-* ...). Refusals are audited (denied event).
 */

export const MAX_UNITS = 500;
export const MAX_FAILED = 50;
const LIST_ARGS = ['list-units', '--type=service', '--no-legend', '--plain', '--no-pager'];

export interface UnitLine {
  name: string;
  load: string;
  active: string;
  sub: string;
  description: string;
}

/** Parses `systemctl list-units --plain --no-legend` lines: UNIT LOAD ACTIVE SUB DESCRIPTION. */
export function parseUnitList(out: string): UnitLine[] {
  const units: UnitLine[] = [];
  for (const raw of out.split('\n')) {
    // Some versions still print the failed marker ("●" or "*") in front.
    const line = raw.replace(/^\s*(?:●|\*)\s*/, '').trim();
    if (line === '') continue;
    const m = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
    if (!m) continue;
    const [, name, load, active, sub, description] = m;
    if (!name?.endsWith('.service') || !load || !active || !sub) continue;
    units.push({
      name: name.slice(0, 200),
      load: load.slice(0, 32),
      active: active.slice(0, 32),
      sub: sub.slice(0, 32),
      description: (description ?? '').slice(0, 200),
    });
  }
  return units;
}

/** True when the agent may start/stop/restart `unit`. */
export function isManageable(unit: string, allowed: readonly string[] | undefined): boolean {
  return (
    serviceUnitSchema.safeParse(unit).success &&
    (allowed ?? []).includes(unit) &&
    !isDeniedServiceUnit(unit)
  );
}

/** Failed first, then by name. */
export function sortUnits<T extends { name: string; active: string }>(units: T[]): T[] {
  return [...units].sort((a, b) => {
    const fa = a.active === 'failed' ? 0 : 1;
    const fb = b.active === 'failed' ? 0 : 1;
    return fa - fb || a.name.localeCompare(b.name);
  });
}

/** The unit's real id (`systemctl show -p Id --value`), null when it cannot be read. */
export async function resolveUnitId(host: HostContext, unit: string): Promise<string | null> {
  const r = await host.exec('systemctl', ['show', '-p', 'Id', '--value', '--', unit], {
    timeoutMs: 10_000,
  });
  if (r.code !== 0) return null;
  const id = r.stdout.trim().split('\n')[0]?.trim() ?? '';
  return id.endsWith('.service') && id.length <= 200 ? id : null;
}

async function systemdAvailable(host: HostContext): Promise<boolean> {
  const probe = await host.exec('systemctl', ['--version'], { timeoutMs: 5000 });
  return !isMissingProgram(probe) && probe.code === 0;
}

export async function systemServices(_p: unknown, ctx: ActionContext): Promise<ServicesData> {
  if (!(await systemdAvailable(ctx.host))) return { systemd: false, units: [] };
  const r = await ctx.host.exec('systemctl', [...LIST_ARGS, '--all'], {
    timeoutMs: 20_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (r.code !== 0) throw new ActionError('failed', 'systemctl list-units failed', false);
  // list-units shows real unit ids (never aliases), so isManageable sees the real name.
  const units: ServiceUnitInfo[] = sortUnits(parseUnitList(r.stdout))
    .slice(0, MAX_UNITS)
    .map((u) => ({ ...u, manageable: isManageable(u.name, ctx.services) }));
  return servicesDataSchema.parse({ systemd: true, units });
}

/** Names of failed service units for the inventory; undefined without systemd. */
export async function collectFailedServices(host: HostContext): Promise<string[] | undefined> {
  const r = await host.exec('systemctl', [...LIST_ARGS, '--state=failed'], {
    timeoutMs: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (isMissingProgram(r) || r.code !== 0) return undefined;
  return parseUnitList(r.stdout)
    .filter((u) => u.active === 'failed')
    .map((u) => u.name)
    .sort()
    .slice(0, MAX_FAILED);
}

export async function systemService(
  params: RpcParams<'system.service'>,
  ctx: ActionContext,
): Promise<{ ok: true; active: string }> {
  const { unit, op } = params;
  if (isDeniedServiceUnit(unit)) {
    throw new ActionError('not_allowed', 'unit is on the service deny list');
  }
  if (!isManageable(unit, ctx.services)) {
    throw new ActionError('not_allowed', 'unit is not listed in HZ_AGENT_SERVICES');
  }
  if (!(await systemdAvailable(ctx.host))) {
    throw new ActionError('failed', 'systemctl not available on the host', false);
  }
  // An alias (dbus-org.freedesktop.network1.service -> systemd-networkd.service) must not
  // smuggle a denied unit past the name check: the real unit id is checked too.
  const real = await resolveUnitId(ctx.host, unit);
  if (real === null) throw new ActionError('failed', 'could not resolve the unit', false);
  if (isDeniedServiceUnit(real)) {
    throw new ActionError('not_allowed', `unit is an alias of ${real.slice(0, 120)} (deny list)`);
  }
  ctx.log.info('service action', { unit, op });
  const r = await ctx.host.exec('systemctl', [op, '--no-ask-password', '--', unit], {
    timeoutMs: 60_000,
  });
  if (r.error === 'timeout')
    throw new ActionError('timeout', `systemctl ${op} took over 60 s`, false);
  if (r.code !== 0) {
    throw new ActionError('failed', `systemctl ${op} failed (exit ${r.code ?? '?'})`, false);
  }
  const state = await ctx.host.exec('systemctl', ['is-active', '--', unit], { timeoutMs: 10_000 });
  const active = (state.stdout.trim().split('\n')[0] ?? '').slice(0, 32) || 'unknown';
  return { ok: true, active };
}
