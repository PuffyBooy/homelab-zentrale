import type { FastifyPluginAsync } from 'fastify';
import {
  certificateCreateSchema,
  certificateSchema,
  certificateUpdateSchema,
  dnsProviderCreateSchema,
  dnsProviderSchema,
  dnsProviderTestResponseSchema,
  dnsProviderUpdateSchema,
  dnsRecordCreateSchema,
  dnsRecordSchema,
  dnsRecordUpdateSchema,
  domainIdParamsSchema,
  domainSettingsSchema,
  domainsResponseSchema,
} from '@hz/shared';
import { hasStepUp, requireStepUp } from '../auth/index.js';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import type { DomainService } from './service.js';

export interface DomainsRoutesOptions {
  db: Db;
  now: Clock;
  domains: DomainService;
}

/**
 * /api/domains/* (packages/shared/src/api/domains.ts). Admin session everywhere,
 * module gate `domains` in modules/service.ts. Step-up: providers (create,
 * change, delete), certificates (create, delete, new deploy targets) and adopting
 * a foreign record.
 * Answers are always read back from the database, never from the request.
 */
export const domainsRoutes: FastifyPluginAsync<DomainsRoutesOptions> = async (app, o) => {
  const stepUp = requireStepUp(o.now);
  const d = o.domains;
  const audit = (action: string, target: string | null, details?: Record<string, unknown>): void =>
    writeAudit(o.db, o.now(), { actor: 'admin', action, target, ...(details ? { details } : {}) });

  app.get('/domains', async () => domainsResponseSchema.parse(d.list()));

  app.put('/domains/settings', async (request) => {
    const body = domainSettingsSchema.parse(request.body);
    const s = d.setSettings(body);
    audit('domains.settings', null, { acmeEmailSet: s.acmeEmail !== null });
    return domainSettingsSchema.parse(s);
  });

  // ---- providers ----

  app.post('/domains/providers', { preHandler: stepUp }, async (request, reply) => {
    const body = dnsProviderCreateSchema.parse(request.body);
    const p = await d.createProvider(body);
    audit('domains.provider_created', p.id, { kind: p.kind });
    return reply.code(201).send(dnsProviderSchema.parse(p));
  });

  app.put('/domains/providers/:id', { preHandler: stepUp }, async (request) => {
    const { id } = domainIdParamsSchema.parse(request.params);
    const body = dnsProviderUpdateSchema.parse(request.body);
    const r = await d.updateProvider(id, body);
    audit('domains.provider_updated', id, { tokenChanged: r.tokenChanged });
    return dnsProviderSchema.parse(r.provider);
  });

  app.delete('/domains/providers/:id', { preHandler: stepUp }, async (request, reply) => {
    const { id } = domainIdParamsSchema.parse(request.params);
    d.deleteProvider(id);
    audit('domains.provider_deleted', id);
    return reply.code(204).send();
  });

  app.post('/domains/providers/:id/test', async (request) => {
    const { id } = domainIdParamsSchema.parse(request.params);
    return dnsProviderTestResponseSchema.parse(await d.testProvider(id));
  });

  // ---- records ----

  app.post('/domains/records', async (request, reply) => {
    const body = dnsRecordCreateSchema.parse(request.body);
    if (body.adopt && !hasStepUp(request, o.now)) throw new HttpError(403, 'step_up_required');
    const r = await d.createRecord(body);
    audit('domains.record_created', r.id, { name: r.name, type: r.type, adopt: body.adopt });
    return reply.code(201).send(dnsRecordSchema.parse(r));
  });

  app.put('/domains/records/:id', async (request) => {
    const { id } = domainIdParamsSchema.parse(request.params);
    const body = dnsRecordUpdateSchema.parse(request.body);
    const r = await d.updateRecord(id, body);
    audit('domains.record_updated', id, { name: r.name, type: r.type });
    return dnsRecordSchema.parse(r);
  });

  app.delete('/domains/records/:id', async (request, reply) => {
    const { id } = domainIdParamsSchema.parse(request.params);
    await d.deleteRecord(id);
    audit('domains.record_deleted', id);
    return reply.code(204).send();
  });

  app.post('/domains/records/:id/sync', async (request) => {
    const { id } = domainIdParamsSchema.parse(request.params);
    return dnsRecordSchema.parse(await d.manualSync(id));
  });

  // ---- certificates ----

  app.post('/domains/certificates', { preHandler: stepUp }, async (request, reply) => {
    const body = certificateCreateSchema.parse(request.body);
    const c = d.createCertificate(body);
    audit('domains.certificate_created', c.id, { names: c.names, ca: c.ca });
    return reply.code(201).send(certificateSchema.parse(c));
  });

  app.put('/domains/certificates/:id', async (request) => {
    const { id } = domainIdParamsSchema.parse(request.params);
    const body = certificateUpdateSchema.parse(request.body);
    // New deploy targets receive the private key: step-up. Removing targets or
    // switching autoRenew does not need it.
    if (body.deploy && d.addsDeployTargets(id, body.deploy) && !hasStepUp(request, o.now))
      throw new HttpError(403, 'step_up_required');
    const c = d.updateCertificate(id, body);
    audit('domains.certificate_updated', id, { autoRenew: c.autoRenew, deploy: c.deploy.length });
    return certificateSchema.parse(c);
  });

  app.post('/domains/certificates/:id/renew', async (request, reply) => {
    const { id } = domainIdParamsSchema.parse(request.params);
    const c = d.renewCertificate(id);
    audit('domains.certificate_renew', id);
    return reply.code(202).send(certificateSchema.parse(c));
  });

  app.delete('/domains/certificates/:id', { preHandler: stepUp }, async (request, reply) => {
    const { id } = domainIdParamsSchema.parse(request.params);
    await d.deleteCertificate(id);
    audit('domains.certificate_deleted', id);
    return reply.code(204).send();
  });
};
