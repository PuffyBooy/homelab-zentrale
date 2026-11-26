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

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type ServerRow = typeof servers.$inferSelect;
export type ServerStateRow = typeof serverState.$inferSelect;
export type AlertRow = typeof alerts.$inferSelect;
export type ContainerRow = typeof containers.$inferSelect;
export type CheckRow = typeof checks.$inferSelect;
export type CertStatusRow = typeof certStatus.$inferSelect;
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
