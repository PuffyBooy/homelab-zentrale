import type { LightMyRequestResponse } from 'fastify';
import { shareCreateResponseSchema } from '@hz/shared';
import { stepUp } from './agent-helpers.js';
import { gameRequest, type GameSetup } from './games-helpers.js';
import { HOST } from './helpers.js';

export interface CreatedShare {
  id: string;
  token: string;
  urls: { tailnet: string; public: string | null };
}

/** Creates a link through the admin API and returns the plain token from the URL. */
export async function createShare(
  s: GameSetup,
  gameId: string,
  body: Record<string, unknown> = {},
): Promise<CreatedShare> {
  const res = await gameRequest(s, 'POST', `/api/games/${gameId}/shares`, {
    person: 'Max',
    perms: ['power'],
    expires: '7d',
    ...body,
  });
  if (res.statusCode !== 201) throw new Error(`create share ${res.statusCode} ${res.body}`);
  const parsed = shareCreateResponseSchema.parse(res.json());
  const token = parsed.urls.tailnet.split('/s/')[1] ?? '';
  return { id: parsed.share.id, token, urls: parsed.urls };
}

let ipSeq = 0;
/** A fresh client IP, so the per-IP limit does not interfere with other checks. */
export const nextIp = (): string => {
  ipSeq += 1;
  return `10.77.${(ipSeq >> 8) & 255}.${ipSeq & 255}`;
};

export interface FriendOpts {
  token?: string;
  pin?: string;
  ip?: string;
  payload?: Record<string, unknown>;
  origin?: string | null;
  /** Raw Authorization header (overrides `token`). */
  authorization?: string;
}

/** A friend's request to the tailnet share API `/s/api/<path>`. */
export function friend(
  s: GameSetup,
  method: 'GET' | 'POST',
  path: string,
  o: FriendOpts = {},
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = {
    host: HOST,
    'x-forwarded-for': o.ip ?? nextIp(),
  };
  if (o.authorization !== undefined) headers.authorization = o.authorization;
  else if (o.token !== undefined) headers.authorization = `Share ${o.token}`;
  if (o.pin !== undefined) headers['x-share-pin'] = o.pin;
  if (method === 'POST' && o.origin !== null) headers.origin = o.origin ?? `https://${HOST}`;
  return s.t.app.inject({
    method,
    url: `/s/api/${path}`,
    headers,
    ...(method === 'POST' ? { payload: o.payload ?? {} } : {}),
  });
}

export interface GatewayOpts {
  gatewayToken?: string | null;
  token?: string;
  pin?: string;
  clientIp?: string | null;
  payload?: Record<string, unknown>;
}

/** The gateway's request to `/api/share-gateway/<path>` (server to server, no Origin). */
export function gateway(
  s: GameSetup,
  method: 'GET' | 'POST',
  path: string,
  o: GatewayOpts = {},
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { host: HOST };
  if (o.gatewayToken) headers.authorization = `Bearer ${o.gatewayToken}`;
  if (o.token !== undefined) headers['x-share-token'] = o.token;
  if (o.pin !== undefined) headers['x-share-pin'] = o.pin;
  if (o.clientIp !== null) headers['x-share-client-ip'] = o.clientIp ?? nextIp();
  return s.t.app.inject({
    method,
    url: `/api/share-gateway/${path}`,
    headers,
    ...(method === 'POST' ? { payload: o.payload ?? {} } : {}),
  });
}

/** Turns the gateway on (step-up) and returns a fresh gateway token. */
export async function enableGateway(
  s: GameSetup,
  publicUrl = 'https://spiel.example.org',
): Promise<string> {
  await stepUp(s.t, s.secret, s.cookie);
  const put = await gameRequest(s, 'PUT', '/api/settings/share-gateway', {
    enabled: true,
    publicUrl,
  });
  if (put.statusCode !== 200) throw new Error(`gateway settings ${put.statusCode} ${put.body}`);
  const tok = await gameRequest(s, 'POST', '/api/settings/share-gateway/token');
  if (tok.statusCode !== 200) throw new Error(`gateway token ${tok.statusCode}`);
  return tok.json<{ token: string }>().token;
}

/** Every key path of a JSON value (`game.players.names[]`). */
export function keyPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => keyPaths(v, `${prefix}[]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => {
      const p = prefix ? `${prefix}.${k}` : k;
      return [p, ...keyPaths(v, p)];
    });
  }
  return [];
}
