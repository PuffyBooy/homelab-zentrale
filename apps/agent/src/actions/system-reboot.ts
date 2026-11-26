import type { RpcParams } from '@hz/shared';
import { isMissingProgram } from '../exec.js';
import { ActionError, type ActionContext } from './types.js';

/** Delay between the rpc.result and the reboot, so the core gets the answer. */
export const REBOOT_DELAY_MS = 2000;

/**
 * system.reboot: confirmName must equal HZ_AGENT_NAME exactly (the core also
 * demands step-up). The reboot runs `systemctl reboot` on the host via nsenter.
 */
export async function systemReboot(params: RpcParams<'system.reboot'>, ctx: ActionContext) {
  if (params.confirmName !== ctx.name) {
    throw new ActionError('confirm_mismatch', 'confirmName does not match the server name');
  }
  const probe = await ctx.host.exec('systemctl', ['--version'], { timeoutMs: 5000 });
  if (isMissingProgram(probe) || probe.code !== 0) {
    throw new ActionError('failed', 'systemctl not available on the host');
  }
  ctx.log.warn('reboot requested by core', { delayMs: REBOOT_DELAY_MS });
  ctx.later(() => {
    void ctx.host.exec('systemctl', ['reboot'], { timeoutMs: 30_000 }).then((r) => {
      if (r.code !== 0) ctx.log.error('reboot failed', { code: r.code, error: r.error });
    });
  }, REBOOT_DELAY_MS);
  return { scheduled: true, inMs: REBOOT_DELAY_MS };
}
