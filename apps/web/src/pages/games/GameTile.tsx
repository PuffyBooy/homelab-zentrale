import type { GameSummary } from '@hz/shared';
import { useEffect, useState, type ReactElement } from 'react';
import { GameServer } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { disabledTileActions, gameTileProps } from '../../lib/games.js';
import { gameErrorText, useGameAction } from './useGameAction.js';

export interface GameTileProps {
  game: GameSummary;
  /** "Konsole": usually the detail page, on the detail page the console line. */
  onConsole: () => void;
}

/**
 * GameServer tile with the real actions. A click on the address copies it; screen
 * readers hear "Adresse kopiert". "Teilen" stays disabled until the share links (M7).
 */
export function GameTile({ game, onConsole }: GameTileProps): ReactElement {
  const act = useGameAction();
  const [copied, setCopied] = useState(false);

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
        onCopy={() => setCopied(true)}
        disabledActions={disabled}
      />
      <span className="hz-sr" aria-live="polite">
        {copied ? `Adresse ${game.address} kopiert` : ''}
      </span>
      {act.error ? <FormError title={gameErrorText(act.error)} /> : null}
    </>
  );
}
