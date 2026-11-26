import {
  caCertSchema,
  integrationSecretSchema,
  integrationSettingsSchema,
  integrationUrlSchema,
  okResponseSchema,
  proxmoxTokenIdSchema,
  urlOrigin,
  type DnsFilterVariant,
  type IntegrationId,
  type IntegrationSettings,
  type IntegrationSettingsRequest,
} from '@hz/shared';
import { useQuery } from '@tanstack/react-query';
import type { IconName, Status } from '@hz/ui';
import { api } from './api.js';
import { formatAgo, formatWhen } from './format.js';

/**
 * Einstellungen → Anbindungen (SPEC 16, packages/shared/src/api/integrations.ts).
 * One settings object per integration; the secret is write-only (`secretSet`).
 * Changing url, username, secret, CA or variant needs step-up: api() asks and retries.
 */

export const integrationSettingsKey = (id: IntegrationId) =>
  ['integration', id, 'settings'] as const;

export function fetchIntegrationSettings(
  id: IntegrationId,
  signal?: AbortSignal,
): Promise<IntegrationSettings> {
  return api(`/api/${id}/settings`, { schema: integrationSettingsSchema, signal });
}

export function saveIntegrationSettings(
  id: IntegrationId,
  body: IntegrationSettingsRequest,
): Promise<IntegrationSettings> {
  return api(`/api/${id}/settings`, { method: 'PUT', body, schema: integrationSettingsSchema });
}

/** Forgets url, secret and CA (step-up). */
export async function deleteIntegrationSettings(id: IntegrationId): Promise<void> {
  await api(`/api/${id}/settings`, { method: 'DELETE', schema: okResponseSchema });
}

/** Runs one request now and answers the fresh status. */
export function testIntegration(id: IntegrationId): Promise<IntegrationSettings> {
  return api(`/api/${id}/test`, { method: 'POST', schema: integrationSettingsSchema });
}

// ---------------------------------------------------------------------------
// Labels

export const INTEGRATION_TITLE: Record<IntegrationId, string> = {
  proxmox: 'Proxmox',
  dnsfilter: 'DNS-Filter',
  fritzbox: 'FRITZ!Box',
  uptimekuma: 'Uptime Kuma',
};

export const INTEGRATION_ICON: Record<IntegrationId, IconName> = {
  proxmox: 'cloud',
  dnsfilter: 'lock',
  fritzbox: 'wifi',
  uptimekuma: 'globe',
};

export const URL_PLACEHOLDER: Record<IntegrationId, string> = {
  proxmox: 'https://pve.lan:8006',
  dnsfilter: 'http://192.168.1.2',
  fritzbox: 'http://192.168.178.1:49000',
  uptimekuma: 'http://192.168.1.20:3001',
};

export const VARIANT_LABEL: Record<DnsFilterVariant, string> = {
  pihole: 'Pi-hole v6',
  adguard: 'AdGuard Home',
};

/** Label of the user name field, or null when the integration has none. */
export function usernameLabel(id: IntegrationId, variant: DnsFilterVariant | null): string | null {
  if (id === 'proxmox') return 'API-Token-ID (benutzer@realm!name)';
  if (id === 'fritzbox') return 'Benutzer';
  if (id === 'dnsfilter' && variant === 'adguard') return 'Benutzer';
  return null;
}

export function secretLabel(id: IntegrationId, variant: DnsFilterVariant | null): string {
  if (id === 'proxmox') return 'API-Token-Secret';
  if (id === 'uptimekuma') return 'API-Key';
  if (id === 'dnsfilter' && variant !== 'adguard') return 'App-Passwort';
  return 'Passwort';
}

export const SECRET_HINT: Record<IntegrationId, string> = {
  proxmox: 'Datacenter → Berechtigungen → API-Token. Am besten mit der Rolle PVEVMUser statt root.',
  dnsfilter:
    'Pi-hole: Einstellungen → Web-Interface/API → App-Passwort. AdGuard: Login des Admins.',
  fritzbox: 'FRITZ!Box-Benutzer mit dem Recht „FRITZ!Box Einstellungen“. TR-064 muss an sein.',
  uptimekuma: 'Uptime Kuma: Einstellungen → API-Keys. Gelesen wird nur /metrics.',
};

export const URL_NOTE = 'Wechselt die Adresse, musst du das Token neu eintragen.';

// ---------------------------------------------------------------------------
// Status

export function integrationTileStatus(s: IntegrationSettings | undefined): Status | undefined {
  if (!s) return undefined;
  if (s.status === 'ok') return 'ok';
  if (s.status === 'error') return 'warn';
  return 'off';
}

/** Proxmox (token id) and AdGuard need a user name; FRITZ!Box may go without one. */
export function usernameRequired(id: IntegrationId, variant: DnsFilterVariant | null): boolean {
  return id === 'proxmox' || (id === 'dnsfilter' && variant === 'adguard');
}

/**
 * URL and secret (and the user name where needed) are stored. The core reports `off`
 * also for a set-up integration that never answered yet, so `status` alone is not enough.
 */
export function isIntegrationConfigured(id: IntegrationId, s: IntegrationSettings): boolean {
  if (s.url === null || !s.secretSet) return false;
  return !usernameRequired(id, s.variant) || s.username !== null;
}

/** "OK", "Fehler: Zeitüberschreitung", "noch nicht geprüft", "nicht eingerichtet". */
export function integrationStatusText(s: IntegrationSettings): string {
  if (s.status === 'ok') return 'OK';
  if (s.status === 'error') return `Fehler: ${s.error ?? 'unbekannt'}`;
  return s.url !== null && s.secretSet ? 'noch nicht geprüft' : 'nicht eingerichtet';
}

/** "zuletzt OK 23:04 · vor 4 Min" or "noch nie". */
export function lastOkText(s: IntegrationSettings, now: Date = new Date()): string {
  if (!s.lastOkAt) return 'noch nie';
  const d = new Date(s.lastOkAt);
  return `${formatWhen(d, now)} · ${formatAgo(d, now)}`;
}

// ---------------------------------------------------------------------------
// Form

export interface IntegrationForm {
  url: string;
  username: string;
  secret: string;
  caCert: string;
  /** Remove the stored CA (only shown while caSet). */
  removeCa: boolean;
  variant: DnsFilterVariant;
}

export type IntegrationFormErrors = Partial<
  Record<'url' | 'username' | 'secret' | 'caCert', string>
>;

export function integrationToForm(s: IntegrationSettings): IntegrationForm {
  return {
    url: s.url ?? '',
    username: s.username ?? '',
    secret: '',
    caCert: '',
    removeCa: false,
    variant: s.variant ?? 'pihole',
  };
}

const PLAIN_USER_RE = /^[A-Za-z0-9._@-]{1,64}$/;

/**
 * Builds the PUT body from the form: only fields that changed. Errors in German, per
 * field. When the URL origin changes the core drops the stored secret, so a new one is
 * required in the same request (a token is never sent to a host it was not entered for).
 */
export function buildIntegrationPatch(
  id: IntegrationId,
  s: IntegrationSettings,
  f: IntegrationForm,
): { patch: IntegrationSettingsRequest; errors: IntegrationFormErrors } {
  const patch: IntegrationSettingsRequest = {};
  const errors: IntegrationFormErrors = {};

  const variant = id === 'dnsfilter' ? f.variant : null;
  if (id === 'dnsfilter' && f.variant !== s.variant) patch.variant = f.variant;

  const url = f.url.trim();
  const urlChanged = url !== (s.url ?? '');
  if (urlChanged) {
    if (!url) errors.url = `Adresse fehlt, z. B. ${URL_PLACEHOLDER[id]}.`;
    else if (!integrationUrlSchema.safeParse(url).success)
      errors.url = 'Adresse mit http:// oder https://, ohne Benutzer, Query oder Anker.';
    else patch.url = url;
  }

  const userLabel = usernameLabel(id, variant);
  if (userLabel) {
    const u = f.username.trim();
    if (u !== (s.username ?? '')) {
      if (!u && !usernameRequired(id, variant)) patch.username = null;
      else if (!u) errors.username = `${userLabel.split(' (')[0]} fehlt.`;
      else if (id === 'proxmox' && !proxmoxTokenIdSchema.safeParse(u).success)
        errors.username = 'Format: benutzer@realm!tokenname, z. B. hz@pve!zentrale.';
      else if (id !== 'proxmox' && !PLAIN_USER_RE.test(u))
        errors.username = 'Nur Buchstaben, Ziffern und . _ @ -, höchstens 64 Zeichen.';
      else patch.username = u;
    } else if (!u && usernameRequired(id, variant) && (url || s.url)) {
      errors.username = `${userLabel.split(' (')[0]} fehlt.`;
    }
  } else if (s.username !== null && id === 'dnsfilter') {
    // Pi-hole has only a password.
    patch.username = null;
  }

  const secret = f.secret;
  const originChanged =
    urlChanged &&
    !!s.url &&
    !!url &&
    urlOrigin(url) !== null &&
    urlOrigin(url) !== urlOrigin(s.url);
  if (secret) {
    if (!integrationSecretSchema.safeParse(secret).success)
      errors.secret = 'Nur druckbare Zeichen, ohne Leerzeichen am Anfang oder Ende.';
    else patch.secret = secret;
  } else if (originChanged && s.secretSet) {
    errors.secret = 'Neue Adresse: Zugangsdaten neu eintragen.';
  } else if (!s.secretSet && (url || s.url)) {
    errors.secret = `${secretLabel(id, variant)} fehlt.`;
  }
  if (!url && !s.url && (secret || f.username.trim())) {
    errors.url = `Adresse fehlt, z. B. ${URL_PLACEHOLDER[id]}.`;
  }

  const ca = f.caCert.trim();
  if (ca) {
    if (!caCertSchema.safeParse(ca).success)
      errors.caCert = 'PEM-Zertifikat erwartet (-----BEGIN CERTIFICATE----- …), höchstens 3.';
    else patch.caCert = ca;
  } else if (f.removeCa && s.caSet) {
    patch.caCert = null;
  }

  return { patch, errors };
}

export function hasErrors(errors: object): boolean {
  return Object.keys(errors).length > 0;
}

/** Settings of one integration; `ready` once it has URL and secret (status not `off`). */
export function useIntegrationSettings(id: IntegrationId, enabled = true) {
  const q = useQuery({
    queryKey: integrationSettingsKey(id),
    queryFn: ({ signal }) => fetchIntegrationSettings(id, signal),
    enabled,
    staleTime: 30_000,
  });
  return {
    query: q,
    /** null while unknown. */
    configured: q.data ? isIntegrationConfigured(id, q.data) : null,
  };
}
