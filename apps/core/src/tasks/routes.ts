import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  taskCommandResponseSchema,
  taskCreateRequestSchema,
  taskIdParamsSchema,
  taskRunSchema,
  taskRunsResponseSchema,
  taskSchema,
  tasksResponseSchema,
  taskUpdateRequestSchema,
} from '@hz/shared';
import { hasStepUp } from '../auth/guard.js';
import { writeAudit } from '../db/audit.js';
import type { ScheduledTaskRow } from '../db/schema.js';
import type { FeatureContext } from '../features.js';
import { HttpError } from '../http/errors.js';
import type { TaskService } from './service.js';

/**
 * Routes of api/tasks.ts. Every response is read back from the database
 * (never echoed from the request body); the command text only leaves the core
 * through GET .../command with step-up.
 */
export function taskRoutes(ctx: FeatureContext, svc: TaskService): FastifyPluginAsync {
  return async (app) => {
    const needStepUp = (request: FastifyRequest): void => {
      if (!hasStepUp(request, ctx.now)) throw new HttpError(403, 'step_up_required');
    };
    const taskOf = (request: FastifyRequest): ScheduledTaskRow => {
      const { id } = taskIdParamsSchema.parse(request.params);
      const row = svc.row(id);
      if (!row) throw new HttpError(404, 'not_found');
      return row;
    };
    const read = (id: string) => {
      const task = svc.get(id);
      if (!task) throw new HttpError(404, 'not_found');
      return taskSchema.parse(task);
    };

    app.get('/tasks', async () =>
      tasksResponseSchema.parse({ tasks: svc.list(), commandServers: svc.commandServers() }),
    );

    app.post('/tasks', async (request, reply: FastifyReply) => {
      const req = taskCreateRequestSchema.parse(request.body);
      if (req.action.kind === 'command') needStepUp(request);
      if (!ctx.servers.row(req.serverId)) throw new HttpError(404, 'not_found');
      svc.checkLimits(req.serverId);
      svc.checkAction(req.serverId, req.action);
      const id = svc.create(req);
      return reply.code(201).send(read(id));
    });

    app.put('/tasks/:id', async (request) => {
      const patch = taskUpdateRequestSchema.parse(request.body);
      const row = taskOf(request);
      // Editing a command task, or turning a task into one, needs step-up.
      if (row.kind === 'command' || patch.action?.kind === 'command') needStepUp(request);
      if (patch.action !== undefined) svc.checkAction(row.serverId, patch.action);
      svc.update(row, patch);
      return read(row.id);
    });

    app.delete('/tasks/:id', async (request, reply) => {
      const row = taskOf(request);
      svc.remove(row);
      return reply.code(204).send();
    });

    app.post('/tasks/:id/run', async (request, reply) => {
      const row = taskOf(request);
      if (row.kind === 'command') needStepUp(request);
      const run = svc.startRun(row, 'manual');
      return reply.code(202).send(taskRunSchema.parse(run));
    });

    app.get('/tasks/:id/runs', async (request) => {
      const row = taskOf(request);
      return taskRunsResponseSchema.parse({ runs: svc.runs(row.id) });
    });

    app.get('/tasks/:id/command', async (request) => {
      needStepUp(request);
      const row = taskOf(request);
      const command = svc.command(row.id);
      if (command === null) throw new HttpError(404, 'not_found');
      writeAudit(ctx.db, ctx.now(), {
        actor: 'admin',
        action: 'task.command_read',
        target: row.id,
        details: { serverId: row.serverId, name: row.name },
      });
      return taskCommandResponseSchema.parse({ command });
    });
  };
}
