import type { FastifyPluginAsync } from 'fastify';
import {
  discordBindingRequestSchema,
  discordBotSettingsRequestSchema,
  discordBotStateSchema,
  shareParamsSchema,
} from '@hz/shared';
import { requireStepUp } from '../auth/index.js';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import type { DiscordBotService } from './service.js';

export interface DiscordRoutesOptions {
  db: Db;
  now: Clock;
  bot: DiscordBotService;
}

/**
 * /api/discord-bot (module discordbot). Admin session from the global guard.
 * Changing the settings (token, application, guild) needs step-up; binding a
 * friend's Discord user to a share link does not (the link's rights apply).
 * The token is write-only: responses only say tokenSet.
 */
export const discordRoutes: FastifyPluginAsync<DiscordRoutesOptions> = async (app, o) => {
  const stepUp = requireStepUp(o.now);
  const audit = (action: string, target: string | null, details: Record<string, unknown>): void =>
    writeAudit(o.db, o.now(), { actor: 'admin', action, target, details });

  app.get('/discord-bot', async () => discordBotStateSchema.parse(o.bot.state()));

  app.put('/discord-bot', { preHandler: stepUp }, async (request) => {
    const body = discordBotSettingsRequestSchema.parse(request.body);
    const r = await o.bot.updateSettings(body);
    audit('discordbot.settings', null, {
      applicationId: body.applicationId,
      guildId: body.guildId,
      tokenChanged: r.tokenChanged,
      tokenCleared: r.tokenCleared,
    });
    return discordBotStateSchema.parse(o.bot.state());
  });

  app.put('/discord-bot/bindings/:id', async (request) => {
    const { id } = shareParamsSchema.parse(request.params);
    const { discordUserId } = discordBindingRequestSchema.parse(request.body);
    o.bot.bind(id, discordUserId);
    audit('discordbot.binding', id, { discordUserId });
    return discordBotStateSchema.parse(o.bot.state());
  });
};
