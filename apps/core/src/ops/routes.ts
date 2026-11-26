import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  fail2banResponseSchema,
  fail2banServerSchema,
  fail2banUnbanRequestSchema,
  logSearchRequestSchema,
  logSearchResponseSchema,
  vulnScanSettingsSchema,
  vulnScanStateSchema,
  type Fail2banServer,
} from '@hz/shared';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import { WindowLimiter } from '../share/limits.js';
import type { Fail2banService } from './fail2ban.js';
import type { LogSearchService } from './logsearch.js';
import type { VulnScanService } from './vulnscan.js';

export interface OpsRoutesOptions {
  db: Db;
  now: Clock;
  logsearch: LogSearchService;
  vulnscan: VulnScanService;
  fail2ban: Fail2banService;
}

/** Log searches per admin session and minute. */
export const LOG_SEARCH_LIMIT = 10;
/** fail2ban unbans per admin session and minute. */
export const FAIL2BAN_UNBAN_LIMIT = 30;
const MINUTE = 60_000;
/** POST /api/vulnscan/run takes no fields (an empty JSON object is fine). */
const vulnScanRunBody = z.strictObject({});

/**
 * Optional operations modules (admin session; the module gate answers 404
 * module_disabled while a module is off):
 * POST /api/logsearch, GET /api/vulnscan, PUT /api/vulnscan/settings,
 * POST /api/vulnscan/run, GET /api/fail2ban, POST /api/fail2ban/unban.
 */
export const opsRoutes: FastifyPluginAsync<OpsRoutesOptions> = async (app, o) => {
  const searchLimit = new WindowLimiter(LOG_SEARCH_LIMIT, MINUTE, o.now);
  const unbanLimit = new WindowLimiter(FAIL2BAN_UNBAN_LIMIT, MINUTE, o.now);

  // ---- logsearch ----------------------------------------------------------------
  app.post('/logsearch', async (request) => {
    // The guard guarantees a session here; key the budget by its public id.
    const wait = searchLimit.hit(request.auth?.session.id ?? 'anonymous');
    if (wait !== null) throw new HttpError(429, 'rate_limited', wait);
    const body = logSearchRequestSchema.parse(request.body);
    const res = await o.logsearch.search(body);
    // The query may contain secrets (a token someone grepped for): only its length.
    writeAudit(o.db, o.now(), {
      actor: 'admin',
      action: 'logsearch.query',
      target: null,
      details: {
        servers: res.servers.length,
        sinceMinutes: body.sinceMinutes,
        queryLength: body.query.length,
      },
    });
    return logSearchResponseSchema.parse(res);
  });

  // ---- vulnscan -----------------------------------------------------------------
  app.get('/vulnscan', async () => vulnScanStateSchema.parse(o.vulnscan.state()));

  app.put('/vulnscan/settings', async (request) => {
    const body = vulnScanSettingsSchema.parse(request.body);
    o.vulnscan.setSettings(body);
    writeAudit(o.db, o.now(), {
      actor: 'admin',
      action: 'vulnscan.settings',
      target: null,
      details: { ...body },
    });
    return vulnScanStateSchema.parse(o.vulnscan.state());
  });

  app.post('/vulnscan/run', async (request, reply) => {
    // No body is accepted: the core never names an image or container.
    if (request.body !== undefined && request.body !== null) {
      const empty = vulnScanRunBody.safeParse(request.body);
      if (!empty.success) throw new HttpError(400, 'invalid_input');
    }
    const r = o.vulnscan.runManual();
    if (r === 'busy') throw new HttpError(409, 'busy', undefined, 'Scan läuft bereits');
    if (typeof r === 'number') throw new HttpError(429, 'rate_limited', r);
    writeAudit(o.db, o.now(), { actor: 'admin', action: 'vulnscan.run', target: null });
    return reply.code(202).send(vulnScanStateSchema.parse(o.vulnscan.state()));
  });

  // ---- fail2ban -----------------------------------------------------------------
  app.get('/fail2ban', async () =>
    fail2banResponseSchema.parse({ servers: await o.fail2ban.list() }),
  );

  app.post('/fail2ban/unban', async (request) => {
    const wait = unbanLimit.hit(request.auth?.session.id ?? 'anonymous');
    if (wait !== null) throw new HttpError(429, 'rate_limited', wait);
    const body = fail2banUnbanRequestSchema.parse(request.body);
    // Defence in depth: a jail never starts like an option or a hidden name.
    if (/^[-.]/.test(body.jail)) throw new HttpError(400, 'invalid_input');
    const details = { serverId: body.serverId, jail: body.jail, ip: body.ip };
    let server: Fail2banServer;
    try {
      server = await o.fail2ban.unban(body.serverId, body.jail, body.ip);
    } catch (err) {
      if (err instanceof HttpError && err.code !== 'not_found') {
        writeAudit(o.db, o.now(), {
          actor: 'admin',
          action: 'fail2ban.unban_failed',
          target: body.serverId,
          details,
        });
      }
      throw err;
    }
    writeAudit(o.db, o.now(), {
      actor: 'admin',
      action: 'fail2ban.unban',
      target: body.serverId,
      details,
    });
    return fail2banServerSchema.parse(server);
  });
};
