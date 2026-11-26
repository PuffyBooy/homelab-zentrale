import type { FastifyInstance } from 'fastify';
import { voiceRoutes } from './routes.js';
import { VoiceService, type VoiceDeps } from './service.js';

export { VoiceService, type VoiceDeps } from './service.js';

export interface VoiceHandle {
  service: VoiceService;
  /** Module switch (voice). Off: nothing happens in HA (nothing is cleared either). */
  setEnabled(on: boolean): void;
  /** Resolves when running triggers and mirror writes are done. */
  idle(): Promise<void>;
  /** Detaches from Home Assistant and the game service (preClose). */
  shutdown(): void;
}

/**
 * Creates the voice service (Echo Show / Alexa via Home Assistant helpers) and
 * registers its routes under /api. Call after setupAuth and before app.ready().
 * Starts off; switch it with setEnabled(modules.enabled('voice')).
 */
export async function setupVoice(app: FastifyInstance, deps: VoiceDeps): Promise<VoiceHandle> {
  const service = new VoiceService(deps);
  await app.register(voiceRoutes, { prefix: '/api', db: deps.db, now: deps.now, voice: service });
  return {
    service,
    setEnabled: (on) => service.setEnabled(on),
    idle: () => service.idle(),
    shutdown: () => service.shutdown(),
  };
}
