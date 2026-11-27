import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  consoleQuerySchema,
  consoleSessionListQuerySchema,
  consoleSessionListResponseSchema,
} from '@hz/shared';
import { originAllowed } from '../auth/guard.js';
import type { AuthService } from '../auth/index.js';
import { SESSION_COOKIE } from '../auth/sessions.js';
import { sendError } from '../http/errors.js';
import type { ConsoleService } from './service.js';

export interface ConsoleRoutesOptions {
  auth: AuthService;
  consoles: ConsoleService;
  baseUrl: string | undefined;
}

interface Pending {
  authSessionId: string;
  serverId: string;
  /** M23: core container id for a shell inside that container. */
  container?: string;
}

/**
 * WS /console?serverId=<id>[&container=<core container id>] for the web terminal. Like /live, the upgrade needs a
 * valid admin session (401) and a same-origin Origin (403), both checked before the
 * handshake, plus a valid query (400). Step-up, allowTerminal, agent and limits are
 * checked by ConsoleService on the socket (`closed` with the reason), so the page
 * can tell the admin why.
 *
 * A plain GET /console (reload of the console page) is the web app, not the socket.
 */
export const consoleSocketRoutes: FastifyPluginAsync<ConsoleRoutesOptions> = async (app, o) => {
  const pending = new WeakMap<FastifyRequest['raw'], Pending>();

  async function gate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> {
    if (!request.ws) return undefined;
    const auth = o.auth.sessions.resolve(request.cookies[SESSION_COOKIE]);
    if (!auth) return sendError(reply, 401, 'unauthorized');
    if (!originAllowed(request, o.baseUrl)) return sendError(reply, 403, 'bad_origin');
    const q = consoleQuerySchema.safeParse(request.query ?? {});
    if (!q.success) return sendError(reply, 400, 'invalid_input');
    pending.set(request.raw, {
      authSessionId: auth.session.id,
      serverId: q.data.serverId,
      ...(q.data.container !== undefined ? { container: q.data.container } : {}),
    });
    return undefined;
  }

  app.route({
    method: 'GET',
    url: '/console',
    preValidation: gate,
    handler: (_request, reply) => reply.callNotFound(),
    wsHandler: (socket, request) => {
      const p = pending.get(request.raw);
      if (!p) {
        socket.close(1008, 'no session');
        return;
      }
      o.consoles.handleSocket(socket, { ...p, ip: request.ip });
    },
  });
};

/** GET /api/console/sessions (admin session via the global guard). */
export const consoleApiRoutes: FastifyPluginAsync<{ consoles: ConsoleService }> = async (
  app,
  o,
) => {
  app.get('/console/sessions', async (request) => {
    const q = consoleSessionListQuerySchema.parse(request.query ?? {});
    return consoleSessionListResponseSchema.parse({ sessions: o.consoles.list(q) });
  });
};
