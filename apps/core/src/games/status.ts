import type { ContainerState, GameStatusData, GameSummary } from '@hz/shared';

/** setup: being set up; failed: setup failed; running/stopped: what the admin wants. */
export type GamePhase = 'setup' | 'failed' | 'running' | 'stopped';

/** A status answer older than this no longer counts (two missed polls). */
export const STATUS_FRESH_MS = 75_000;
/** A container that started this recently and does not answer yet is still starting. */
export const STARTING_GRACE_MS = 10 * 60_000;
/** Below this, Minecraft TPS is a warning. */
export const TPS_WARN = 15;

export interface GameStateInput {
  phase: GamePhase;
  phaseText: string | null;
  /** In-memory operation (start, stop, restart, backup, settings). */
  busyText: string | null;
  connected: boolean;
  container: {
    state: ContainerState;
    exitCode: number | null;
    startedAt: number | null;
  } | null;
  status: GameStatusData | null;
  statusAt: number | null;
  /** Template has no query method: running container = online. */
  noQuery: boolean;
  now: number;
}

export interface GameState {
  status: GameSummary['status'];
  statusText: string;
  /** Whether players/TPS of the last status answer are current. */
  live: boolean;
}

const tpsText = (tps: number): string =>
  new Intl.NumberFormat('de-AT', { maximumFractionDigits: 1 }).format(tps);

/** Whether the last status answer belongs to the current container run and is fresh. */
export function statusIsLive(i: GameStateInput): boolean {
  if (!i.status || i.statusAt === null) return false;
  if (i.now - i.statusAt > STATUS_FRESH_MS) return false;
  const started = i.container?.startedAt ?? null;
  return started === null || i.statusAt >= started;
}

export function gameState(i: GameStateInput): GameState {
  const off = (statusText: string): GameState => ({ status: 'off', statusText, live: false });
  if (i.busyText !== null) return { status: 'busy', statusText: i.busyText, live: false };
  if (i.phase === 'setup') {
    return { status: 'busy', statusText: i.phaseText ?? 'Wird aufgesetzt', live: false };
  }
  if (i.phase === 'failed') {
    return {
      status: 'crit',
      statusText: i.phaseText
        ? `Aufsetzen fehlgeschlagen: ${i.phaseText}`
        : 'Aufsetzen fehlgeschlagen',
      live: false,
    };
  }
  if (!i.connected) return off('Server offline');
  const c = i.container;
  const running = c?.state === 'running';
  if (i.phase === 'stopped' && !running) return off('Gestoppt');
  if (!c) return { status: 'crit', statusText: 'Container fehlt', live: false };
  switch (c.state) {
    case 'restarting':
      return { status: 'crit', statusText: 'Startet ständig neu', live: false };
    case 'exited':
    case 'dead':
      return c.exitCode !== null && c.exitCode !== 0
        ? { status: 'crit', statusText: `Container abgestürzt (Exit ${c.exitCode})`, live: false }
        : off('Gestoppt');
    case 'paused':
      return off('Pausiert');
    case 'created':
    case 'removing':
      return { status: 'busy', statusText: 'Startet', live: false };
    case 'running':
      break;
  }
  if (i.noQuery) return { status: 'ok', statusText: 'Läuft', live: false };
  const live = statusIsLive(i);
  if (live && i.status?.online) {
    const tps = i.status.tps;
    if (tps !== null && tps < TPS_WARN) {
      return { status: 'warn', statusText: `TPS niedrig (${tpsText(tps)})`, live: true };
    }
    return { status: 'ok', statusText: 'Läuft', live: true };
  }
  const started = c.startedAt;
  if (started === null || i.now - started < STARTING_GRACE_MS) {
    return { status: 'busy', statusText: 'Startet', live: false };
  }
  return { status: 'warn', statusText: 'Antwortet nicht', live: false };
}
