import type { FastifyPluginAsync } from 'fastify';
import {
  availableRepoListResponseSchema,
  commitListQuerySchema,
  commitListResponseSchema,
  deployDetailResponseSchema,
  deployListQuerySchema,
  deployListResponseSchema,
  deployRequestSchema,
  deployResponseSchema,
  deployTargetRequestSchema,
  deployTargetResponseSchema,
  githubIdParamsSchema,
  githubSettingsSchema,
  githubTokenRequestSchema,
  okResponseSchema,
  repoAddRequestSchema,
  repoListResponseSchema,
  repoResponseSchema,
} from '@hz/shared';
import { requireStepUp } from '../auth/index.js';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import { rpcHttpError } from '../servers/routes.js';
import { toDeploy } from './deploys.js';
import type { GithubService } from './service.js';

export interface GithubRoutesOptions {
  db: Db;
  now: Clock;
  github: GithubService;
}

/** /api/github/* (SPEC 7). Admin session everywhere; changing the token needs step-up. */
export const githubRoutes: FastifyPluginAsync<GithubRoutesOptions> = async (app, o) => {
  const stepUp = requireStepUp(o.now);
  const g = o.github;
  const audit = (action: string, target: string | null, details?: Record<string, unknown>): void =>
    writeAudit(o.db, o.now(), { actor: 'admin', action, target, ...(details ? { details } : {}) });
  const idOf = (params: unknown): string => githubIdParamsSchema.parse(params).id;

  // ---- token / settings --------------------------------------------------------

  app.get('/github/settings', async () => githubSettingsSchema.parse(g.settings()));

  app.put('/github/token', { preHandler: stepUp }, async (request) => {
    const { token } = githubTokenRequestSchema.parse(request.body);
    const result = await g.setToken(token);
    audit('github.token_set', null, { login: result.login });
    return githubSettingsSchema.parse(result);
  });

  app.delete('/github/token', { preHandler: stepUp }, async () => {
    g.clearToken();
    audit('github.token_cleared', null);
    return okResponseSchema.parse({ ok: true });
  });

  // ---- repos ---------------------------------------------------------------------

  app.get('/github/repos', async () => repoListResponseSchema.parse({ repos: g.list() }));

  app.get('/github/available', async () =>
    availableRepoListResponseSchema.parse({ repos: await g.available() }),
  );

  app.post('/github/repos', async (request) => {
    const { fullName } = repoAddRequestSchema.parse(request.body);
    const repo = await g.addRepo(fullName);
    audit('github.repo_added', repo.id, { fullName: repo.fullName });
    return repoResponseSchema.parse({ repo });
  });

  app.delete('/github/repos/:id', async (request) => {
    const id = idOf(request.params);
    const row = g.repoRow(id);
    if (!row || !g.removeRepo(id)) throw new HttpError(404, 'not_found');
    audit('github.repo_removed', id, { fullName: row.fullName });
    return okResponseSchema.parse({ ok: true });
  });

  app.get('/github/repos/:id/commits', async (request) => {
    const id = idOf(request.params);
    const { branch } = commitListQuerySchema.parse(request.query ?? {});
    return commitListResponseSchema.parse({ commits: await g.commits(id, branch) });
  });

  // ---- targets -------------------------------------------------------------------

  app.post('/github/repos/:id/targets', async (request) => {
    const id = idOf(request.params);
    const body = deployTargetRequestSchema.parse(request.body);
    const target = g.createTarget(id, body);
    audit('github.target_created', target.id, {
      repoId: id,
      serverId: target.serverId,
      path: target.path,
      branch: target.branch,
      method: target.method,
      autoDeploy: target.autoDeploy,
    });
    return deployTargetResponseSchema.parse({ target });
  });

  app.put('/github/targets/:id', async (request) => {
    const id = idOf(request.params);
    const body = deployTargetRequestSchema.parse(request.body);
    const target = g.updateTarget(id, body);
    audit('github.target_updated', id, {
      serverId: target.serverId,
      path: target.path,
      branch: target.branch,
      method: target.method,
      autoDeploy: target.autoDeploy,
    });
    return deployTargetResponseSchema.parse({ target });
  });

  app.delete('/github/targets/:id', async (request) => {
    const id = idOf(request.params);
    const row = g.removeTarget(id);
    if (!row) throw new HttpError(404, 'not_found');
    audit('github.target_deleted', id, { repoId: row.repoId, serverId: row.serverId });
    return okResponseSchema.parse({ ok: true });
  });

  app.post('/github/targets/:id/deploy-key', async (request) => {
    const id = idOf(request.params);
    const row = g.targetRow(id);
    if (!row) throw new HttpError(404, 'not_found');
    let target;
    try {
      target = await g.createDeployKey(id);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      audit('github.deploy_key_failed', id, { serverId: row.serverId });
      throw rpcHttpError(err);
    }
    audit('github.deploy_key', id, { serverId: row.serverId, keyName: target.keyName });
    return deployTargetResponseSchema.parse({ target });
  });

  // ---- deploys -------------------------------------------------------------------

  app.post('/github/targets/:id/deploy', async (request, reply) => {
    const id = idOf(request.params);
    const body = deployRequestSchema.parse(request.body ?? {});
    try {
      const deploy = await g.deploy(id, body);
      return reply.code(202).send(deployResponseSchema.parse({ deploy }));
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        audit('deploy.refused', id, { reason: err.code, ...(body.sha ? { sha: body.sha } : {}) });
      }
      throw err;
    }
  });

  app.get('/github/deploys', async (request) => {
    const q = deployListQuerySchema.parse(request.query ?? {});
    if (q.targetId !== undefined && !g.targetRow(q.targetId)) {
      throw new HttpError(404, 'not_found');
    }
    return deployListResponseSchema.parse({ deploys: g.deployList(q) });
  });

  app.get('/github/deploys/:id', async (request) => {
    const id = idOf(request.params);
    const row = g.deployer.row(id);
    if (!row) throw new HttpError(404, 'not_found');
    return deployDetailResponseSchema.parse({
      deploy: toDeploy(row),
      log: g.deployer.logOf(id) ?? '',
    });
  });
};

