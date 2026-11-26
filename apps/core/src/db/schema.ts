import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * Drizzle schema. Must match `migrations.ts` (checked by test/db.test.ts).
 * All timestamps are milliseconds since epoch (UTC).
 */

export const users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  username: text('username').notNull().unique(),
  /** argon2id (PHC string). */
  passwordHash: text('password_hash').notNull(),
  /** Base32 secret, encrypted with crypto.ts (AAD `users.totp_secret`). */
  totpSecretEnc: text('totp_secret_enc').notNull(),
  /** Last accepted TOTP time step, so a code can never be used twice. */
  totpLastStep: integer('totp_last_step'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const sessions = sqliteTable(
  'sessions',
  {
    /** Public random id (shown in the session list, used to revoke). Not the cookie value. */
    id: text('id').primaryKey(),
    /** SHA-256 of the cookie value. The cookie value itself is never stored. */
    tokenHash: text('token_hash').notNull().unique(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull(),
    lastSeen: integer('last_seen').notNull(),
    expiresAt: integer('expires_at').notNull(),
    userAgent: text('user_agent').notNull().default(''),
    stepUpUntil: integer('step_up_until'),
  },
  (t) => [index('sessions_user_id').on(t.userId), index('sessions_expires_at').on(t.expiresAt)],
);

export const recoveryCodes = sqliteTable(
  'recovery_codes',
  {
    id: integer('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the normalized code (lowercase, no dash). */
    codeHash: text('code_hash').notNull().unique(),
    createdAt: integer('created_at').notNull(),
    usedAt: integer('used_at'),
  },
  (t) => [index('recovery_codes_user_id').on(t.userId)],
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey(),
    ts: integer('ts').notNull(),
    /** `admin`, `anonymous`, `system`, later `share:<id>`. */
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    target: text('target'),
    /** JSON, never contains secrets. */
    detailsJson: text('details_json'),
  },
  (t) => [index('audit_log_ts').on(t.ts)],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  /** JSON. Secret values inside are encrypted with crypto.ts. */
  valueJson: text('value_json').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// ---- M2: servers, agents, metrics, containers, alerts ---------------------

export const servers = sqliteTable('servers', {
  /** Random public id (base64url). */
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  location: text('location').notNull().default(''),
  arch: text('arch'),
  os: text('os'),
  tailscaleIp: text('tailscale_ip'),
  publicIp: text('public_ip'),
  agentVersion: text('agent_version'),
  /** Capabilities from the last hello ({terminal, docker}). */
  capabilitiesJson: text('capabilities_json'),
  /** Partial thresholds; missing keys use the defaults from @hz/shared. */
  thresholdsJson: text('thresholds_json').notNull().default('{}'),
  allowTerminal: integer('allow_terminal', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
  lastSeen: integer('last_seen'),
  /** M12: home | cloud | vps | other, null = not set (port forwarding hint). */
  network: text('network'),
});

/** Latest metrics and inventory of a server (one row per server). */
export const serverState = sqliteTable('server_state', {
  serverId: text('server_id')
    .primaryKey()
    .references(() => servers.id, { onDelete: 'cascade' }),
  /** Last `metrics` message without `type`. */
  metricsJson: text('metrics_json'),
  metricsAt: integer('metrics_at'),
  systemJson: text('system_json'),
  updatesJson: text('updates_json'),
  rebootRequired: integer('reboot_required', { mode: 'boolean' }),
  sshFailed24h: integer('ssh_failed_24h'),
  fail2banBanned: integer('fail2ban_banned'),
  listeningPortsJson: text('listening_ports_json'),
  inventoryAt: integer('inventory_at'),
});

export const agentTokens = sqliteTable(
  'agent_tokens',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    /** SHA-256 of `agent:<token>`. The token itself is never stored. */
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: integer('created_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (t) => [index('agent_tokens_server_id').on(t.serverId)],
);

export const enrollTokens = sqliteTable('enroll_tokens', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  location: text('location').notNull().default(''),
  /** SHA-256 of `enroll:<token>`. */
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
  /** Server created with this token. */
  serverId: text('server_id'),
});

/** Raw samples, kept 48 h. Percentages 0..100, net in bytes per second. */
export const metricsRaw = sqliteTable(
  'metrics_raw',
  {
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    ts: integer('ts').notNull(),
    cpu: real('cpu').notNull(),
    ram: real('ram').notNull(),
    swap: real('swap').notNull(),
    /** Highest usage of all disks. */
    diskMax: real('disk_max'),
    /** [{mount, pct}] */
    diskJson: text('disk_json').notNull().default('[]'),
    temp: real('temp'),
    netIn: real('net_in').notNull(),
    netOut: real('net_out').notNull(),
  },
  (t) => [index('metrics_raw_server_ts').on(t.serverId, t.ts), index('metrics_raw_ts').on(t.ts)],
);

const rollupColumns = {
  serverId: text('server_id')
    .notNull()
    .references(() => servers.id, { onDelete: 'cascade' }),
  /** Bucket start. */
  ts: integer('ts').notNull(),
  cpu: real('cpu').notNull(),
  ram: real('ram').notNull(),
  swap: real('swap').notNull(),
  diskMax: real('disk_max'),
  temp: real('temp'),
  netIn: real('net_in').notNull(),
  netOut: real('net_out').notNull(),
  /** Number of raw samples in the bucket (weight for the next level). */
  samples: integer('samples').notNull(),
};

/** 5-minute means, kept 30 days. */
export const metrics5m = sqliteTable('metrics_5m', rollupColumns, (t) => [
  primaryKey({ columns: [t.serverId, t.ts] }),
  index('metrics_5m_ts').on(t.ts),
]);

/** Hourly means, kept 1 year. */
export const metrics1h = sqliteTable('metrics_1h', { ...rollupColumns }, (t) => [
  primaryKey({ columns: [t.serverId, t.ts] }),
  index('metrics_1h_ts').on(t.ts),
]);

export const containers = sqliteTable(
  'containers',
  {
    /** Stable per server + name (containers/service.ts, containerCoreId). */
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Changes when the container is recreated (image update). */
    dockerId: text('docker_id').notNull(),
    image: text('image').notNull(),
    composeProject: text('compose_project'),
    composeService: text('compose_service'),
    /** Label com.docker.compose.project.working_dir as reported (not trusted as a path). */
    composeDir: text('compose_dir'),
    state: text('state').notNull(),
    health: text('health').notNull(),
    statusText: text('status_text').notNull().default(''),
    exitCode: integer('exit_code'),
    startedAt: integer('started_at'),
    restartCount: integer('restart_count'),
    cpu: real('cpu'),
    memBytes: real('mem_bytes'),
    portsJson: text('ports_json').notNull().default('[]'),
    /** Full ContainerInfo from the last inventory. */
    infoJson: text('info_json').notNull(),
    /**
     * Last admin action that takes the container down: `stop` (holds until the
     * container runs again) or `restart` (also image update, holds until intent_until).
     */
    intent: text('intent'),
    intentUntil: integer('intent_until'),
    /** Last OOM event, so the following `die` is reported as out of memory. */
    oomAt: integer('oom_at'),
    /** Alert class of the last evaluation (containers/status.ts), for transitions. */
    alertClass: text('alert_class'),
    updatedAt: integer('updated_at').notNull(),
    /** Last known memory usage (kept while stopped), for the derived RAM reserve (M10). */
    lastMemBytes: real('last_mem_bytes'),
    /** M12: label homelab.game (a valid game folder name) from the inventory. */
    gameLabel: text('game_label'),
  },
  (t) => [
    unique().on(t.serverId, t.name),
    index('containers_server_docker').on(t.serverId, t.dockerId),
  ],
);
export const alerts = sqliteTable(
  'alerts',
  {
    id: text('id').primaryKey(),
    /** Dedupe key: at most one open/acked alert per key. */
    key: text('key').notNull(),
    level: text('level').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    serverId: text('server_id').references(() => servers.id, { onDelete: 'set null' }),
    source: text('source').notNull(),
    state: text('state').notNull(),
    openedAt: integer('opened_at').notNull(),
    ackedAt: integer('acked_at'),
    resolvedAt: integer('resolved_at'),
  },
  (t) => [
    uniqueIndex('alerts_active_key')
      .on(t.key)
      .where(sql`state != 'resolved'`),
    index('alerts_opened_at').on(t.openedAt),
    index('alerts_server_id').on(t.serverId),
    index('alerts_state_opened').on(t.state, t.openedAt),
  ],
);

// ---- M4: checks, push ------------------------------------------------------

export const checks = sqliteTable('checks', {
  /** Random public id (base64url). */
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  /** Full CheckDef (shared schema) as JSON. Never contains credentials (rejected). */
  defJson: text('def_json').notNull(),
  /** `core` or the server id of the agent that runs the check. */
  runFrom: text('run_from').notNull(),
  serverId: text('server_id').references(() => servers.id, { onDelete: 'set null' }),
  intervalS: integer('interval_s').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** Evaluated status (checks/evaluate.ts). */
  status: text('status').notNull().default('busy'),
  reason: text('reason'),
  lastCode: integer('last_code'),
  lastMs: real('last_ms'),
  lastCheckedAt: integer('last_checked_at'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  consecutiveSlow: integer('consecutive_slow').notNull().default(0),
  /** First failure of the current failure streak. */
  downSince: integer('down_since'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** Raw results, kept 30 days. `error` is the short German reason, never a response body. */
export const checkResults = sqliteTable(
  'check_results',
  {
    checkId: text('check_id')
      .notNull()
      .references(() => checks.id, { onDelete: 'cascade' }),
    ts: integer('ts').notNull(),
    ok: integer('ok', { mode: 'boolean' }).notNull(),
    code: integer('code'),
    ms: real('ms'),
    error: text('error'),
  },
  (t) => [index('check_results_check_ts').on(t.checkId, t.ts), index('check_results_ts').on(t.ts)],
);

export const certStatus = sqliteTable('cert_status', {
  checkId: text('check_id')
    .primaryKey()
    .references(() => checks.id, { onDelete: 'cascade' }),
  sslExpiresAt: integer('ssl_expires_at'),
  domainExpiresAt: integer('domain_expires_at'),
  checkedAt: integer('checked_at'),
  domainCheckedAt: integer('domain_checked_at'),
});

export const pushSubscriptions = sqliteTable('push_subscriptions', {
  id: text('id').primaryKey(),
  /** SHA-256 of `push:<endpoint>`, to update instead of duplicate a subscription. */
  endpointHash: text('endpoint_hash').notNull().unique(),
  /** Endpoint URL, encrypted (it is a capability URL). */
  endpointEnc: text('endpoint_enc').notNull(),
  /** Host of the endpoint only, shown in the device list. */
  endpointHost: text('endpoint_host').notNull(),
  /** {p256dh, auth}, encrypted. */
  keysEnc: text('keys_enc').notNull(),
  label: text('label').notNull().default(''),
  createdAt: integer('created_at').notNull(),
  lastOkAt: integer('last_ok_at'),
});

// ---- M5: GitHub and deploy ---------------------------------------------------

export const githubRepos = sqliteTable('github_repos', {
  id: text('id').primaryKey(),
  /** "owner/name" as GitHub reports it (unique, case-insensitive). */
  fullName: text('full_name').notNull().unique(),
  private: integer('private', { mode: 'boolean' }).notNull().default(false),
  defaultBranch: text('default_branch').notNull(),
  lastCommitSha: text('last_commit_sha'),
  ciStatus: text('ci_status').notNull().default('off'),
  createdAt: integer('created_at').notNull(),
  /** Last successful sync with GitHub. */
  updatedAt: integer('updated_at'),
});

/** Last 30 commits (CommitInfo with CI) per tracked branch: default branch and target branches. */
export const githubBranches = sqliteTable(
  'github_branches',
  {
    repoId: text('repo_id')
      .notNull()
      .references(() => githubRepos.id, { onDelete: 'cascade' }),
    branch: text('branch').notNull(),
    headSha: text('head_sha'),
    commitsJson: text('commits_json').notNull().default('[]'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.repoId, t.branch] })],
);

/** Conditional requests: ETag and the reduced response data per GitHub API path. */
export const githubEtags = sqliteTable('github_etags', {
  url: text('url').primaryKey(),
  etag: text('etag').notNull(),
  dataJson: text('data_json').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const deployTargets = sqliteTable(
  'deploy_targets',
  {
    id: text('id').primaryKey(),
    repoId: text('repo_id')
      .notNull()
      .references(() => githubRepos.id, { onDelete: 'cascade' }),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    branch: text('branch').notNull(),
    method: text('method').notNull(),
    autoDeploy: integer('auto_deploy', { mode: 'boolean' }).notNull().default(false),
    /** Deploy key name on the agent; the private key never leaves the server. */
    keyName: text('key_name'),
    publicKey: text('public_key'),
    /** Sha of the last successful deploy. */
    liveSha: text('live_sha'),
    /** Last sha an auto-deploy was started for (auto-deploy once per sha). */
    autoSha: text('auto_sha'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [unique().on(t.serverId, t.path), index('deploy_targets_repo').on(t.repoId)],
);

export const deploys = sqliteTable(
  'deploys',
  {
    id: text('id').primaryKey(),
    targetId: text('target_id')
      .notNull()
      .references(() => deployTargets.id, { onDelete: 'cascade' }),
    sha: text('sha').notNull(),
    status: text('status').notNull(),
    /** manual | auto | rollback */
    triggeredBy: text('triggered_by').notNull(),
    summary: text('summary'),
    /** Log tail, max 256 KB. */
    logText: text('log_text').notNull().default(''),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (t) => [
    index('deploys_target_started').on(t.targetId, t.startedAt),
    index('deploys_started').on(t.startedAt),
    index('deploys_status').on(t.status),
  ],
);

// ---- M6: game servers ------------------------------------------------------------

export const gameServers = sqliteTable(
  'game_servers',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    templateId: text('template_id').notNull(),
    /** Folder /opt/homelab/games/<name>/ and container game-<name>; unique per server. */
    name: text('name').notNull(),
    /** Non-secret template field values (defaults applied). */
    settingsJson: text('settings_json').notNull().default('{}'),
    /** [{name, port, protocol, count}] host ports. */
    portsJson: text('ports_json').notNull().default('[]'),
    /** Host port of RCON (published on 127.0.0.1 only). */
    rconPort: integer('rcon_port'),
    /** RCON password, crypto.ts (AAD `game_servers.rcon:<id>`). */
    rconSecretEnc: text('rcon_secret_enc'),
    /** JSON of secret template fields, crypto.ts (AAD `game_servers.secrets:<id>`). */
    secretValuesEnc: text('secret_values_enc'),
    externalAddress: text('external_address').notNull().default(''),
    autoStopMinutes: integer('auto_stop_minutes').notNull().default(0),
    /** setup | failed | running | stopped (what the admin wants / where setup is). */
    phase: text('phase').notNull(),
    /** Setup progress or failure reason (German). */
    phaseText: text('phase_text'),
    /** Last game.status result (gameStatusDataSchema). */
    statusJson: text('status_json'),
    statusAt: integer('status_at'),
    /** Since when the running game has had 0 players (auto-stop). */
    emptySince: integer('empty_since'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    /** M10: wichtig | normal | niedrig (api/throttle.ts). */
    priority: text('priority').notNull().default('normal'),
    allowStop: integer('allow_stop', { mode: 'boolean' }).notNull().default(false),
    allowStopWithPlayers: integer('allow_stop_with_players', { mode: 'boolean' })
      .notNull()
      .default(false),
    /** M12: while asleep, wake listeners are armed (template.wake != none). */
    wakeOnConnect: integer('wake_on_connect', { mode: 'boolean' }).notNull().default(false),
    /** M12: stopped by the sleep mode, wake listeners requested. */
    sleeping: integer('sleeping', { mode: 'boolean' }).notNull().default(false),
    /** M12: mods/plugins changed since the last start ("Neustart nötig"). */
    modsRestartNeeded: integer('mods_restart_needed', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [unique().on(t.serverId, t.name)],
);

export const gameBackups = sqliteTable(
  'game_backups',
  {
    id: text('id').primaryKey(),
    gameId: text('game_id')
      .notNull()
      .references(() => gameServers.id, { onDelete: 'cascade' }),
    /** Backup file on the server, below /opt/homelab/backups/. */
    path: text('path').notNull(),
    size: integer('size').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('game_backups_game_created').on(t.gameId, t.createdAt)],
);

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type ServerRow = typeof servers.$inferSelect;
export type ServerStateRow = typeof serverState.$inferSelect;
export type AlertRow = typeof alerts.$inferSelect;
export type ContainerRow = typeof containers.$inferSelect;
export type CheckRow = typeof checks.$inferSelect;
export type CertStatusRow = typeof certStatus.$inferSelect;
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
export type GithubRepoRow = typeof githubRepos.$inferSelect;
export type DeployTargetRow = typeof deployTargets.$inferSelect;
export type DeployRow = typeof deploys.$inferSelect;
export type GameServerRow = typeof gameServers.$inferSelect;
export type GameBackupRow = typeof gameBackups.$inferSelect;

// ---- M7: share links -------------------------------------------------------------

export const shareLinks = sqliteTable(
  'share_links',
  {
    id: text('id').primaryKey(),
    gameId: text('game_id')
      .notNull()
      .references(() => gameServers.id, { onDelete: 'cascade' }),
    person: text('person').notNull(),
    /** SHA-256 of `share:<token>`. The token itself is never stored. */
    tokenHash: text('token_hash').notNull().unique(),
    /** argon2id of the 4-digit PIN, or null. */
    pinHash: text('pin_hash'),
    /** SharePerm[] */
    permsJson: text('perms_json').notNull(),
    expiresAt: integer('expires_at'),
    revokedAt: integer('revoked_at'),
    lastUsedAt: integer('last_used_at'),
    /** Wrong PINs in a row (reset by a right PIN or the end of a lock). */
    pinFailures: integer('pin_failures').notNull().default(0),
    lockedUntil: integer('locked_until'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('share_links_game').on(t.gameId)],
);

export const shareAudit = sqliteTable(
  'share_audit',
  {
    id: text('id').primaryKey(),
    /** No foreign key: the history stays when a revoked link is deleted. */
    shareId: text('share_id').notNull(),
    gameId: text('game_id')
      .notNull()
      .references(() => gameServers.id, { onDelete: 'cascade' }),
    person: text('person').notNull(),
    action: text('action').notNull(),
    detail: text('detail'),
    ts: integer('ts').notNull(),
    ip: text('ip'),
    /** tailnet | gateway */
    via: text('via').notNull(),
  },
  (t) => [index('share_audit_game_ts').on(t.gameId, t.ts), index('share_audit_ts').on(t.ts)],
);

export type ShareLinkRow = typeof shareLinks.$inferSelect;
export type ShareAuditRow = typeof shareAudit.$inferSelect;

// ---- M8: Home Assistant ----------------------------------------------------------

export const haEnergyMonths = sqliteTable('ha_energy_months', {
  /** YYYY-MM in the configured time zone (HZ_TIMEZONE). */
  month: text('month').primaryKey(),
  /** Energy sensor the values belong to. */
  entityId: text('entity_id').notNull(),
  /** Meter value (kWh) the month counts from; moves on a meter reset. */
  startKwh: real('start_kwh').notNull(),
  lastKwh: real('last_kwh').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export type HaEnergyMonthRow = typeof haEnergyMonths.$inferSelect;

// ---- M9: web console log, wall devices -----------------------------------------------

/** One row per web console session. Never keystrokes or output. */
export const consoleSessions = sqliteTable(
  'console_sessions',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    startedAt: integer('started_at').notNull(),
    /** null while open. */
    endedAt: integer('ended_at'),
    /** ConsoleCloseReason, null while open. */
    reason: text('reason'),
    ip: text('ip'),
    /** Bytes typed (browser -> shell) and shown (shell -> browser). */
    bytesIn: integer('bytes_in').notNull().default(0),
    bytesOut: integer('bytes_out').notNull().default(0),
  },
  (t) => [
    index('console_sessions_server_started').on(t.serverId, t.startedAt),
    index('console_sessions_started').on(t.startedAt),
  ],
);

/** Read-only wall tablets (SPEC 12). Deleting a row revokes the device. */
export const wallDevices = sqliteTable('wall_devices', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /**
   * SHA-256 of `wall:<token>` of the one-time link; null once it was exchanged.
   * The token itself is never stored.
   */
  tokenHash: text('token_hash').unique(),
  /** SHA-256 of `wall:<secret>` of the device cookie; null until paired (or after relink). */
  sessionHash: text('session_hash').unique(),
  /** Hash of the link that paired the current cookie (a kiosk reload repeats it). */
  usedTokenHash: text('used_token_hash'),
  createdAt: integer('created_at').notNull(),
  lastSeenAt: integer('last_seen_at'),
  pairedAt: integer('paired_at'),
});

/** Warn/info pushes held back during quiet hours (migration 10). */
export const pushDigestItems = sqliteTable('push_digest_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ts: integer('ts').notNull(),
  level: text('level').notNull(),
  title: text('title').notNull(),
  /** JSON array of push_subscriptions ids that would have received the push. */
  deviceIdsJson: text('device_ids_json').notNull(),
});

/** Backups of deleted game servers, purged 30 days after deletion (migration 10). */
export const deletedGameBackups = sqliteTable(
  'deleted_game_backups',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    /** Core id of the deleted game (no foreign key: the row is gone). */
    gameId: text('game_id').notNull(),
    /** Folder name: /opt/homelab/backups/<gameName>/. */
    gameName: text('game_name').notNull(),
    deletedAt: integer('deleted_at').notNull(),
    lastAttemptAt: integer('last_attempt_at'),
    lastError: text('last_error'),
  },
  (t) => [index('deleted_game_backups_server').on(t.serverId)],
);

export type ConsoleSessionRow = typeof consoleSessions.$inferSelect;
export type WallDeviceRow = typeof wallDevices.$inferSelect;
export type PushDigestItemRow = typeof pushDigestItems.$inferSelect;
export type DeletedGameBackupRow = typeof deletedGameBackups.$inferSelect;

// ---- M10: priorities and automatic throttling (migration 11) ----------------------

/** Priority of a plain container, keyed by the core container id (server id + name). */
export const containerPriorities = sqliteTable(
  'container_priorities',
  {
    containerId: text('container_id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    containerName: text('container_name').notNull(),
    priority: text('priority').notNull(),
    allowStop: integer('allow_stop', { mode: 'boolean' }).notNull().default(false),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('container_priorities_server').on(t.serverId)],
);

/** Throttle settings (merged ThrottleSettings) and schedule windows of a server. */
export const serverThrottle = sqliteTable('server_throttle', {
  serverId: text('server_id')
    .primaryKey()
    .references(() => servers.id, { onDelete: 'cascade' }),
  settingsJson: text('settings_json').notNull().default('{}'),
  schedulesJson: text('schedules_json').notNull().default('[]'),
  updatedAt: integer('updated_at').notNull(),
});

/** Current throttle and auto-stop mark of a container (core container id). */
export const containerThrottles = sqliteTable(
  'container_throttles',
  {
    containerId: text('container_id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    containerName: text('container_name').notNull(),
    /** Game server of the container (no foreign key, rows of deleted games are dropped). */
    gameId: text('game_id'),
    /** Docker container the limit was set on; a recreate drops the limit. */
    dockerId: text('docker_id'),
    /** Current --cpus limit, null = not throttled. */
    cpus: real('cpus'),
    /** --cpus limit before the throttle (restored on unthrottle), null = none. */
    originalCpus: real('original_cpus'),
    /** auto | admin | schedule */
    by: text('by'),
    reason: text('reason'),
    since: integer('since'),
    /** Stopped by the rule set; cleared when the container runs again. */
    autoStoppedAt: integer('auto_stopped_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('container_throttles_server').on(t.serverId),
    index('container_throttles_game').on(t.gameId),
  ],
);

/** Restart attempts of stopped `wichtig` containers. */
export const wichtigRestarts = sqliteTable(
  'wichtig_restarts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    containerId: text('container_id').notNull(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    ts: integer('ts').notNull(),
    ok: integer('ok', { mode: 'boolean' }).notNull(),
  },
  (t) => [index('wichtig_restarts_container_ts').on(t.containerId, t.ts)],
);

export type ContainerPriorityRow = typeof containerPriorities.$inferSelect;
export type ServerThrottleRow = typeof serverThrottle.$inferSelect;
export type ContainerThrottleRow = typeof containerThrottles.$inferSelect;

// ---- M11: onboarding, port audit ----------------------------------------------

/** One-step onboarding codes (8 chars, 15 min, once). */
export const onboardingCodes = sqliteTable(
  'onboarding_codes',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    location: text('location').notNull().default(''),
    /** HMAC-SHA-256 of the canonical code (subkey of HZ_SECRET_KEY). Never the code. */
    codeHash: text('code_hash').notNull().unique(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    /** Swapped for an enrollment token (enrollTokenId). */
    exchangedAt: integer('exchanged_at'),
    cancelledAt: integer('cancelled_at'),
    enrollTokenId: text('enroll_token_id'),
  },
  (t) => [index('onboarding_codes_expires').on(t.expiresAt)],
);

/** Allowed public listening ports of a server. */
export const serverAllowedPorts = sqliteTable(
  'server_allowed_ports',
  {
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    proto: text('proto').notNull(),
    port: integer('port').notNull(),
    note: text('note'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.proto, t.port] })],
);

/** Present once the allowed list of a server exists (seeded or set by hand). */
export const serverPortAudit = sqliteTable('server_port_audit', {
  serverId: text('server_id')
    .primaryKey()
    .references(() => servers.id, { onDelete: 'cascade' }),
  seededAt: integer('seeded_at').notNull(),
});

export type OnboardingCodeRow = typeof onboardingCodes.$inferSelect;
export type ServerAllowedPortRow = typeof serverAllowedPorts.$inferSelect;

// ---- M11: game migration ------------------------------------------------------

/** One attempt to move a game server to another server (games/migrate.ts). */
export const gameMigrations = sqliteTable(
  'game_migrations',
  {
    id: text('id').primaryKey(),
    gameId: text('game_id')
      .notNull()
      .references(() => gameServers.id, { onDelete: 'cascade' }),
    gameName: text('game_name').notNull(),
    sourceServerId: text('source_server_id').notNull(),
    sourceServerName: text('source_server_name').notNull(),
    targetServerId: text('target_server_id').notNull(),
    targetServerName: text('target_server_name').notNull(),
    /** MigrationPhase (api/migrate.ts). */
    phase: text('phase').notNull(),
    failedPhase: text('failed_phase'),
    bytesDone: integer('bytes_done').notNull().default(0),
    bytesTotal: integer('bytes_total'),
    sha256: text('sha256'),
    /** MigrationErrorCode. */
    error: text('error'),
    /** Fixed German text, never agent output. */
    errorText: text('error_text'),
    rollback: text('rollback'),
    /** HostPort[] on the target. */
    portsJson: text('ports_json').notNull().default('[]'),
    rconPort: integer('rcon_port'),
    forwardingHint: text('forwarding_hint'),
    wasRunning: integer('was_running', { mode: 'boolean' }).notNull().default(false),
    /** game.import was accepted: the target folder belongs to this migration. */
    targetTouched: integer('target_touched', { mode: 'boolean' }).notNull().default(false),
    /** Rollback still has to remove the target copy. */
    cleanupTarget: integer('cleanup_target', { mode: 'boolean' }).notNull().default(false),
    /** Rollback still has to start the source game again. */
    restartSource: integer('restart_source', { mode: 'boolean' }).notNull().default(false),
    startedAt: integer('started_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (t) => [index('game_migrations_game').on(t.gameId, t.startedAt)],
);

export type GameMigrationRow = typeof gameMigrations.$inferSelect;

// ---- M13: NAS und Speicher ------------------------------------------------------

/** Latest inventory.storage of a server (storage/service.ts). */
export const serverStorage = sqliteTable('server_storage', {
  serverId: text('server_id')
    .primaryKey()
    .references(() => servers.id, { onDelete: 'cascade' }),
  storageJson: text('storage_json').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
// ---- M12: game server features ------------------------------------------------

/** Restart / backup at weekdays and HH:MM in HZ_TIMEZONE (games/schedules.ts). */
export const gameSchedules = sqliteTable(
  'game_schedules',
  {
    id: text('id').primaryKey(),
    gameId: text('game_id')
      .notNull()
      .references(() => gameServers.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    /** restart | backup */
    kind: text('kind').notNull(),
    /** ISO weekdays 1..7 */
    daysJson: text('days_json').notNull(),
    /** HH:MM */
    time: text('time').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    lastRunAt: integer('last_run_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('game_schedules_game').on(t.gameId, t.position)],
);

/** Discord webhook per game; the URL is a secret (crypto.ts, AAD game_notify.discord:<id>). */
export const gameNotify = sqliteTable('game_notify', {
  gameId: text('game_id')
    .primaryKey()
    .references(() => gameServers.id, { onDelete: 'cascade' }),
  webhookEnc: text('webhook_enc'),
  eventsJson: text('events_json').notNull().default('[]'),
  lastSentAt: integer('last_sent_at'),
  /** Fixed German text, never the URL. */
  lastError: text('last_error'),
  updatedAt: integer('updated_at').notNull(),
});

/** One play session of a player name (from the status polls). */
export const gamePlayerSessions = sqliteTable(
  'game_player_sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    gameId: text('game_id')
      .notNull()
      .references(() => gameServers.id, { onDelete: 'cascade' }),
    player: text('player').notNull(),
    startedAt: integer('started_at').notNull(),
    lastSeen: integer('last_seen').notNull(),
    endedAt: integer('ended_at'),
  },
  (t) => [
    index('game_player_sessions_game').on(t.gameId, t.startedAt),
    index('game_player_sessions_open').on(t.gameId, t.endedAt),
  ],
);

/** Players online per game and UTC hour (sum over samples, peak). */
export const gamePlayerHours = sqliteTable(
  'game_player_hours',
  {
    gameId: text('game_id')
      .notNull()
      .references(() => gameServers.id, { onDelete: 'cascade' }),
    hourTs: integer('hour_ts').notNull(),
    samples: integer('samples').notNull(),
    playersSum: integer('players_sum').notNull(),
    peak: integer('peak').notNull(),
    peakAt: integer('peak_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.gameId, t.hourTs] }),
    index('game_player_hours_ts').on(t.hourTs),
  ],
);

/** Jars installed through the zentrale (Modrinth metadata). */
export const gameMods = sqliteTable(
  'game_mods',
  {
    gameId: text('game_id')
      .notNull()
      .references(() => gameServers.id, { onDelete: 'cascade' }),
    fileName: text('file_name').notNull(),
    projectId: text('project_id').notNull(),
    title: text('title').notNull(),
    installedAt: integer('installed_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.fileName] })],
);

/** A friend's request to be put on the whitelist (share link with whitelist_request). */
export const whitelistRequests = sqliteTable(
  'whitelist_requests',
  {
    id: text('id').primaryKey(),
    gameId: text('game_id')
      .notNull()
      .references(() => gameServers.id, { onDelete: 'cascade' }),
    /** No foreign key: the request history stays when a link is deleted. */
    shareId: text('share_id').notNull(),
    person: text('person').notNull(),
    player: text('player').notNull(),
    /** pending | approved | rejected */
    state: text('state').notNull(),
    createdAt: integer('created_at').notNull(),
    decidedAt: integer('decided_at'),
  },
  (t) => [
    index('whitelist_requests_game').on(t.gameId, t.createdAt),
    index('whitelist_requests_share').on(t.shareId, t.createdAt),
  ],
);

export type GameScheduleRow = typeof gameSchedules.$inferSelect;
export type GameNotifyRow = typeof gameNotify.$inferSelect;
export type WhitelistRequestRow = typeof whitelistRequests.$inferSelect;

// ---- M22: cloud servers ---------------------------------------------------------

/** A VM ordered at a cloud provider (cloud/service.ts). */
export const cloudMachines = sqliteTable(
  'cloud_machines',
  {
    id: text('id').primaryKey(),
    /** CloudProvider (azure). */
    provider: text('provider').notNull(),
    /** VM name in Azure, Tailscale host name and server name. */
    name: text('name').notNull().unique(),
    size: text('size').notNull(),
    region: text('region').notNull(),
    diskType: text('disk_type').notNull(),
    diskGb: integer('disk_gb').notNull(),
    publicIpEnabled: integer('public_ip_enabled', { mode: 'boolean' }).notNull(),
    publicIp: text('public_ip'),
    /** Server row of the enrolled agent. */
    serverId: text('server_id').references(() => servers.id, { onDelete: 'set null' }),
    /** onboarding_codes.id of the current install code. */
    onboardingId: text('onboarding_id'),
    /** CloudMachineState. */
    state: text('state').notNull(),
    stateText: text('state_text'),
    /** One of CLOUD_ERRORS. */
    error: text('error'),
    idleMinutes: integer('idle_minutes').notNull(),
    idleSince: integer('idle_since'),
    /** CloudPendingGame, encrypted (AAD cloud_machines.pending_game:<id>). */
    pendingGameJson: text('pending_game_json'),
    /** Compute price per hour confirmed at the order (EUR). */
    computeEurPerHour: real('compute_eur_per_hour').notNull(),
    /** 'live' | 'estimate' */
    priceSource: text('price_source').notNull().default('estimate'),
    /** The VM may be powered at Azure: running time is counted (billing). */
    vmPowered: integer('vm_powered', { mode: 'boolean' }).notNull().default(false),
    stateChangedAt: integer('state_changed_at').notNull(),
    createdAt: integer('created_at').notNull(),
    /** Last change, also the last usage accounting (restart-safe running time). */
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('cloud_machines_server').on(t.serverId)],
);

/** Running seconds of a machine per calendar month (YYYY-MM in HZ_TIMEZONE). */
export const cloudUsage = sqliteTable(
  'cloud_usage',
  {
    machineId: text('machine_id')
      .notNull()
      .references(() => cloudMachines.id, { onDelete: 'cascade' }),
    month: text('month').notNull(),
    runningSeconds: integer('running_seconds').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.machineId, t.month] })],
);

export type CloudMachineRow = typeof cloudMachines.$inferSelect;
