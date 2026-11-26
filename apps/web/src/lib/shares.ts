import {
  okResponseSchema,
  shareAuditResponseSchema,
  shareCreateResponseSchema,
  shareGatewaySettingsSchema,
  shareGatewayTokenResponseSchema,
  shareListResponseSchema,
  sharePersonSchema,
  sharePinSchema,
  shareResponseSchema,
  type SharePerm,
  type ShareLink,
} from '@hz/shared';
import type { Status } from '@hz/ui';
import { api } from './api.js';
import { formatAgo, formatWhen } from './format.js';

/** Inferred from the shared schemas, so web needs no direct zod import. */
export type ShareAuditEntry = ReturnType<typeof shareAuditResponseSchema.parse>['entries'][number];
export type ShareGatewaySettings = ReturnType<typeof shareGatewaySettingsSchema.parse>;
export type ShareCreated = ReturnType<typeof shareCreateResponseSchema.parse>;
export type ShareExpiry = '1d' | '7d' | '14d' | '30d' | 'never';

// ---------------------------------------------------------------------------
// Query keys and REST calls (routes from packages/shared/src/api/share.ts)

export const sharesKey = (gameId: string) => ['shares', gameId] as const;
export const shareAuditKey = (gameId: string) => ['share-audit', gameId] as const;
export const shareGatewayKey = ['settings', 'share-gateway'] as const;

const enc = encodeURIComponent;

export async function fetchShares(gameId: string, signal?: AbortSignal): Promise<ShareLink[]> {
  const res = await api(`/api/games/${enc(gameId)}/shares`, {
    schema: shareListResponseSchema,
    signal,
  });
  return res.shares;
}

export interface ShareCreateInput {
  person: string;
  perms: SharePerm[];
  expires: ShareExpiry;
  pin?: string;
}

export function createShare(gameId: string, body: ShareCreateInput): Promise<ShareCreated> {
  return api(`/api/games/${enc(gameId)}/shares`, {
    method: 'POST',
    body,
    schema: shareCreateResponseSchema,
  });
}

export async function revokeShare(id: string): Promise<ShareLink> {
  const res = await api(`/api/shares/${enc(id)}/revoke`, {
    method: 'POST',
    schema: shareResponseSchema,
  });
  return res.share;
}

export async function removeShare(id: string): Promise<void> {
  await api(`/api/shares/${enc(id)}`, { method: 'DELETE', schema: okResponseSchema });
}

export async function fetchShareAudit(
  gameId: string,
  signal?: AbortSignal,
  limit = 50,
): Promise<ShareAuditEntry[]> {
  const res = await api(`/api/games/${enc(gameId)}/share-audit?limit=${limit}`, {
    schema: shareAuditResponseSchema,
    signal,
  });
  return res.entries;
}

export function fetchShareGateway(signal?: AbortSignal): Promise<ShareGatewaySettings> {
  return api('/api/settings/share-gateway', { schema: shareGatewaySettingsSchema, signal });
}

/** Step-up route: api() asks for the TOTP code and retries once. */
export function saveShareGateway(body: {
  enabled: boolean;
  publicUrl: string | null;
}): Promise<ShareGatewaySettings> {
  return api('/api/settings/share-gateway', {
    method: 'PUT',
    body,
    schema: shareGatewaySettingsSchema,
  });
}

/** Step-up route. The token is shown once; the old one stops working. */
export async function createGatewayToken(): Promise<string> {
  const res = await api('/api/settings/share-gateway/token', {
    method: 'POST',
    schema: shareGatewayTokenResponseSchema,
  });
  return res.token;
}

// ---------------------------------------------------------------------------
// Texts (SPEC 6.4, "Stimme und Text")

export const PERM_ORDER: readonly SharePerm[] = [
  'power',
  'restart',
  'console_read',
  'console_write',
  'whitelist',
];

export const PERM_TEXT: Record<SharePerm, string> = {
  power: 'Starten/Stoppen',
  restart: 'Neustart',
  console_read: 'Konsole lesen',
  console_write: 'Konsole schreiben',
  whitelist: 'Whitelist bearbeiten',
};

/** Whitelist editing only exists for Minecraft Java. */
export function permsFor(templateId: string): SharePerm[] {
  return PERM_ORDER.filter((p) => p !== 'whitelist' || templateId === 'minecraft-java');
}

/** "Starten/Stoppen · Konsole lesen", in the fixed order. */
export function permsText(perms: readonly SharePerm[]): string {
  const list = PERM_ORDER.filter((p) => perms.includes(p));
  return list.length ? list.map((p) => PERM_TEXT[p]).join(' · ') : 'keine Rechte';
}

export const EXPIRY_OPTIONS: readonly { value: ShareExpiry; label: string }[] = [
  { value: '1d', label: '1 Tag' },
  { value: '7d', label: '7 Tage' },
  { value: '14d', label: '14 Tage' },
  { value: '30d', label: '30 Tage' },
  { value: 'never', label: 'nie' },
];

export interface ShareStateView {
  status: Status;
  /** Short tag next to the shape. */
  tag: string;
  /** "läuft ab 03.12. 23:04", "abgelaufen 24.11. 09:00" … */
  when: string;
  locked: boolean;
}

function lockedNow(s: Pick<ShareLink, 'lockedUntil'>, now: Date): boolean {
  return !!s.lockedUntil && new Date(s.lockedUntil).getTime() > now.getTime();
}

export function shareState(s: ShareLink, now: Date = new Date()): ShareStateView {
  if (s.state === 'revoked') {
    return {
      status: 'off',
      tag: 'WIDERRUFEN',
      when: s.revokedAt ? `widerrufen ${formatWhen(new Date(s.revokedAt), now)}` : 'widerrufen',
      locked: false,
    };
  }
  if (s.state === 'expired') {
    return {
      status: 'off',
      tag: 'ABGELAUFEN',
      when: s.expiresAt ? `abgelaufen ${formatWhen(new Date(s.expiresAt), now)}` : 'abgelaufen',
      locked: false,
    };
  }
  const when = s.expiresAt ? `läuft ab ${formatWhen(new Date(s.expiresAt), now)}` : 'läuft nie ab';
  if (lockedNow(s, now) && s.lockedUntil) {
    return {
      status: 'warn',
      tag: 'GESPERRT',
      when: `${when} · PIN gesperrt bis ${formatWhen(new Date(s.lockedUntil), now)}`,
      locked: true,
    };
  }
  return { status: 'ok', tag: 'AKTIV', when, locked: false };
}

/** "mit PIN · zuletzt vor 4 Min" */
export function shareSub(s: ShareLink, now: Date = new Date()): string {
  const used = s.lastUsedAt
    ? `zuletzt benutzt ${formatAgo(new Date(s.lastUsedAt), now)}`
    : 'noch nie benutzt';
  return `${s.hasPin ? 'mit PIN' : 'ohne PIN'} · ${used}`;
}

/** Active links first (newest first), then expired and revoked. */
export function sortShares(list: readonly ShareLink[]): ShareLink[] {
  const rank = { active: 0, expired: 1, revoked: 2 } as const;
  return [...list].sort(
    (a, b) => rank[a.state] - rank[b.state] || b.createdAt.localeCompare(a.createdAt),
  );
}

export const AUDIT_TEXT: Record<ShareAuditEntry['action'], string> = {
  view: 'hat die Seite geöffnet',
  start: 'hat gestartet',
  stop: 'hat gestoppt',
  restart: 'hat neu gestartet',
  console_read: 'hat die Konsole gelesen',
  console_write: 'hat einen Befehl gesendet',
  whitelist_add: 'hat zur Whitelist hinzugefügt',
  whitelist_remove: 'hat von der Whitelist entfernt',
  pin_failed: 'hat eine falsche PIN eingegeben',
  pin_locked: 'ist gesperrt (5 falsche PINs)',
  denied: 'wurde abgewiesen (kein Recht)',
};

/** Failed or refused attempts get the warn shape in the audit list. */
export function auditIsWarning(action: ShareAuditEntry['action']): boolean {
  return action === 'pin_failed' || action === 'pin_locked' || action === 'denied';
}

/** "23:04 · über Gateway · 203.0.113.7" */
export function auditSub(e: ShareAuditEntry, now: Date = new Date()): string {
  const via = e.via === 'gateway' ? 'über Gateway' : 'im Tailnet';
  return [formatWhen(new Date(e.ts), now), via, e.ip].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------
// Create form

export interface ShareDraft {
  person: string;
  perms: SharePerm[];
  expires: ShareExpiry;
  pin: string;
}

export const emptyDraft = (): ShareDraft => ({
  person: '',
  perms: ['power'],
  expires: '7d',
  pin: '',
});

/** Konsole schreiben includes reading; switching reading off also switches writing off. */
export function togglePerm(perms: readonly SharePerm[], p: SharePerm, on: boolean): SharePerm[] {
  const next = new Set(perms);
  if (on) {
    next.add(p);
    if (p === 'console_write') next.add('console_read');
  } else {
    next.delete(p);
    if (p === 'console_read') next.delete('console_write');
  }
  return PERM_ORDER.filter((x) => next.has(x));
}

export type ShareDraftErrors = Partial<Record<'person' | 'perms' | 'pin', string>>;

export function validateDraft(
  d: ShareDraft,
  allowed: readonly SharePerm[],
): { errors: ShareDraftErrors; body: ShareCreateInput | null } {
  const errors: ShareDraftErrors = {};
  const person = sharePersonSchema.safeParse(d.person);
  if (!person.success) {
    errors.person = d.person.trim()
      ? "Höchstens 40 Zeichen: Buchstaben, Ziffern, Leerzeichen und . _ ' -"
      : 'Name der Person eingeben.';
  }
  const perms = d.perms.filter((p) => allowed.includes(p));
  if (perms.length === 0) errors.perms = 'Mindestens ein Recht wählen.';
  const pin = d.pin.trim();
  if (pin && !sharePinSchema.safeParse(pin).success) errors.pin = 'Genau 4 Ziffern oder leer.';
  if (Object.keys(errors).length || !person.success) return { errors, body: null };
  return {
    errors,
    body: { person: person.data, perms, expires: d.expires, ...(pin ? { pin } : {}) },
  };
}

// ---------------------------------------------------------------------------
// Share-Gateway settings

/** Public URL of the gateway: https only, no path, query or credentials; needed when on. */
export function publicUrlError(value: string, enabled: boolean): string | null {
  const v = value.trim();
  if (!v) return enabled ? 'Zum Einschalten die öffentliche Adresse eintragen.' : null;
  if (v.length > 200) return 'Höchstens 200 Zeichen.';
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return 'Ganze Adresse mit https:// eintragen.';
  }
  if (u.protocol !== 'https:') return 'Nur https-Adressen.';
  if (u.username || u.password) return 'Ohne Benutzer und Passwort.';
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
    return 'Nur die Adresse, ohne Pfad (z. B. https://spiel.example.duckdns.org).';
  }
  return null;
}
