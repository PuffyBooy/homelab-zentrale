import { useMemo, type ReactElement } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button, Tile } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { useGames, useServerFilter } from '../../lib/data.js';
import { errorText } from '../../lib/errors.js';
import { sortGames } from '../../lib/games.js';
import { useLiveTopic } from '../../lib/live.js';
import { ALL_SERVERS } from '../../lib/servers.js';
import { GameTile } from './GameTile.js';

export const NEW_GAME_HREF = '/games/new';

/** /games (SPEC 6.3): one GameServer tile per game, problems first, live over `games`. */
export function GamesPage(): ReactElement | null {
  useLiveTopic('games');
  const games = useGames();
  const [filter] = useServerFilter();
  const navigate = useNavigate();
  const one = filter !== ALL_SERVERS ? filter : undefined;

  const list = useMemo(() => {
    const all = games.data ?? [];
    return sortGames(one ? all.filter((g) => g.serverId === one) : all);
  }, [games.data, one]);

  if (games.isError && !games.data) return <FormError title={errorText(games.error)} />;
  if (!games.data) return null;

  const create = (
    <Button
      variant="primary"
      icon="plus"
      onClick={() =>
        void navigate(one ? `${NEW_GAME_HREF}?server=${encodeURIComponent(one)}` : NEW_GAME_HREF)
      }
    >
      Neuer Gameserver
    </Button>
  );

  if (list.length === 0) {
    return (
      <Tile title="Gameserver" icon="gamepad" span={4}>
        <p className="app-text">
          {one
            ? 'Auf diesem Server läuft noch kein Gameserver.'
            : 'Noch keine Gameserver. Aus einer Vorlage (Minecraft, Valheim, Terraria, CS2 …) steht einer in wenigen Minuten.'}
        </p>
        <div className="hz-form-actions">{create}</div>
      </Tile>
    );
  }

  return (
    <>
      <div className="app-toolbar">{create}</div>
      <div className="hz-grid app-grid">
        {list.map((g) => (
          <div key={g.id} className="hz-span-2 app-game">
            <GameTile game={g} onConsole={() => void navigate(`/games/${g.id}#konsole`)} />
            <Link className="app-more" to={`/games/${g.id}`}>
              {g.name}: Konsole, Backups, Einstellungen
            </Link>
          </div>
        ))}
      </div>
    </>
  );
}
