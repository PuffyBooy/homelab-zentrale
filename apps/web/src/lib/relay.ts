import {
  dnsNameSchema,
  gameRelayResponseSchema,
  ingressListResponseSchema,
  ingressResponseSchema,
  ingressUpdateRequestSchema,
  publicIpv4Schema,
  type GameRelay,
  type GameSummary,
  type Ingress,
} from '@hz/shared';
import type { Status } from '@hz/ui';
import { api, isApiError } from './api.js';
import { errorText } from './errors.js';

/** Inferred from the shared schemas, so web needs no direct zod import. */
export type IngressUpdate = ReturnType<typeof ingressUpdateRequestSchema.parse>;

// ---------------------------------------------------------------------------
// Query keys and REST calls (routes from packages/shared/src/api/relay.ts)

export const ingressesKey = ['relay', 'ingresses'] as const;
export const gameRelayKey = (gameId: string) => ['game-relay', gameId] as const;

const enc = encodeURIComponent;

export async function fetchIngresses(signal?: AbortSignal): Promise<Ingress[]> {
  const res = await api('/api/relay/ingresses', { schema: ingressListResponseSchema, signal });
  return res.ingresses;
}

/** Step-up route: api() asks for the TOTP code and retries once. */
export async function saveIngress(serverId: string, body: IngressUpdate): Promise<Ingress> {
  const res = await api(`/api/servers/${enc(serverId)}/ingress`, {
    method: 'PUT',
    body,
    schema: ingressResponseSchema,
  });
  return res.ingress;
}

export async function fetchGameRelay(
  gameId: string,
  signal?: AbortSignal,
): Promise<GameRelay | null> {
  const res = await api(`/api/games/${enc(gameId)}/relay`, {
    schema: gameRelayResponseSchema,
    signal,
  });
  return res.relay;
}

export interface GameRelayInput {
  ingressServerId: string | null;
  dnsName?: string | null;
}

/** Step-up route. `ingressServerId: null` removes the relay (direct again). */
export async function saveGameRelay(
  gameId: string,
  body: GameRelayInput,
): Promise<GameRelay | null> {
  const res = await api(`/api/games/${enc(gameId)}/relay`, {
    method: 'PUT',
    body,
    schema: gameRelayResponseSchema,
  });
  return res.relay;
}

// ---------------------------------------------------------------------------
// Ingress (Settings → Eingänge)

export const RELAY_ENV_HINT = 'Am Server HZ_AGENT_ALLOW_RELAY=1 setzen und Agent neu starten.';

/** Status dot of one ingress row: always shape and text. */
export function ingressStatus(i: Ingress): { status: Status; label: string } {
  if (!i.enabled) return { status: 'off', label: 'Aus' };
  if (!i.connected) return { status: 'crit', label: 'Getrennt' };
  if (!i.capable) return { status: 'warn', label: 'Relay nicht erlaubt' };
  return { status: 'ok', label: 'Bereit' };
}

/** "Bereit 2 · Aus 1" style summary for the tile head. */
export function ingressSummary(list: readonly Ingress[]): { status: Status; label: string } {
  const on = list.filter((i) => i.enabled);
  if (on.length === 0) return { status: 'off', label: 'KEINER' };
  const bad = on.filter((i) => !i.connected || !i.capable).length;
  if (bad > 0) return { status: 'warn', label: `${bad} PRÜFEN` };
  return { status: 'ok', label: `${on.length} BEREIT` };
}

export interface IngressDraft {
  enabled: boolean;
  publicIp: string;
  portFrom: string;
  portTo: string;
}

export const DEFAULT_PORT_FROM = 25565;
export const DEFAULT_PORT_TO = 25600;

export function ingressDraft(i: Ingress): IngressDraft {
  // A server that was never an ingress may report 0–0: suggest the Minecraft range.
  const fresh = i.portFrom < 1024 || i.portTo < 1024;
  return {
    enabled: i.enabled,
    publicIp: i.publicIp ?? '',
    portFrom: String(fresh ? DEFAULT_PORT_FROM : i.portFrom),
    portTo: String(fresh ? DEFAULT_PORT_TO : i.portTo),
  };
}

export type IngressDraftErrors = Partial<Record<'publicIp' | 'portFrom' | 'portTo', string>>;

function parsePort(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d{1,5}$/.test(t)) return null;
  return Number(t);
}

/**
 * Checks the draft like the core does (ingressUpdateRequestSchema). An empty IPv4 means
 * "from the inventory". German messages per field.
 */
export function parseIngressDraft(
  d: IngressDraft,
): { ok: true; body: IngressUpdate } | { ok: false; errors: IngressDraftErrors } {
  const errors: IngressDraftErrors = {};
  const ip = d.publicIp.trim();
  if (ip && !publicIpv4Schema.safeParse(ip).success) {
    errors.publicIp = 'Keine öffentliche IPv4-Adresse (z. B. 203.0.113.7).';
  }
  const from = parsePort(d.portFrom);
  const to = parsePort(d.portTo);
  if (from == null || from < 1024 || from > 65535) errors.portFrom = 'Port 1024 bis 65535.';
  if (to == null || to < 1024 || to > 65535) errors.portTo = 'Port 1024 bis 65535.';
  if (from != null && to != null && !errors.portFrom && !errors.portTo) {
    if (from > to) errors.portTo = 'Muss größer oder gleich „von“ sein.';
    else if (to - from > 5000) errors.portTo = 'Höchstens 5000 Ports.';
  }
  if (Object.keys(errors).length > 0 || from == null || to == null) return { ok: false, errors };
  const parsed = ingressUpdateRequestSchema.safeParse({
    enabled: d.enabled,
    publicIp: ip || null,
    portFrom: from,
    portTo: to,
  });
  if (!parsed.success) return { ok: false, errors: { portTo: 'Portbereich ungültig.' } };
  return { ok: true, body: parsed.data };
}

export function ingressDirty(i: Ingress, d: IngressDraft): boolean {
  const base = ingressDraft(i);
  return (
    base.enabled !== d.enabled ||
    base.publicIp !== d.publicIp.trim() ||
    base.portFrom !== d.portFrom.trim() ||
    base.portTo !== d.portTo.trim()
  );
}

export function ingressErrorText(err: unknown): string | null {
  if (!err || isApiError(err, 'step_up_required')) return null;
  if (isApiError(err) && err.status === 409 && !err.hint) {
    return 'Über diesen Eingang laufen noch Spiele. Stell sie zuerst auf einen anderen Eingang oder auf direkt um.';
  }
  return errorText(err);
}

export function relayedGamesText(i: Ingress): string {
  if (i.games.length === 0) return 'keine';
  return i.games.map((g) => g.name).join(', ');
}

// ---------------------------------------------------------------------------
// Relay per game (Gameserver → Erreichbar über)

export const DIRECT = '';

/** Ingresses a game can use: enabled, capable and not the server the game runs on. */
export function relayChoices(
  ingresses: readonly Ingress[],
  game: Pick<GameSummary, 'serverId'>,
): Ingress[] {
  return ingresses
    .filter((i) => i.enabled && i.capable && i.serverId !== game.serverId)
    .sort((a, b) => a.serverName.localeCompare(b.serverName));
}

export function relayChoiceLabel(i: Ingress): string {
  const ip = i.publicIp ?? 'IP aus Inventar fehlt';
  return `${i.serverName} · ${ip}${i.connected ? '' : ' · getrennt'}`;
}

/** Small hint under a game tile: "über oracle-a1". */
export function relayVia(r: Pick<GameRelay, 'ingressName'>): string {
  return `über ${r.ingressName}`;
}

const RELAY_STATE: Record<GameRelay['state'], { status: Status; label: string }> = {
  ok: { status: 'ok', label: 'Weiterleitung aktiv' },
  pending: { status: 'busy', label: 'Wartet auf den Eingang' },
  error: { status: 'crit', label: 'Fehler am Eingang' },
};

export function relayStatus(r: GameRelay): { status: Status; label: string } {
  return RELAY_STATE[r.state];
}

/** Where the DNS names come from (M20 domains module). */
export const DOMAINS_PATH = '/internet';

/** DNS line of a relay: always shape and text. null: the game has no DNS name. */
export function relayDnsStatus(r: GameRelay): { status: Status; label: string } | null {
  if (!r.dnsName || r.dnsOk === null) return null;
  if (r.dnsOk) return { status: 'ok', label: 'Zeigt auf den Eingang' };
  return { status: 'warn', label: 'Zeigt nicht auf den Eingang' };
}

export function dnsOkText(r: GameRelay): string {
  const st = relayDnsStatus(r);
  if (!st) return 'kein Name';
  if (st.status === 'ok') return 'zeigt auf den Eingang';
  return r.dnsError ?? 'zeigt noch nicht auf den Eingang';
}

/** Validates the optional DNS name; empty means none. */
export function parseDnsName(
  raw: string,
): { ok: true; name: string | null } | { ok: false; error: string } {
  const t = raw.trim();
  if (!t) return { ok: true, name: null };
  const parsed = dnsNameSchema.safeParse(t);
  if (!parsed.success) return { ok: false, error: 'Ungültiger Name (z. B. mc.example.org).' };
  return { ok: true, name: parsed.data };
}

export function gameRelayErrorText(err: unknown): string | null {
  if (!err || isApiError(err, 'step_up_required')) return null;
  if (isApiError(err) && err.status === 409 && !err.hint) {
    return 'Ein Port ist am Eingang schon belegt oder liegt außerhalb seines Bereichs.';
  }
  return errorText(err);
}
