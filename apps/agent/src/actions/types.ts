import type { RpcAction, RpcErrorCode, RpcParams } from '@hz/shared';
import type { RunOptions, RunResult } from '../exec.js';
import type { HostContext } from '../host.js';
import type { Logger } from '../log.js';
import type { StreamManager } from '../streams.js';

/** Thrown by actions; becomes rpc.result {ok:false, error:{code, message}}. */
export class ActionError extends Error {
  constructor(
    public readonly code: RpcErrorCode,
    message: string,
    /** false: a normal refusal (e.g. compose container on container.update), no `denied` event. */
    public readonly audit = true,
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
  /** Output of streaming actions (rpc id = stream id). */
  streams: StreamManager;
  /** Runs a program inside the agent container (exec.ts runFile; injected for tests). */
  run: (file: string, args: readonly string[], opts?: RunOptions) => Promise<RunResult>;
  /** Docker socket path, for the docker CLI (DOCKER_HOST). */
  dockerSocket: string;
}

export type ActionHandler<A extends RpcAction> = (
  params: RpcParams<A>,
  ctx: ActionContext,
  rpcId: string,
) => Promise<unknown>;

export type ActionHandlers = { [A in RpcAction]: ActionHandler<A> };
