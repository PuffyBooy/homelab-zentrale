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
];
