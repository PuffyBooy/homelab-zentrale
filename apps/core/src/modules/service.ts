import type { FastifyInstance } from 'fastify';
import { MODULE_DEFAULTS, MODULES, modulesSchema, type ModuleId, type Modules } from '@hz/shared';
import type { Clock } from '../clock.js';
import type { Db } from '../db/index.js';
import { readSetting, writeSetting } from '../db/settings.js';
import { decodedPath } from '../auth/guard.js';
import { sendError } from '../http/errors.js';

export const MODULES_SETTING = 'modules';

/**
 * Optional modules (packages/shared/src/api/modules.ts). Stored in `settings`
 * (row written by migration 10). Listeners start/stop the module's pollers,
 * connections and jobs, so a switch works without restart.
 */
export class ModuleService {
  private cached: Modules | null = null;
  private readonly listeners = new Set<(id: ModuleId, on: boolean) => void>();

  constructor(
    private readonly db: Db,
    private readonly now: Clock,
  ) {}

  get(): Modules {
    if (this.cached) return this.cached;
    const parsed = modulesSchema.partial().safeParse(readSetting(this.db, MODULES_SETTING) ?? {});
    const next: Modules = { ...MODULE_DEFAULTS };
    if (parsed.success) {
      for (const m of MODULES) {
        const v = parsed.data[m];
        if (v !== undefined) next[m] = v;
      }
    }
    this.cached = next;
    return next;
  }

  enabled(id: ModuleId): boolean {
    return this.get()[id];
  }

  /** Applies a patch; returns the modules whose state changed. */
  set(patch: { [K in ModuleId]?: boolean | undefined }): ModuleId[] {
    const prev = this.get();
    const next: Modules = { ...prev };
    for (const m of MODULES) {
      const v = patch[m];
      if (v !== undefined) next[m] = v;
    }
    const changed = MODULES.filter((m) => prev[m] !== next[m]);
    if (changed.length === 0) return [];
    writeSetting(this.db, MODULES_SETTING, next, this.now());
    this.cached = next;
    for (const m of changed) for (const fn of this.listeners) fn(m, next[m]);
    return changed;
  }

  onChange(fn: (id: ModuleId, on: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** Path prefixes of each module (API, share pages of friends, share gateway API). */
const MODULE_PREFIXES: Record<ModuleId, readonly string[]> = {
  github: ['/api/github'],
  homeassistant: ['/api/ha'],
  games: ['/api/games', '/api/shares', '/api/settings/share-gateway', '/api/share-gateway', '/s'],
  proxmox: ['/api/proxmox'],
  dnsfilter: ['/api/dnsfilter'],
  fritzbox: ['/api/fritzbox'],
  uptimekuma: ['/api/uptimekuma'],
  storage: ['/api/storage'],
};

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** The module a path belongs to, or null (the router is case-sensitive, so is this). */
export function moduleOfPath(path: string): ModuleId | null {
  for (const m of MODULES) {
    if (MODULE_PREFIXES[m].some((p) => under(path, p))) return m;
  }
  return null;
}

/**
 * onRequest hook after the auth guard: routes of a disabled module answer
 * 404 module_disabled (an anonymous request still gets the guard's 401 first).
 * Both the decoded URL and the matched route pattern are checked.
 */
export function installModuleGate(app: FastifyInstance, modules: ModuleService): void {
  app.addHook('onRequest', async (request, reply) => {
    const decoded = decodedPath(request.url);
    const route = request.routeOptions.url;
    for (const p of [decoded, typeof route === 'string' ? route : null]) {
      if (p === null) continue;
      const m = moduleOfPath(p);
      if (m !== null && !modules.enabled(m)) return sendError(reply, 404, 'module_disabled');
    }
    return undefined;
  });
}
