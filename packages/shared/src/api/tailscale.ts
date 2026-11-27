import { z } from 'zod';

/**
 * Tailscale join for "Server hinzufügen" (M11b). The one-liner must work on a fresh
 * server that is not in the tailnet yet, so it first installs Tailscale and joins.
 *
 * With a Tailscale OAuth client stored here (scope "Auth Keys: write", one tag), the
 * hub mints a fresh auth key per onboarding code: single use, preauthorized, not
 * ephemeral, tagged, valid as long as the code (ONBOARDING_TTL_MINUTES). The key is
 * put into the one-liner and shown once, like the code; it is never stored. Without
 * a client the one-liner runs an interactive `tailscale up` (login link).
 *
 * GET    /api/tailscale           (session)          -> TailscaleSettings
 * PUT    /api/tailscale           (session + step-up) TailscaleSettingsRequest -> TailscaleSettings
 * POST   /api/tailscale/test      (session)          -> TailscaleSettings (mints and deletes a key)
 * DELETE /api/tailscale           (session + step-up) -> TailscaleSettings
 */

export const TAILSCALE_DEFAULT_TAG = 'tag:homelab-server';
/** Tailscale tag names: letter first, then letters, digits and dashes. */
export const tailscaleTagSchema = z
  .string()
  .max(60)
  .regex(/^tag:[A-Za-z][A-Za-z0-9-]{0,49}$/, { message: 'Tag wie tag:homelab-server' });
/** OAuth client id (admin console → Settings → OAuth clients). */
export const tailscaleClientIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9]{6,64}$/, { message: 'Client-ID aus der Tailscale-Konsole' });
/** OAuth client secret. Write-only: never returned. */
export const tailscaleClientSecretSchema = z
  .string()
  .regex(/^tskey-client-[A-Za-z0-9_-]{8,200}$/, { message: 'Secret beginnt mit tskey-client-' });
/** A minted auth key (only in the one-liner). */
export const TAILSCALE_AUTH_KEY_RE = /^tskey-auth-[A-Za-z0-9_-]{8,200}$/;

/** Fixed German texts of the last check; no API text is ever passed through. */
export const TAILSCALE_ERRORS = [
  'Client-ID oder Secret falsch',
  'Keine Berechtigung für Auth-Keys oder diesen Tag',
  'Tailscale nicht erreichbar',
  'Unerwartete Antwort von Tailscale',
  'Zugangsdaten nicht lesbar, bitte neu eintragen',
] as const;
export const tailscaleErrorSchema = z.enum(TAILSCALE_ERRORS);
export type TailscaleErrorText = z.infer<typeof tailscaleErrorSchema>;

export const tailscaleSettingsSchema = z.strictObject({
  clientId: tailscaleClientIdSchema.nullable(),
  secretSet: z.boolean(),
  tag: tailscaleTagSchema,
  /** off: not set up; ok: last mint worked; error: last mint failed. */
  status: z.enum(['off', 'ok', 'error']),
  error: tailscaleErrorSchema.nullable(),
  lastOkAt: z.iso.datetime().nullable(),
});
export type TailscaleSettings = z.infer<typeof tailscaleSettingsSchema>;

export const tailscaleSettingsRequestSchema = z.strictObject({
  clientId: tailscaleClientIdSchema.optional(),
  clientSecret: tailscaleClientSecretSchema.optional(),
  tag: tailscaleTagSchema.optional(),
});
export type TailscaleSettingsRequest = z.infer<typeof tailscaleSettingsRequestSchema>;

/** How the one-liner joins the tailnet. */
export const onboardingTailscaleModeSchema = z.enum(['auto', 'login']);
export type OnboardingTailscaleMode = z.infer<typeof onboardingTailscaleModeSchema>;
