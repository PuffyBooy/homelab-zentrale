import {
  logsSearchDataSchema,
  type LogSearchHit,
  type LogSearchRequest,
  type LogSearchResponse,
} from '@hz/shared';
import type { AgentHub } from '../agents/hub.js';
import type { Clock } from '../clock.js';
import type { ContainerService } from '../containers/service.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import { rpcState, serverRefs, type ServerRef } from './common.js';

/** One logs.search per server; reading 20 000 lines of many containers takes a while. */
export const LOG_SEARCH_TIMEOUT_MS = 30_000;
/** The agent accepts at most this many container refs per call. */
const MAX_CONTAINERS = 200;

type ServerResult = LogSearchResponse['servers'][number];

/** Newest first; lines without a timestamp last (stable otherwise). */
export function compareHits(a: LogSearchHit, b: LogSearchHit): number {
  if (a.ts === b.ts) return 0;
  if (a.ts === null) return 1;
  if (b.ts === null) return -1;
  return Date.parse(b.ts) - Date.parse(a.ts);
}

/**
 * Searches container logs on all (or the selected) servers at once. The query
 * is plain text; it is passed to the agents and never written to a log.
 */
export class LogSearchService {
  constructor(
    private readonly deps: {
      db: Db;
      now: Clock;
      hub: AgentHub;
      containers: ContainerService;
      timeoutMs?: number;
    },
  ) {}

  async search(req: LogSearchRequest): Promise<LogSearchResponse> {
    const started = this.deps.now();
    const all = serverRefs(this.deps.db);
    let selected: ServerRef[];
    if (req.serverIds !== undefined && req.serverIds.length > 0) {
      const wanted = new Set(req.serverIds);
      selected = all.filter((s) => wanted.has(s.id));
      if (selected.length !== wanted.size) throw new HttpError(404, 'not_found');
    } else {
      selected = all.filter((s) => this.deps.hub.isConnected(s.id));
    }

    const perServer = await Promise.all(selected.map((s) => this.searchServer(s, req)));
    const hits = perServer.flatMap((r) => r.hits).sort(compareHits);
    const kept = hits.slice(0, req.maxMatches);
    // Servers whose hits fell off the global cap are truncated too.
    const cut = new Set(hits.slice(req.maxMatches).map((h) => h.serverId));
    const servers = perServer.map((r) =>
      cut.has(r.server.serverId) ? { ...r.server, truncated: true } : r.server,
    );
    return { hits: kept, servers, tookMs: Math.max(0, this.deps.now() - started) };
  }

  private async searchServer(
    s: ServerRef,
    req: LogSearchRequest,
  ): Promise<{ server: ServerResult; hits: LogSearchHit[] }> {
    const base = { serverId: s.id, name: s.name, scannedContainers: 0, truncated: false };
    if (!this.deps.hub.isConnected(s.id))
      return { server: { ...base, state: 'offline' }, hits: [] };
    const filter = req.container?.toLowerCase() ?? '';
    const list = this.deps.containers
      .list(s.id)
      .filter((c) => filter === '' || c.name.toLowerCase().includes(filter));
    if (list.length === 0) return { server: { ...base, state: 'no_containers' }, hits: [] };
    const refs = list.slice(0, MAX_CONTAINERS).map((c) => c.dockerId);
    try {
      const raw = await this.deps.hub.call(
        s.id,
        'logs.search',
        {
          query: req.query,
          caseSensitive: req.caseSensitive,
          sinceMinutes: req.sinceMinutes,
          // Without a name filter the agent searches all of its containers.
          ...(filter === '' ? {} : { containers: refs }),
          maxMatches: req.maxMatches,
        },
        { timeoutMs: this.deps.timeoutMs ?? LOG_SEARCH_TIMEOUT_MS },
      );
      const data = logsSearchDataSchema.safeParse(raw);
      if (!data.success) return { server: { ...base, state: 'failed' }, hits: [] };
      const hits: LogSearchHit[] = data.data.matches.slice(0, req.maxMatches).map((m) => ({
        serverId: s.id,
        serverName: s.name,
        containerId: m.containerId,
        containerName: m.containerName,
        ts: m.ts,
        stream: m.stream,
        text: m.text,
      }));
      return {
        server: {
          ...base,
          state: 'ok',
          scannedContainers: data.data.scannedContainers,
          truncated: data.data.truncated || list.length > MAX_CONTAINERS,
        },
        hits,
      };
    } catch (err) {
      return { server: { ...base, state: rpcState(err) }, hits: [] };
    }
  }
}
