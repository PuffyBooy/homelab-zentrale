import type { GameSummary } from '@hz/shared';
import { skipToken, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router';
import { Button, StatusDot, Tile } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { useGames, useServers, useTemplates } from '../../lib/data.js';
import { errorText } from '../../lib/errors.js';
import { formatAgo, formatWhen } from '../../lib/format.js';
import {
  autoStopText,
  gameEventsKey,
  gamePorts,
  portLabel,
  setupState,
  type GameEventBuffer,
} from '../../lib/games.js';
import { useLiveTopic } from '../../lib/live.js';
import { useNow } from '../../lib/useNow.js';
import { BackupsTile } from './BackupsTile.js';
import { ConsoleTile } from './ConsoleTile.js';
import { DeleteGameDialog } from './DeleteGameDialog.js';
import { ForwardHint } from './ForwardHint.js';
import { GameTile } from './GameTile.js';
import { SettingsTile } from './SettingsTile.js';
import { SetupTile } from './SetupTile.js';

const SETUP_PARAM = 'setup';

/** The command line, or the log box when the game has no RCON (read only). */
function focusConsole(input: HTMLInputElement | null, anchor: HTMLElement | null): void {
  const target = input ?? anchor?.querySelector<HTMLElement>('.hz-term-body') ?? null;
  target?.focus({ preventScroll: true });
}

/** /games/:id (SPEC 6.3): status, actions, setup progress, console (RCON + log), backups, settings. */
export function GameDetailPage(): ReactElement | null {
  useLiveTopic('games');
  const { id = '' } = useParams();
  const games = useGames();
  const game = games.data?.find((g) => g.id === id);

  if (games.isError && !games.data) return <FormError title={errorText(games.error)} />;
  if (!games.data) return null;
  if (!game) {
    return (
      <Tile title="Gameserver" icon="gamepad">
        <p className="app-empty">
          Diesen Gameserver gibt es nicht mehr. <Link to="/games">Zu allen Gameservern</Link>
        </p>
      </Tile>
    );
  }
  return <Detail game={game} />;
}

function Detail({ game }: { game: GameSummary }): ReactElement {
  useLiveTopic(`game:${game.id}`);
  const events = useQuery<GameEventBuffer>({
    queryKey: gameEventsKey(game.id),
    queryFn: skipToken,
  });
  const servers = useServers();
  const templates = useTemplates();
  const now = useNow(30_000);
  const [params, setParams] = useSearchParams();
  const { hash } = useLocation();
  const [deleting, setDeleting] = useState(false);
  const consoleInput = useRef<HTMLInputElement>(null);
  const consoleAnchor = useRef<HTMLDivElement>(null);

  const list = events.data?.events ?? [];
  const state = setupState(list);
  const showSetup = params.get(SETUP_PARAM) === '1' || state === 'running' || state === 'error';
  const tpl = templates.data?.find((t) => t.id === game.templateId);
  const server = servers.data?.find((s) => s.id === game.serverId);
  const ports = gamePorts(game, tpl);

  useEffect(() => {
    if (hash !== '#konsole') return;
    consoleAnchor.current?.scrollIntoView({ block: 'start' });
    focusConsole(consoleInput.current, consoleAnchor.current);
  }, [hash]);

  const toConsole = (): void => {
    consoleAnchor.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    focusConsole(consoleInput.current, consoleAnchor.current);
  };

  const closeSetup = (): void =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(SETUP_PARAM);
        return next;
      },
      { replace: true },
    );

  return (
    <div className="hz-grid app-grid">
      {showSetup ? <SetupTile game={game} events={list} onClose={closeSetup} /> : null}
      <div className="hz-span-2 app-game">
        <GameTile game={game} onConsole={toConsole} />
      </div>
      <Tile title={game.name} icon="gamepad" span={2}>
        <dl className="app-kv">
          <dt>Status</dt>
          <dd>
            <StatusDot status={game.status} label={game.statusText} className="app-status-auto" />
          </dd>
          <dt>Spiel</dt>
          <dd>
            {game.game}
            {game.version ? ` · ${game.version}` : ''}
          </dd>
          <dt>Server</dt>
          <dd>
            <Link to={`/servers/${game.serverId}`}>{game.serverName}</Link>
          </dd>
          <dt>Adresse</dt>
          <dd className="app-break">{game.address}</dd>
          <dt>Ports</dt>
          <dd>{ports.map((p) => portLabel(p.port, p.protocol, p.count)).join(' · ')}</dd>
          <dt>Auto-Stopp</dt>
          <dd>{autoStopText(game.autoStopMinutes)}</dd>
          <dt>Konsole</dt>
          <dd>{game.rcon ? 'RCON und Log' : 'nur Log (kein RCON)'}</dd>
          <dt>Letztes Backup</dt>
          <dd>
            {game.lastBackupAt
              ? `${formatWhen(new Date(game.lastBackupAt), now)} · ${formatAgo(new Date(game.lastBackupAt), now)}`
              : 'noch keins'}
          </dd>
          <dt>Angelegt</dt>
          <dd>{formatWhen(new Date(game.createdAt), now)}</dd>
        </dl>
      </Tile>
      <div className="hz-span-4 app-anchor" id="konsole" ref={consoleAnchor}>
        <ConsoleTile ref={consoleInput} game={game} events={list} />
      </div>
      <BackupsTile game={game} now={now} />
      <SettingsTile game={game} tpl={tpl} />
      <Tile title="Von außen erreichbar" icon="globe" span={2}>
        <ForwardHint ports={ports} server={server} />
      </Tile>
      <Tile title="Löschen" icon="alert" span={2}>
        <p className="app-text">
          Entfernt Container und Ordner von {game.name} auf {game.serverName}. Die Welt wird vorher
          gesichert.
        </p>
        <div className="hz-form-actions">
          <Button variant="danger" onClick={() => setDeleting(true)}>
            {game.name} löschen
          </Button>
        </div>
      </Tile>
      {deleting ? <DeleteGameDialog game={game} onClose={() => setDeleting(false)} /> : null}
    </div>
  );
}
