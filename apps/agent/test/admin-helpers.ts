import { vi, type Mock } from 'vitest';
import type { AgentEvent, RpcEnvelope } from '@hz/shared';
import { Dispatcher, type ActionContext } from '../src/actions/index.js';
import type { RunOptions, RunResult } from '../src/exec.js';
import { createLogger } from '../src/log.js';
import { StreamManager } from '../src/streams.js';

export interface ExecCall {
  file: string;
  args: readonly string[];
  opts?: RunOptions | undefined;
}

export type ExecFn = (file: string, args: readonly string[]) => RunResult | Promise<RunResult>;

export const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });

export interface AdminSetup {
  d: Dispatcher;
  ctx: ActionContext;
  events: AgentEvent[];
  execCalls: ExecCall[];
  later: Mock<(fn: () => void, ms: number) => void>;
}

/** A dispatcher with a fake host exec for the M16/M17 actions. */
export function setupAdmin(
  exec: ExecFn = () => ok(),
  overrides: Partial<ActionContext> = {},
): AdminSetup {
  const events: AgentEvent[] = [];
  const execCalls: ExecCall[] = [];
  const later = vi.fn<(fn: () => void, ms: number) => void>();
  const ctx: ActionContext = {
    name: 'oracle-a1',
    allowTerminal: false,
    homelabRoot: '/opt/homelab/',
    host: {
      hostProc: '/nonexistent-proc',
      hostRoot: '/nonexistent-host-root',
      docker: null,
      exec: async (file, args, opts) => {
        execCalls.push({ file, args, opts });
        return exec(file, args);
      },
    },
    log: createLogger('error', () => undefined),
    later,
    streams: new StreamManager({ send: () => true, bufferedAmount: () => 0 }),
    run: async () => ok(),
    dockerSocket: '/var/run/docker.sock',
    spawn: () => {
      throw new Error('spawn not expected');
    },
    dataDir: '/nonexistent-data',
    ...overrides,
  };
  const d = new Dispatcher(ctx, (e) => events.push(e));
  return { d, ctx, events, execCalls, later };
}

export const rpc = (action: string, params: unknown): RpcEnvelope => ({
  type: 'rpc',
  id: 'rpc_12345678',
  action,
  params,
});
