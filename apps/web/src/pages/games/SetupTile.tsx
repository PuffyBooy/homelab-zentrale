import type { GameSummary } from '@hz/shared';
import { useMemo, type ReactElement } from 'react';
import { Alert, Button, StatusDot, Terminal, Tile } from '@hz/ui';
import { lastError, progressLines, setupState, type GameEvent } from '../../lib/games.js';
import { useTerminalFollow } from './useTerminalFollow.js';

/**
 * Setup progress (SPEC 6.2 step 3) from topic `game:<id>`: pull image, create world,
 * "bereit". Also shows backup progress, which uses the same events.
 */
export function SetupTile({
  game,
  events,
  onClose,
}: {
  game: GameSummary;
  events: readonly GameEvent[];
  onClose: () => void;
}): ReactElement {
  const lines = useMemo(() => progressLines(events), [events]);
  const state = setupState(events);
  const wrap = useTerminalFollow(lines, 'Fortschritt beim Aufsetzen');
  const running = state === 'running' || (state === 'none' && game.status === 'busy');
  const err = lastError(events);

  return (
    <Tile
      title={`${game.name} aufsetzen`}
      icon="terminal"
      span={4}
      actions={
        <>
          <StatusDot
            status={state === 'ready' ? 'ok' : state === 'error' ? 'crit' : 'busy'}
            label={state === 'ready' ? 'bereit' : state === 'error' ? 'Fehler' : game.statusText}
          />
          <Button size="sm" variant="ghost" onClick={onClose}>
            Schließen
          </Button>
        </>
      }
    >
      {state === 'ready' ? (
        <Alert tone="ok" title={`${game.name} ist bereit.`}>
          Adresse {game.address}. Für Freunde ohne Tailscale die Ports unten freigeben.
        </Alert>
      ) : null}
      {state === 'error' ? (
        <Alert tone="crit" title={`Aufsetzen von ${game.name} fehlgeschlagen.`}>
          {err ?? 'Grund im Log oben.'} Einstellungen prüfen und neu starten oder löschen.
        </Alert>
      ) : null}
      <div className="app-term" ref={wrap}>
        <div className="app-term-scope" data-theme="dark">
          <Terminal
            title={`setup ${game.name}`}
            host={game.serverName}
            lines={lines.length ? lines : [{ text: 'Warte auf den Agent …', kind: 'dim' }]}
            height="min(32vh, 280px)"
            cursor={running}
          />
        </div>
      </div>
    </Tile>
  );
}
