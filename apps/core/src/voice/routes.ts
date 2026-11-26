import type { FastifyPluginAsync } from 'fastify';
import { voiceGameParamsSchema, voiceGameRequestSchema, voiceStateSchema } from '@hz/shared';
import { hasStepUp } from '../auth/index.js';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import type { VoiceService } from './service.js';

export interface VoiceRoutesOptions {
  db: Db;
  now: Clock;
  voice: VoiceService;
}

/**
 * /api/voice (module voice). Admin session from the global guard. Step-up when
 * a game gets a new switch entity or allowStop is turned on (control from
 * outside the hub, through Home Assistant and Alexa).
 */
export const voiceRoutes: FastifyPluginAsync<VoiceRoutesOptions> = async (app, o) => {
  app.get('/voice', async () => voiceStateSchema.parse(o.voice.state()));

  app.put('/voice/games/:id', async (request) => {
    const { id } = voiceGameParamsSchema.parse(request.params);
    const body = voiceGameRequestSchema.parse(request.body);
    if (o.voice.needsStepUp(id, body) && !hasStepUp(request, o.now)) {
      throw new HttpError(403, 'step_up_required');
    }
    o.voice.update(id, body);
    writeAudit(o.db, o.now(), {
      actor: 'admin',
      action: 'voice.game',
      target: id,
      details: {
        switchEntity: body.switchEntity,
        statusEntity: body.statusEntity,
        allowStop: body.allowStop,
      },
    });
    return voiceStateSchema.parse(o.voice.state());
  });
};
