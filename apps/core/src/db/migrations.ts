/**
 * Schema migrations, embedded in code so they work from src, dist and the Docker
 * image without drizzle-kit or extra files at runtime.
 *
 * Rules: never edit a migration that has shipped. Add a new entry with the next
 * version number. `schema.ts` must match the result of all migrations (tested).
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'auth',
    sql: `
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  totp_secret_enc TEXT NOT NULL,
  totp_last_step INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  step_up_until INTEGER
);
CREATE INDEX sessions_user_id ON sessions(user_id);
CREATE INDEX sessions_expires_at ON sessions(expires_at);

CREATE TABLE recovery_codes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX recovery_codes_user_id ON recovery_codes(user_id);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  details_json TEXT
);
CREATE INDEX audit_log_ts ON audit_log(ts);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`,
  },
  {
    version: 2,
    name: 'servers',
    sql: `
CREATE TABLE servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  location TEXT NOT NULL DEFAULT '',
  arch TEXT,
  os TEXT,
  tailscale_ip TEXT,
  public_ip TEXT,
  agent_version TEXT,
  capabilities_json TEXT,
  thresholds_json TEXT NOT NULL DEFAULT '{}',
  allow_terminal INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen INTEGER
);

CREATE TABLE server_state (
  server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  metrics_json TEXT,
  metrics_at INTEGER,
  system_json TEXT,
  updates_json TEXT,
  reboot_required INTEGER,
  ssh_failed_24h INTEGER,
  fail2ban_banned INTEGER,
  listening_ports_json TEXT,
  inventory_at INTEGER
);

CREATE TABLE agent_tokens (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX agent_tokens_server_id ON agent_tokens(server_id);

CREATE TABLE enroll_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  server_id TEXT
);

CREATE TABLE metrics_raw (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  cpu REAL NOT NULL,
  ram REAL NOT NULL,
  swap REAL NOT NULL,
  disk_max REAL,
  disk_json TEXT NOT NULL DEFAULT '[]',
  temp REAL,
  net_in REAL NOT NULL,
  net_out REAL NOT NULL
);
CREATE INDEX metrics_raw_server_ts ON metrics_raw(server_id, ts);
CREATE INDEX metrics_raw_ts ON metrics_raw(ts);

CREATE TABLE metrics_5m (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  cpu REAL NOT NULL,
  ram REAL NOT NULL,
  swap REAL NOT NULL,
  disk_max REAL,
  temp REAL,
  net_in REAL NOT NULL,
  net_out REAL NOT NULL,
  samples INTEGER NOT NULL,
  PRIMARY KEY (server_id, ts)
);
CREATE INDEX metrics_5m_ts ON metrics_5m(ts);

CREATE TABLE metrics_1h (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  cpu REAL NOT NULL,
  ram REAL NOT NULL,
  swap REAL NOT NULL,
  disk_max REAL,
  temp REAL,
  net_in REAL NOT NULL,
  net_out REAL NOT NULL,
  samples INTEGER NOT NULL,
  PRIMARY KEY (server_id, ts)
);
CREATE INDEX metrics_1h_ts ON metrics_1h(ts);

CREATE TABLE containers (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  docker_id TEXT NOT NULL,
  name TEXT NOT NULL,
  image TEXT NOT NULL,
  compose_project TEXT,
  state TEXT NOT NULL,
  health TEXT NOT NULL,
  ports_json TEXT NOT NULL DEFAULT '[]',
  info_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (server_id, docker_id)
);

CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  level TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
  source TEXT NOT NULL,
  state TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  acked_at INTEGER,
  resolved_at INTEGER
);
-- At most one open or acked alert per key (dedupe).
CREATE UNIQUE INDEX alerts_active_key ON alerts(key) WHERE state != 'resolved';
CREATE INDEX alerts_opened_at ON alerts(opened_at);
CREATE INDEX alerts_server_id ON alerts(server_id);
`,
  },
  {
    version: 3,
    name: 'containers',
    // The containers table is a cache of the last inventory, so it is rebuilt
    // instead of altered: the core id is now stable per server + name (a
    // recreated container keeps its id), and the inventory fields get columns.
    sql: `
DROP TABLE containers;
CREATE TABLE containers (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  docker_id TEXT NOT NULL,
  image TEXT NOT NULL,
  compose_project TEXT,
  compose_service TEXT,
  compose_dir TEXT,
  state TEXT NOT NULL,
  health TEXT NOT NULL,
  status_text TEXT NOT NULL DEFAULT '',
  exit_code INTEGER,
  started_at INTEGER,
  restart_count INTEGER,
  cpu REAL,
  mem_bytes REAL,
  ports_json TEXT NOT NULL DEFAULT '[]',
  info_json TEXT NOT NULL,
  intent TEXT,
  intent_until INTEGER,
  oom_at INTEGER,
  alert_class TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (server_id, name)
);
CREATE INDEX containers_server_docker ON containers(server_id, docker_id);
`,
  },
  {
    version: 4,
    name: 'checks_push',
    // M4: website/port checks with 30 days of raw results, certificate and
    // domain expiry per check, and Web Push subscriptions (endpoint and keys
    // encrypted; the hash only dedupes a re-subscription of the same browser).
    sql: `
CREATE TABLE checks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  def_json TEXT NOT NULL,
  run_from TEXT NOT NULL,
  server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
  interval_s INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'busy',
  reason TEXT,
  last_code INTEGER,
  last_ms REAL,
  last_checked_at INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_slow INTEGER NOT NULL DEFAULT 0,
  down_since INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE check_results (
  check_id TEXT NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  code INTEGER,
  ms REAL,
  error TEXT
);
CREATE INDEX check_results_check_ts ON check_results(check_id, ts);
CREATE INDEX check_results_ts ON check_results(ts);

CREATE TABLE cert_status (
  check_id TEXT PRIMARY KEY REFERENCES checks(id) ON DELETE CASCADE,
  ssl_expires_at INTEGER,
  domain_expires_at INTEGER,
  checked_at INTEGER,
  domain_checked_at INTEGER
);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint_hash TEXT NOT NULL UNIQUE,
  endpoint_enc TEXT NOT NULL,
  endpoint_host TEXT NOT NULL,
  keys_enc TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER
);
`,
  },
  {
    version: 5,
    name: 'github',
    // M5: tracked GitHub repos, their branch commit cache (last 30 with CI),
    // ETag cache for conditional requests, deploy targets and deploys. The
    // GitHub token lives encrypted in `settings`, never here.
    sql: `
CREATE TABLE github_repos (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  private INTEGER NOT NULL DEFAULT 0,
  default_branch TEXT NOT NULL,
  last_commit_sha TEXT,
  ci_status TEXT NOT NULL DEFAULT 'off',
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);

CREATE TABLE github_branches (
  repo_id TEXT NOT NULL REFERENCES github_repos(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  head_sha TEXT,
  commits_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, branch)
);

CREATE TABLE github_etags (
  url TEXT PRIMARY KEY,
  etag TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE deploy_targets (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES github_repos(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  branch TEXT NOT NULL,
  method TEXT NOT NULL,
  auto_deploy INTEGER NOT NULL DEFAULT 0,
  key_name TEXT,
  public_key TEXT,
  live_sha TEXT,
  auto_sha TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (server_id, path)
);
CREATE INDEX deploy_targets_repo ON deploy_targets(repo_id);

CREATE TABLE deploys (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES deploy_targets(id) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  status TEXT NOT NULL,
  triggered_by TEXT NOT NULL,
  summary TEXT,
  log_text TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX deploys_target_started ON deploys(target_id, started_at);
CREATE INDEX deploys_started ON deploys(started_at);
CREATE INDEX deploys_status ON deploys(status);
`,
  },
  {
    version: 6,
    name: 'games',
    // Game servers (SPEC 6.2/6.3). Secrets (RCON password, secret template fields)
    // are AES-256-GCM encrypted; settings_json only holds non-secret field values.
    sql: `
CREATE TABLE game_servers (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL,
  name TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}',
  ports_json TEXT NOT NULL DEFAULT '[]',
  rcon_port INTEGER,
  rcon_secret_enc TEXT,
  secret_values_enc TEXT,
  external_address TEXT NOT NULL DEFAULT '',
  auto_stop_minutes INTEGER NOT NULL DEFAULT 0,
  phase TEXT NOT NULL,
  phase_text TEXT,
  status_json TEXT,
  status_at INTEGER,
  empty_since INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (server_id, name)
);

CREATE TABLE game_backups (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES game_servers(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX game_backups_game_created ON game_backups(game_id, created_at);
`,
  },
  {
    version: 7,
    name: 'share',
    // Share links (SPEC 6.4). Only the SHA-256 of the token and the argon2id hash
    // of the optional PIN are stored. share_audit keeps person and game_id itself,
    // so the history survives deleting a revoked link; it goes with the game.
    // Gateway settings (enabled, publicUrl, token hash, lastSeenAt) live in
    // `settings` under `share.gateway`.
    sql: `
CREATE TABLE share_links (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES game_servers(id) ON DELETE CASCADE,
  person TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  pin_hash TEXT,
  perms_json TEXT NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  last_used_at INTEGER,
  pin_failures INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX share_links_game ON share_links(game_id);

CREATE TABLE share_audit (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL,
  game_id TEXT NOT NULL REFERENCES game_servers(id) ON DELETE CASCADE,
  person TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  ts INTEGER NOT NULL,
  ip TEXT,
  via TEXT NOT NULL
);
CREATE INDEX share_audit_game_ts ON share_audit(game_id, ts);
CREATE INDEX share_audit_ts ON share_audit(ts);
`,
  },
  {
    version: 8,
    name: 'homeassistant',
    // Monthly energy baseline for "kWh im Monat" (SPEC 10). One row per Vienna month
    // (YYYY-MM): start_kwh is the meter value the month counts from, last_kwh the
    // newest reading. A meter reset (value drops) moves start_kwh so the month keeps
    // its consumption. entity_id: a different energy sensor starts a new baseline.
    // HA URL, token (AES-256-GCM) and the entity selection live in `settings`.
    sql: `
CREATE TABLE ha_energy_months (
  month TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  start_kwh REAL NOT NULL,
  last_kwh REAL NOT NULL,
  updated_at INTEGER NOT NULL
);
`,
  },
  {
    version: 9,
    name: 'console_wall',
    // Web console log (SPEC 11): who/when/how long/how many bytes, never content.
    // The history goes with the server. ended_at NULL = still open (or the core
    // stopped while it was open; closed with reason 'error' on the next start).
    // Wall devices (SPEC 12): only the SHA-256 of `wall:<token>`; deleting the row
    // revokes the device at once.
    // Indices for the overview queries (M9 performance).
    sql: `
CREATE TABLE console_sessions (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  reason TEXT,
  ip TEXT,
  bytes_in INTEGER NOT NULL DEFAULT 0,
  bytes_out INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX console_sessions_server_started ON console_sessions(server_id, started_at);
CREATE INDEX console_sessions_started ON console_sessions(started_at);

CREATE TABLE wall_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE INDEX alerts_state_opened ON alerts(state, opened_at);
`,
  },
  {
    version: 10,
    name: 'decisions_2026_11',
    // Quiet-hours digest (push): warn/info pushes suppressed in the quiet hours wait
    // here until the quiet hours end; device_ids_json: push devices that existed when
    // the push was suppressed (only they get the digest). Titles only, no bodies.
    // Purge of backups of deleted game servers: one row per deleted game, dropped
    // once the agent purged the backups older than 30 days after deleted_at.
    // game_name is the folder name (/opt/homelab/backups/<game_name>/).
    // Wall devices: one-time token. token_hash NULL = the link was used; the cookie
    // carries a separate random session secret (session_hash); used_token_hash lets a
    // kiosk reload with the already used link pass when it still has its cookie.
    // Existing devices keep working: their old cookie (the token itself) becomes
    // their session secret, and their link stays usable once.
    // Optional modules: an existing install keeps GitHub/HA on when configured.
    sql: `
CREATE TABLE push_digest_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  title TEXT NOT NULL,
  device_ids_json TEXT NOT NULL
);

CREATE TABLE deleted_game_backups (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL,
  game_name TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  last_attempt_at INTEGER,
  last_error TEXT
);
CREATE INDEX deleted_game_backups_server ON deleted_game_backups(server_id);

CREATE TABLE wall_devices_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT UNIQUE,
  session_hash TEXT UNIQUE,
  used_token_hash TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  paired_at INTEGER
);
INSERT INTO wall_devices_new (id, name, token_hash, session_hash, used_token_hash, created_at, last_seen_at, paired_at)
  -- Devices already seen keep their cookie (the old token becomes the session secret),
  -- but the old link must not pair a second time: it moves to used_token_hash.
  SELECT id, name,
         CASE WHEN last_seen_at IS NULL THEN token_hash ELSE NULL END,
         CASE WHEN last_seen_at IS NULL THEN NULL ELSE token_hash END,
         CASE WHEN last_seen_at IS NULL THEN NULL ELSE token_hash END,
         created_at, last_seen_at, last_seen_at
  FROM wall_devices;
DROP TABLE wall_devices;
ALTER TABLE wall_devices_new RENAME TO wall_devices;

INSERT OR IGNORE INTO settings (key, value_json, updated_at)
  SELECT 'modules', json_object(
    'github', json(CASE WHEN EXISTS (SELECT 1 FROM settings WHERE key = 'github.token') THEN 'true' ELSE 'false' END),
    'homeassistant', json(CASE WHEN EXISTS (
      SELECT 1 FROM settings WHERE key = 'ha.settings' AND json_extract(value_json, '$.url') IS NOT NULL
    ) THEN 'true' ELSE 'false' END),
    'games', json('true')
  ), CAST(strftime('%s', 'now') AS INTEGER) * 1000;
`,
  },
  {
    version: 11,
    name: 'throttle',
    // M10 priorities and automatic throttling (SPEC 6a).
    // container_priorities: keyed by the core container id (derived from server id +
    // container name, so it survives a recreate); server_id/container_name for display
    // and cleanup. Game containers take their priority from game_servers instead.
    // server_throttle: per-server settings (only the merged ThrottleSettings) and the
    // schedule windows; missing row = defaults, no windows.
    // container_throttles: current throttle (cpus, since, by auto/admin/schedule, German
    // reason, the --cpus limit to restore) and the auto-stop mark. docker_id: the limit
    // belongs to this docker container (a recreate drops it). game_id: set for game
    // containers, so a game shows its state even after compose down removed the container.
    // wichtig_restarts: restart attempts of stopped `wichtig` containers (max 3 in 10 min).
    // containers.last_mem_bytes: last known memory, for the derived RAM reserve.
    sql: `
CREATE TABLE container_priorities (
  container_id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  container_name TEXT NOT NULL,
  priority TEXT NOT NULL,
  allow_stop INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX container_priorities_server ON container_priorities(server_id);

ALTER TABLE game_servers ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE game_servers ADD COLUMN allow_stop INTEGER NOT NULL DEFAULT 0;
ALTER TABLE game_servers ADD COLUMN allow_stop_with_players INTEGER NOT NULL DEFAULT 0;

CREATE TABLE server_throttle (
  server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  settings_json TEXT NOT NULL DEFAULT '{}',
  schedules_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

CREATE TABLE container_throttles (
  container_id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  container_name TEXT NOT NULL,
  game_id TEXT,
  docker_id TEXT,
  cpus REAL,
  original_cpus REAL,
  by TEXT,
  reason TEXT,
  since INTEGER,
  auto_stopped_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX container_throttles_server ON container_throttles(server_id);
CREATE INDEX container_throttles_game ON container_throttles(game_id);

CREATE TABLE wichtig_restarts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  container_id TEXT NOT NULL,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL
);
CREATE INDEX wichtig_restarts_container_ts ON wichtig_restarts(container_id, ts);

ALTER TABLE containers ADD COLUMN last_mem_bytes REAL;
`,
  },
  {
    version: 12,
    name: 'onboarding_ports',
    // M11 one-step onboarding and port audit.
    // onboarding_codes: code_hash is HMAC-SHA-256 of the canonical code (key derived from
    // HZ_SECRET_KEY), never the code. exchanged_at: the code was swapped for an enrollment
    // token (enroll_token_id); cancelled_at: cancelled by the admin.
    // server_allowed_ports: the allowed public ports of a server. server_port_audit: one row
    // per server once its list exists (seeded from the first inventory or set by hand).
    sql: `
CREATE TABLE onboarding_codes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  code_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  exchanged_at INTEGER,
  cancelled_at INTEGER,
  enroll_token_id TEXT
);
CREATE INDEX onboarding_codes_expires ON onboarding_codes(expires_at);

CREATE TABLE server_allowed_ports (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  proto TEXT NOT NULL,
  port INTEGER NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, proto, port)
);

CREATE TABLE server_port_audit (
  server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  seeded_at INTEGER NOT NULL
);
`,
  },
  {
    version: 13,
    name: 'game_migrations',
    // M11 moving a game server to another server (apps/core/src/games/migrate.ts).
    // One row per attempt; the latest per game is shown. Server ids carry no foreign key
    // (the record outlives a deleted server), names are copied for display.
    // was_running: the source game ran before (restart it on rollback).
    // target_touched: game.import was accepted, so the target folder is ours to remove.
    // cleanup_target / restart_source: rollback steps still to do (agent was offline or
    // the core restarted); retried while the agent is connected.
    sql: `
CREATE TABLE game_migrations (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES game_servers(id) ON DELETE CASCADE,
  game_name TEXT NOT NULL,
  source_server_id TEXT NOT NULL,
  source_server_name TEXT NOT NULL,
  target_server_id TEXT NOT NULL,
  target_server_name TEXT NOT NULL,
  phase TEXT NOT NULL,
  failed_phase TEXT,
  bytes_done INTEGER NOT NULL DEFAULT 0,
  bytes_total INTEGER,
  sha256 TEXT,
  error TEXT,
  error_text TEXT,
  rollback TEXT,
  ports_json TEXT NOT NULL DEFAULT '[]',
  rcon_port INTEGER,
  forwarding_hint TEXT,
  was_running INTEGER NOT NULL DEFAULT 0,
  target_touched INTEGER NOT NULL DEFAULT 0,
  cleanup_target INTEGER NOT NULL DEFAULT 0,
  restart_source INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX game_migrations_game ON game_migrations(game_id, started_at);
`,
  },
  {
    version: 14,
    name: 'server_storage',
    // M13 NAS und Speicher (apps/core/src/storage): the latest inventory.storage per
    // server (md RAID, volumes, disks, SMART) as validated JSON.
    sql: `
CREATE TABLE server_storage (
  server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  storage_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`,
  },
];
