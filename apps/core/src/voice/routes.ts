import type { FastifyPluginAsync } from 'fastify';
import { voiceGameParamsSchema, voiceGameRequestSchema, voiceStateSchema } from '@hz/shared';
import { hasStepUp } from '../auth/index.js';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import { WindowLimiter } from '../share/limits.js';
import type { VoiceService } from './service.js';

export interface VoiceRoutesOptions {
  db: Db;
  now: Clock;
  voice: VoiceService;
}

/** Voice game changes per admin session and minute. */
export const VOICE_UPDATE_LIMIT = 30;

/**
 * /api/voice (module voice). Admin session from the global guard. Step-up when
 * a game gets a new switch or status entity or allowStop is turned on (control
 * from outside the hub, through Home Assistant and Alexa).
 */
export const voiceRoutes: FastifyPluginAsync<VoiceRoutesOptions> = async (app, o) => {
  app.get('/voice', async () => voiceStateSchema.parse(o.voice.state()));

  const updateLimit = new WindowLimiter(VOICE_UPDATE_LIMIT, 60_000, o.now);

  app.put('/voice/games/:id', async (request) => {
    // The guard guarantees a session here; key the budget by its public id.
    const wait = updateLimit.hit(request.auth?.session.id ?? 'anonymous');
    if (wait !== null) throw new HttpError(429, 'rate_limited', wait);
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
