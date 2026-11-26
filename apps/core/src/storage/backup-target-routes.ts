import type { FastifyPluginAsync } from 'fastify';
import { backupTargetResponseSchema, backupTargetSettingsSchema } from '@hz/shared';
import { requireStepUp } from '../auth/guard.js';
import type { Clock } from '../clock.js';
import { HttpError } from '../http/errors.js';
import { BackupTargetBusyError, type BackupTargetService } from './backup-target.js';

export interface BackupTargetRoutesOptions {
  backupTarget: BackupTargetService;
  now: Clock;
}

/**
 * M13b NAS als Backup-Ziel. Prefix /api; module gate `storage` (/api/storage).
 * Changing the settings needs step-up: it decides where a copy of the whole
 * database goes.
 */
export const backupTargetRoutes: FastifyPluginAsync<BackupTargetRoutesOptions> = async (app, o) => {
  const stepUp = requireStepUp(o.now);

  app.get('/storage/backup-target', async () =>
    backupTargetResponseSchema.parse(o.backupTarget.view()),
  );

  app.put('/storage/backup-target', { preHandler: stepUp }, async (request) => {
    const body = backupTargetSettingsSchema.parse(request.body);
    try {
      o.backupTarget.update(body);
    } catch (err) {
      if (err instanceof Error && err.message === 'unknown_server') {
        throw new HttpError(400, 'invalid_input');
      }
      throw err;
    }
    return backupTargetResponseSchema.parse(o.backupTarget.view());
  });

  app.post('/storage/backup-target/run', async (_request, reply) => {
    const s = o.backupTarget.settings();
    if (!s.enabled) throw new HttpError(409, 'conflict');
    if (o.backupTarget.isRunning) throw new HttpError(409, 'busy');
    o.backupTarget.start().catch((err: unknown) => {
      if (!(err instanceof BackupTargetBusyError)) {
        app.log.error(
          { err: err instanceof Error ? err.name : 'error' },
          'backup target run failed',
        );
      }
    });
    return reply.code(202).send({ started: true });
  });
};
