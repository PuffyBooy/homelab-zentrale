import { z } from 'zod';
import {
  agentNameSchema,
  cleanupKindSchema,
  dockerDfDataSchema,
  duDataSchema,
  hostDirPathSchema,
  processSortSchema,
  processesDataSchema,
  serviceOpSchema,
  serviceUnitSchema,
  servicesDataSchema,
} from '../agent-protocol.js';

/**
 * M16: Server im Detail, Überwachung und Verwaltung (ROADMAP M16, SPEC 5.5).
 *
 * All routes need an admin session; the agent must be connected (else 409
 * agent_offline). Everything except the service actions, cleanup and shutdown
 * is read-only.
 *
 * GET  /api/servers/:id/history?range=1h|24h|7d|30d  -> HistoryResponse (now with diskMax)
 * GET  /api/servers/:id/du?path=/var                 -> DuResponse (system.du, max 1 per 5 s per server)
 * GET  /api/servers/:id/docker-df                    -> DockerDfResponse
 * POST /api/servers/:id/cleanup  { items? }          -> { freedBytes } (items default: all)
 * GET  /api/servers/:id/services                     -> ServicesResponse
 * POST /api/servers/:id/services { unit, op }        -> { ok: true } (audited; agent allowlist)
 * GET  /api/servers/:id/processes?sort=cpu|mem       -> ProcessesResponse (top 25)
 * POST /api/servers/:id/shutdown { confirmName }     -> { ok: true } (step-up, name must match)
 */

export const duQuerySchema = z.strictObject({ path: hostDirPathSchema.default('/') });
export type DuQuery = z.infer<typeof duQuerySchema>;
export const duResponseSchema = duDataSchema;
export type DuResponse = z.infer<typeof duResponseSchema>;

export const dockerDfResponseSchema = dockerDfDataSchema;
export type DockerDfResponse = z.infer<typeof dockerDfResponseSchema>;

/** POST /api/servers/:id/cleanup. An empty body cleans everything (as before M16). */
export const cleanupRequestSchema = z
  .strictObject({
    items: z
      .array(cleanupKindSchema)
      .min(1)
      .max(5)
      .refine((a) => new Set(a).size === a.length, { message: 'duplicate item' })
      .optional(),
  })
  .default({});
export type CleanupRequest = z.infer<typeof cleanupRequestSchema>;

export const servicesResponseSchema = servicesDataSchema;
export type ServicesResponse = z.infer<typeof servicesResponseSchema>;
export const serviceActionRequestSchema = z.strictObject({
  unit: serviceUnitSchema,
  op: serviceOpSchema,
});
export type ServiceActionRequest = z.infer<typeof serviceActionRequestSchema>;

export const PROCESS_LIST_LIMIT = 25;
export const processesQuerySchema = z.strictObject({ sort: processSortSchema.default('cpu') });
export type ProcessesQuery = z.infer<typeof processesQuerySchema>;
export const processesResponseSchema = processesDataSchema;
export type ProcessesResponse = z.infer<typeof processesResponseSchema>;

/** POST /api/servers/:id/shutdown (step-up). The server stays off until someone powers it on (or WoL). */
export const shutdownRequestSchema = z.strictObject({ confirmName: agentNameSchema });
export type ShutdownRequest = z.infer<typeof shutdownRequestSchema>;
