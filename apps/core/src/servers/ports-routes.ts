import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  allowedPortsUpdateRequestSchema,
  portAllowRequestSchema,
  portAuditResponseSchema,
  serverIdParamsSchema,
} from '@hz/shared';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import type { PortAuditService } from './ports.js';
import type { ServerService } from './service.js';

export interface PortRoutesOptions {
  db: Db;
  now: Clock;
  servers: ServerService;
  ports: PortAuditService;
}

/** Port audit (admin session, no step-up). Prefix /api. */
export const portRoutes: FastifyPluginAsync<PortRoutesOptions> = async (app, o) => {
  function serverOf(request: FastifyRequest) {
    const { id } = serverIdParamsSchema.parse(request.params);
    const row = o.servers.row(id);
    if (!row) throw new HttpError(404, 'not_found');
    return row;
  }

  app.get('/servers/:id/ports/allowed', async (request) => {
    const row = serverOf(request);
    return portAuditResponseSchema.parse(o.ports.get(row.id));
  });

  app.put('/servers/:id/ports/allowed', async (request) => {
    const row = serverOf(request);
    const body = allowedPortsUpdateRequestSchema.parse(request.body);
    const res = o.ports.replace(row.id, body.ports);
    writeAudit(o.db, o.now(), {
      actor: 'admin',
      action: 'ports.update',
      target: row.id,
      details: { name: row.name, ports: body.ports.map((p) => `${p.proto}/${p.port}`) },
    });
    return portAuditResponseSchema.parse(res);
  });

  app.post('/servers/:id/ports/allow', async (request) => {
    const row = serverOf(request);
    const body = portAllowRequestSchema.parse(request.body);
    const res = o.ports.allow(row.id, body);
    if (res === 'full') throw new HttpError(409, 'conflict');
    writeAudit(o.db, o.now(), {
      actor: 'admin',
      action: 'ports.allow',
      target: row.id,
      details: { name: row.name, port: body.port, proto: body.proto },
    });
    return portAuditResponseSchema.parse(res);
  });
};
