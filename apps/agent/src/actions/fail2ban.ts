import {
  banIpSchema,
  fail2banStatusDataSchema,
  type Fail2banJail,
  type Fail2banStatusData,
  type RpcParams,
} from '@hz/shared';
import { isMissingProgram, type RunResult } from '../exec.js';
import { parseFail2banJails } from '../collect/security.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * fail2ban.status / fail2ban.unban on the host (ctx.host.exec = nsenter into PID 1).
 *
 * Only these fixed calls, always as argument arrays:
 *   fail2ban-client status
 *   fail2ban-client status <jail>                 (jail from the jail list)
 *   fail2ban-client set <jail> unbanip <ip>        (jail must be in the jail list, ip validated)
 */

const FAIL2BAN_TIMEOUT_MS = 10_000;
export const MAX_BANNED_IPS = 1000;

const COUNTERS = {
  currentlyFailed: /Currently failed:[ \t]*(\d{1,12})/,
  totalFailed: /Total failed:[ \t]*(\d{1,12})/,
  currentlyBanned: /Currently banned:[ \t]*(\d{1,12})/,
  totalBanned: /Total banned:[ \t]*(\d{1,12})/,
} as const;

function counter(text: string, key: keyof typeof COUNTERS): number {
  const m = COUNTERS[key].exec(text);
  const n = m?.[1] ? Number(m[1]) : 0;
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/** Parses `fail2ban-client status <jail>`. IPs that are not valid IPv4/IPv6 are dropped. */
export function parseFail2banJailStatus(name: string, text: string): Fail2banJail {
  const list = /Banned IP list:[ \t]*(.*)$/m.exec(text)?.[1] ?? '';
  const ips: string[] = [];
  const seen = new Set<string>();
  for (const entry of list.split(/\s+/)) {
    if (ips.length >= MAX_BANNED_IPS) break;
    if (entry === '' || seen.has(entry) || !banIpSchema.safeParse(entry).success) continue;
    seen.add(entry);
    ips.push(entry);
  }
  return {
    name,
    currentlyFailed: counter(text, 'currentlyFailed'),
    totalFailed: counter(text, 'totalFailed'),
    currentlyBanned: counter(text, 'currentlyBanned'),
    totalBanned: counter(text, 'totalBanned'),
    bannedIps: ips,
  };
}

type Exec = ActionContext['host']['exec'];

async function jailList(exec: Exec): Promise<string[] | null> {
  let r: RunResult;
  try {
    r = await exec('fail2ban-client', ['status'], { timeoutMs: FAIL2BAN_TIMEOUT_MS });
  } catch {
    return null;
  }
  if (isMissingProgram(r) || r.code !== 0) return null;
  return parseFail2banJails(r.stdout);
}

export async function fail2banStatus(
  _params: RpcParams<'fail2ban.status'>,
  ctx: ActionContext,
): Promise<Fail2banStatusData> {
  const jails = await jailList(ctx.host.exec);
  if (jails === null) return { installed: false, jails: [] };
  const out: Fail2banJail[] = [];
  for (const jail of jails) {
    const r = await ctx.host.exec('fail2ban-client', ['status', jail], {
      timeoutMs: FAIL2BAN_TIMEOUT_MS,
    });
    if (r.code !== 0) continue;
    out.push(parseFail2banJailStatus(jail, r.stdout));
  }
  const data: Fail2banStatusData = { installed: true, jails: out };
  return fail2banStatusDataSchema.parse(data);
}

export async function fail2banUnban(
  params: RpcParams<'fail2ban.unban'>,
  ctx: ActionContext,
): Promise<null> {
  const { jail, ip } = params;
  // Already checked by the schema; repeated here because these become program arguments.
  if (jail.startsWith('-') || !banIpSchema.safeParse(ip).success) {
    throw new ActionError('invalid_params', 'invalid jail or ip');
  }
  const jails = await jailList(ctx.host.exec);
  if (jails === null) throw new ActionError('failed', 'fail2ban is not available', false);
  if (!jails.includes(jail)) throw new ActionError('invalid_params', 'unknown jail');
  const r = await ctx.host.exec('fail2ban-client', ['set', jail, 'unbanip', ip], {
    timeoutMs: FAIL2BAN_TIMEOUT_MS,
  });
  if (r.code !== 0) throw new ActionError('failed', 'unban failed', false);
  ctx.log.info('fail2ban unban', { jail, ip });
  return null;
}
