import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { originAllowed } from '../auth/guard.js';
import type { AuthService } from '../auth/index.js';
import { SESSION_COOKIE } from '../auth/sessions.js';
import { sendError } from '../http/errors.js';
import type { LiveHub } from './hub.js';

export interface LiveRoutesOptions {
  auth: AuthService;
  live: LiveHub;
  baseUrl: string | undefined;
}

/**
 * WS /live for browsers. The upgrade only happens with a valid admin session
 * (401 otherwise) and a same-origin Origin header (403 otherwise), both checked
 * before the handshake. Revoked sessions are closed by LiveHub.checkSessions.
 */
export const liveRoutes: FastifyPluginAsync<LiveRoutesOptions> = async (app, o) => {
  const sessionOf = new WeakMap<FastifyRequest['raw'], string>();

  async function gate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> {
    const auth = o.auth.sessions.resolve(request.cookies[SESSION_COOKIE]);
    if (!auth) return sendError(reply, 401, 'unauthorized');
    if (!originAllowed(request, o.baseUrl)) return sendError(reply, 403, 'bad_origin');
    sessionOf.set(request.raw, auth.session.id);
    return undefined;
  }

  app.get('/live', { websocket: true, preValidation: gate }, (socket, request) => {
    const sessionId = sessionOf.get(request.raw);
    if (!sessionId) {
      socket.close(1008, 'no session');
      return;
    }
    o.live.handleSocket(socket, sessionId);
  });
};
