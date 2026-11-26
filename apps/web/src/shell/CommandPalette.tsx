import type { HaState } from '@hz/shared';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState, type KeyboardEvent, type ReactElement } from 'react';
import { Icon, type IconName } from '@hz/ui';
import { Dialog } from '../components/Dialog.js';
import { haStateKey, isOn, itemUsable, withPending } from '../lib/ha.js';
import { pendingToggles, runToggle } from '../lib/haActions.js';
import { errorText } from '../lib/errors.js';
import { showErrorToast } from './AlertToasts.js';
import { navItems, settingsItem, shortcutLabel } from '../nav.js';

export interface PaletteCommand {
  id: string;
  label: string;
  /** Navigation target; ignored when `run` is set. */
  to: string;
  /** Action instead of navigation (Home Assistant switches). */
  run?: (() => void) | undefined;
  icon?: IconName | undefined;
  hint?: string | undefined;
}

/** For now the palette only navigates (docs/ROADMAP.md, M1). */
export const paletteCommands: PaletteCommand[] = [
  ...navItems.map((it, i) => ({
    id: it.id,
    label: it.label,
    to: it.href ?? '/',
    icon: it.icon,
    hint: shortcutLabel(it, i),
  })),
  { id: settingsItem.id, label: settingsItem.label, to: settingsItem.href },
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
          void runToggle(qc, i.entityId, !on).catch((err: unknown) =>
            showErrorToast(`${i.label} nicht geschaltet`, errorText(err)),
          ),
      };
    });
}

export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter(
    (c) => c.label.toLowerCase().includes(q) || (!c.run && c.to.toLowerCase().includes(q)),
  );
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onRun: (to: string) => void;
}

export function CommandPalette({ open, onClose, onRun }: CommandPaletteProps): ReactElement {
  return (
    <Dialog open={open} onClose={onClose} label="Befehlspalette" className="hz-palette">
      <PaletteBody onClose={onClose} onRun={onRun} />
    </Dialog>
  );
}

function PaletteBody({ onClose, onRun }: Omit<CommandPaletteProps, 'open'>): ReactElement {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const listId = useId();
  const qc = useQueryClient();
  const [ha] = useState(() => haCommands(qc, qc.getQueryData<HaState>(haStateKey)));
  const results = useMemo(
    () => filterCommands(query.trim() ? [...paletteCommands, ...ha] : paletteCommands, query),
    [query, ha],
  );
  const current = Math.min(index, Math.max(results.length - 1, 0));
  const active = results[current];

  function run(cmd: PaletteCommand | undefined): void {
    if (!cmd) return;
    onClose();
    if (cmd.run) cmd.run();
    else onRun(cmd.to);
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
      run(active);
    }
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
        placeholder="Wohin? Seite suchen …"
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
              onClick={() => run(c)}
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
