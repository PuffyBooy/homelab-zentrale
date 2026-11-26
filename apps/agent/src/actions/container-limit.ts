import os from 'node:os';
import type { ContainerLimitData, RpcParams } from '@hz/shared';
import { isProtectedContainer } from './protected.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * container.limit: `docker update --cpus <n>` over the Engine API
 * (POST /containers/{id}/update). The request body only ever contains NanoCpus;
 * memory, restart policy and everything else stay untouched. cpus null removes
 * the limit (NanoCpus 0, like --cpus 0).
 *
 * Refused with not_allowed: unknown containers, containers with the label
 * hz.role (core, agent) and the agent's own container. The value is capped at the
 * host's CPU count (Docker refuses more than that anyway).
 */

interface LimitInspect {
  Id?: unknown;
  Config?: { Labels?: Record<string, string> | null } | null;
}

/** The parts of dockerode container.limit uses (also what tests fake). */
export interface LimitDocker {
  getContainer(id: string): {
    inspect(): Promise<unknown>;
    update(opts: { NanoCpus: number }): Promise<unknown>;
  };
  info(): Promise<unknown>;
}

export interface LimitOptions {
  /** Hostname of the agent's container (own-container check); default os.hostname(). */
  hostname?: string;
  /** Fallback CPU count when Docker info has no NCPU; default os.availableParallelism(). */
  fallbackCpus?: number;
}

const refuse = (msg: string) => new ActionError('not_allowed', msg);

/** CPU count of the host: Docker info NCPU, else what Node sees. Always >= 1. */
export async function hostCpuCount(docker: LimitDocker, fallback?: number): Promise<number> {
  try {
    const info = (await docker.info()) as { NCPU?: unknown } | null;
    const n = info?.NCPU;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1) return n;
  } catch {
    // fall through
  }
  const f = fallback ?? os.availableParallelism();
  return Number.isInteger(f) && f >= 1 ? f : 1;
}

export async function limitContainer(
  docker: LimitDocker,
  params: RpcParams<'container.limit'>,
  opts: LimitOptions = {},
): Promise<ContainerLimitData> {
  let info: LimitInspect;
  try {
    info = (await docker.getContainer(params.id).inspect()) as LimitInspect;
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) throw refuse('unknown container');
    throw new ActionError('failed', 'container inspect failed');
  }
  const id = typeof info.Id === 'string' ? info.Id : '';
  if (!/^[0-9a-f]{12,64}$/.test(id)) throw refuse('unknown container');
  if (isProtectedContainer({ id, labels: info.Config?.Labels }, opts.hostname)) {
    throw refuse('the agent and the core are never throttled');
  }

  let applied: number | null = null;
  if (params.cpus !== null) {
    const max = await hostCpuCount(docker, opts.fallbackCpus);
    applied = Math.round(Math.min(params.cpus, max) * 100) / 100;
  }
  const nano = applied === null ? 0 : Math.round(applied * 1e9);
  try {
    // By the resolved id, not the name: the name cannot be swapped in between.
    await docker.getContainer(id).update({ NanoCpus: nano });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404) throw new ActionError('not_found', 'container not found');
    throw new ActionError('failed', 'docker refused the cpu limit');
  }
  return { cpus: applied };
}

export async function containerLimit(
  params: RpcParams<'container.limit'>,
  ctx: ActionContext,
): Promise<ContainerLimitData> {
  const docker = ctx.host.docker;
  if (!docker) throw new ActionError('failed', 'docker not available');
  return limitContainer(docker as unknown as LimitDocker, params);
}
