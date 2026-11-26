import type { RpcAction, RpcErrorCode, RpcParams } from '@hz/shared';
import type { HostContext } from '../host.js';
import type { Logger } from '../log.js';

/** Thrown by actions; becomes rpc.result {ok:false, error:{code, message}}. */
export class ActionError extends Error {
  constructor(
    public readonly code: RpcErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ActionError';
  }
}

export interface ActionContext {
  /** HZ_AGENT_NAME; system.reboot must be confirmed with exactly this name. */
  name: string;
  allowTerminal: boolean;
  homelabRoot: string;
  host: HostContext;
  log: Logger;
  /** Schedules work after the rpc.result was sent (e.g. the reboot itself). */
  later: (fn: () => void, ms: number) => void;
}

export type ActionHandler<A extends RpcAction> = (
  params: RpcParams<A>,
  ctx: ActionContext,
  rpcId: string,
) => Promise<unknown>;

export type ActionHandlers = { [A in RpcAction]: ActionHandler<A> };
