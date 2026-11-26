import type { FastifyInstance } from 'fastify';
import { discordRoutes } from './routes.js';
import { DiscordBotService, type DiscordBotDeps } from './service.js';

export { DiscordBotService, type DiscordBotDeps } from './service.js';

export interface DiscordBotHandle {
  service: DiscordBotService;
  /** Module switch (discordbot): connects the gateway when configured, else disconnects. */
  setEnabled(on: boolean): void;
  /** Resolves when running interaction handlers are done. */
  idle(): Promise<void>;
  /** Closes the gateway (preClose). */
  shutdown(): void;
}

/**
 * Creates the Discord bot service and registers its routes under /api. Call
 * after setupAuth (the global guard) and before app.ready(). The bot starts off;
 * the caller switches it with setEnabled(modules.enabled('discordbot')).
 */
export async function setupDiscordBot(
  app: FastifyInstance,
  deps: DiscordBotDeps,
): Promise<DiscordBotHandle> {
  const service = new DiscordBotService(deps);
  await app.register(discordRoutes, { prefix: '/api', db: deps.db, now: deps.now, bot: service });
  return {
    service,
    setEnabled: (on) => service.setEnabled(on),
    idle: () => service.idle(),
    shutdown: () => service.shutdown(),
  };
}
