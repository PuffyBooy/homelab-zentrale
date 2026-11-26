import { z } from 'zod';
import { fileNameSchema, homelabPathSchema, shaSchema } from '../agent-protocol.js';

/**
 * GitHub and deploy (SPEC 7). The core polls GitHub with a fine-grained PAT
 * (Contents/Actions/Metadata read). The token never leaves the core; the target
 * server clones with its own deploy key (generated on the agent, only the public
 * half is shown) or anonymously for public repos.
 */

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export const githubIdParamsSchema = z.strictObject({ id: idSchema });

/** "owner/name" as GitHub allows it. */
export const repoFullNameSchema = z
  .string()
  .max(140)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/)
  .refine((n) => !n.endsWith('.git') && !n.includes('..'), { message: 'invalid repo name' });

/** Git branch name (subset of git check-ref-format, no leading dash). */
export const branchSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine(
    (b) => !b.includes('..') && !b.includes('//') && !b.endsWith('/') && !b.endsWith('.lock'),
    {
      message: 'invalid branch name',
    },
  );

export const ciStatusSchema = z.enum(['ok', 'crit', 'busy', 'off']);
export type CiStatus = z.infer<typeof ciStatusSchema>;

// ---- token / settings --------------------------------------------------------

// GET /api/github/settings
export const githubSettingsSchema = z.strictObject({
  tokenSet: z.boolean(),
  /** GitHub login of the token owner, after a successful check. */
  login: z.string().nullable(),
  lastPollAt: z.iso.datetime().nullable(),
  /** Short German reason of the last failure, e.g. "Token ungültig", "Rate-Limit bis 14:05". */
  error: z.string().nullable(),
  rateRemaining: z.number().int().nullable(),
});
export type GithubSettings = z.infer<typeof githubSettingsSchema>;

// PUT /api/github/token (step-up) -> githubSettingsSchema; DELETE /api/github/token (step-up)
export const githubTokenRequestSchema = z.strictObject({
  token: z
    .string()
    .trim()
    .min(20)
    .max(255)
    .regex(/^(github_pat_|ghp_)[A-Za-z0-9_]+$/),
});

// ---- repos ---------------------------------------------------------------------

export const commitInfoSchema = z.strictObject({
  sha: shaSchema,
  /** First line only, max 200 chars. */
  message: z.string().max(200),
  author: z.string().max(100),
  at: z.iso.datetime(),
  ci: ciStatusSchema,
});
export type CommitInfo = z.infer<typeof commitInfoSchema>;

export const deployMethodSchema = z.enum(['compose', 'script']);

export const deployTargetSchema = z.strictObject({
  id: idSchema,
  repoId: idSchema,
  serverId: z.string().max(64),
  serverName: z.string(),
  path: homelabPathSchema,
  branch: branchSchema,
  method: deployMethodSchema,
  autoDeploy: z.boolean(),
  /** Name of the deploy key on the agent (null: public repo, anonymous https clone). */
  keyName: fileNameSchema.nullable(),
  /** Public key (ssh-ed25519 …) to add under GitHub repo → Settings → Deploy keys (read only). */
  publicKey: z.string().max(200).nullable(),
  /** Commit that runs there now (last successful deploy). */
  liveSha: shaSchema.nullable(),
  /** Number of commits on `branch` after liveSha (max 30, "30+" in the UI). */
  behind: z.number().int().nonnegative(),
  deploying: z.boolean(),
});
export type DeployTarget = z.infer<typeof deployTargetSchema>;

export const repoSummarySchema = z.strictObject({
  id: idSchema,
  fullName: repoFullNameSchema,
  private: z.boolean(),
  defaultBranch: branchSchema,
  htmlUrl: z.url({ protocol: /^https$/ }),
  lastCommit: commitInfoSchema.nullable(),
  ci: ciStatusSchema,
  targets: z.array(deployTargetSchema),
  updatedAt: z.iso.datetime().nullable(),
});
export type RepoSummary = z.infer<typeof repoSummarySchema>;

// GET /api/github/repos
export const repoListResponseSchema = z.strictObject({ repos: z.array(repoSummarySchema) });
export const repoResponseSchema = z.strictObject({ repo: repoSummarySchema });

// GET /api/github/available -> repos the token can see (for "Repo hinzufügen")
export const availableRepoListResponseSchema = z.strictObject({
  repos: z.array(
    z.strictObject({
      fullName: repoFullNameSchema,
      private: z.boolean(),
      tracked: z.boolean(),
    }),
  ),
});

// POST /api/github/repos -> repoResponseSchema; DELETE /api/github/repos/:id
export const repoAddRequestSchema = z.strictObject({ fullName: repoFullNameSchema });

// GET /api/github/repos/:id/commits?branch= -> last 30 commits
export const commitListQuerySchema = z.strictObject({ branch: branchSchema.optional() });
export const commitListResponseSchema = z.strictObject({
  commits: z.array(
    commitInfoSchema.extend({
      /** Target ids where this commit is live now. */
      liveOn: z.array(idSchema),
      /** Target ids where this commit was deployed successfully before (rollback possible). */
      deployedBefore: z.array(idSchema),
    }),
  ),
});

// ---- targets and deploys --------------------------------------------------------

// POST /api/github/repos/:id/targets, PUT /api/github/targets/:id -> { target }
export const deployTargetRequestSchema = z.strictObject({
  serverId: z.string().min(1).max(64),
  path: homelabPathSchema,
  branch: branchSchema,
  method: deployMethodSchema.default('compose'),
  autoDeploy: z.boolean().default(false),
});
export const deployTargetResponseSchema = z.strictObject({ target: deployTargetSchema });
// DELETE /api/github/targets/:id
// POST /api/github/targets/:id/deploy-key -> agent creates (or returns) the key -> { target }

export const deployStatusSchema = z.enum(['queued', 'running', 'ok', 'failed', 'cancelled']);
export const deployTriggerSchema = z.enum(['manual', 'auto', 'rollback']);

export const deploySchema = z.strictObject({
  id: idSchema,
  targetId: idSchema,
  sha: shaSchema,
  status: deployStatusSchema,
  trigger: deployTriggerSchema,
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  /** Short German result, e.g. "compose up fehlgeschlagen (Exit 1)". */
  summary: z.string().nullable(),
});
export type Deploy = z.infer<typeof deploySchema>;

// POST /api/github/targets/:id/deploy { sha? (default: head of branch), rollback? }
// -> 202 { deploy }; 409 busy (lock per target) or ci_not_green
export const deployRequestSchema = z.strictObject({
  sha: shaSchema.optional(),
  /** Rollback: sha must be an earlier successful deploy of this target; CI rule is skipped. */
  rollback: z.boolean().default(false),
});
export const deployResponseSchema = z.strictObject({ deploy: deploySchema });

// GET /api/github/deploys?targetId=&limit= ; GET /api/github/deploys/:id -> { deploy, log }
export const deployListQuerySchema = z.strictObject({
  targetId: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export const deployListResponseSchema = z.strictObject({ deploys: z.array(deploySchema) });
export const deployDetailResponseSchema = z.strictObject({
  deploy: deploySchema,
  /** Stored log (max 256 KB, tail). Live lines come over the topic `deploy:<id>`. */
  log: z.string(),
});

/** Topic `deploy:<id>` items: one log chunk each. */
export const deployLogChunkSchema = z.strictObject({
  id: z.string(),
  channel: z.enum(['stdout', 'stderr', 'progress']),
  text: z.string().max(64 * 1024),
});
