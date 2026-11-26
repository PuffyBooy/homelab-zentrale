import type { FastifyPluginAsync } from 'fastify';
import {
  discordBindingRequestSchema,
  discordBotSettingsRequestSchema,
  discordBotStateSchema,
  shareParamsSchema,
} from '@hz/shared';
import { hasStepUp, requireStepUp } from '../auth/index.js';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import { WindowLimiter } from '../share/limits.js';
import type { DiscordBotService } from './service.js';

export interface DiscordRoutesOptions {
  db: Db;
  now: Clock;
  bot: DiscordBotService;
}

/** Binding changes per admin session and minute. */
export const DISCORD_BINDING_LIMIT = 30;

/**
 * /api/discord-bot (module discordbot). Admin session from the global guard.
 * Changing the settings (token, application, guild) needs step-up, and so does
 * binding a Discord user to a share link (it hands out control from outside
 * the hub); removing a binding (discordUserId null) does not.
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

  const bindingLimit = new WindowLimiter(DISCORD_BINDING_LIMIT, 60_000, o.now);

  app.put('/discord-bot/bindings/:id', async (request) => {
    // The guard guarantees a session here; key the budget by its public id.
    const wait = bindingLimit.hit(request.auth?.session.id ?? 'anonymous');
    if (wait !== null) throw new HttpError(429, 'rate_limited', wait);
    const { id } = shareParamsSchema.parse(request.params);
    const { discordUserId } = discordBindingRequestSchema.parse(request.body);
    if (discordUserId !== null && !hasStepUp(request, o.now)) {
      throw new HttpError(403, 'step_up_required');
    }
    o.bot.bind(id, discordUserId);
    audit('discordbot.binding', id, { discordUserId });
    return discordBotStateSchema.parse(o.bot.state());
  });
};
