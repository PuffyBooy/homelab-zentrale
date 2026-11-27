import { z } from 'zod';
import {
  composeProjectSchema,
  containerDetailsDataSchema,
  dockerImageSchema,
  dockerNetworkSchema,
  dockerVolumeSchema,
  imagePullRefSchema,
  volumeNameSchema,
} from '../agent-docker.js';
import { containerIdSchema, containerSummarySchema } from './containers.js';

/**
 * M23 Docker komplett (SPEC 6.3). Every route needs an admin session; every
 * change is written to the audit log (who, what, target), never env values.
 * Old agents without these actions answer not_allowed -> 409 agent_outdated.
 *
 * Step-up (fresh TOTP, 15 min) for: volume removal, container removal.
 * Name confirmation (typed) for: container removal, volume removal, stack down.
 * Containers of a game server (label homelab.game) are refused with 409 for
 * remove and stack ops ("über die Gameserver-Seite"); protected containers
 * (hz.role) with 403 forbidden.
 */

const serverIdSchema = z.string().min(1).max(64);

// GET /api/containers/:id/details -> containerDetailsResponseSchema
export const containerDetailsResponseSchema = z.strictObject({
  details: containerDetailsDataSchema,
});
export type ContainerDetailsResponse = z.infer<typeof containerDetailsResponseSchema>;

// POST /api/containers/:id/remove (step-up) { confirmName, removeVolumes } -> okResponseSchema (api/auth.ts)
// confirmName must equal the container name. 409 conflict while it runs.
export const containerRemoveRequestSchema = z.strictObject({
  confirmName: z.string().min(1).max(256),
  removeVolumes: z.boolean().default(false),
});
export type ContainerRemoveRequest = z.infer<typeof containerRemoveRequestSchema>;


export const dockerServerParamsSchema = z.strictObject({ serverId: serverIdSchema });

// GET /api/servers/:serverId/docker/images
export const dockerImageListResponseSchema = z.strictObject({
  images: z.array(dockerImageSchema),
});
export type DockerImageListResponse = z.infer<typeof dockerImageListResponseSchema>;

// POST /api/servers/:serverId/docker/images/pull { ref } -> { image } (up to 15 min)
export const imagePullRequestSchema = z.strictObject({ ref: imagePullRefSchema });
export const imagePullResponseSchema = z.strictObject({
  image: z.strictObject({ id: z.string(), tags: z.array(z.string()) }),
});

// POST /api/servers/:serverId/docker/images/:imageId/remove {} -> { ok }
// imageId: the 64 hex digits without "sha256:". 409 conflict while in use.
export const imageRemoveParamsSchema = z.strictObject({
  serverId: serverIdSchema,
  imageId: z.string().regex(/^[0-9a-f]{64}$/),
});

// GET /api/servers/:serverId/docker/volumes
export const dockerVolumeListResponseSchema = z.strictObject({
  volumes: z.array(dockerVolumeSchema),
});
export type DockerVolumeListResponse = z.infer<typeof dockerVolumeListResponseSchema>;

// POST /api/servers/:serverId/docker/volumes/:name/remove (step-up) { confirmName } -> { ok }
export const volumeRemoveParamsSchema = z.strictObject({
  serverId: serverIdSchema,
  name: volumeNameSchema,
});
export const volumeRemoveRequestSchema = z.strictObject({
  confirmName: z.string().min(1).max(256),
});

// GET /api/servers/:serverId/docker/networks
export const dockerNetworkListResponseSchema = z.strictObject({
  networks: z.array(dockerNetworkSchema),
});
export type DockerNetworkListResponse = z.infer<typeof dockerNetworkListResponseSchema>;

// POST /api/servers/:serverId/docker/networks/:networkId/remove {} -> { ok }
export const networkRemoveParamsSchema = z.strictObject({
  serverId: serverIdSchema,
  networkId: z.string().regex(/^[0-9a-f]{64}$/),
});

/**
 * POST /api/servers/:serverId/stacks/:project/:op
 * update = pull + up. down needs { confirmName: project }. Others take {}.
 * -> { ok, containers } (the project's containers after the op, from the core's list)
 */
export const stackActionSchema = z.enum(['start', 'stop', 'restart', 'update', 'down']);
export type StackAction = z.infer<typeof stackActionSchema>;
export const stackActionParamsSchema = z.strictObject({
  serverId: serverIdSchema,
  project: composeProjectSchema,
  op: stackActionSchema,
});
export const stackActionRequestSchema = z.strictObject({
  confirmName: z.string().min(1).max(100).optional(),
});
export const stackActionResponseSchema = z.strictObject({
  ok: z.literal(true),
  containers: z.array(containerSummarySchema),
});

/**
 * Web console target (SPEC 11, M23): wss://<core>/console?serverId=<id>[&container=<core container id>].
 * With container: a shell inside that running container of the server (same
 * step-up, allowTerminal, limits and logging as the host console; the audit entry
 * names the container). Protected containers (hz.role) close with not_allowed.
 */
export const consoleContainerParamSchema = containerIdSchema;
