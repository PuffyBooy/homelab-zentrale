import type { FastifyPluginAsync } from 'fastify';
import { storageListResponseSchema, storageParamsSchema, storageServerSchema } from '@hz/shared';
import { HttpError } from '../http/errors.js';
import type { StorageService } from './service.js';

export interface StorageRoutesOptions {
  storage: StorageService;
}

/** NAS und Speicher (admin session, read only). Prefix /api; module gate `storage`. */
export const storageRoutes: FastifyPluginAsync<StorageRoutesOptions> = async (app, o) => {
  app.get('/storage', async () => storageListResponseSchema.parse({ servers: o.storage.list() }));

  app.get('/storage/:id', async (request) => {
    const { id } = storageParamsSchema.parse(request.params);
    const s = o.storage.get(id);
    if (!s) throw new HttpError(404, 'not_found');
    return storageServerSchema.parse(s);
  });
};
