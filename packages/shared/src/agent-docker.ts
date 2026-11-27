import { z } from 'zod';

/**
 * M23 Docker komplett: agent actions for the full Docker view of a server
 * (container details and removal, images, volumes, networks, compose stacks
 * that the Zentrale did not create). Kept apart from agent-protocol.ts like
 * agent-ops.ts; this file must not import agent-protocol.ts (it is spread into
 * rpcParamsByAction at module load).
 *
 * Rules every handler enforces on the agent (defense in depth, the core checks too):
 * - Containers with label hz.role (agent, core, updater) and the agent's own
 *   container are never removed, never exec'd into, never part of a stack op
 *   (`not_allowed`). Images, volumes and networks that such a container uses
 *   (in any state) are never removed (`not_allowed`).
 * - Nothing is ever forced: a running container, an image in use, a volume in
 *   use, a network with endpoints is refused by Docker; the agent maps that
 *   409 to `busy`. No `force`, no `prune` here (pruning stays in system.cleanup).
 * - The core never sends a path or a command. Stack ops get only the compose
 *   project name; the agent reads working dir and config files from the labels
 *   of the project's existing containers itself.
 * - Env values of containers never leave the agent (only the keys).
 */

const containerRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const isoTs = z.iso.datetime();
const count = z.number().int().nonnegative();
const bytes = z.number().nonnegative();

/** `sha256:<64 hex>` as Docker reports image ids. */
export const imageIdSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
/** Full network id (64 hex). */
export const networkIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
/** Docker volume name rule ([a-zA-Z0-9][a-zA-Z0-9_.-]+). */
export const volumeNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/);
/** Compose project name rule (docker compose normalizes to this). */
export const composeProjectSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/);

/**
 * Image reference for image.pull: `[registry[:port]/]repo[/repo...][:tag][@sha256:<64>]`.
 * Lower-case repository path, no scheme, no spaces, no leading dash (never an option).
 */
export const imagePullRefSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(?:@sha256:[0-9a-f]{64})?$/,
  );

/**
 * Stack operations. start/stop/restart work on every project through the Docker
 * API (all containers with label com.docker.compose.project=<project>). pull, up
 * and down run `docker compose` with the project's own working dir and config
 * files from the labels: below /opt/homelab/ in the agent like compose.*,
 * elsewhere on the host through nsenter (needs the compose plugin on the host,
 * `failed` with "docker compose not available on the host" otherwise, and
 * HZ_AGENT_HOST_EXEC != none). down keeps volumes (never `--volumes`).
 */
export const stackOpSchema = z.enum(['start', 'stop', 'restart', 'pull', 'up', 'down']);
export type StackOp = z.infer<typeof stackOpSchema>;

export const dockerRpcParams = {
  /**
   * `docker rm` of a stopped container (`busy` while running, never force).
   * removeVolumes also deletes its anonymous volumes (`docker rm -v`), never
   * named volumes. Result: null.
   */
  'container.remove': z.strictObject({
    id: containerRef,
    removeVolumes: z.boolean().default(false),
  }),
  /** Details of one container (inspect + one stats sample when running). Result: containerDetailsDataSchema. */
  'container.inspect': z.strictObject({ id: containerRef }),
  /** All images. Result: dockerImagesDataSchema. */
  'docker.images': z.strictObject({}),
  /** Pull an image by reference (registry auth is not supported). Result: imagePullDataSchema. */
  'image.pull': z.strictObject({ ref: imagePullRefSchema }),
  /** `docker rmi <id>` without force (`busy` while a container uses it). Result: null. */
  'image.remove': z.strictObject({ id: imageIdSchema }),
  /** All volumes with size and users. Result: dockerVolumesDataSchema. */
  'docker.volumes': z.strictObject({}),
  /** `docker volume rm <name>` without force (`busy` while in use). Result: null. */
  'volume.remove': z.strictObject({ name: volumeNameSchema }),
  /** All networks. Result: dockerNetworksDataSchema. */
  'docker.networks': z.strictObject({}),
  /** `docker network rm <id>`; built-in networks (bridge, host, none) are refused. Result: null. */
  'network.remove': z.strictObject({ id: networkIdSchema }),
  /** One operation on a compose project (see stackOpSchema). Result: stackOpDataSchema. */
  'stack.op': z.strictObject({ project: composeProjectSchema, op: stackOpSchema }),
} as const;

// ---- result data ----------------------------------------------------------------

export const mountInfoSchema = z.strictObject({
  type: z.enum(['bind', 'volume', 'tmpfs', 'npipe', 'cluster', 'image']),
  /** Host path (bind) or volume name; empty for tmpfs. */
  source: z.string().max(1000),
  destination: z.string().max(1000),
  rw: z.boolean(),
});
export type MountInfo = z.infer<typeof mountInfoSchema>;

export const containerStatsSchema = z.strictObject({
  /** CPU in percent of one core (100 = one full core). */
  cpuPercent: z.number().nonnegative(),
  memBytes: bytes,
  /** null without a memory limit. */
  memLimitBytes: bytes.nullable(),
  netRxBytes: bytes,
  netTxBytes: bytes,
  blockReadBytes: bytes,
  blockWriteBytes: bytes,
  pids: count,
});
export type ContainerStats = z.infer<typeof containerStatsSchema>;

export const containerDetailsDataSchema = z.strictObject({
  /** Full 64-hex container id. */
  id: z.string().regex(/^[0-9a-f]{64}$/),
  name: z.string().max(256),
  image: z.string().max(300),
  imageId: z.string().max(80),
  createdAt: isoTs,
  startedAt: isoTs.nullable(),
  finishedAt: isoTs.nullable(),
  state: z.string().max(20),
  health: z.enum(['healthy', 'unhealthy', 'starting', 'none']),
  exitCode: z.number().int().nullable(),
  restartCount: count,
  /** Docker restart policy name ("no", "always", "unless-stopped", "on-failure"). */
  restartPolicy: z.string().max(30),
  /** Names of the environment variables only. Values never leave the agent. */
  envKeys: z.array(z.string().max(200)).max(300),
  mounts: z.array(mountInfoSchema).max(100),
  networks: z
    .array(z.strictObject({ name: z.string().max(256), ip: z.string().max(64).nullable() }))
    .max(50),
  ports: z
    .array(
      z.strictObject({
        privatePort: z.number().int().min(1).max(65535),
        publicPort: z.number().int().min(1).max(65535).nullable(),
        protocol: z.enum(['tcp', 'udp', 'sctp']),
        ip: z.string().max(64).nullable(),
      }),
    )
    .max(200),
  composeProject: z.string().max(100).nullable(),
  composeService: z.string().max(100).nullable(),
  /** hz.role container or the agent itself: no remove, no shell, no stack ops. */
  protected: z.boolean(),
  /** One sample, null when the container does not run. */
  stats: containerStatsSchema.nullable(),
});
export type ContainerDetailsData = z.infer<typeof containerDetailsDataSchema>;

export const dockerImageSchema = z.strictObject({
  id: imageIdSchema,
  /** repo:tag, empty for dangling images. */
  tags: z.array(z.string().max(300)).max(50),
  sizeBytes: bytes,
  createdAt: isoTs,
  /** Containers (any state) that use this image. */
  containers: count,
  dangling: z.boolean(),
  /** Used by a protected container: never removed. */
  protected: z.boolean(),
});
export type DockerImage = z.infer<typeof dockerImageSchema>;
export const dockerImagesDataSchema = z.strictObject({
  images: z.array(dockerImageSchema).max(2000),
});
export type DockerImagesData = z.infer<typeof dockerImagesDataSchema>;

export const imagePullDataSchema = z.strictObject({
  id: imageIdSchema,
  tags: z.array(z.string().max(300)).max(50),
});
export type ImagePullData = z.infer<typeof imagePullDataSchema>;

export const dockerVolumeSchema = z.strictObject({
  name: volumeNameSchema,
  driver: z.string().max(100),
  createdAt: isoTs.nullable(),
  /** From `docker system df -v`; null when Docker did not report it. */
  sizeBytes: bytes.nullable(),
  /** Names of the containers (any state) that mount it. */
  containers: z.array(z.string().max(256)).max(200),
  composeProject: z.string().max(100).nullable(),
  /** Mounted by a protected container: never removed. */
  protected: z.boolean(),
});
export type DockerVolume = z.infer<typeof dockerVolumeSchema>;
export const dockerVolumesDataSchema = z.strictObject({
  volumes: z.array(dockerVolumeSchema).max(2000),
});
export type DockerVolumesData = z.infer<typeof dockerVolumesDataSchema>;

export const BUILTIN_NETWORKS = ['bridge', 'host', 'none'] as const;

export const dockerNetworkSchema = z.strictObject({
  id: networkIdSchema,
  name: z.string().max(256),
  driver: z.string().max(100),
  scope: z.string().max(20),
  /** bridge, host, none: never removed. */
  builtin: z.boolean(),
  internal: z.boolean(),
  /** Names of the attached containers. */
  containers: z.array(z.string().max(256)).max(500),
  composeProject: z.string().max(100).nullable(),
  /** A protected container is attached: never removed. */
  protected: z.boolean(),
});
export type DockerNetwork = z.infer<typeof dockerNetworkSchema>;
export const dockerNetworksDataSchema = z.strictObject({
  networks: z.array(dockerNetworkSchema).max(1000),
});
export type DockerNetworksData = z.infer<typeof dockerNetworksDataSchema>;

export const stackOpDataSchema = z.strictObject({
  /** Containers the operation touched (start/stop/restart), or the project had before (pull/up/down). */
  containers: count,
  /** inside = below /opt/homelab/ (agent's compose), host = elsewhere (host's compose via nsenter), api = Docker API only. */
  via: z.enum(['api', 'inside', 'host']),
});
export type StackOpData = z.infer<typeof stackOpDataSchema>;
