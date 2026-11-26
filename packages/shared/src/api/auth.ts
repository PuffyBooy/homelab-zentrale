import { z } from 'zod';
import { modulesSchema } from './modules.js';
import { insufficientRamDetailsSchema } from './throttle.js';

/** Shared limits so web and core validate the same way. */
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;
export const RECOVERY_CODE_COUNT = 10;
/** Step-up lasts this long after a fresh TOTP (docs/SECURITY.md). */
export const STEP_UP_MINUTES = 15;

export const usernameSchema = z.string().trim().toLowerCase().regex(USERNAME_RE);
export const passwordSchema = z.string().min(PASSWORD_MIN).max(PASSWORD_MAX);
/** 6-digit TOTP code. */
export const totpCodeSchema = z.string().regex(/^\d{6}$/);
/** Recovery code, shown as xxxxx-xxxxx (lowercase base32-ish). */
export const recoveryCodeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z2-7]{5}-?[a-z2-7]{5}$/);
/** Login accepts a TOTP code or a recovery code. */
export const secondFactorSchema = z.union([totpCodeSchema, recoveryCodeSchema]);

/** One-time setup token from the core log, URL-safe base64. */
export const setupTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22,128}$/);

// GET /api/auth/state (public: tells the web app which screen to show)
export const authStateSchema = z.strictObject({
  setupRequired: z.boolean(),
  authenticated: z.boolean(),
  username: z.string().optional(),
  /** ISO time until step-up is valid, if active. */
  stepUpUntil: z.iso.datetime().optional(),
  /** Only when authenticated: which optional modules are on (hide nav items and tiles). */
  modules: modulesSchema.optional(),
  /** Only when authenticated: IANA zone of the core (HZ_TIMEZONE), e.g. "Europe/Vienna". */
  timeZone: z.string().max(64).optional(),
});
export type AuthState = z.infer<typeof authStateSchema>;

// POST /api/setup/start
export const setupStartRequestSchema = z.strictObject({
  setupToken: setupTokenSchema,
  username: usernameSchema,
  password: passwordSchema,
});
export type SetupStartRequest = z.infer<typeof setupStartRequestSchema>;
export const setupStartResponseSchema = z.strictObject({
  /** otpauth:// URI for the QR code. */
  otpauthUri: z.string().startsWith('otpauth://totp/'),
  /** Base32 secret for manual entry. Only returned once, during setup. */
  secret: z.string().regex(/^[A-Z2-7]+$/),
  /** SVG markup of the QR code (rendered by the core, no inline script). */
  qrSvg: z.string().startsWith('<svg'),
});
export type SetupStartResponse = z.infer<typeof setupStartResponseSchema>;
/** Same shape as the setup: otpauth URI, base32 secret (shown once), QR as SVG. */
export const totpStartResponseSchema = setupStartResponseSchema;

// POST /api/setup/confirm
export const setupConfirmRequestSchema = z.strictObject({
  setupToken: setupTokenSchema,
  code: totpCodeSchema,
});
export type SetupConfirmRequest = z.infer<typeof setupConfirmRequestSchema>;
export const recoveryCodesResponseSchema = z.strictObject({
  recoveryCodes: z.array(z.string()).length(RECOVERY_CODE_COUNT),
});
export type RecoveryCodesResponse = z.infer<typeof recoveryCodesResponseSchema>;

// POST /api/auth/login
export const loginRequestSchema = z.strictObject({
  username: usernameSchema,
  password: z.string().min(1).max(PASSWORD_MAX),
  code: secondFactorSchema,
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;
/** Successful login answers with the new auth state (and sets the session cookie). */
export const loginResponseSchema = authStateSchema;
export type LoginResponse = AuthState;

// POST /api/auth/step-up
export const stepUpRequestSchema = z.strictObject({ code: totpCodeSchema });
export type StepUpRequest = z.infer<typeof stepUpRequestSchema>;
export const stepUpResponseSchema = z.strictObject({ stepUpUntil: z.iso.datetime() });
export type StepUpResponse = z.infer<typeof stepUpResponseSchema>;

// TOTP re-setup (SPEC 13, Konto), both step-up:
// POST /api/auth/totp/start {} -> totpStartResponseSchema (new secret, pending 10 min,
//   the old one stays valid until confirm)
// POST /api/auth/totp/confirm { code } (code of the NEW secret) -> { ok }; other
//   sessions are revoked.
export const totpConfirmRequestSchema = z.strictObject({ code: totpCodeSchema });

// POST /api/auth/recovery-codes (step-up required): regenerate
// -> recoveryCodesResponseSchema

// POST /api/auth/password (step-up required)
export const changePasswordRequestSchema = z.strictObject({
  currentPassword: z.string().min(1).max(PASSWORD_MAX),
  newPassword: passwordSchema,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

// GET /api/auth/sessions
export const sessionInfoSchema = z.strictObject({
  id: z.string(),
  current: z.boolean(),
  userAgent: z.string(),
  createdAt: z.iso.datetime(),
  lastSeen: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type SessionInfo = z.infer<typeof sessionInfoSchema>;
export const sessionListResponseSchema = z.strictObject({ sessions: z.array(sessionInfoSchema) });
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;

// DELETE /api/auth/sessions/:id
export const sessionIdParamsSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
});

/** Generic success / error envelopes. Errors carry a stable code, never internals. */
export const okResponseSchema = z.strictObject({ ok: z.literal(true) });
export const errorCodeSchema = z.enum([
  'unauthorized',
  'forbidden',
  'step_up_required',
  'invalid_input',
  'invalid_credentials',
  'rate_limited',
  'setup_done',
  'setup_invalid',
  'bad_origin',
  'not_found',
  'conflict',
  'internal',
  /** The agent of this server is not connected (409). */
  'agent_offline',
  /** The agent answered the RPC with an error (502). */
  'agent_error',
  /** The agent did not answer in time (504). */
  'agent_timeout',
  /** confirmName does not match the server name (400). */
  'confirm_mismatch',
  /** A deploy for this target is already running (409, lock per target). */
  'busy',
  /** The CI of the commit is not green, deploy refused (409). */
  'ci_not_green',
  /** GitHub could not be reached or refused the request (502); details in /api/github/settings. */
  'github_error',
  /** Home Assistant is not connected or refused/timed out the service call (502). */
  'ha_error',
  /** The optional module (github, homeassistant, games) is switched off (404). */
  'module_disabled',
  /**
   * Game start refused: its RAM limit does not fit into free RAM minus the
   * reserve for wichtig containers (409). `details`: InsufficientRamDetails.
   */
  'insufficient_ram',
  /**
   * Game start refused because the server's RAM is unknown (no metrics, or older
   * than 60 s), so the reserve cannot be checked (409). Only for share-link
   * starts (the share API answers it as 409 `unavailable`); the admin may start.
   */
  'ram_unknown',
  /** An alert channel (Discord, Telegram, ntfy) refused or did not answer the test message (502). */
  'channel_failed',
  /**
   * M22: the confirmed cloud price no longer matches the core's estimate (409).
   * `currentEurPerHour` carries the current running price; the UI asks again.
   */
  'price_changed',
  /**
   * M22: the cloud budget of the month is used up (409). Automatic starts are refused;
   * the admin repeats the order or the machine start with `overBudget: true`.
   */
  'over_budget',
  /** M22: the cloud provider refused or did not answer (502); `message` is one of CLOUD_ERRORS. */
  'cloud_error',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export const errorResponseSchema = z.strictObject({
  ok: z.literal(false),
  error: errorCodeSchema,
  /** Seconds until retry is allowed (rate limit). */
  retryAfter: z.number().int().optional(),
  /**
   * Optional fixed German hint for the user (e.g. "Server-Passwort: mindestens
   * 8 Zeichen"). Written by the core, never contains input values or internals.
   */
  message: z.string().max(200).optional(),
  /** Only with error `insufficient_ram`. */
  details: insufficientRamDetailsSchema.optional(),
  /** Only with error `price_changed` (M22): the current running price in EUR per hour. */
  currentEurPerHour: z.number().nonnegative().optional(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
