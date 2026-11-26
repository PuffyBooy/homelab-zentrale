import type {
  ContainerSummary,
  GameSummary,
  HaState,
  Modules,
  RepoSummary,
  ServerSummary,
} from '@hz/shared';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState, type KeyboardEvent, type ReactElement } from 'react';
import { Button, Icon, type IconName } from '@hz/ui';
import { Dialog } from '../components/Dialog.js';
import { FormError } from '../components/FormError.js';
import { isApiError } from '../lib/api.js';
import { containersKey, runContainerAction } from '../lib/containers.js';
import { useContainers, useGames, useRepos, useServers } from '../lib/data.js';
import { errorText } from '../lib/errors.js';
import { findGameContainer, gameAction, gamesKey, isGameRunning } from '../lib/games.js';
import { reposKey, startDeploy } from '../lib/github.js';
import { haStateKey, isOn, itemUsable, withPending } from '../lib/ha.js';
import { pendingToggles, runToggle } from '../lib/haActions.js';
import { ALL_MODULES_ON, visibleNavItems } from '../lib/modules.js';
import { showErrorToast } from './AlertToasts.js';
import { navItems, settingsItem, shortcutLabel } from '../nav.js';

export interface PaletteConfirm {
  /** Question in the confirm view, status first: "minecraft neu starten?" */
  title: string;
  text: string;
  /** Button label (verb in the infinitive). */
  action: string;
}

export interface PaletteCommand {
  id: string;
  label: string;
  /** Navigation target; ignored when `run` is set. */
  to: string;
  /** Action instead of navigation. A rejected promise shows its error in the palette. */
  run?: (() => Promise<unknown>) | undefined;
  /** Destructive or disruptive actions ask first. */
  confirm?: PaletteConfirm | undefined;
  icon?: IconName | undefined;
  hint?: string | undefined;
}

/** Pages: always listed, also with an empty query. Switched-off modules are left out. */
export function pageCommands(modules: Modules = ALL_MODULES_ON): PaletteCommand[] {
  return [
    ...visibleNavItems(navItems, modules).map((it, i) => ({
      id: it.id,
      label: it.label,
      to: it.href ?? '/',
      icon: it.icon,
      hint: shortcutLabel(it, i),
    })),
    { id: settingsItem.id, label: settingsItem.label, to: settingsItem.href },
  ];
}

/** All pages with every module on. */
export const paletteCommands: PaletteCommand[] = pageCommands();

/** Fixed actions that only show up while searching. */
export const staticActions: PaletteCommand[] = [
  { id: 'wall', label: 'Wandmodus öffnen', to: '/wall', icon: 'wifi', hint: 'Seite' },
];

/**
 * "Licht Wohnzimmer ausschalten": one command per overview switch while HA is
 * connected. They only show up while searching, so the empty palette stays a page list.
 */
export function haCommands(qc: QueryClient, state: HaState | undefined): PaletteCommand[] {
  if (!state) return [];
  const view = withPending(state, pendingToggles.snapshot());
  return view.items
    .filter((i) => i.kind === 'toggle' && i.overview && itemUsable(view, i) && !i.pending)
    .map((i) => {
      const on = isOn(i);
      return {
        id: `ha:${i.entityId}`,
        label: `${i.label} ${on ? 'ausschalten' : 'einschalten'}`,
        to: '/home',
        icon: 'power' as const,
        hint: on ? 'AN' : 'AUS',
        // Errors revert the switch and show a short toast.
        run: () =>
          runToggle(qc, i.entityId, !on).catch((err: unknown) =>
            showErrorToast(`${i.label} nicht geschaltet`, errorText(err)),
          ),
      };
    });
}

/** Servers: detail page and "Konsole <server>" where the console is allowed. */
export function serverCommands(servers: readonly ServerSummary[]): PaletteCommand[] {
  return servers.flatMap((s) => {
    const out: PaletteCommand[] = [
      {
        id: `server:${s.id}`,
        label: s.name,
        to: `/servers/${encodeURIComponent(s.id)}`,
        icon: 'server',
        hint: 'Server',
      },
    ];
    if (s.allowTerminal && s.connected) {
      out.push({
        id: `console:${s.id}`,
        label: `Konsole ${s.name}`,
        to: `/console?server=${encodeURIComponent(s.id)}`,
        icon: 'terminal',
        hint: 'Konsole',
      });
    }
    return out;
  });
}

/** Containers: logs and restart (asks first). Game containers are handled as games. */
export function containerCommands(
  qc: QueryClient,
  containers: readonly ContainerSummary[],
): PaletteCommand[] {
  return containers.flatMap((c) => [
    {
      id: `container-logs:${c.id}`,
      label: `${c.name} Logs`,
      to: `/containers/${encodeURIComponent(c.id)}/logs`,
      icon: 'container' as const,
      hint: c.serverName,
    },
    {
      id: `container-restart:${c.id}`,
      label: `${c.name} neu starten`,
      to: '/containers',
      icon: 'refresh' as const,
      hint: c.serverName,
      confirm: {
        title: `${c.name} auf ${c.serverName} neu starten?`,
        text: 'Der Container ist für einige Sekunden weg.',
        action: 'Neu starten',
      },
      run: async () => {
        await runContainerAction(c.id, 'restart');
        await qc.invalidateQueries({ queryKey: containersKey });
      },
    },
  ]);
}

/** Games: start when stopped; stop and restart (ask first) when running. */
export function gameCommands(qc: QueryClient, games: readonly GameSummary[]): PaletteCommand[] {
  return games.flatMap((g) => {
    const act = (action: 'start' | 'stop' | 'restart') => async () => {
      await gameAction(g.id, action);
      await qc.invalidateQueries({ queryKey: gamesKey });
    };
    const page: PaletteCommand = {
      id: `game:${g.id}`,
      label: g.name,
      to: `/games/${encodeURIComponent(g.id)}`,
      icon: 'gamepad',
      hint: 'Gameserver',
    };
    if (!isGameRunning(g)) {
      return [
        page,
        {
          id: `game-start:${g.id}`,
          label: `${g.name} starten`,
          to: '/games',
          icon: 'play',
          hint: g.serverName,
          run: act('start'),
        },
      ];
    }
    return [
      page,
      {
        id: `game-restart:${g.id}`,
        label: `${g.name} neu starten`,
        to: '/games',
        icon: 'refresh',
        hint: g.serverName,
        confirm: {
          title: `${g.name} neu starten?`,
          text: 'Alle Spieler fliegen kurz raus.',
          action: 'Neu starten',
        },
        run: act('restart'),
      },
      {
        id: `game-stop:${g.id}`,
        label: `${g.name} stoppen`,
        to: '/games',
        icon: 'stop',
        hint: g.serverName,
        confirm: {
          title: `${g.name} stoppen?`,
          text: 'Alle Spieler werden getrennt.',
          action: 'Stoppen',
        },
        run: act('stop'),
      },
    ];
  });
}

function repoName(fullName: string): string {
  return fullName.split('/').pop() ?? fullName;
}

/** "my-app deployen" (one target) or "my-app auf heimserver deployen". */
export function repoCommands(qc: QueryClient, repos: readonly RepoSummary[]): PaletteCommand[] {
  return repos.flatMap((r) => {
    const name = repoName(r.fullName);
    const page: PaletteCommand = {
      id: `repo:${r.id}`,
      label: name,
      to: `/github/${encodeURIComponent(r.id)}`,
      icon: 'git',
      hint: 'Repo',
    };
    const deploys = r.targets
      .filter((t) => t.headSha && !t.deploying)
      .map((t): PaletteCommand => ({
        id: `deploy:${t.id}`,
        label: r.targets.length > 1 ? `${name} auf ${t.serverName} deployen` : `${name} deployen`,
        to: `/github/${encodeURIComponent(r.id)}`,
        icon: 'git',
        hint: t.serverName,
        confirm: {
          title: `${name} auf ${t.serverName} deployen?`,
          text: `Commit ${t.headSha?.slice(0, 7) ?? ''} von ${t.branch} nach ${t.path}.${
            t.behind ? ` ${t.behind} neue Commits.` : ''
          }`,
          action: 'Deployen',
        },
        run: async () => {
          await startDeploy(t.id, { sha: t.headSha ?? undefined });
          await qc.invalidateQueries({ queryKey: reposKey });
        },
      }));
    return [page, ...deploys];
  });
}

export function withoutGames(
  containers: readonly ContainerSummary[],
  games: readonly GameSummary[],
): ContainerSummary[] {
  const own = new Set(games.map((g) => findGameContainer(g, containers)?.id));
  // Containers with the label homelab.game belong to a game server, known or not.
  return containers.filter((c) => c.game == null && !own.has(c.id));
}

export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  const words = q.split(/\s+/);
  return commands.filter((c) => {
    const hay = `${c.label} ${c.hint ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w)) || (!c.run && c.to.toLowerCase().includes(q));
  });
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onRun: (to: string) => void;
  /** Optional modules; pages and actions of switched-off ones are left out. */
  modules?: Modules | undefined;
}

export function CommandPalette({
  open,
  onClose,
  onRun,
  modules = ALL_MODULES_ON,
}: CommandPaletteProps): ReactElement {
  return (
    <Dialog open={open} onClose={onClose} label="Befehlspalette" className="hz-palette">
      <PaletteBody onClose={onClose} onRun={onRun} modules={modules} />
    </Dialog>
  );
}

const MAX_RESULTS = 50;

function PaletteBody({
  onClose,
  onRun,
  modules,
}: Omit<CommandPaletteProps, 'open' | 'modules'> & { modules: Modules }): ReactElement {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [confirm, setConfirm] = useState<PaletteCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listId = useId();
  const qc = useQueryClient();
  const [ha] = useState(() =>
    modules.homeassistant ? haCommands(qc, qc.getQueryData<HaState>(haStateKey)) : [],
  );
  // Loaded while the palette is open, so "minecraft neu starten" works from any page.
  const servers = useServers();
  const containers = useContainers();
  const games = useGames(modules.games);
  const repos = useRepos(modules.github);
  const pages = useMemo(() => pageCommands(modules), [modules]);
  const gameList = modules.games ? games.data : undefined;
  const repoList = modules.github ? repos.data : undefined;

  const actions = useMemo(
    () => [
      ...staticActions,
      ...serverCommands(servers.data ?? []),
      ...gameCommands(qc, gameList ?? []),
      ...repoCommands(qc, repoList ?? []),
      // Game containers are listed as games.
      ...containerCommands(qc, withoutGames(containers.data ?? [], gameList ?? [])),
      ...ha,
    ],
    [qc, servers.data, containers.data, gameList, repoList, ha],
  );
  const results = useMemo(
    () =>
      filterCommands(query.trim() ? [...pages, ...actions] : pages, query).slice(0, MAX_RESULTS),
    [query, actions, pages],
  );
  const current = Math.min(index, Math.max(results.length - 1, 0));
  const active = results[current];

  async function execute(cmd: PaletteCommand): Promise<void> {
    if (!cmd.run) {
      onClose();
      onRun(cmd.to);
      return;
    }
    if (!cmd.confirm) {
      onClose();
      void cmd.run().catch(() => undefined);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await cmd.run();
      onClose();
      onRun(cmd.to);
    } catch (err) {
      setBusy(false);
      if (!isApiError(err, 'step_up_required')) setError(errorText(err));
    }
  }

  function pick(cmd: PaletteCommand | undefined): void {
    if (!cmd) return;
    if (cmd.run && cmd.confirm) {
      setConfirm(cmd);
      setError(null);
      return;
    }
    void execute(cmd);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setIndex((current + step + results.length) % results.length);
    } else if (e.key === 'Home' && results.length) {
      e.preventDefault();
      setIndex(0);
    } else if (e.key === 'End' && results.length) {
      e.preventDefault();
      setIndex(results.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(active);
    }
  }

  if (confirm?.confirm) {
    const c = confirm.confirm;
    return (
      <div className="hz-dialog-body app-palette-confirm" data-testid="palette-confirm">
        <h2 className="hz-dialog-head">{c.title}</h2>
        <p className="hz-dialog-text">{c.text}</p>
        {error ? <FormError title={error} /> : null}
        <div className="hz-dialog-foot">
          <Button onClick={() => setConfirm(null)} data-autofocus="">
            Abbrechen
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => void execute(confirm)}>
            {busy ? 'Läuft …' : c.action}
          </Button>
        </div>
      </div>
    );
  }

  const optionId = (c: PaletteCommand): string => `${listId}-${c.id}`;

  return (
    <>
      <input
        className="hz-palette-input"
        type="text"
        role="combobox"
        aria-label="Wohin?"
        aria-expanded={true}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active ? optionId(active) : undefined}
        placeholder="Wohin? Seite, Server oder Aktion suchen …"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={onKeyDown}
        data-autofocus=""
      />
      {results.length ? (
        <ul className="hz-palette-list" role="listbox" id={listId} aria-label="Ziele">
          {results.map((c, i) => (
            <li
              key={c.id}
              id={optionId(c)}
              role="option"
              aria-selected={i === current}
              className="hz-palette-opt"
              onMouseMove={() => setIndex(i)}
              onClick={() => pick(c)}
            >
              {c.icon ? (
                <Icon name={c.icon} size={14} />
              ) : (
                <span className="hz-icon app-icon-gap" aria-hidden={true} />
              )}
              <span>{c.label}</span>
              <span className="hz-palette-group">{c.hint ?? ''}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="hz-palette-empty" role="status" id={listId}>
          Kein Treffer für „{query.trim()}“.
        </div>
      )}
      <div className="hz-palette-foot" aria-hidden={true}>
        <span>↑↓ wählen</span>
        <span>Enter öffnen</span>
        <span>Esc schließen</span>
      </div>
    </>
  );
}
