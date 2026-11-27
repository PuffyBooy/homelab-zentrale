import type { FastifyPluginAsync } from 'fastify';
import {
  containerDetailsDataSchema,
  containerDetailsResponseSchema,
  containerIdParamsSchema,
  containerRemoveRequestSchema,
  dockerImageListResponseSchema,
  dockerImagesDataSchema,
  dockerNetworkListResponseSchema,
  dockerNetworksDataSchema,
  dockerServerParamsSchema,
  dockerVolumeListResponseSchema,
  dockerVolumesDataSchema,
  imagePullDataSchema,
  imagePullRequestSchema,
  imagePullResponseSchema,
  imageRemoveParamsSchema,
  networkRemoveParamsSchema,
  okResponseSchema,
  stackActionParamsSchema,
  stackActionRequestSchema,
  stackActionResponseSchema,
  stackOpDataSchema,
  volumeRemoveParamsSchema,
  volumeRemoveRequestSchema,
  type StackAction,
  type StackOp,
} from '@hz/shared';
import type { z } from 'zod';
import type { AgentHub } from '../agents/hub.js';
import { RpcError } from '../agents/hub.js';
import { requireStepUp } from '../auth/index.js';
import type { Clock } from '../clock.js';
import type { ContainerService } from '../containers/service.js';
import { INTENT_TTL_MS } from '../containers/status.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import type { ContainerRow } from '../db/schema.js';
import { HttpError } from '../http/errors.js';
import { rpcHttpError } from '../servers/routes.js';
import type { ServerService } from '../servers/service.js';
import { isProtected } from '../throttle/service.js';

/**
 * M23 Docker komplett (contract and rules: @hz/shared api/docker.ts). Admin
 * session for every route (global guard); step-up for container and volume
 * removal. The core checks protection (hz.role), game containers and the typed
 * name before anything reaches the agent; the agent checks again.
 */

export const INSPECT_TIMEOUT_MS = 30_000;
export const LIST_TIMEOUT_MS = 60_000;
export const REMOVE_TIMEOUT_MS = 60_000;
/** Pulling images can take a while on a Pi. */
export const PULL_TIMEOUT_MS = 15 * 60_000;
export const STACK_API_TIMEOUT_MS = 3 * 60_000;
export const STACK_UP_TIMEOUT_MS = 10 * 60_000;
export const STACK_DOWN_TIMEOUT_MS = 5 * 60_000;
/** After a restart/update returns, a short grace for the last state changes. */
const SETTLE_MS = 60_000;

/** Fixed texts for the UI (never agent output). */
export const DOCKER_TEXTS = {
  agentOutdated: 'Agent zu alt, bitte aktualisieren',
  gameContainer: 'Gameserver über die Gameserver-Seite löschen',
  gameStack: 'Gameserver über die Gameserver-Seite steuern',
  running: 'Container zuerst stoppen',
} as const;

/** Docker states in which `docker rm` (without force) refuses. */
const RUNNING_STATES = new Set(['running', 'restarting', 'paused', 'removing']);

/**
 * Agent errors of the M23 actions. An agent older than M23 does not know the
 * action (parseRpc: not_allowed "action not allowed"): 409 with a hint to
 * update it. busy (in use, running) 409, not_found 404, else rpcHttpError.
 */
export function dockerHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof RpcError) {
    if (err.code === 'not_allowed' && err.detail === 'action not allowed') {
      return new HttpError(409, 'conflict', undefined, DOCKER_TEXTS.agentOutdated);
    }
    if (err.code === 'busy') return new HttpError(409, 'busy');
    if (err.code === 'not_found') return new HttpError(404, 'not_found');
  }
  return rpcHttpError(err);
}

export interface DockerRoutesOptions {
  db: Db;
  now: Clock;
  containers: ContainerService;
  servers: ServerService;
  hub: AgentHub;
  /** The game a container belongs to (M10), else null. */
  gameIdOf?: (row: ContainerRow) => string | null;
}

export const dockerRoutes: FastifyPluginAsync<DockerRoutesOptions> = async (app, o) => {
  const stepUp = requireStepUp(o.now);
  const audit = (action: string, target: string, details: Record<string, unknown>): void =>
    writeAudit(o.db, o.now(), { actor: 'admin', action, target, details });

  const isGame = (row: ContainerRow): boolean =>
    row.gameLabel !== null || (o.gameIdOf?.(row) ?? null) !== null;

  function containerOf(params: unknown): ContainerRow {
    const { id } = containerIdParamsSchema.parse(params);
    const row = o.containers.row(id);
    if (!row) throw new HttpError(404, 'not_found');
    return row;
  }

  /** The server (404) with a connected agent (409). */
  function connectedServer(serverId: string) {
    const row = o.servers.row(serverId);
    if (!row) throw new HttpError(404, 'not_found');
    if (!o.hub.isConnected(row.id)) throw new HttpError(409, 'agent_offline');
    return row;
  }

  /** Runs an agent call, maps its errors and validates the answer (502 otherwise). */
  async function call<S extends z.ZodType>(
    fn: () => Promise<unknown>,
    schema: S,
  ): Promise<z.infer<S>> {
    let data: unknown;
    try {
      data = await fn();
    } catch (err) {
      throw dockerHttpError(err);
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new HttpError(502, 'agent_error');
    return parsed.data;
  }

  /** A change: audit before, `<action>_failed` with the error code after a failure. */
  async function change(
    action: string,
    target: string,
    details: Record<string, unknown>,
    fn: () => Promise<unknown>,
  ): Promise<unknown> {
    audit(action, target, details);
    try {
      return await fn();
    } catch (err) {
      const e = dockerHttpError(err);
      audit(`${action}_failed`, target, { ...details, error: e.code });
      throw e;
    }
  }

  // ---- containers --------------------------------------------------------------

  app.get('/containers/:id/details', async (request) => {
    const row = containerOf(request.params);
    if (!o.hub.isConnected(row.serverId)) throw new HttpError(409, 'agent_offline');
    const details = await call(
      () =>
        o.hub.call(
          row.serverId,
          'container.inspect',
          { id: row.dockerId },
          { timeoutMs: INSPECT_TIMEOUT_MS },
        ),
      containerDetailsDataSchema,
    );
    return containerDetailsResponseSchema.parse({ details });
  });

  app.post('/containers/:id/remove', { preHandler: stepUp }, async (request) => {
    const row = containerOf(request.params);
    const body = containerRemoveRequestSchema.parse(request.body ?? {});
    if (isProtected(row)) throw new HttpError(403, 'forbidden');
    if (isGame(row)) {
      throw new HttpError(409, 'conflict', undefined, DOCKER_TEXTS.gameContainer);
    }
    if (body.confirmName !== row.name) throw new HttpError(400, 'confirm_mismatch');
    if (RUNNING_STATES.has(row.state)) {
      throw new HttpError(409, 'conflict', undefined, DOCKER_TEXTS.running);
    }
    if (!o.hub.isConnected(row.serverId)) throw new HttpError(409, 'agent_offline');
    await change(
      'docker.container.remove',
      row.id,
      { serverId: row.serverId, name: row.name, removeVolumes: body.removeVolumes },
      () =>
        o.hub.call(
          row.serverId,
          'container.remove',
          { id: row.dockerId, removeVolumes: body.removeVolumes },
          { timeoutMs: REMOVE_TIMEOUT_MS },
        ),
    );
    o.containers.forget(row.id);
    return okResponseSchema.parse({ ok: true });
  });

  // ---- images ------------------------------------------------------------------

  app.get('/servers/:serverId/docker/images', async (request) => {
    const { serverId } = dockerServerParamsSchema.parse(request.params);
    const server = connectedServer(serverId);
    const data = await call(
      () => o.hub.call(server.id, 'docker.images', {}, { timeoutMs: LIST_TIMEOUT_MS }),
      dockerImagesDataSchema,
    );
    return dockerImageListResponseSchema.parse({ images: data.images });
  });

  app.post('/servers/:serverId/docker/images/pull', async (request) => {
    const { serverId } = dockerServerParamsSchema.parse(request.params);
    const { ref } = imagePullRequestSchema.parse(request.body ?? {});
    const server = connectedServer(serverId);
    const data = await change('docker.image.pull', server.id, { serverId: server.id, ref }, () =>
      call(
        () => o.hub.call(server.id, 'image.pull', { ref }, { timeoutMs: PULL_TIMEOUT_MS }),
        imagePullDataSchema,
      ),
    );
    const image = imagePullDataSchema.parse(data);
    return imagePullResponseSchema.parse({ image: { id: image.id, tags: image.tags } });
  });

  app.post('/servers/:serverId/docker/images/:imageId/remove', async (request) => {
    const { serverId, imageId } = imageRemoveParamsSchema.parse(request.params);
    const server = connectedServer(serverId);
    await change('docker.image.remove', server.id, { serverId: server.id, imageId }, () =>
      o.hub.call(
        server.id,
        'image.remove',
        { id: `sha256:${imageId}` },
        { timeoutMs: REMOVE_TIMEOUT_MS },
      ),
    );
    return okResponseSchema.parse({ ok: true });
  });

  // ---- volumes -----------------------------------------------------------------

  app.get('/servers/:serverId/docker/volumes', async (request) => {
    const { serverId } = dockerServerParamsSchema.parse(request.params);
    const server = connectedServer(serverId);
    const data = await call(
      () => o.hub.call(server.id, 'docker.volumes', {}, { timeoutMs: LIST_TIMEOUT_MS }),
      dockerVolumesDataSchema,
    );
    return dockerVolumeListResponseSchema.parse({ volumes: data.volumes });
  });

  app.post(
    '/servers/:serverId/docker/volumes/:name/remove',
    { preHandler: stepUp },
    async (request) => {
      const { serverId, name } = volumeRemoveParamsSchema.parse(request.params);
      const body = volumeRemoveRequestSchema.parse(request.body ?? {});
      if (!o.servers.row(serverId)) throw new HttpError(404, 'not_found');
      if (body.confirmName !== name) throw new HttpError(400, 'confirm_mismatch');
      const server = connectedServer(serverId);
      await change('docker.volume.remove', server.id, { serverId: server.id, name }, () =>
        o.hub.call(server.id, 'volume.remove', { name }, { timeoutMs: REMOVE_TIMEOUT_MS }),
      );
      return okResponseSchema.parse({ ok: true });
    },
  );

  // ---- networks ----------------------------------------------------------------

  app.get('/servers/:serverId/docker/networks', async (request) => {
    const { serverId } = dockerServerParamsSchema.parse(request.params);
    const server = connectedServer(serverId);
    const data = await call(
      () => o.hub.call(server.id, 'docker.networks', {}, { timeoutMs: LIST_TIMEOUT_MS }),
      dockerNetworksDataSchema,
    );
    return dockerNetworkListResponseSchema.parse({ networks: data.networks });
  });

  app.post('/servers/:serverId/docker/networks/:networkId/remove', async (request) => {
    const { serverId, networkId } = networkRemoveParamsSchema.parse(request.params);
    const server = connectedServer(serverId);
    await change('docker.network.remove', server.id, { serverId: server.id, networkId }, () =>
      o.hub.call(server.id, 'network.remove', { id: networkId }, { timeoutMs: REMOVE_TIMEOUT_MS }),
    );
    return okResponseSchema.parse({ ok: true });
  });

  // ---- compose stacks ----------------------------------------------------------

  app.post('/servers/:serverId/stacks/:project/:op', async (request) => {
    const { serverId, project, op } = stackActionParamsSchema.parse(request.params);
    const body = stackActionRequestSchema.parse(request.body ?? {});
    if (!o.servers.row(serverId)) throw new HttpError(404, 'not_found');
    const ids = o.containers.projectIds({ id: '', serverId, composeProject: project });
    const rows = ids
      .map((id) => o.containers.row(id))
      .filter((r): r is ContainerRow => r !== undefined);
    // Only projects the core knows (from the inventory); the core checks every member.
    if (rows.length === 0) throw new HttpError(404, 'not_found');
    if (rows.some(isProtected)) throw new HttpError(403, 'forbidden');
    if (rows.some(isGame)) throw new HttpError(409, 'conflict', undefined, DOCKER_TEXTS.gameStack);
    if (op === 'down' && body.confirmName !== project) {
      throw new HttpError(400, 'confirm_mismatch');
    }
    const server = connectedServer(serverId);
    const names = rows.map((r) => r.name).sort();

    // Mark the downtime as intended before the agent acts (no alert, no self-heal).
    const restarting = op === 'restart' || op === 'update';
    for (const r of rows) {
      if (op === 'stop' || op === 'down') o.containers.setIntent(r.id, 'stop');
      else if (restarting) o.containers.setIntent(r.id, 'restart', INTENT_TTL_MS);
      else o.containers.setIntent(r.id, null);
    }
    const stack = (stackOp: StackOp, timeoutMs: number) =>
      call(
        () => o.hub.call(server.id, 'stack.op', { project, op: stackOp }, { timeoutMs }),
        stackOpDataSchema,
      );
    try {
      await change(
        `docker.stack.${op}`,
        server.id,
        { serverId: server.id, project, containers: names },
        () => runStack(op, stack),
      );
    } catch (err) {
      if (op !== 'start') for (const r of rows) o.containers.setIntent(r.id, null);
      throw err;
    }
    if (restarting) for (const r of rows) o.containers.setIntent(r.id, 'restart', SETTLE_MS);
    const containers = o.containers.list(server.id).filter((c) => c.composeProject === project);
    return stackActionResponseSchema.parse({ ok: true, containers });
  });
};

async function runStack(
  op: StackAction,
  stack: (op: StackOp, timeoutMs: number) => Promise<unknown>,
): Promise<void> {
  switch (op) {
    case 'start':
    case 'stop':
    case 'restart':
      await stack(op, STACK_API_TIMEOUT_MS);
      return;
    case 'update':
      await stack('pull', PULL_TIMEOUT_MS);
      await stack('up', STACK_UP_TIMEOUT_MS);
      return;
    case 'down':
      await stack('down', STACK_DOWN_TIMEOUT_MS);
      return;
  }
}
