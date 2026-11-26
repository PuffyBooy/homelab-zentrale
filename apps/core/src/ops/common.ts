import { asc } from 'drizzle-orm';
import { RpcError } from '../agents/hub.js';
import type { Db } from '../db/index.js';
import { servers } from '../db/schema.js';

/** Per-server outcome of an ops RPC that did not return data. */
export type OpsRpcState = 'offline' | 'unsupported' | 'failed';

/**
 * Agent too old for the action (not_allowed) -> unsupported; not connected ->
 * offline; anything else (timeout, failed, invalid data) -> failed.
 */
export function rpcState(err: unknown): OpsRpcState {
  if (!(err instanceof RpcError)) return 'failed';
  switch (err.code) {
    case 'not_allowed':
      return 'unsupported';
    case 'offline':
    case 'disconnected':
      return 'offline';
    default:
      return 'failed';
  }
}

export interface ServerRef {
  id: string;
  name: string;
}

/** All servers, sorted by name. */
export function serverRefs(db: Db): ServerRef[] {
  return db
    .select({ id: servers.id, name: servers.name })
    .from(servers)
    .orderBy(asc(servers.name))
    .all();
}

/** One line, no control characters, at most `max` chars (agent text going into alerts). */
export function plainText(v: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
