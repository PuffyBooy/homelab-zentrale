import type { GameSummary } from '@hz/shared';
import { useMutation } from '@tanstack/react-query';
import { forwardRef, useId, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Button, Terminal, Tile } from '@hz/ui';
import {
  consoleLines,
  historyStep,
  pushHistory,
  sendRcon,
  type ConsoleEntry,
  type GameEvent,
} from '../../lib/games.js';
import { gameErrorText } from './useGameAction.js';
import { useTerminalFollow } from './useTerminalFollow.js';

let seq = 0;

/**
 * RCON console (SPEC 6.3): Terminal with the console lines of topic `game:<id>` and the
 * commands typed here with their answers. One line, history with arrow up/down.
 */
export const ConsoleTile = forwardRef<
  HTMLInputElement,
  { game: GameSummary; events: readonly GameEvent[] }
>(function ConsoleTile({ game, events }, inputRef) {
  const id = useId();
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const [line, setLine] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState('');

  const lines = useMemo(() => consoleLines(events, entries), [events, entries]);
  const wrap = useTerminalFollow(lines, `Konsole ${game.name}`);

  const send = useMutation({
    mutationFn: ({ command }: { entryId: string; command: string }) => sendRcon(game.id, command),
    onSuccess: (output, { entryId }) =>
      setEntries((list) => list.map((e) => (e.id === entryId ? { ...e, output } : e))),
    onError: (err, { entryId }) =>
      setEntries((list) =>
        list.map((e) => (e.id === entryId ? { ...e, error: gameErrorText(err) } : e)),
      ),
  });

  const blocked = !game.rcon
    ? 'Dieses Spiel hat keine RCON-Konsole. Oben stehen nur die Ausgaben des Servers.'
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
    <Tile title="Konsole" icon="terminal" span={4} count={game.rcon ? 'RCON' : 'nur Ausgabe'}>
      <div className="app-term" ref={wrap}>
        <div className="app-term-scope" data-theme="dark">
          <Terminal
            title={game.rcon ? `rcon ${game.name}` : `log ${game.name}`}
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
      {blocked ? (
        <p className="hz-field-hint" id={`${id}-hint`}>
          {blocked}
        </p>
      ) : null}
    </Tile>
  );
});
