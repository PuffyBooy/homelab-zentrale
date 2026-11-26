import type { FastifyPluginAsync } from 'fastify';
import {
  containerActionParamsSchema,
  containerActionResponseSchema,
  containerListQuerySchema,
  containerListResponseSchema,
  type ContainerAction,
} from '@hz/shared';
import type { AgentHub } from '../agents/hub.js';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import type { ContainerRow } from '../db/schema.js';
import { HttpError } from '../http/errors.js';
import { rpcHttpError } from '../servers/routes.js';
import type { ServerService } from '../servers/service.js';
import { managedComposeDir, type ContainerService } from './service.js';
import { INTENT_TTL_MS } from './status.js';

export interface ContainerRoutesOptions {
  db: Db;
  now: Clock;
  containers: ContainerService;
  servers: ServerService;
  hub: AgentHub;
}

const ACTION_TIMEOUT_MS = 60_000;
/** Pulling images can take a while on a Pi. */
const PULL_TIMEOUT_MS = 15 * 60_000;
const UP_TIMEOUT_MS = 10 * 60_000;
/** After a restart/update returns, a short grace for the last state changes. */
const SETTLE_MS = 60_000;

export type UpdatePlan = { kind: 'compose'; dir: string } | { kind: 'container'; dockerId: string };

/**
 * Image update: compose projects below /opt/homelab/ get `compose pull` +
 * `compose up` in their working dir; everything else (standalone containers,
 * compose dirs elsewhere or not normalized) gets `container.update`.
 */
export function updatePlan(row: Pick<ContainerRow, 'composeDir' | 'dockerId'>): UpdatePlan {
  const dir = managedComposeDir(row.composeDir);
  return dir === null ? { kind: 'container', dockerId: row.dockerId } : { kind: 'compose', dir };
}

export const containerRoutes: FastifyPluginAsync<ContainerRoutesOptions> = async (app, o) => {
  const audit = (action: string, target: string, details: Record<string, unknown>): void =>
    writeAudit(o.db, o.now(), { actor: 'admin', action, target, details });

  app.get('/containers', async (request) => {
    const { serverId } = containerListQuerySchema.parse(request.query ?? {});
    if (serverId !== undefined && !o.servers.row(serverId)) throw new HttpError(404, 'not_found');
    return containerListResponseSchema.parse({ containers: o.containers.list(serverId) });
  });

  app.post('/containers/:id/:action', async (request) => {
    const { id, action } = containerActionParamsSchema.parse(request.params);
    const row = o.containers.row(id);
    if (!row) throw new HttpError(404, 'not_found');
    if (!o.hub.isConnected(row.serverId)) throw new HttpError(409, 'agent_offline');

    const plan = action === 'update' ? updatePlan(row) : null;
    audit(`container.${action}`, row.id, {
      serverId: row.serverId,
      name: row.name,
      ...(plan ? { method: plan.kind } : {}),
    });

    // Mark the downtime as intended before the agent acts. A compose update recreates
    // every service of the project, so all of its containers get the intent.
    const affected = plan?.kind === 'compose' ? o.containers.projectIds(row) : [row.id];
    if (action === 'stop') o.containers.setIntent(row.id, 'stop');
    else if (action === 'restart' || action === 'update') {
      for (const id of affected) o.containers.setIntent(id, 'restart', INTENT_TTL_MS);
    } else o.containers.setIntent(row.id, null);

    try {
      await run(o.hub, row, action, plan);
    } catch (err) {
      if (action !== 'start') for (const id of affected) o.containers.setIntent(id, null);
      audit(`container.${action}_failed`, row.id, { serverId: row.serverId, name: row.name });
      throw rpcHttpError(err);
    }
    if (action === 'restart' || action === 'update') {
      for (const id of affected) o.containers.setIntent(id, 'restart', SETTLE_MS);
    }
    return containerActionResponseSchema.parse({
      ok: true,
      container: o.containers.summary(row.id),
    });
  });
};

async function run(
  hub: AgentHub,
  row: ContainerRow,
  action: ContainerAction,
  plan: UpdatePlan | null,
): Promise<void> {
  const ref = { id: row.dockerId };
  switch (action) {
    case 'start':
      await hub.call(row.serverId, 'container.start', ref, { timeoutMs: ACTION_TIMEOUT_MS });
      return;
    case 'stop':
      await hub.call(row.serverId, 'container.stop', ref, { timeoutMs: ACTION_TIMEOUT_MS });
      return;
    case 'restart':
      await hub.call(row.serverId, 'container.restart', ref, { timeoutMs: ACTION_TIMEOUT_MS });
      return;
    case 'update':
      if (plan?.kind === 'compose') {
        await hub.call(
          row.serverId,
          'compose.pull',
          { dir: plan.dir },
          { timeoutMs: PULL_TIMEOUT_MS },
        );
        await hub.call(row.serverId, 'compose.up', { dir: plan.dir }, { timeoutMs: UP_TIMEOUT_MS });
      } else {
        await hub.call(row.serverId, 'container.update', ref, { timeoutMs: PULL_TIMEOUT_MS });
      }
      return;
  }
}
