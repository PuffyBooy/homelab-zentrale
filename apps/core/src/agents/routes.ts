import type { FastifyPluginAsync } from 'fastify';
import type { AgentHub } from './hub.js';

export interface AgentRoutesOptions {
  hub: AgentHub;
}

/**
 * WS /agent. No session and no Origin check (agents are not browsers): the
 * agent authenticates with its token in the first message (`hello`). Frame
 * size is limited by the websocket plugin (maxPayload = MAX_MESSAGE_BYTES).
 */
export const agentRoutes: FastifyPluginAsync<AgentRoutesOptions> = async (app, o) => {
  app.get('/agent', { websocket: true }, (socket, request) => {
    o.hub.handleSocket(socket, request.ip);
  });
};
