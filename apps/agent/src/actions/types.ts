import type { RpcAction, RpcErrorCode, RpcParams } from '@hz/shared';
import type { RunOptions, RunResult, Spawner } from '../exec.js';
import type { HostContext } from '../host.js';
import type { Logger } from '../log.js';
import type { StreamManager } from '../streams.js';
import type { WakeManager } from './game-wake.js';
import type { PtyManager } from './pty.js';
import type { TaskManager } from './task-exec.js';
import type { UpdateService } from '../update/service.js';
import type { RelayManager } from './relay.js';

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
  /** Starts a program with streamed output (exec.ts spawnFile; injected for tests). */
  spawn: Spawner;
  /** HZ_AGENT_DATA (agent state, deploy keys). */
  dataDir: string;
  /** Pinned Trivy image for image.scan (config HZ_AGENT_TRIVY_IMAGE); default TRIVY_IMAGE_DEFAULT. */
  trivyImage?: string;
  /** Web console sessions (actions/pty.ts); only set when HZ_AGENT_ALLOW_TERMINAL=1. */
  pty?: PtyManager;
  /** HZ_AGENT_ALLOW_TASKS=1: task.exec may run host commands. Missing = off. */
  allowTasks?: boolean;
  /** Scheduled commands (actions/task-exec.ts); only set when HZ_AGENT_ALLOW_TASKS=1. */
  tasks?: TaskManager;
  /** Wake listeners of sleeping games (game.wake.*); set by index.ts. */
  wake?: WakeManager;
  /** M16: systemd units system.service may control (HZ_AGENT_SERVICES, already filtered). */
  services?: readonly string[];
  /** M17: image updates (update.*); set by index.ts when Docker is available. */
  updates?: UpdateService;
  /** Game relay routes (relay.set); only set when HZ_AGENT_ALLOW_RELAY=1. */
  relay?: RelayManager;
}

export type ActionHandler<A extends RpcAction> = (
  params: RpcParams<A>,
  ctx: ActionContext,
  rpcId: string,
) => Promise<unknown>;

export type ActionHandlers = { [A in RpcAction]: ActionHandler<A> };
