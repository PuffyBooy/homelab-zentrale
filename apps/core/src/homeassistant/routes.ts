import type { FastifyPluginAsync } from 'fastify';
import {
  haAvailableResponseSchema,
  haConfigSchema,
  haEntityParamsSchema,
  haItemResponseSchema,
  haPressRequestSchema,
  haSettingsRequestSchema,
  haSettingsSchema,
  haStateSchema,
  haToggleRequestSchema,
  okResponseSchema,
} from '@hz/shared';
import { hasStepUp, requireStepUp } from '../auth/index.js';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import type { HaService } from './service.js';

export interface HaRoutesOptions {
  db: Db;
  now: Clock;
  ha: HaService;
}

/**
 * /api/ha/* (SPEC 10). Admin session everywhere. Step-up: changing URL or token,
 * deleting the token and pressing a door opener. Only configured entities can be
 * controlled, and only through the fixed service map of their kind.
 */
export const haRoutes: FastifyPluginAsync<HaRoutesOptions> = async (app, o) => {
  const stepUp = requireStepUp(o.now);
  const ha = o.ha;
  const audit = (action: string, target: string | null, details?: Record<string, unknown>): void =>
    writeAudit(o.db, o.now(), { actor: 'admin', action, target, ...(details ? { details } : {}) });

  app.get('/ha/settings', async () => haSettingsSchema.parse(ha.settings()));

  app.put('/ha/settings', async (request) => {
    const body = haSettingsRequestSchema.parse(request.body);
    if (ha.needsStepUp(body) && !hasStepUp(request, o.now)) {
      throw new HttpError(403, 'step_up_required');
    }
    const r = await ha.updateSettings(body);
    audit('ha.settings', null, {
      urlChanged: r.urlChanged,
      tokenChanged: r.tokenChanged,
      ...(body.pricePerKwh !== undefined ? { pricePerKwh: body.pricePerKwh } : {}),
      ...(body.energyEntityId !== undefined ? { energyEntityId: body.energyEntityId } : {}),
      ...(body.powerEntityId !== undefined ? { powerEntityId: body.powerEntityId } : {}),
    });
    return haSettingsSchema.parse(r.settings);
  });

  app.delete('/ha/token', { preHandler: stepUp }, async () => {
    ha.clearToken();
    audit('ha.token_cleared', null);
    return okResponseSchema.parse({ ok: true });
  });

  app.get('/ha/available', async () =>
    haAvailableResponseSchema.parse({ entities: ha.available() }),
  );

  app.get('/ha/config', async () => haConfigSchema.parse(ha.config()));

  app.put('/ha/config', async (request) => {
    const body = haConfigSchema.parse(request.body);
    const saved = ha.setConfig(body);
    audit('ha.config', null, { rooms: saved.rooms.length, entities: saved.entities.length });
    return haConfigSchema.parse(saved);
  });

  app.get('/ha/state', async () => haStateSchema.parse(ha.state()));

  app.post('/ha/entities/:entityId/toggle', async (request) => {
    const { entityId } = haEntityParamsSchema.parse(request.params);
    const { on } = haToggleRequestSchema.parse(request.body);
    const r = await ha.toggle(entityId, on);
    audit('ha.toggle', entityId, { on, service: `${r.call.domain}.${r.call.service}` });
    return haItemResponseSchema.parse({ item: r.item });
  });

  // Door opener: step-up first (a stolen session must not open the door), then confirm.
  app.post('/ha/entities/:entityId/press', { preHandler: stepUp }, async (request) => {
    const { entityId } = haEntityParamsSchema.parse(request.params);
    haPressRequestSchema.parse(request.body);
    const r = await ha.press(entityId);
    audit('ha.press', entityId, { service: `${r.call.domain}.${r.call.service}` });
    return haItemResponseSchema.parse({ item: r.item });
  });
};
