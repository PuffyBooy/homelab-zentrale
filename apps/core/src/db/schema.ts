import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
