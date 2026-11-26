import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  appInstallRequestSchema,
  appPreviewResponseSchema,
  appRemoveRequestSchema,
  appSecretsResponseSchema,
  appsResponseSchema,
  appTemplateCustomRequestSchema,
  appTemplateDetailSchema,
  appTemplateIdParamsSchema,
  appTemplatesResponseSchema,
  installedAppIdParamsSchema,
  installedAppSchema,
} from '@hz/shared';
import { requireStepUp } from '../auth/index.js';
import type { Clock } from '../clock.js';
import type { AppAction, AppService } from './service.js';

const actionParamsSchema = installedAppIdParamsSchema.extend({
  action: z.enum(['start', 'stop', 'restart', 'update']),
});

/**
 * /api/apps/* (packages/shared/src/api/apps.ts). Admin session everywhere (auth
 * guard before the feature routes; module gate 404 when `apps` is off).
 * Reading passwords and removing an app need step-up. Every response is built
 * from the database or the loaded templates and parsed with its strict schema;
 * request bodies are never echoed.
 */
export function appRoutes(svc: AppService, now: Clock): FastifyPluginAsync {
  return async (app) => {
    const stepUp = requireStepUp(now);

    app.get('/apps/templates', async () =>
      appTemplatesResponseSchema.parse({ templates: svc.templateList() }),
    );

    app.get('/apps/templates/:id', async (request) => {
      const { id } = appTemplateIdParamsSchema.parse(request.params);
      return appTemplateDetailSchema.parse(svc.templateDetail(id));
    });

    app.post('/apps/templates', async (request, reply) => {
      const body = appTemplateCustomRequestSchema.parse(request.body);
      const detail = svc.createCustom(body.meta, body.compose);
      return reply.code(201).send(appTemplateDetailSchema.parse(detail));
    });

    app.put('/apps/templates/:id', async (request) => {
      const { id } = appTemplateIdParamsSchema.parse(request.params);
      const body = appTemplateCustomRequestSchema.parse(request.body);
      return appTemplateDetailSchema.parse(svc.updateCustom(id, body.meta, body.compose));
    });

    app.delete('/apps/templates/:id', async (request, reply) => {
      const { id } = appTemplateIdParamsSchema.parse(request.params);
      svc.deleteCustom(id);
      return reply.code(204).send();
    });

    app.post('/apps/templates/:id/preview', async (request) => {
      const { id } = appTemplateIdParamsSchema.parse(request.params);
      const body = appInstallRequestSchema.parse(request.body);
      return appPreviewResponseSchema.parse(svc.preview(id, body));
    });

    app.get('/apps', async () => appsResponseSchema.parse({ apps: svc.list() }));

    app.post('/apps', async (request, reply) => {
      const body = appInstallRequestSchema.parse(request.body);
      const installed = svc.install(body);
      return reply.code(202).send(installedAppSchema.parse(installed));
    });

    app.post('/apps/:id/:action', async (request, reply) => {
      const { id, action } = actionParamsSchema.parse(request.params);
      const res = svc.action(id, action satisfies AppAction);
      return reply.code(202).send(installedAppSchema.parse(res));
    });

    app.get('/apps/:id/secrets', { preHandler: stepUp }, async (request) => {
      const { id } = installedAppIdParamsSchema.parse(request.params);
      return appSecretsResponseSchema.parse({ values: svc.secrets(id) });
    });

    app.delete('/apps/:id', { preHandler: stepUp }, async (request, reply) => {
      const { id } = installedAppIdParamsSchema.parse(request.params);
      const body = appRemoveRequestSchema.parse(request.body ?? {});
      svc.remove(id, body.confirmName, body.deleteData);
      return reply.code(202).send({ ok: true });
    });
  };
}
