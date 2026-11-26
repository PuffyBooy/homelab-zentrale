import type { GameSummary } from '@hz/shared';
import type { ReactElement } from 'react';
import { Link, useNavigate } from 'react-router';
import { Tile } from '@hz/ui';
import { sortGames } from '../../lib/games.js';
import { stoppedText } from '../../lib/gameFeatures.js';
import { GameTile } from './GameTile.js';

const MAX_TILES = 2;

/**
 * Overview pair "Gameserver / Websites" (SPEC 4, Dashboard.html): the running game
 * servers (problems and setups count as running) as GameServer tiles, at most two.
 * Without any running game, a small tile says how many are stopped.
 */
export function GamesTile({
  games,
  serverId,
}: {
  games: GameSummary[];
  serverId?: string | undefined;
}): ReactElement {
  const navigate = useNavigate();
  const active = sortGames(games.filter((g) => g.status !== 'off'));
  const shown = active.slice(0, MAX_TILES);
  const more = games.length - shown.length;
  const href = serverId ? `/games?server=${encodeURIComponent(serverId)}` : '/games';

  if (shown.length === 0) {
    return (
      <Tile
        title="Gameserver"
        icon="gamepad"
        count={String(games.length)}
        span={2}
        footer={
          <Link className="app-more" to={games.length ? href : '/games/new'}>
            {games.length ? 'Alle Gameserver' : 'Neuer Gameserver'}
          </Link>
        }
      >
        <p className="app-empty">{stoppedText(games)}</p>
      </Tile>
    );
  }

  return (
    <div className="hz-span-2 app-game-stack">
      {shown.map((g) => (
        <div key={g.id} className="app-game">
          <GameTile game={g} onConsole={() => void navigate(`/games/${g.id}#konsole`)} />
        </div>
      ))}
      <Link className="app-more" to={href}>
        {more > 0 ? `+${more} weitere · alle Gameserver` : 'Alle Gameserver'}
      </Link>
    </div>
  );
}
