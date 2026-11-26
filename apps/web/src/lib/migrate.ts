import {
  MIGRATION_POLL_MS,
  gameMigrateResponseSchema,
  gameMigrationResponseSchema,
  migrationActivePhases,
  migrationSuggestResponseSchema,
  type GameMigrateRequest,
  type GameMigrateResponse,
  type GameSummary,
  type Migration,
  type MigrationPhase,
  type MigrationSuggestResponse,
  type ServerSummary,
} from '@hz/shared';
import type { Status } from '@hz/ui';
import { api, isApiError } from './api.js';
import { errorText } from './errors.js';
import { formatBytes, formatNumber } from './format.js';
import { portLabel, portRange } from './games.js';

export { MIGRATION_POLL_MS };

export const migrationKey = (gameId: string) => ['games', 'migration', gameId] as const;
export const migrationSuggestKey = (gameId: string, targetServerId: string) =>
  ['games', 'migration', gameId, 'suggest', targetServerId] as const;

const enc = encodeURIComponent;

export function fetchMigrationSuggest(
  gameId: string,
  targetServerId: string,
  signal?: AbortSignal,
): Promise<MigrationSuggestResponse> {
  const q = new URLSearchParams({ targetServerId });
  return api(`/api/games/${enc(gameId)}/migration/suggest?${q.toString()}`, {
    schema: migrationSuggestResponseSchema,
    signal,
  });
}

/** 202 { migrationId }. Step-up comes from api(). */
export function startMigration(
  gameId: string,
  body: GameMigrateRequest,
): Promise<GameMigrateResponse> {
  return api(`/api/games/${enc(gameId)}/migrate`, {
    method: 'POST',
    body,
    schema: gameMigrateResponseSchema,
  });
}

export async function fetchMigration(
  gameId: string,
  signal?: AbortSignal,
): Promise<Migration | null> {
  const res = await api(`/api/games/${enc(gameId)}/migration`, {
    schema: gameMigrationResponseSchema,
    signal,
  });
  return res.migration;
}

/** Only before phase `start`; afterwards 409 conflict. */
export async function cancelMigration(gameId: string): Promise<Migration | null> {
  const res = await api(`/api/games/${enc(gameId)}/migration/cancel`, {
    method: 'POST',
    body: {},
    schema: gameMigrationResponseSchema,
  });
  return res.migration;
}

// ---------------------------------------------------------------------------
// Presentation helpers (pure, unit tested)

/** Online servers except the one the game runs on, by name. */
export function migrationTargets(
  servers: readonly ServerSummary[],
  game: Pick<GameSummary, 'serverId'>,
): ServerSummary[] {
  return servers
    .filter((s) => s.connected && s.id !== game.serverId)
    .sort((a, b) => a.name.localeCompare(b.name, 'de-AT'));
}

export function isMigrationActive(m: Pick<Migration, 'phase'> | null | undefined): boolean {
  return !!m && migrationActivePhases.includes(m.phase);
}

/** Abbrechen geht nur, solange am Ziel noch nichts gestartet wurde. */
export function canCancelMigration(m: Pick<Migration, 'phase'> | null | undefined): boolean {
  return !!m && (m.phase === 'backup' || m.phase === 'transfer' || m.phase === 'restore');
}

/** The five working steps, in order. */
export const MIGRATION_STEPS = ['backup', 'transfer', 'restore', 'start', 'stop_old'] as const;
export type MigrationStep = (typeof MIGRATION_STEPS)[number];

export const PHASE_LABEL: Record<MigrationPhase, string> = {
  backup: 'Sichern',
  transfer: 'Übertragen',
  restore: 'Entpacken am Ziel',
  start: 'Starten am Ziel',
  stop_old: 'Alten stoppen',
  done: 'Fertig',
  failed: 'Fehlgeschlagen',
};

export type StepState = 'done' | 'active' | 'failed' | 'pending';

/** State of each step for the progress list. */
export function stepStates(
  m: Pick<Migration, 'phase' | 'failedPhase'>,
): { step: MigrationStep; state: StepState }[] {
  const at: MigrationPhase | null = m.phase === 'failed' ? m.failedPhase : m.phase;
  const idx =
    m.phase === 'done'
      ? MIGRATION_STEPS.length
      : at
        ? MIGRATION_STEPS.indexOf(at as MigrationStep)
        : -1;
  return MIGRATION_STEPS.map((step, i) => {
    if (i < idx) return { step, state: 'done' };
    if (i === idx) return { step, state: m.phase === 'failed' ? 'failed' : 'active' };
    return { step, state: 'pending' };
  });
}

export const STEP_STATUS: Record<Exclude<StepState, 'pending'>, Status> = {
  done: 'ok',
  active: 'busy',
  failed: 'crit',
};

/** Status of the whole migration (tile dot). */
export function migrationStatus(m: Pick<Migration, 'phase'>): Status {
  if (m.phase === 'done') return 'ok';
  if (m.phase === 'failed') return 'crit';
  return 'busy';
}

/** "1,2 GB von 3,4 GB · 35 %", "1,2 GB" while the total is unknown. */
export function progressText(p: Migration['progress']): string {
  if (p.bytesTotal == null || p.bytesTotal === 0) return formatBytes(p.bytesDone);
  return `${formatBytes(p.bytesDone)} von ${formatBytes(p.bytesTotal)} · ${formatNumber(
    progressPercent(p),
    0,
  )} %`;
}

export function progressPercent(p: Migration['progress']): number {
  if (!p.bytesTotal) return 0;
  return Math.max(0, Math.min(100, (p.bytesDone / p.bytesTotal) * 100));
}

/** Statussatz of the progress tile. */
export function migrationSentence(m: Migration, gameName: string): string {
  if (m.phase === 'done') return `${gameName} läuft jetzt auf ${m.targetServerName}.`;
  if (m.phase === 'failed') {
    return `Umzug nach ${m.targetServerName} fehlgeschlagen${
      m.failedPhase ? ` beim Schritt „${PHASE_LABEL[m.failedPhase]}“` : ''
    }.`;
  }
  return `${gameName} zieht von ${m.sourceServerName} nach ${m.targetServerName} um: ${PHASE_LABEL[m.phase]} …`;
}

/** "game 25565 → 25570/TCP" per changed port. */
export function changedPortLines(changed: MigrationSuggestResponse['changed']): string[] {
  return changed.map(
    (c) =>
      `${c.name} ${portRange(c.from, c.count)} → ${portLabel(c.to, c.protocol, c.count)}${
        c.local ? ' · nur lokal' : ''
      }`,
  );
}

/** Errors of POST migrate (409 variants from the contract). */
export function migrateErrorText(err: unknown): string | null {
  if (!err || isApiError(err, 'step_up_required')) return null;
  if (isApiError(err, 'insufficient_ram')) return errorText(err);
  if (isApiError(err) && err.hint) return err.hint;
  if (isApiError(err, 'agent_offline')) {
    return 'Quell- oder Zielserver ist offline. Der Umzug geht, sobald beide verbunden sind.';
  }
  if (isApiError(err, 'busy')) {
    return 'Auf dem Gameserver läuft gerade etwas (Umzug, Setup oder Backup). Kurz warten.';
  }
  if (isApiError(err, 'conflict')) {
    return 'Am Ziel ist ein Port belegt oder der Spielordner gibt es dort schon.';
  }
  if (isApiError(err, 'invalid_input')) return 'Ziel ungültig. Einen anderen Server wählen.';
  return errorText(err);
}

/** How long a finished migration stays visible on the game page. */
export const MIGRATION_SHOW_FINISHED_MS = 60 * 60_000;

export function showMigration(m: Migration | null | undefined, now: Date): m is Migration {
  if (!m) return false;
  if (isMigrationActive(m)) return true;
  const end = m.finishedAt ?? m.updatedAt;
  return now.getTime() - new Date(end).getTime() < MIGRATION_SHOW_FINISHED_MS;
}
