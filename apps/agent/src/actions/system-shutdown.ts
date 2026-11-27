import type { RpcParams } from '@hz/shared';
import { isMissingProgram } from '../exec.js';
import { REBOOT_DELAY_MS } from './system-reboot.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * system.shutdown: like system.reboot, but `systemctl poweroff`. confirmName must
 * equal HZ_AGENT_NAME exactly (the core also demands step-up). The host stays off
 * until someone powers it on (or Wake-on-LAN).
 */
export async function systemShutdown(params: RpcParams<'system.shutdown'>, ctx: ActionContext) {
  if (params.confirmName !== ctx.name) {
    throw new ActionError('confirm_mismatch', 'confirmName does not match the server name');
  }
  const probe = await ctx.host.exec('systemctl', ['--version'], { timeoutMs: 5000 });
  if (isMissingProgram(probe) || probe.code !== 0) {
    throw new ActionError('failed', 'systemctl not available on the host');
  }
  ctx.log.warn('shutdown requested by core', { delayMs: REBOOT_DELAY_MS });
  ctx.later(() => {
    void ctx.host.exec('systemctl', ['poweroff'], { timeoutMs: 30_000 }).then((r) => {
      if (r.code !== 0) ctx.log.error('poweroff failed', { code: r.code, error: r.error });
    });
  }, REBOOT_DELAY_MS);
  return { scheduled: true, inMs: REBOOT_DELAY_MS };
}
