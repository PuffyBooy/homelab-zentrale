import type { GameSummary } from '@hz/shared';
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  forwardRef,
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { Button, Terminal, Tile } from '@hz/ui';
import { isApiError } from '../../lib/api.js';
import { useContainers } from '../../lib/data.js';
import {
  consoleLines,
  dropEntry,
  findGameContainer,
  historyStep,
  pushHistory,
  sendRcon,
  settleEntry,
  stampedLogLines,
  type ConsoleEntry,
  type GameEvent,
} from '../../lib/games.js';
import { useLiveState, useLiveTopic } from '../../lib/live.js';
import { containerLogsKey, type LogBuffer } from '../../lib/logs.js';
import { gameErrorText } from './useGameAction.js';
import { useTerminalFollow } from './useTerminalFollow.js';

let seq = 0;

/**
 * Console (SPEC 6.3): the live log of the game container (topic
 * `container-logs:<containerId>`) merged with the console events of `game:<id>` and the
 * RCON commands typed here with their answers. One line, history with arrow up/down.
 * Without RCON the console only reads; there is no `docker attach` input.
 */
export const ConsoleTile = forwardRef<
  HTMLInputElement,
  { game: GameSummary; events: readonly GameEvent[] }
>(function ConsoleTile({ game, events }, inputRef) {
  const id = useId();
  const qc = useQueryClient();
  const live = useLiveState();
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const [line, setLine] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState('');

  useLiveTopic('containers');
  const containers = useContainers();
  const container = useMemo(
    () => findGameContainer(game, containers.data ?? []),
    [game, containers.data],
  );
  const containerId = container?.id ?? null;
  useLiveTopic(containerId ? `container-logs:${containerId}` : null);
  // Fed only by the live socket (lib/live.ts); dropped when the console closes.
  const logs = useQuery<LogBuffer>({
    queryKey: containerLogsKey(containerId ?? ''),
    queryFn: skipToken,
  });
  useEffect(() => {
    if (!containerId) return;
    return () => qc.removeQueries({ queryKey: containerLogsKey(containerId), exact: true });
  }, [qc, containerId]);

  const logLines = useMemo(() => stampedLogLines(logs.data), [logs.data]);
  const lines = useMemo(() => consoleLines(events, entries, logLines), [events, entries, logLines]);
  const wrap = useTerminalFollow(lines, `Konsole ${game.name}`);

  const send = useMutation({
    mutationFn: ({ command }: { entryId: string; command: string }) => sendRcon(game.id, command),
    onSuccess: (output, { entryId }) =>
      setEntries((list) => settleEntry(list, entryId, { output })),
    onError: (err, { entryId, command }) => {
      if (isApiError(err, 'step_up_required')) {
        // Step-up cancelled: nothing was sent. Drop the "…" line, give the command back.
        setEntries((list) => dropEntry(list, entryId));
        setLine((cur) => cur || command);
        return;
      }
      setEntries((list) => settleEntry(list, entryId, { error: gameErrorText(err) }));
    },
  });

  const containerName = container?.name ?? `game-${game.name}`;
  const logState = !containers.data
    ? null
    : !container
      ? `Container ${containerName} ist auf ${game.serverName} nicht zu sehen. Keine Log-Ausgabe.`
      : !logs.data
        ? live === 'open'
          ? 'Log verbindet …'
          : 'Live-Verbindung getrennt · neuer Versuch läuft'
        : logs.data.ended
          ? `Log von ${containerName} beendet (Container läuft nicht).`
          : null;

  const blocked = !game.rcon
    ? `Keine RCON-Konsole: Oben steht das Log von ${containerName}, nur zum Lesen.`
    : game.status === 'off'
      ? 'Server ist gestoppt. Befehle gehen nach dem Start.'
      : game.status === 'busy'
        ? `${game.statusText}. Befehle gehen, sobald der Server läuft.`
        : null;

  function submit(e: FormEvent): void {
    e.preventDefault();
    const command = line.trim();
    if (!command || blocked) return;
    const entry: ConsoleEntry = {
      id: `cmd-${++seq}`,
      ts: new Date().toISOString(),
      command,
      output: null,
      error: null,
    };
    setEntries((list) => [...list.slice(-199), entry]);
    const next = pushHistory(history, command);
    setHistory(next);
    setIndex(next.length);
    setDraft('');
    setLine('');
    send.mutate({ entryId: entry.id, command });
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const typing = index >= history.length ? line : draft;
    const step = historyStep(history, index, e.key === 'ArrowUp' ? 'up' : 'down', typing);
    if (index >= history.length) setDraft(line);
    setIndex(step.index);
    setLine(step.value);
  }

  return (
    <Tile title="Konsole" icon="terminal" span={4} count={game.rcon ? 'RCON + Log' : 'nur Log'}>
      <div className="app-term" ref={wrap}>
        <div className="app-term-scope" data-theme="dark">
          <Terminal
            title={game.rcon ? `rcon ${containerName}` : `docker logs ${containerName}`}
            host={game.serverName}
            prompt=">"
            lines={
              lines.length
                ? lines
                : [
                    {
                      text: game.rcon
                        ? 'Noch keine Ausgabe. Befehl eingeben, z. B. list oder say Hallo.'
                        : 'Noch keine Ausgabe.',
                      kind: 'dim',
                    },
                  ]
            }
            height="min(36vh, 320px)"
            cursor={false}
          />
        </div>
      </div>
      {logState ? (
        <p className="hz-field-hint" aria-live="polite">
          {logState}
        </p>
      ) : null}
      {game.rcon ? (
        <form className="app-console-line" onSubmit={submit}>
          <label className="hz-sr" htmlFor={id}>
            Befehl an {game.name}
          </label>
          <span className="app-console-prompt" aria-hidden={true}>
            &gt;
          </span>
          <input
            ref={inputRef}
            id={id}
            className="hz-input hz-input-mono"
            value={line}
            onChange={(e) => {
              setLine(e.target.value.replace(/[\r\n]/g, ''));
              setIndex(history.length);
            }}
            onKeyDown={onKey}
            placeholder={blocked ? '' : 'Befehl, Pfeil hoch für den letzten'}
            maxLength={1000}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={!!blocked}
            aria-describedby={blocked ? `${id}-hint` : undefined}
          />
          <Button type="submit" size="sm" disabled={!!blocked || !line.trim()}>
            Senden
          </Button>
        </form>
      ) : null}
      {blocked ? (
        <p className="hz-field-hint" id={`${id}-hint`}>
          {blocked}
        </p>
      ) : null}
    </Tile>
  );
});
