import type { GameSummary } from '@hz/shared';
import { useEffect, useState, type ReactElement } from 'react';
import { Link } from 'react-router';
import { Alert, GameServer } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { isApiError } from '../../lib/api.js';
import { OVER_BUDGET_GAME_TEXT, OVER_BUDGET_START_HINT } from '../../lib/cloud.js';
import { disabledTileActions, gameTileProps } from '../../lib/games.js';
import { ThrottleBadge } from '../throttle/ThrottleBadge.js';
import { ShareCreateDialog } from './ShareCreateDialog.js';
import { gameErrorText, useGameAction } from './useGameAction.js';

export interface GameTileProps {
  game: GameSummary;
  /** "Konsole": usually the detail page, on the detail page the console line. */
  onConsole: () => void;
}

/**
 * GameServer tile with the real actions. A click on the address copies it; screen
 * readers hear "Adresse kopiert". "Teilen" opens "Link erstellen" (share links, M7).
 */
export function GameTile({ game, onConsole }: GameTileProps): ReactElement {
  const act = useGameAction();
  const [copied, setCopied] = useState(false);
  const [sharing, setSharing] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const pending = act.isPending;
  const disabled = disabledTileActions(game);
  if (pending) disabled.push('start', 'stop', 'restart');

  return (
    <>
      <GameServer
        {...gameTileProps(game)}
        onStart={() => act.mutate({ id: game.id, action: 'start' })}
        onStop={() => act.mutate({ id: game.id, action: 'stop' })}
        onRestart={() => act.mutate({ id: game.id, action: 'restart' })}
        onConsole={onConsole}
        onShare={() => setSharing(true)}
        onCopy={() => setCopied(true)}
        disabledActions={disabled}
      />
      {game.throttled || game.autoStopped ? (
        <div className="app-game-hint">
          <ThrottleBadge throttled={game.throttled} autoStopped={game.autoStopped} />
        </div>
      ) : null}
      <span className="hz-sr" aria-live="polite">
        {copied ? `Adresse ${game.address} kopiert` : ''}
      </span>
      {isApiError(act.error, 'over_budget') ? (
        <Alert
          tone="crit"
          title={OVER_BUDGET_GAME_TEXT}
          action={
            <Link className="hz-btn hz-btn-secondary hz-btn-sm" to="/cloud">
              <span>Seite Cloud</span>
            </Link>
          }
        >
          {OVER_BUDGET_START_HINT}
        </Alert>
      ) : act.error ? (
        <FormError title={gameErrorText(act.error)} />
      ) : null}
      {sharing ? <ShareCreateDialog game={game} onClose={() => setSharing(false)} /> : null}
    </>
  );
}
