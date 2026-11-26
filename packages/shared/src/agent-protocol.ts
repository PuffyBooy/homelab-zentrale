import { z } from 'zod';
import { opsRpcParams } from './agent-ops.js';

/**
 * Agent <-> core protocol (docs/ARCHITECTURE.md, "Agent-Protokoll").
 * One WebSocket per agent to wss://<core>/agent. Every message is JSON and is
 * validated with these schemas on both sides. Unknown message types and unknown
 * RPC actions are rejected.
 *
 * This file already contains the messages of later milestones, so they never
 * have to change the protocol again. Bump PROTOCOL_VERSION on breaking changes.
 */
export const PROTOCOL_VERSION = 1;

/** Max size of one WebSocket frame we accept (both directions). */
export const MAX_MESSAGE_BYTES = 1024 * 1024;
/** Max size of one stream chunk. */
export const MAX_CHUNK_CHARS = 64 * 1024;

/** All file system paths the agent touches must live below this root. */
export const HOMELAB_ROOT = '/opt/homelab/';

// ---------------------------------------------------------------------------
// Basics

export const agentNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
/** Agent, enrollment tokens: >= 128 bit, URL-safe base64. */
export const agentTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22,128}$/);
export const rpcIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export const streamIdSchema = rpcIdSchema;
/** Docker container id (short or long) or name. */
export const containerRefSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
export const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const isoTs = z.iso.datetime();
const nonNeg = z.number().finite().nonnegative();
const percent = z.number().finite().min(0).max(100);

/** Bounds of a docker --cpus limit (container.limit, throttle settings). */
export const CPUS_MIN = 0.1;
export const CPUS_MAX = 64;
/**
 * A CPU share for `docker update --cpus`: finite number 0.1..64, rounded to 2
 * decimals. Rejects NaN, Infinity, negatives, 0 and strings (no coercion).
 */
export const cpusSchema = z
  .number()
  .finite()
  .min(CPUS_MIN)
  .max(CPUS_MAX)
  .transform((v) => Math.round(v * 100) / 100);

/**
 * A path below /opt/homelab/. This is only the syntactic check; the agent
 * additionally resolves it with realpath and checks the prefix again.
 */
export const homelabPathSchema = z
  .string()
  .max(512)
  .refine((p) => p.startsWith(HOMELAB_ROOT) && p.length > HOMELAB_ROOT.length, {
    message: 'path must be below /opt/homelab/',
  })
  .refine((p) => !p.includes('\0'), { message: 'NUL in path' })
  .refine((p) => !p.split('/').some((seg) => seg === '..' || seg === '.'), {
    message: 'path must be normalized',
  })
  .refine((p) => !p.includes('//'), { message: 'path must be normalized' })
  // Writing below .git would let compose.write or a deploy plant git hooks/config.
  .refine((p) => !p.split('/').some((seg) => seg.toLowerCase() === '.git'), {
    message: 'no .git in path',
  });

/**
 * Name of a game folder /opt/homelab/games/<name>/ and its backup folder
 * /opt/homelab/backups/<name>/ (same rule as gameNameSchema in api/games.ts and
 * GAME_NAME in the agent, without trimming).
 */
export const gameFolderNameSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])$/);

/**
 * GameDig game types the agent may query (allowlist, gamedig 5 ids).
 * M12 added the new templates (Satisfactory, Enshrouded, Project Zomboid,
 * ARK: Survival Evolved = `ase`, Rust, V Rising).
 */
export const GAMEDIG_TYPES = [
  'valheim',
  'counterstrike2',
  'palworld',
  'satisfactory',
  'enshrouded',
  'projectzomboid',
  'ase',
  'rust',
  'vrising',
] as const;
export const gamedigTypeSchema = z.enum(GAMEDIG_TYPES);

/** Single file name (no directories). */
export const fileNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/)
  .refine((n) => !n.includes('..'), { message: 'invalid file name' });

// ---------------------------------------------------------------------------
// Agent -> core

export const helloSchema = z.strictObject({
  type: z.literal('hello'),
  protocol: z.number().int().positive(),
  name: agentNameSchema,
  version: z.string().max(40),
  arch: z.string().max(20),
  os: z.string().max(120),
  token: agentTokenSchema,
  capabilities: z.strictObject({
    /** HZ_AGENT_ALLOW_TERMINAL=1 on this server. */
    terminal: z.boolean(),
    docker: z.boolean(),
  }),
});
export type Hello = z.infer<typeof helloSchema>;

export const diskSchema = z.strictObject({
  mount: z.string().max(256),
  fs: z.string().max(64).optional(),
  usedBytes: nonNeg,
  totalBytes: nonNeg,
});
export type Disk = z.infer<typeof diskSchema>;

export const metricsSchema = z.strictObject({
  type: z.literal('metrics'),
  ts: isoTs,
  /** CPU usage in percent over the last interval. */
  cpu: percent,
  load1: nonNeg.optional(),
  ram: z.strictObject({ usedBytes: nonNeg, totalBytes: nonNeg }),
  swap: z.strictObject({ usedBytes: nonNeg, totalBytes: nonNeg }),
  disks: z.array(diskSchema).max(32),
  /** Highest CPU/SoC temperature in °C, null if unknown. */
  temp: z.number().finite().min(-50).max(150).nullable(),
  net: z.strictObject({ rxBps: nonNeg, txBps: nonNeg }),
  uptimeS: nonNeg,
});
export type Metrics = z.infer<typeof metricsSchema>;

export const containerStateSchema = z.enum([
  'created',
  'running',
  'paused',
  'restarting',
  'removing',
  'exited',
  'dead',
]);
export type ContainerState = z.infer<typeof containerStateSchema>;
export const containerHealthSchema = z.enum(['healthy', 'unhealthy', 'starting', 'none']);
export type ContainerHealth = z.infer<typeof containerHealthSchema>;

export const portMappingSchema = z.strictObject({
  privatePort: z.number().int().min(1).max(65535),
  publicPort: z.number().int().min(1).max(65535).optional(),
  ip: z.string().max(64).optional(),
  proto: z.enum(['tcp', 'udp', 'sctp']),
});
export type PortMapping = z.infer<typeof portMappingSchema>;

export const containerInfoSchema = z.strictObject({
  dockerId: z.string().regex(/^[0-9a-f]{12,64}$/),
  name: z.string().max(128),
  image: z.string().max(256),
  imageId: z.string().max(128).optional(),
  composeProject: z.string().max(128).optional(),
  composeService: z.string().max(128).optional(),
  /** Working dir of the compose project (label com.docker.compose.project.working_dir). */
  composeDir: z.string().max(512).optional(),
  state: containerStateSchema,
  health: containerHealthSchema,
  /** Docker status text, e.g. "Up 3 hours". */
  statusText: z.string().max(128),
  exitCode: z.number().int().optional(),
  startedAt: isoTs.optional(),
  ports: z.array(portMappingSchema).max(64),
  cpu: percent.optional(),
  memBytes: nonNeg.optional(),
  restartCount: z.number().int().nonnegative().optional(),
  /** Value of the label hz.role when it is core, agent or updater (M17 helper); never a throttle target. */
  role: z.enum(['core', 'agent', 'updater']).optional(),
  /** Current --cpus limit (HostConfig.NanoCpus / 1e9), null without a limit. */
  cpuLimit: nonNeg.nullable().optional(),
  /**
   * M12: value of the label `homelab.game` (the game's folder name), when it is a
   * valid game folder name. The core links game containers by this label first.
   */
  game: gameFolderNameSchema.optional(),
});
export type ContainerInfo = z.infer<typeof containerInfoSchema>;

export const listeningPortSchema = z.strictObject({
  proto: z.enum(['tcp', 'udp']),
  address: z.string().max(64),
  port: z.number().int().min(1).max(65535),
  process: z.string().max(64).optional(),
});
export type ListeningPort = z.infer<typeof listeningPortSchema>;

export const systemInfoSchema = z.strictObject({
  hostname: z.string().max(128),
  os: z.string().max(120),
  kernel: z.string().max(120),
  arch: z.string().max(20),
  cpuModel: z.string().max(160).optional(),
  cpuCores: z.number().int().positive().optional(),
  tailscaleIp: z.string().max(64).optional(),
  publicIp: z.string().max(64).optional(),
  dockerVersion: z.string().max(40).optional(),
});
export type SystemInfo = z.infer<typeof systemInfoSchema>;

// ---------------------------------------------------------------------------
// Storage (M13: NAS und Speicher). Generic Linux: md RAID, volumes, physical
// disks with SMART. Works on any server; on a NAS (e.g. UGREEN NASync with
// UGOS Pro) this is the main view. Every part fails soft on the agent.

/** Kernel block device name of a physical disk (sda, nvme0n1). */
export const blockDeviceNameSchema = z.string().regex(/^(?:sd[a-z]{1,3}|nvme\d{1,3}n\d{1,3})$/);
/** md array name (md0, md127). */
export const mdNameSchema = z.string().regex(/^md\d{1,4}$/);

export const raidStateSchema = z.enum(['clean', 'degraded', 'syncing', 'inactive']);
export type RaidState = z.infer<typeof raidStateSchema>;

export const raidArraySchema = z.strictObject({
  name: mdNameSchema,
  /** raid0, raid1, raid5, raid6, raid10, linear ... */
  level: z.string().regex(/^[a-z0-9]{1,16}$/),
  state: raidStateSchema,
  /** Member devices the array should have ([n/m] in mdstat: n). */
  devicesTotal: z.number().int().nonnegative().max(256),
  /** Members that are up ([n/m]: m). */
  devicesActive: z.number().int().nonnegative().max(256),
  /** Member partitions/disks (sda3, nvme0n1p2), failed ones marked. */
  members: z
    .array(
      z.strictObject({
        device: z.string().regex(/^[a-z0-9]{1,32}$/),
        /** Physical disk this member lives on, if known. */
        disk: blockDeviceNameSchema.optional(),
        failed: z.boolean(),
        spare: z.boolean(),
      }),
    )
    .max(64),
  /** Running resync/recovery/check/reshape. */
  sync: z
    .strictObject({
      kind: z.enum(['resync', 'recovery', 'check', 'reshape']),
      percent,
      /** Estimated minutes left, if mdstat reports it. */
      finishMin: nonNeg.optional(),
    })
    .optional(),
  sizeBytes: nonNeg.optional(),
});
export type RaidArray = z.infer<typeof raidArraySchema>;

export const storageVolumeSchema = z.strictObject({
  mount: z.string().max(256),
  fs: z.string().max(32),
  usedBytes: nonNeg,
  totalBytes: nonNeg,
  /** md arrays and physical disks below this volume (through LVM/dm). */
  arrays: z.array(mdNameSchema).max(32),
  disks: z.array(blockDeviceNameSchema).max(64),
});
export type StorageVolume = z.infer<typeof storageVolumeSchema>;

export const smartHealthSchema = z.enum(['passed', 'failed', 'unknown']);
export type SmartHealth = z.infer<typeof smartHealthSchema>;

export const physicalDiskSchema = z.strictObject({
  name: blockDeviceNameSchema,
  kind: z.enum(['hdd', 'ssd', 'nvme']),
  model: z.string().max(80).optional(),
  serial: z.string().max(64).optional(),
  sizeBytes: nonNeg,
  /** °C; null when unknown or the disk sleeps (no SMART read while in standby). */
  tempC: z.number().finite().min(-40).max(150).nullable(),
  /** The disk was in standby at the last read; SMART values are from the last awake read. */
  standby: z.boolean(),
  /** null when SMART is off or could not be read. */
  smart: z
    .strictObject({
      health: smartHealthSchema,
      powerOnHours: nonNeg.optional(),
      /** ATA 5 Reallocated_Sector_Ct. */
      reallocated: nonNeg.optional(),
      /** ATA 197 Current_Pending_Sector. */
      pending: nonNeg.optional(),
      /** ATA 198 Offline_Uncorrectable. */
      uncorrectable: nonNeg.optional(),
      /** NVMe media and data integrity errors. */
      mediaErrors: nonNeg.optional(),
      /** NVMe percentage used (wear), may exceed 100. */
      wearPct: z.number().finite().min(0).max(255).optional(),
      /** When these values were read (may be older than the inventory while the disk sleeps). */
      readAt: isoTs,
    })
    .nullable(),
});
export type PhysicalDisk = z.infer<typeof physicalDiskSchema>;

export const storageInfoSchema = z.strictObject({
  /** Detected NAS platform; `ugreen` for UGREEN NASync / UGOS. */
  platform: z.strictObject({
    kind: z.enum(['ugreen', 'generic']),
    vendor: z.string().max(64).optional(),
    model: z.string().max(80).optional(),
  }),
  /**
   * SMART: `on` read with smartctl, `off` (HZ_AGENT_SMART=0, default), `unavailable`
   * (switched on but smartctl could not open the disks: missing rights).
   */
  smart: z.enum(['on', 'off', 'unavailable']),
  arrays: z.array(raidArraySchema).max(32),
  volumes: z.array(storageVolumeSchema).max(32),
  disks: z.array(physicalDiskSchema).max(64),
});
export type StorageInfo = z.infer<typeof storageInfoSchema>;

export const inventorySchema = z.strictObject({
  type: z.literal('inventory'),
  ts: isoTs,
  system: systemInfoSchema,
  containers: z.array(containerInfoSchema).max(500),
  /** null when the agent cannot read the package state. */
  updates: z
    .strictObject({
      total: z.number().int().nonnegative(),
      security: z.number().int().nonnegative(),
    })
    .nullable(),
  rebootRequired: z.boolean(),
  sshFailed24h: z.number().int().nonnegative().nullable(),
  /** null when fail2ban is not installed. */
  fail2banBanned: z.number().int().nonnegative().nullable(),
  listeningPorts: z.array(listeningPortSchema).max(1000),
  /** M13: md RAID, volumes, disks. Absent from older agents. */
  storage: storageInfoSchema.optional(),
  /** M16: systemd service units in state `failed` (names only). Absent without systemd. */
  failedServices: z.array(z.string().max(200)).max(50).optional(),
});
export type Inventory = z.infer<typeof inventorySchema>;

/** M17: what an image update replaces. `core` is the container with hz.role=core on this host. */
export const updateTargetSchema = z.enum(['agent', 'core']);
export type UpdateTarget = z.infer<typeof updateTargetSchema>;

/** M17: version of an image, from its OCI labels. */
export const imageVersionSchema = z.strictObject({
  /** Docker image id (sha256:...). */
  imageId: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  /** org.opencontainers.image.revision (git commit). */
  revision: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/)
    .optional(),
  /** org.opencontainers.image.version, e.g. sha-1a2b3c4 or v1.2.0. */
  version: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/)
    .optional(),
  /** org.opencontainers.image.created. */
  created: isoTs.optional(),
});
export type ImageVersion = z.infer<typeof imageVersionSchema>;

/**
 * M17 outcome of an update: updated (new image healthy), up_to_date (nothing to
 * do), rolled_back (new image failed the health check, old one runs again),
 * failed (could not update; the old container still runs unless the message says so).
 */
export const updateOutcomeSchema = z.enum(['updated', 'up_to_date', 'rolled_back', 'failed']);
export type UpdateOutcome = z.infer<typeof updateOutcomeSchema>;

export const agentEventSchema = z.strictObject({
  type: z.literal('event'),
  ts: isoTs,
  event: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('container'),
      dockerId: z.string().regex(/^[0-9a-f]{12,64}$/),
      name: z.string().max(128),
      action: z.enum([
        'start',
        'stop',
        'die',
        'restart',
        'kill',
        'pause',
        'unpause',
        'create',
        'destroy',
        'health_status',
      ]),
      exitCode: z.number().int().optional(),
      health: containerHealthSchema.optional(),
    }),
    z.strictObject({
      kind: z.literal('oom'),
      dockerId: z.string().regex(/^[0-9a-f]{12,64}$/),
      name: z.string().max(128),
    }),
    /**
     * M12: a sleeping game (game.wake.arm) got a connection that asks to play
     * (Minecraft login, Bedrock open-connection request, any TCP data or a
     * non-query UDP datagram). The agent has already closed all wake listeners of
     * that game. No client address is sent.
     */
    z.strictObject({
      kind: z.literal('game_wake'),
      gameId: gameFolderNameSchema,
      port: z.number().int().min(1024).max(65535),
      protocol: z.enum(['tcp', 'udp']),
    }),
    /**
     * M17: outcome of update.apply. Sent right after the update, or after the
     * next hello when the connection dropped meanwhile (core restart, agent
     * replaced). The core ignores unknown or finished runIds.
     */
    z.strictObject({
      kind: z.literal('update_result'),
      runId: rpcIdSchema,
      target: updateTargetSchema,
      outcome: updateOutcomeSchema,
      from: imageVersionSchema.optional(),
      to: imageVersionSchema.optional(),
      /** Short English reason on rolled_back/failed (no secrets, no paths outside the image). */
      message: z.string().max(300).optional(),
    }),
    z.strictObject({
      kind: z.literal('denied'),
      /** An action that was rejected by the allowlist or the path check. */
      action: z.string().max(64),
      reason: z.string().max(200),
    }),
  ]),
});
export type AgentEvent = z.infer<typeof agentEventSchema>;

export const rpcErrorCodeSchema = z.enum([
  'not_allowed',
  'invalid_params',
  'bad_path',
  'not_found',
  'busy',
  'failed',
  'timeout',
  'terminal_disabled',
  'confirm_mismatch',
]);
export type RpcErrorCode = z.infer<typeof rpcErrorCodeSchema>;

export const rpcResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    type: z.literal('rpc.result'),
    id: rpcIdSchema,
    ok: z.literal(true),
    data: z.unknown(),
  }),
  z.strictObject({
    type: z.literal('rpc.result'),
    id: rpcIdSchema,
    ok: z.literal(false),
    error: z.strictObject({ code: rpcErrorCodeSchema, message: z.string().max(500) }),
  }),
]);
export type RpcResult = z.infer<typeof rpcResultSchema>;

export const streamDataSchema = z.strictObject({
  type: z.literal('stream.data'),
  streamId: streamIdSchema,
  /** Which output: stdout/stderr of a process, or a progress line. */
  channel: z.enum(['stdout', 'stderr', 'progress']).default('stdout'),
  chunk: z.string().max(MAX_CHUNK_CHARS),
});
export type StreamData = z.infer<typeof streamDataSchema>;

export const streamEndSchema = z.strictObject({
  type: z.literal('stream.end'),
  streamId: streamIdSchema,
  code: z.number().int(),
  error: z.string().max(500).optional(),
});
export type StreamEnd = z.infer<typeof streamEndSchema>;

// ---------------------------------------------------------------------------
// M11: binary transfer of a game archive (game.export / game.import)
//
// Both actions are streaming actions: the rpc id is the stream id (= transfer
// id). Archive bytes travel as base64 in `transfer.chunk` frames, separate from
// the text frames of stream.data. The receiver acknowledges with
// `transfer.ack`; the sender keeps at most TRANSFER_WINDOW chunks unacked.
//
// game.export (source agent -> core):
//   rpc.result ok (accepted) -> stream.data progress lines (archive is built)
//   -> transfer.begin {bytes, sha256, chunks} -> transfer.chunk seq 0..chunks-1
//   (core answers transfer.ack) -> transfer.end -> stream.end 0.
// game.import (core -> target agent):
//   rpc.result ok (accepted, staging created) -> core sends transfer.chunk
//   seq 0..chunks-1 (agent answers transfer.ack) -> core sends transfer.end
//   -> agent verifies size + sha256, checks every archive member
//   (checkArchiveMember), extracts, sends progress lines, last one
//   `result {json}` (gameImportDoneDataSchema) -> stream.end 0.
// Errors: stream.end with code != 0 and `error` = a transferErrorCode.
// stream.cancel (either side aborts) makes the agent delete its temp files.
// No chunk or ack for TRANSFER_IDLE_TIMEOUT_MS: the transfer is aborted.

/** Raw bytes per chunk. base64 of 48 KiB is exactly MAX_CHUNK_CHARS (64 Ki chars). */
export const TRANSFER_CHUNK_BYTES = 48 * 1024;
/** Max unacknowledged chunks in flight (1,5 MiB). */
export const TRANSFER_WINDOW = 32;
/** Abort a transfer after this long without a chunk or an ack. */
export const TRANSFER_IDLE_TIMEOUT_MS = 60_000;
/** Largest game archive a migration moves (50 GiB). */
export const MIGRATION_MAX_BYTES = 50 * 1024 * 1024 * 1024;
/** Upper bound for the number of chunks of one transfer. */
export const MAX_TRANSFER_CHUNKS = Math.ceil(MIGRATION_MAX_BYTES / TRANSFER_CHUNK_BYTES);
/** Max entries (files + dirs) in an imported archive. */
export const ARCHIVE_MAX_ENTRIES = 1_000_000;
/** Max length of one archive member path. */
export const ARCHIVE_MAX_PATH = 1024;
/** The only top-level member of a game archive (world data, like game.backup). */
export const GAME_ARCHIVE_ROOT = 'data';
/**
 * Import staging folder, on the same file system as the game folders so the
 * final rename is atomic: /opt/homelab/games/.import-<streamId>/ (a dot name
 * never matches gameFolderNameSchema).
 */
export const IMPORT_STAGING_PREFIX = '.import-';

export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const transferBytes = z.number().int().min(1).max(MIGRATION_MAX_BYTES);
const transferSeq = z
  .number()
  .int()
  .min(0)
  .max(MAX_TRANSFER_CHUNKS - 1);
const transferChunkCount = z.number().int().min(1).max(MAX_TRANSFER_CHUNKS);

/** Standard base64 (with padding) of 1..TRANSFER_CHUNK_BYTES bytes. */
export const transferDataSchema = z
  .string()
  .min(4)
  .max(MAX_CHUNK_CHARS)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/)
  .refine((s) => s.length % 4 === 0, { message: 'invalid base64 length' });

/** Agent -> core only (game.export): archive is built, size and checksum are known. */
export const transferBeginSchema = z.strictObject({
  type: z.literal('transfer.begin'),
  streamId: streamIdSchema,
  bytes: transferBytes,
  sha256: sha256Schema,
  chunks: transferChunkCount,
});
export type TransferBegin = z.infer<typeof transferBeginSchema>;

/**
 * Both directions. Chunks are sent in order; every chunk except the last has
 * exactly TRANSFER_CHUNK_BYTES raw bytes (checked by the receiver). A gap,
 * duplicate or out-of-order seq aborts the transfer with error `sequence`.
 */
export const transferChunkSchema = z.strictObject({
  type: z.literal('transfer.chunk'),
  streamId: streamIdSchema,
  seq: transferSeq,
  data: transferDataSchema,
});
export type TransferChunk = z.infer<typeof transferChunkSchema>;

/** Both directions. `seq` is the highest seq received in order. */
export const transferAckSchema = z.strictObject({
  type: z.literal('transfer.ack'),
  streamId: streamIdSchema,
  seq: transferSeq,
});
export type TransferAck = z.infer<typeof transferAckSchema>;

/** Both directions: after the last chunk. The receiver compares all three values. */
export const transferEndSchema = z.strictObject({
  type: z.literal('transfer.end'),
  streamId: streamIdSchema,
  chunks: transferChunkCount,
  bytes: transferBytes,
  sha256: sha256Schema,
});
export type TransferEnd = z.infer<typeof transferEndSchema>;

/** Value of stream.end.error for failed game.export / game.import. */
export const transferErrorCodeSchema = z.enum([
  /** Archive larger than maxBytes / announced bytes. */
  'too_large',
  /** Received bytes or sha256 differ from transfer.end. */
  'checksum_mismatch',
  /** An archive member failed checkArchiveMember, or tar failed to list/extract. */
  'bad_archive',
  /** Gap, duplicate or out-of-order chunk, or a chunk with the wrong size. */
  'sequence',
  /** Nothing received for TRANSFER_IDLE_TIMEOUT_MS. */
  'timeout',
  /** stream.cancel received. */
  'cancelled',
  /** Target game folder already has a data/ folder. */
  'exists',
  /** Disk full or another I/O error. */
  'io',
]);
export type TransferErrorCode = z.infer<typeof transferErrorCodeSchema>;

export type ArchiveMemberKind = 'file' | 'dir' | 'symlink' | 'hardlink' | 'other';
export type ArchiveMemberCheck = { ok: true } | { ok: false; reason: string };

/**
 * Checks one member of an archive before game.import extracts anything.
 * Allowed: regular files and directories named `data`, `data/` or `data/...`.
 * Rejected: absolute paths, `..` / `.` / empty segments, `./` prefixes, NUL and
 * control characters, paths longer than ARCHIVE_MAX_PATH, and every symlink,
 * hard link, device, FIFO or socket. The agent lists the whole archive first
 * and extracts only if every member passes.
 */
export function checkArchiveMember(path: string, kind: ArchiveMemberKind): ArchiveMemberCheck {
  if (kind !== 'file' && kind !== 'dir') return { ok: false, reason: `${kind} not allowed` };
  if (path.length === 0 || path.length > ARCHIVE_MAX_PATH) return { ok: false, reason: 'length' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return { ok: false, reason: 'control character' };
  if (path.startsWith('/')) return { ok: false, reason: 'absolute path' };
  const trimmed = kind === 'dir' && path.endsWith('/') ? path.slice(0, -1) : path;
  const segs = trimmed.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) {
    return { ok: false, reason: 'path must be normalized' };
  }
  if (segs[0] !== GAME_ARCHIVE_ROOT) return { ok: false, reason: 'outside data/' };
  if (kind === 'file' && segs.length === 1) return { ok: false, reason: 'data must be a folder' };
  return { ok: true };
}

export const pingSchema = z.strictObject({ type: z.literal('ping'), ts: isoTs });
export const pongSchema = z.strictObject({ type: z.literal('pong'), ts: isoTs });

export const agentToCoreSchema = z.discriminatedUnion('type', [
  helloSchema,
  metricsSchema,
  inventorySchema,
  agentEventSchema,
  rpcResultSchema,
  streamDataSchema,
  streamEndSchema,
  pingSchema,
  pongSchema,
  transferBeginSchema,
  transferChunkSchema,
  transferAckSchema,
  transferEndSchema,
]);
export type AgentToCore = z.infer<typeof agentToCoreSchema>;

// ---------------------------------------------------------------------------
// Core -> agent

export const enrolledSchema = z.strictObject({
  type: z.literal('enrolled'),
  /** Permanent agent token. The agent stores it in /data/agent.json. */
  agentToken: agentTokenSchema,
  serverId: z.string().max(64),
});
export const welcomeSchema = z.strictObject({
  type: z.literal('welcome'),
  serverId: z.string().max(64),
  protocol: z.number().int().positive(),
  /** Requested intervals. */
  metricsIntervalS: z.number().int().min(5).max(300),
  inventoryIntervalS: z.number().int().min(15).max(3600),
});
export const rejectSchema = z.strictObject({
  type: z.literal('reject'),
  code: z.enum(['bad_token', 'revoked', 'protocol', 'name_taken', 'invalid']),
});

/**
 * WebSocket close codes the core uses on /agent. After `reject` the core closes
 * with REJECTED (or REVOKED); an agent should not retry a rejected token in a
 * tight loop.
 */
export const AGENT_CLOSE = {
  /** Another connection of the same server replaced this one. */
  REPLACED: 4000,
  /** Sent after a `reject` (bad token, protocol, name taken, invalid hello). */
  REJECTED: 4001,
  /** No valid `hello` within 10 s. */
  HELLO_TIMEOUT: 4002,
  /** The agent token was revoked or the server was deleted. */
  REVOKED: 4003,
  /** Too many invalid or too many messages. */
  POLICY: 1008,
} as const;

/** Time the agent has to send `hello` after connecting. */
export const HELLO_TIMEOUT_MS = 10_000;

// RPC params, one schema per allowed action -------------------------------

const containerIdParams = z.strictObject({ id: containerRefSchema });
const dirParams = z.strictObject({ dir: homelabPathSchema });
const timeoutMs = z.number().int().min(100).max(60_000);
const hostSchema = z
  .string()
  .max(253)
  .regex(/^[A-Za-z0-9.:[\]-]+$/);

export const httpCheckParamsSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }).max(2048),
  method: z.enum(['GET', 'HEAD']).default('GET'),
  expectStatusMin: z.number().int().min(100).max(599).default(200),
  expectStatusMax: z.number().int().min(100).max(599).default(399),
  contains: z.string().max(200).optional(),
  timeoutMs: timeoutMs.default(10_000),
});
export const tcpCheckParamsSchema = z.strictObject({
  host: hostSchema,
  port: z.number().int().min(1).max(65535),
  timeoutMs: timeoutMs.default(10_000),
});
export const pingCheckParamsSchema = z.strictObject({
  host: hostSchema,
  count: z.number().int().min(1).max(5).default(3),
  timeoutMs: timeoutMs.default(10_000),
});

/**
 * File names compose.write accepts: plain names plus exactly `.env` (secrets of a
 * game folder, written by the agent with mode 0600). No other dotfiles.
 */
export const composeFileNameSchema = z.union([z.literal('.env'), fileNameSchema]);

export const composeFilesSchema = z
  .record(composeFileNameSchema, z.string().max(256 * 1024))
  .refine((files) => Object.keys(files).length >= 1 && Object.keys(files).length <= 20, {
    message: '1 to 20 files',
  });

/** GitHub owner/repo segment: no leading dash or dot, not ".git" itself. */
const GH_SEG = '[A-Za-z0-9_][A-Za-z0-9_.-]*';
export const repoUrlSchema = z
  .string()
  .max(300)
  .regex(
    new RegExp(`^(https://github\\.com/${GH_SEG}/${GH_SEG}|git@github\\.com:${GH_SEG}/${GH_SEG})$`),
  )
  .refine(
    (u) => {
      const parts = u.replace(/^.*github\.com[:/]/, '').split('/');
      return parts.every((p) => p.replace(/\.git$/, '').length > 0 && !p.includes('..'));
    },
    { message: 'invalid repo url' },
  );

// ---------------------------------------------------------------------------
// M12: mods, restore

/**
 * A relative path below a game's data/ folder ("world", "Saves/Multiplayer"):
 * segments of letters, digits, . _ -, no empty, "." or ".." segment.
 */
export const worldPathSchema = z
  .string()
  .max(120)
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/)
  .refine((p) => !p.split('/').some((seg) => seg === '.' || seg === '..'), {
    message: 'invalid path',
  });

/** Paper plugins (data/plugins) or Fabric mods (data/mods). */
export const modKindSchema = z.enum(['plugins', 'mods']);
export type ModKind = z.infer<typeof modKindSchema>;
/** Largest mod/plugin jar the agent downloads (100 MiB). */
export const MOD_MAX_BYTES = 100 * 1024 * 1024;
/** A jar file name: no path, no leading dot. */
export const modFileNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,118}\.jar$/)
  .refine((n) => !n.includes('..'), { message: 'invalid file name' });
/** Only files of Modrinth's CDN: https://cdn.modrinth.com/data/<project>/versions/<version>/<file>. */
export const modrinthCdnUrlSchema = z
  .string()
  .max(400)
  .regex(
    /^https:\/\/cdn\.modrinth\.com\/data\/[A-Za-z0-9]{8}\/versions\/[A-Za-z0-9]{8}\/[A-Za-z0-9._+%-]{1,200}\.jar$/,
  )
  .refine((u) => !u.includes('..') && !/%2f|%5c|%00/i.test(u), { message: 'invalid url' });
/** Backup archive name as written by game.backup: <gameId>-YYYYMMDD-HHMMSS.tar.zst. */
export const backupFileNameSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])-\d{8}-\d{6}\.tar\.zst$/);

// ---------------------------------------------------------------------------
// M16 Server-Verwaltung and M17 Auto-Update: params of the new actions.

/** What system.cleanup can clean (system.cleanupPreview lists the same kinds). */
export const cleanupKindSchema = z.enum([
  'apt-cache',
  'old-kernels',
  'journal',
  'docker-images',
  'docker-build-cache',
]);
export type CleanupKind = z.infer<typeof cleanupKindSchema>;

/** Host paths system.du never measures (virtual file systems, sockets). */
export const DU_DENIED_ROOTS = ['/proc', '/sys', '/dev', '/run'] as const;

/**
 * An absolute, normalized directory on the host for system.du ("größte Ordner").
 * Read-only: the agent only sums sizes. No control characters, no `.`/`..`
 * segments, no `//`, no trailing slash (except `/` itself), never below
 * /proc, /sys, /dev or /run.
 */
export const hostDirPathSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((p) => p.startsWith('/'), { message: 'absolute path required' })
  .refine((p) => ![...p].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f), {
    message: 'control character in path',
  })
  .refine((p) => p === '/' || !p.endsWith('/'), { message: 'path must be normalized' })
  .refine((p) => !p.includes('//'), { message: 'path must be normalized' })
  .refine((p) => !p.split('/').some((seg) => seg === '..' || seg === '.'), {
    message: 'path must be normalized',
  })
  .refine((p) => !DU_DENIED_ROOTS.some((r) => p === r || p.startsWith(`${r}/`)), {
    message: 'path not allowed',
  });

/**
 * A systemd service unit the agent may start/stop/restart (system.service).
 * The agent additionally requires it in HZ_AGENT_SERVICES and refuses the
 * hard-coded deny list (SERVICE_DENYLIST).
 */
export const serviceUnitSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9@._:-]{0,120}\.service$/)
  .refine((u) => !u.includes('..'), { message: 'invalid unit' });

/**
 * Units that are never started, stopped or restarted from the UI, whatever
 * HZ_AGENT_SERVICES says: stopping them cuts off the agent, the tailnet, SSH or
 * the host itself. Compared without the `.service` suffix and without an `@instance`.
 */
export const SERVICE_DENYLIST = [
  'tailscaled',
  'docker',
  'containerd',
  'ssh',
  'sshd',
  'dbus',
  'dbus-broker',
  'systemd-journald',
  'systemd-logind',
  'systemd-networkd',
  'systemd-resolved',
  'systemd-udevd',
  'networking',
  'NetworkManager',
  'getty',
  'serial-getty',
] as const;

/** True when `unit` (e.g. "sshd.service", "getty@tty1.service") is on SERVICE_DENYLIST. */
export function isDeniedServiceUnit(unit: string): boolean {
  const base = unit.replace(/\.service$/, '').replace(/@.*$/, '');
  return (SERVICE_DENYLIST as readonly string[]).includes(base) || base.startsWith('systemd-');
}

export const serviceOpSchema = z.enum(['start', 'stop', 'restart']);
export type ServiceOp = z.infer<typeof serviceOpSchema>;

export const processSortSchema = z.enum(['cpu', 'mem']);
export type ProcessSort = z.infer<typeof processSortSchema>;

const ptySize = { cols: z.number().int().min(10).max(500), rows: z.number().int().min(5).max(200) };

/** M14 Wake-on-LAN: normalised MAC (upper case, ":"), unicast (I/G bit clear), not all zero. */
export const wolMacSchema = z
  .string()
  .regex(/^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/)
  .refine((m) => m !== '00:00:00:00:00:00' && (Number.parseInt(m.slice(0, 2), 16) & 1) === 0, {
    message: 'invalid mac',
  });

const WOL_IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/** Broadcast target of a magic packet: 255.255.255.255 or an address in a private IPv4 range. */
export function isAllowedWolBroadcast(ip: string): boolean {
  if (!WOL_IPV4.test(ip)) return false;
  if (ip === '255.255.255.255') return true;
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * The allowlist. Each entry maps an action to its params schema.
 * Anything not listed here is rejected by the agent and logged.
 */
export const rpcParamsByAction = {
  /** Log search, vulnerability scan, fail2ban (agent-ops.ts). */
  ...opsRpcParams,
  'container.start': containerIdParams,
  'container.stop': containerIdParams,
  'container.restart': containerIdParams,
  /** Pull the image and recreate a standalone container with the same config. */
  'container.update': containerIdParams,
  /**
   * `docker update --cpus <cpus>`; cpus null removes the limit (--cpus 0).
   * Nothing else is changed (never memory). The agent refuses containers with
   * the label hz.role (core, agent) and its own container with not_allowed, and
   * caps cpus at the host's CPU count. Result: containerLimitDataSchema.
   */
  'container.limit': z.strictObject({ id: containerRefSchema, cpus: cpusSchema.nullable() }),
  /** Stream: the rpc id is the stream id. */
  'container.logs': z.strictObject({
    id: containerRefSchema,
    tail: z.number().int().min(0).max(5000).default(500),
    follow: z.boolean().default(false),
  }),
  'compose.up': dirParams,
  'compose.down': dirParams,
  'compose.pull': dirParams,
  'compose.write': z.strictObject({ dir: homelabPathSchema, files: composeFilesSchema }),
  'game.rcon': z.strictObject({
    gameDir: homelabPathSchema,
    command: z
      .string()
      .min(1)
      .max(1000)
      .refine((c) => !/[\r\n\0]/.test(c), { message: 'single line only' }),
  }),
  /** Stream. World folder as tar.zst into /opt/homelab/backups/, keeps the last `keep`. */
  'game.backup': z.strictObject({
    gameDir: homelabPathSchema,
    keep: z.number().int().min(1).max(50).default(7),
  }),
  /**
   * Players/version/TPS of a game in /opt/homelab/games/<name>/. Query goes to
   * 127.0.0.1:<port>; RCON port and password are read by the agent from the
   * folder's .env (never sent over the wire). Result: gameStatusDataSchema.
   */
  'game.status': z.strictObject({
    gameDir: homelabPathSchema,
    method: z.enum(['minecraft', 'minecraft-bedrock', 'gamedig', 'none']),
    port: z.number().int().min(1).max(65535),
    gamedigType: gamedigTypeSchema.optional(),
    tpsCommand: z.enum(['tps']).optional(),
    timeoutMs: z.number().int().min(500).max(15_000).default(5000),
  }),
  /** compose down and remove a game folder (only /opt/homelab/games/<name>/). */
  'game.remove': z.strictObject({ gameDir: homelabPathSchema }),
  /**
   * Deletes backup archives `<gameId>-YYYYMMDD-HHMMSS.tar.zst` in
   * /opt/homelab/backups/<gameId>/ whose mtime is older than `olderThanDays` days,
   * then removes the folder if it is empty. `gameId` is the game's folder name (the
   * <name> of /opt/homelab/games/<name>/ and of the backup folder), not the core's
   * database id. A missing folder is success with removed 0. Never follows symlinks.
   * The core sends it for game servers that were deleted 30 days ago.
   * Result: gameBackupsPurgeDataSchema.
   */
  'game.backups.purge': z.strictObject({
    gameId: gameFolderNameSchema,
    olderThanDays: z.number().int().min(1).max(3650),
  }),
  /**
   * M11, stream (see "binary transfer" above). Builds a tar.zst of
   * /opt/homelab/games/<gameId>/data (same content and save-off/flush as
   * game.backup; compose.yml and .env are NOT included, the core rewrites them
   * on the target) into /opt/homelab/backups/<gameId>/.export-<streamId>.tar.zst
   * (O_EXCL, no symlinks), then sends it with transfer.begin/chunk/end. The temp
   * file is deleted at stream end or cancel. The game folder is left unchanged.
   * The agent builds the path itself from gameId; no path comes from the wire.
   */
  'game.export': z.strictObject({
    gameId: gameFolderNameSchema,
    maxBytes: z.number().int().min(1).max(MIGRATION_MAX_BYTES).default(MIGRATION_MAX_BYTES),
    /**
     * M12 world download for friends: only these sub paths of data/ go into the
     * archive (as data/<path>), nothing else (no server.properties, configs with
     * RCON/admin passwords, logs with player IPs). Missing paths are skipped;
     * symlinks are never followed. Without `paths`: the whole data/ (migration).
     */
    paths: z.array(worldPathSchema).min(1).max(10).optional(),
  }),
  /**
   * M11, stream. Receives an archive into
   * /opt/homelab/games/.import-<streamId>/, verifies bytes and sha256, checks
   * every member with checkArchiveMember, extracts without owners/permissions
   * of the archive and renames data/ to /opt/homelab/games/<gameId>/data.
   * Refused before the rpc.result with `busy` when that data/ already exists
   * or an import for gameId is running, with `bad_path` when the game folder
   * exists but is not a real directory. The game folder itself may exist
   * (compose.write). Never starts the game. Result: last progress line
   * `result {json}` (gameImportDoneDataSchema).
   */
  'game.import': z.strictObject({
    gameId: gameFolderNameSchema,
    bytes: z.number().int().min(1).max(MIGRATION_MAX_BYTES),
    sha256: sha256Schema,
    chunks: z.number().int().min(1).max(MAX_TRANSFER_CHUNKS),
  }),
  /**
   * M12 sleep mode. Opens wake listeners on the given host ports of a stopped
   * game (refused with `busy` while its container runs). Every port must be a host
   * port the game's /opt/homelab/games/<gameId>/compose.yml publishes (checked by
   * the agent, `not_allowed` otherwise). Listeners bind 0.0.0.0, never forward a
   * byte, cap concurrent connections (16) and frame sizes (1 KiB), and answer:
   * - minecraft (TCP): status ping -> MOTD `motd` and 0/0 players, no wake;
   *   login -> disconnect "Server startet, bitte in 1 Minute neu verbinden" and wake.
   * - minecraft-bedrock (UDP): unconnected ping -> pong with `motd`, no wake;
   *   open connection request -> wake.
   * - raw (TCP or UDP): first TCP data byte or first UDP datagram that is not a
   *   Steam A2S query (0xFFFFFFFF 'T'/'U'/'V'/'W') -> wake.
   * On wake the agent closes all listeners of the game, emits event `game_wake`
   * and frees the ports before the core starts the game. Re-arming replaces the
   * old listeners. Listeners are lost on agent restart (the core re-arms).
   * Result: gameWakeArmDataSchema.
   */
  'game.wake.arm': z.strictObject({
    gameId: gameFolderNameSchema,
    mode: z.enum(['minecraft', 'minecraft-bedrock', 'raw']),
    ports: z
      .array(
        z.strictObject({
          port: z.number().int().min(1024).max(65535),
          protocol: z.enum(['tcp', 'udp']),
        }),
      )
      .min(1)
      .max(4),
    /** Shown in the Minecraft server list while asleep. */
    motd: z
      .string()
      .max(60)
      .regex(/^[\p{L}\p{N} .,:!?()_\u2013-]*$/u),
  }),
  /** Closes all wake listeners of a game (no error when none are open). */
  'game.wake.disarm': z.strictObject({ gameId: gameFolderNameSchema }),
  /**
   * M12 mods/plugins (Paper: data/plugins, Fabric: data/mods). Lists *.jar files
   * (regular files only, no symlinks, max 500). Result: gameModsListDataSchema.
   */
  'game.mods.list': z.strictObject({ gameId: gameFolderNameSchema, kind: modKindSchema }),
  /**
   * Downloads one jar from Modrinth's CDN (https only, no redirects to other
   * hosts, at most sizeBytes and MOD_MAX_BYTES), verifies size and sha512, writes
   * it with O_EXCL to a temp name in the same folder and renames it into
   * data/<kind>/<fileName>. `busy` when the file already exists.
   * Result: gameModFileSchema.
   */
  'game.mods.install': z.strictObject({
    gameId: gameFolderNameSchema,
    kind: modKindSchema,
    url: modrinthCdnUrlSchema,
    fileName: modFileNameSchema,
    sha512: z.string().regex(/^[0-9a-f]{128}$/),
    sizeBytes: z.number().int().min(1).max(MOD_MAX_BYTES),
  }),
  /** Deletes data/<kind>/<fileName> (regular file only). */
  'game.mods.remove': z.strictObject({
    gameId: gameFolderNameSchema,
    kind: modKindSchema,
    fileName: modFileNameSchema,
  }),
  /**
   * M12, stream. Restores /opt/homelab/backups/<gameId>/<fileName> into
   * /opt/homelab/games/<gameId>/data. Refused with `busy` while the game's
   * container runs. Checks every member with checkArchiveMember, extracts into
   * /opt/homelab/games/.restore-<streamId>/ (no owners/permissions from the
   * archive), then swaps: data -> .data-before-restore (one kept, older one
   * deleted), new data -> data. On any error the old data stays in place.
   * Never starts the game. Last progress line: `result {json}`
   * (gameRestoreDoneDataSchema).
   */
  'game.restore': z.strictObject({
    gameId: gameFolderNameSchema,
    fileName: backupFileNameSchema,
  }),
  /** Stream. */
  'deploy.run': z.strictObject({
    dir: homelabPathSchema,
    repoUrl: repoUrlSchema,
    sha: shaSchema,
    method: z.enum(['compose', 'script']),
    /** Deploy key on the agent (from deploy.key); required for and only allowed with git@github.com URLs. */
    keyName: fileNameSchema.optional(),
  }),
  /**
   * Creates (or returns the existing) ed25519 deploy key `name` in the agent's data
   * dir. Result: { publicKey }. The private key never leaves the server.
   */
  'deploy.key': z.strictObject({ name: fileNameSchema }),
  'system.cleanupPreview': z.strictObject({}),
  /**
   * M16: `items` picks what to clean (default: everything from the preview).
   * Never removes containers or volumes.
   */
  'system.cleanup': z.strictObject({
    items: z
      .array(cleanupKindSchema)
      .min(1)
      .max(5)
      .refine((a) => new Set(a).size === a.length, { message: 'duplicate item' })
      .optional(),
  }),
  'system.reboot': z.strictObject({ confirmName: agentNameSchema }),
  /**
   * M14: sends one Wake-on-LAN magic packet (6 x 0xFF + 16 x MAC, 102 bytes) as
   * UDP broadcast to broadcast:port from the agent (host network). Nothing else:
   * no other payload, no other port. At most 6 per minute on the agent.
   */
  'wol.send': z.strictObject({
    mac: wolMacSchema,
    broadcast: z
      .string()
      .max(15)
      .refine(isAllowedWolBroadcast, { message: 'broadcast not allowed' }),
    port: z.union([z.literal(7), z.literal(9)]),
  }),
  'check.http': httpCheckParamsSchema,
  'check.tcp': tcpCheckParamsSchema,
  'check.ping': pingCheckParamsSchema,
  /** Stream: output of the PTY. Only with HZ_AGENT_ALLOW_TERMINAL=1. */
  'pty.open': z.strictObject(ptySize),
  'pty.input': z.strictObject({ streamId: streamIdSchema, data: z.string().max(16 * 1024) }),
  'pty.resize': z.strictObject({ streamId: streamIdSchema, ...ptySize }),
  'pty.close': z.strictObject({ streamId: streamIdSchema }),

  // M16 Server-Verwaltung ----------------------------------------------------
  /**
   * Sizes of the direct children of one host directory (`du -x -d1`), largest
   * first, at most 30. Read-only, stays on the file system of `path`.
   */
  'system.du': z.strictObject({ path: hostDirPathSchema }),
  /** Docker disk usage: images, containers, volumes, build cache (read-only). */
  'system.dockerDf': z.strictObject({}),
  /** systemd service units of the host with their state (read-only). */
  'system.services': z.strictObject({}),
  /** Start/stop/restart one unit listed in HZ_AGENT_SERVICES (never SERVICE_DENYLIST). */
  'system.service': z.strictObject({ unit: serviceUnitSchema, op: serviceOpSchema }),
  /** Top processes of the host by CPU or RAM; process names only, never arguments. */
  'system.processes': z.strictObject({
    sort: processSortSchema,
    limit: z.number().int().min(1).max(50),
  }),
  /** Powers the host off (`systemctl poweroff`). Same checks as system.reboot. */
  'system.shutdown': z.strictObject({ confirmName: agentNameSchema }),

  // M17 Auto-Update ----------------------------------------------------------
  /**
   * Pulls the image tag of the target container (never a different image) and
   * compares it with the running one. Changes nothing else.
   */
  'update.check': z.strictObject({ target: updateTargetSchema }),
  /**
   * Starts the update of the target container and answers at once
   * ({ accepted: true }). The outcome arrives later as event `update_result`
   * with the same runId, also after a reconnect (persisted on the agent).
   * core: the agent recreates the core container with the new image and rolls
   * back unless the core is healthy within 3 min. agent: a short-lived helper
   * container (old image, label hz.role=updater) recreates the agent and rolls
   * back unless the new agent reconnects (healthy) within 3 min.
   */
  'update.apply': z.strictObject({ target: updateTargetSchema, runId: rpcIdSchema }),
  /**
   * OS packages: `apt-get update` + `apt-get -y upgrade` with fixed arguments
   * (no dist-upgrade, no removals, keeps changed config files). apt hosts only.
   */
  'system.upgrade': z.strictObject({}),
} as const;

export type RpcAction = keyof typeof rpcParamsByAction;
export const rpcActions = Object.keys(rpcParamsByAction) as RpcAction[];
export const rpcActionSchema = z.enum(rpcActions as [RpcAction, ...RpcAction[]]);
export type RpcParams<A extends RpcAction> = z.infer<(typeof rpcParamsByAction)[A]>;
export type RpcParamsInput<A extends RpcAction> = z.input<(typeof rpcParamsByAction)[A]>;

/** Actions whose output is a stream (stream.data / stream.end with streamId = rpc id). */
export const streamingActions: readonly RpcAction[] = [
  'container.logs',
  'game.backup',
  'deploy.run',
  'pty.open',
  'game.export',
  'game.import',
  'game.restore',
];
/** Actions that need HZ_AGENT_ALLOW_TERMINAL=1 on the agent and step-up in the core. */
export const terminalActions: readonly RpcAction[] = [
  'pty.open',
  'pty.input',
  'pty.resize',
  'pty.close',
];

/** Envelope; params are validated separately against rpcParamsByAction[action]. */
export const rpcEnvelopeSchema = z.strictObject({
  type: z.literal('rpc'),
  id: rpcIdSchema,
  action: z.string().max(64),
  params: z.unknown(),
});
export type RpcEnvelope = z.infer<typeof rpcEnvelopeSchema>;

export type RpcRequest = {
  [A in RpcAction]: { type: 'rpc'; id: string; action: A; params: RpcParams<A> };
}[RpcAction];

export type RpcParseResult =
  | { ok: true; request: RpcRequest }
  | { ok: false; code: 'not_allowed' | 'invalid_params'; message: string };

/** Validates an RPC: the action must be on the allowlist and the params must match. */
export function parseRpc(envelope: RpcEnvelope): RpcParseResult {
  const action = envelope.action;
  if (!Object.hasOwn(rpcParamsByAction, action)) {
    return { ok: false, code: 'not_allowed', message: 'action not allowed' };
  }
  const schema = rpcParamsByAction[action as RpcAction];
  const parsed = schema.safeParse(envelope.params);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'invalid_params',
      message: parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')
        .slice(0, 500),
    };
  }
  return {
    ok: true,
    request: { type: 'rpc', id: envelope.id, action, params: parsed.data } as RpcRequest,
  };
}

export const streamCancelSchema = z.strictObject({
  type: z.literal('stream.cancel'),
  streamId: streamIdSchema,
});

export const coreToAgentSchema = z.discriminatedUnion('type', [
  enrolledSchema,
  welcomeSchema,
  rejectSchema,
  rpcEnvelopeSchema,
  streamCancelSchema,
  pingSchema,
  pongSchema,
  transferChunkSchema,
  transferAckSchema,
  transferEndSchema,
]);
export type CoreToAgent = z.infer<typeof coreToAgentSchema>;

// RPC result data (what the agent returns in rpc.result.data) ---------------

export const checkResultDataSchema = z.strictObject({
  ok: z.boolean(),
  code: z.number().int().optional(),
  ms: nonNeg.nullable(),
  error: z.string().max(300).optional(),
  /** HTTPS only: certificate expiry. */
  tlsExpiresAt: isoTs.optional(),
});
export type CheckResultData = z.infer<typeof checkResultDataSchema>;

export const cleanupPreviewDataSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      kind: cleanupKindSchema,
      bytes: nonNeg,
      detail: z.string().max(200).optional(),
    }),
  ),
  totalBytes: nonNeg,
});
export type CleanupPreviewData = z.infer<typeof cleanupPreviewDataSchema>;

/** Result of container.limit: the limit now in effect (null = none). */
export const containerLimitDataSchema = z.strictObject({ cpus: nonNeg.nullable() });
export type ContainerLimitData = z.infer<typeof containerLimitDataSchema>;

export const cleanupDataSchema = z.strictObject({ freedBytes: nonNeg });
export const rconDataSchema = z.strictObject({ output: z.string().max(64 * 1024) });
export const backupDoneDataSchema = z.strictObject({
  path: homelabPathSchema,
  sizeBytes: nonNeg,
});
/** Result of game.backups.purge: number of archives deleted. */
export const gameBackupsPurgeDataSchema = z.strictObject({
  removed: z.number().int().nonnegative(),
});
export type GameBackupsPurgeData = z.infer<typeof gameBackupsPurgeDataSchema>;
/** game.import: JSON after the `result ` prefix of the last progress line. */
export const gameImportDoneDataSchema = z.strictObject({
  bytes: z.number().int().min(1).max(MIGRATION_MAX_BYTES),
  sha256: sha256Schema,
  /** Number of files and folders extracted. */
  entries: z.number().int().nonnegative().max(ARCHIVE_MAX_ENTRIES),
});
export type GameImportDoneData = z.infer<typeof gameImportDoneDataSchema>;
export const ptyOpenDataSchema = z.strictObject({ streamId: streamIdSchema });

/** Result of game.wake.arm: the ports that are listening now. */
export const gameWakeArmDataSchema = z.strictObject({
  listening: z
    .array(z.strictObject({ port: z.number().int(), protocol: z.enum(['tcp', 'udp']) }))
    .max(4),
});
export type GameWakeArmData = z.infer<typeof gameWakeArmDataSchema>;
export const gameModFileSchema = z.strictObject({
  fileName: modFileNameSchema,
  sizeBytes: z.number().int().nonnegative(),
  sha512: z.string().regex(/^[0-9a-f]{128}$/),
});
export type GameModFile = z.infer<typeof gameModFileSchema>;
/** Result of game.mods.list. A missing folder is an empty list. */
export const gameModsListDataSchema = z.strictObject({
  files: z.array(gameModFileSchema).max(500),
});
export type GameModsListData = z.infer<typeof gameModsListDataSchema>;
/** game.restore: JSON after the `result ` prefix of the last progress line. */
export const gameRestoreDoneDataSchema = z.strictObject({
  entries: z.number().int().nonnegative().max(ARCHIVE_MAX_ENTRIES),
});
export type GameRestoreDoneData = z.infer<typeof gameRestoreDoneDataSchema>;
export const gameStatusDataSchema = z.strictObject({
  online: z.boolean(),
  players: z
    .strictObject({
      online: z.number().int().nonnegative(),
      max: z.number().int().nonnegative(),
      names: z.array(z.string().max(40)).max(200),
    })
    .nullable(),
  version: z.string().max(80).nullable(),
  tps: z.number().nonnegative().max(100).nullable(),
});
export type GameStatusData = z.infer<typeof gameStatusDataSchema>;

/** Result of deploy.key: only the public half. */
export const deployKeyDataSchema = z.strictObject({
  publicKey: z
    .string()
    .max(200)
    .regex(/^ssh-ed25519 [A-Za-z0-9+/]+=* homelab-zentrale [A-Za-z0-9._-]+$/),
});

// M16 / M17 result data -------------------------------------------------------

export const duDataSchema = z.strictObject({
  path: z.string().max(256),
  /** Size of `path` itself (all children). */
  totalBytes: nonNeg,
  /** Largest first. Names only (one path segment). */
  entries: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(255),
        bytes: nonNeg,
        dir: z.boolean(),
      }),
    )
    .max(30),
  /** More children than listed, or the scan hit its time limit. */
  truncated: z.boolean(),
});
export type DuData = z.infer<typeof duDataSchema>;

const dfPart = {
  count: z.number().int().nonnegative(),
  bytes: nonNeg,
};
export const dockerDfDataSchema = z.strictObject({
  images: z.strictObject({
    ...dfPart,
    unusedCount: z.number().int().nonnegative(),
    unusedBytes: nonNeg,
  }),
  containers: z.strictObject({ ...dfPart, running: z.number().int().nonnegative() }),
  volumes: z.strictObject({
    ...dfPart,
    unusedCount: z.number().int().nonnegative(),
    unusedBytes: nonNeg,
  }),
  buildCache: z.strictObject({ ...dfPart, unusedBytes: nonNeg }),
});
export type DockerDfData = z.infer<typeof dockerDfDataSchema>;

export const serviceUnitInfoSchema = z.strictObject({
  name: z.string().max(200),
  description: z.string().max(200),
  /** loaded, not-found, masked ... */
  load: z.string().max(32),
  /** active, inactive, failed, activating ... */
  active: z.string().max(32),
  /** running, exited, dead, failed ... */
  sub: z.string().max(32),
  /** Listed in HZ_AGENT_SERVICES and not denied: start/stop/restart allowed. */
  manageable: z.boolean(),
});
export type ServiceUnitInfo = z.infer<typeof serviceUnitInfoSchema>;
export const servicesDataSchema = z.strictObject({
  /** False when the host has no systemd (units is empty then). */
  systemd: z.boolean(),
  units: z.array(serviceUnitInfoSchema).max(500),
});
export type ServicesData = z.infer<typeof servicesDataSchema>;

export const processInfoSchema = z.strictObject({
  pid: z.number().int().positive(),
  /** Process name (comm), never the command line: arguments can hold secrets. */
  name: z.string().max(64),
  user: z.string().max(64),
  /** Share of the whole machine, 0..100. */
  cpu: percent,
  memBytes: nonNeg,
  memPct: percent,
  /** R running, S sleeping, D disk, Z zombie ... */
  state: z.string().max(16),
  startedAt: isoTs.optional(),
  /** Name of the Docker container the process runs in, if known. */
  container: z.string().max(128).optional(),
});
export type ProcessInfo = z.infer<typeof processInfoSchema>;
export const processesDataSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  list: z.array(processInfoSchema).max(50),
});
export type ProcessesData = z.infer<typeof processesDataSchema>;

export const updateCheckDataSchema = z.strictObject({
  target: updateTargetSchema,
  /** Image reference the container runs (tag), e.g. ghcr.io/owner/homelab-agent:latest. */
  ref: z.string().max(256),
  current: imageVersionSchema,
  /** The freshly pulled image when it differs from the running one, else null. */
  available: imageVersionSchema.nullable(),
  /** False when the pull failed (offline, private registry); `available` is null then. */
  pulled: z.boolean(),
});
export type UpdateCheckData = z.infer<typeof updateCheckDataSchema>;
export const updateApplyDataSchema = z.strictObject({ accepted: z.literal(true) });
export const systemUpgradeDataSchema = z.strictObject({
  /** Packages upgraded. */
  upgraded: z.number().int().nonnegative(),
  /** Packages kept back (need dist-upgrade or a new dependency). */
  kept: z.number().int().nonnegative(),
  rebootRequired: z.boolean(),
});
export type SystemUpgradeData = z.infer<typeof systemUpgradeDataSchema>;

/** Parses a raw frame from the agent. Returns null for invalid JSON or schema mismatch. */
export function parseAgentMessage(raw: string): AgentToCore | null {
  if (raw.length > MAX_MESSAGE_BYTES) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = agentToCoreSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** Parses a raw frame from the core. Returns null for invalid JSON or schema mismatch. */
export function parseCoreMessage(raw: string): CoreToAgent | null {
  if (raw.length > MAX_MESSAGE_BYTES) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = coreToAgentSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
