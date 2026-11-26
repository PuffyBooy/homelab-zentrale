import { z } from 'zod';

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
  /** Value of the label hz.role when it is core or agent (never a throttle target). */
  role: z.enum(['core', 'agent']).optional(),
  /** Current --cpus limit (HostConfig.NanoCpus / 1e9), null without a limit. */
  cpuLimit: nonNeg.nullable().optional(),
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
});
export type Inventory = z.infer<typeof inventorySchema>;

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

const ptySize = { cols: z.number().int().min(10).max(500), rows: z.number().int().min(5).max(200) };

/**
 * The allowlist. Each entry maps an action to its params schema.
 * Anything not listed here is rejected by the agent and logged.
 */
export const rpcParamsByAction = {
  'container.start': containerIdParams,
  'container.stop': containerIdParams,
  'container.restart': containerIdParams,
  /** Pull the image and recreate a standalone container with the same config. */
  'container.update': containerIdParams,
  /** Stream: the rpc id is the stream id. */
  /**
   * `docker update --cpus <cpus>`; cpus null removes the limit (--cpus 0).
   * Nothing else is changed (never memory). The agent refuses containers with
   * the label hz.role (core, agent) and its own container with not_allowed, and
   * caps cpus at the host's CPU count. Result: containerLimitDataSchema.
   */
  'container.limit': z.strictObject({ id: containerRefSchema, cpus: cpusSchema.nullable() }),
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
    gamedigType: z.enum(['valheim', 'counterstrike2', 'palworld']).optional(),
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
  'system.cleanup': z.strictObject({}),
  'system.reboot': z.strictObject({ confirmName: agentNameSchema }),
  'check.http': httpCheckParamsSchema,
  'check.tcp': tcpCheckParamsSchema,
  'check.ping': pingCheckParamsSchema,
  /** Stream: output of the PTY. Only with HZ_AGENT_ALLOW_TERMINAL=1. */
  'pty.open': z.strictObject(ptySize),
  'pty.input': z.strictObject({ streamId: streamIdSchema, data: z.string().max(16 * 1024) }),
  'pty.resize': z.strictObject({ streamId: streamIdSchema, ...ptySize }),
  'pty.close': z.strictObject({ streamId: streamIdSchema }),
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
      kind: z.enum(['apt-cache', 'old-kernels', 'journal', 'docker-images', 'docker-build-cache']),
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
export const ptyOpenDataSchema = z.strictObject({ streamId: streamIdSchema });
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
