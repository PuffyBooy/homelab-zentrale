import {
  PROXMOX_STEP_UP_ACTIONS,
  proxmoxGuestActionResponseSchema,
  proxmoxGuestsResponseSchema,
  type ProxmoxAction,
  type ProxmoxGuest,
} from '@hz/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { Status } from '@hz/ui';
import { api } from './api.js';
import { useIntegrationSettings } from './integrations.js';
import { formatBytesOf, formatNumber, formatPercent, plural } from './format.js';
import type { StatusSentence } from './servers.js';

/** Proxmox (SPEC 16, page "VMs"). Routes from packages/shared/src/api/integrations.ts. */

export type ProxmoxGuests = ReturnType<typeof proxmoxGuestsResponseSchema.parse>;
export type ProxmoxNode = ProxmoxGuests['nodes'][number];

export const proxmoxGuestsKey = ['proxmox', 'guests'] as const;

/** Refresh interval of the guest list (no live topic). */
export const PROXMOX_REFRESH_MS = 15_000;

export function fetchProxmoxGuests(signal?: AbortSignal): Promise<ProxmoxGuests> {
  return api('/api/proxmox/guests', { schema: proxmoxGuestsResponseSchema, signal });
}

export function useProxmoxGuests(enabled = true): UseQueryResult<ProxmoxGuests> {
  return useQuery({
    queryKey: proxmoxGuestsKey,
    queryFn: ({ signal }) => fetchProxmoxGuests(signal),
    enabled,
    refetchInterval: PROXMOX_REFRESH_MS,
    staleTime: 10_000,
  });
}

/** Settings and guests: the guest list is only read once Proxmox is set up. */
export function useProxmoxView(enabled = true) {
  const settings = useIntegrationSettings('proxmox', enabled);
  const guests = useProxmoxGuests(enabled && settings.configured === true);
  return { settings, guests };
}

export function needsConfirm(action: ProxmoxAction): boolean {
  return PROXMOX_STEP_UP_ACTIONS.includes(action);
}

/** Path of the action route; node and type come from the guest list. */
export function guestActionPath(g: Pick<ProxmoxGuest, 'node' | 'type' | 'vmid'>, a: ProxmoxAction) {
  const enc = encodeURIComponent;
  return `/api/proxmox/guests/${enc(g.node)}/${g.type}/${g.vmid}/${a}`;
}

/**
 * Start goes straight through; shutdown, stop and reboot carry `confirm: true` (the user
 * confirmed in the dialog) and need step-up, which api() asks for and retries once.
 */
export function runGuestAction(
  g: Pick<ProxmoxGuest, 'node' | 'type' | 'vmid'>,
  action: ProxmoxAction,
): Promise<{ ok: true; task: string | null }> {
  return api(guestActionPath(g, action), {
    method: 'POST',
    body: needsConfirm(action) ? { confirm: true } : {},
    schema: proxmoxGuestActionResponseSchema,
  });
}

// ---------------------------------------------------------------------------
// Labels and formatting

export const TYPE_LABEL: Record<ProxmoxGuest['type'], string> = { qemu: 'VM', lxc: 'LXC' };

export const ACTION_LABEL: Record<ProxmoxAction, string> = {
  start: 'Starten',
  shutdown: 'Herunterfahren',
  stop: 'Stoppen',
  reboot: 'Neu starten',
};

export const ACTION_PENDING: Record<ProxmoxAction, string> = {
  start: 'startet …',
  shutdown: 'fährt herunter …',
  stop: 'stoppt …',
  reboot: 'startet neu …',
};

/** Confirm text per action, status first: what happens to the guest. */
export function confirmText(g: ProxmoxGuest, action: ProxmoxAction): string {
  if (action === 'shutdown')
    return `${g.name} bekommt ein ACPI-Signal und fährt sauber herunter. Dienste darin sind danach weg.`;
  if (action === 'stop')
    return `${g.name} wird sofort hart ausgeschaltet, wie Stecker ziehen. Ungespeicherte Daten gehen verloren.`;
  if (action === 'reboot') return `${g.name} startet neu und ist dabei kurz nicht erreichbar.`;
  return `${g.name} starten.`;
}

export function isGuestRunning(g: Pick<ProxmoxGuest, 'status'>): boolean {
  return g.status === 'running';
}

export function guestStatus(g: Pick<ProxmoxGuest, 'status' | 'template'>): Status {
  if (g.template) return 'off';
  if (g.status === 'running') return 'ok';
  if (g.status === 'stopped') return 'off';
  return 'warn';
}

export const GUEST_STATUS_TEXT: Record<ProxmoxGuest['status'], string> = {
  running: 'läuft',
  stopped: 'gestoppt',
  paused: 'pausiert',
  unknown: 'Status unbekannt',
};

export function guestStatusText(g: Pick<ProxmoxGuest, 'status' | 'template'>): string {
  return g.template ? 'Vorlage' : GUEST_STATUS_TEXT[g.status];
}

/** Paused and unknown guests are problems; templates never. */
export function isGuestProblem(g: Pick<ProxmoxGuest, 'status' | 'template'>): boolean {
  return !g.template && (g.status === 'paused' || g.status === 'unknown');
}

const RANK: Record<Status, number> = { crit: 0, warn: 1, busy: 2, info: 3, ok: 4, off: 5 };

/** Problems first, then running, then stopped, templates last; within by name. */
export function sortGuests<T extends ProxmoxGuest>(list: readonly T[]): T[] {
  return [...list].sort(
    (a, b) =>
      Number(a.template) - Number(b.template) ||
      RANK[guestStatus(a)] - RANK[guestStatus(b)] ||
      a.name.localeCompare(b.name, 'de') ||
      a.vmid - b.vmid,
  );
}

/** CPU of a guest in percent of its cores (0..1 of `cpus`). */
export function guestCpuPct(g: Pick<ProxmoxGuest, 'cpu'>): number | null {
  return g.cpu == null ? null : Math.min(100, g.cpu * 100);
}

export function guestRamPct(g: Pick<ProxmoxGuest, 'memBytes' | 'maxMemBytes'>): number | null {
  if (g.memBytes == null || !g.maxMemBytes) return null;
  return Math.min(100, (g.memBytes / g.maxMemBytes) * 100);
}

/** "1,2 / 4 GB" or "—". */
export function guestRamText(g: Pick<ProxmoxGuest, 'memBytes' | 'maxMemBytes'>): string {
  if (g.memBytes == null || !g.maxMemBytes) return '—';
  return formatBytesOf(g.memBytes, g.maxMemBytes);
}

/** "CPU 12 % · 4 Kerne". */
export function guestCpuText(g: Pick<ProxmoxGuest, 'cpu' | 'cpus'>): string {
  const pct = formatPercent(guestCpuPct(g));
  return g.cpus ? `${pct} · ${plural(g.cpus, 'Kern', 'Kerne')}` : pct;
}

export function nodeRamPct(n: ProxmoxNode): number | null {
  if (n.memBytes == null || !n.maxMemBytes) return null;
  return Math.min(100, (n.memBytes / n.maxMemBytes) * 100);
}

export function nodeCpuPct(n: ProxmoxNode): number | null {
  return n.cpu == null ? null : Math.min(100, n.cpu * 100);
}

// ---------------------------------------------------------------------------
// Statussatz

/** "4 von 6 Gästen laufen", "Alle 3 Gäste laufen", "1 Gast läuft". */
function runningText(running: number, total: number): string {
  if (total === 1) return running ? '1 Gast läuft' : 'Kein Gast läuft';
  if (running === total) return `Alle ${formatNumber(total, 0)} Gäste laufen`;
  return `${formatNumber(running, 0)} von ${formatNumber(total, 0)} Gästen ${
    running === 1 ? 'läuft' : 'laufen'
  }`;
}

function problemText(g: ProxmoxGuest): string {
  return g.status === 'paused' ? `${g.name} ist pausiert` : `Status von ${g.name} unbekannt`;
}

/**
 * Problems first: "Proxmox nicht erreichbar: …", "Knoten pve2 ist offline",
 * "web01 ist pausiert", then "4 von 6 Gästen laufen". Templates do not count as guests.
 */
export function proxmoxSentence(data: ProxmoxGuests): StatusSentence {
  if (data.error) return { em: `Proxmox nicht erreichbar: ${data.error}`, rest: '' };
  const guests = data.guests.filter((g) => !g.template);
  if (guests.length === 0 && data.nodes.every((n) => n.online)) {
    return { em: null, rest: 'Keine VMs oder Container auf Proxmox.' };
  }
  const count = runningText(guests.filter(isGuestRunning).length, guests.length);
  const offline = data.nodes.filter((n) => !n.online);
  const problems = guests.filter(isGuestProblem);
  const n = offline.length + problems.length;
  if (n === 1 && offline[0])
    return { em: `Knoten ${offline[0].node} ist offline`, rest: ` · ${count}` };
  if (n === 1 && problems[0]) return { em: problemText(problems[0]), rest: ` · ${count}` };
  if (n > 1) return { em: plural(n, 'Problem', 'Probleme'), rest: ` · ${count}` };
  return { em: null, rest: `${count}.` };
}
