import { ICON_PATHS } from '../../../../packages/ui/src/icon-paths.js';
import type { IconName } from '../../../../packages/ui/src/types.js';
import { STATUS_TAG, type GameStatus } from './logic.js';

/**
 * Tiny DOM builders with the same markup and hz- classes as packages/ui (Icon, Button,
 * StatusDot, Tile, Alert, Terminal). Text is always set as text, never as HTML.
 */

type Attr = string | number | boolean | null | undefined;
export type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, Attr> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: readonly Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

const SVG = 'http://www.w3.org/2000/svg';

export function icon(name: IconName, size = 14): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  const set = (k: string, v: string): void => svg.setAttribute(k, v);
  set('class', 'hz-icon');
  set('width', String(size));
  set('height', String(size));
  set('viewBox', '0 0 24 24');
  set('fill', 'none');
  set('stroke', 'currentColor');
  set('stroke-width', '1.75');
  set('stroke-linecap', 'round');
  set('stroke-linejoin', 'round');
  set('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', ICON_PATHS[name]);
  svg.append(path);
  return svg;
}

export interface ButtonSpec {
  label: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  icon?: IconName;
  type?: 'button' | 'submit';
  disabled?: boolean;
  onClick?: () => void;
  attrs?: Record<string, Attr>;
}

export function button(b: ButtonSpec): HTMLButtonElement {
  const size = b.size ?? 'md';
  const el = h(
    'button',
    {
      class: `hz-btn hz-btn-${b.variant ?? 'secondary'} hz-btn-${size}`,
      type: b.type ?? 'button',
      disabled: b.disabled,
      ...b.attrs,
    },
    b.icon ? icon(b.icon, size === 'sm' ? 12 : 14) : null,
    h('span', {}, b.label),
  );
  if (b.onClick) el.addEventListener('click', b.onClick);
  return el;
}

const STATUS_LONG: Record<GameStatus, string> = {
  ok: 'Läuft',
  warn: 'Warnung',
  crit: 'Ausgefallen',
  off: 'Gestoppt',
  busy: 'Startet',
};

/** Shape + short tag; the German long form is the tooltip. */
export function statusDot(status: GameStatus, title?: string, label?: string): HTMLSpanElement {
  const pulse = status === 'crit' || status === 'busy';
  return h(
    'span',
    { class: `hz-status hz-status-${status}`, title: title ?? STATUS_LONG[status] },
    h('span', { class: pulse ? 'hz-dot hz-dot-pulse' : 'hz-dot', 'aria-hidden': 'true' }),
    h('span', { class: 'hz-status-label' }, label ?? STATUS_TAG[status]),
  );
}

export interface TileSpec {
  title: string;
  icon?: IconName;
  meta?: Child[];
  body: Child[];
  footer?: Child[];
  className?: string;
  labelledBy?: string;
}

export function tile(t: TileSpec): HTMLElement {
  return h(
    'section',
    { class: t.className ? `hz-tile ${t.className}` : 'hz-tile', 'aria-labelledby': t.labelledBy },
    h(
      'header',
      { class: 'hz-tile-head' },
      h(
        'div',
        { class: 'hz-tile-title' },
        t.icon ? icon(t.icon, 12) : null,
        h('span', t.labelledBy ? { id: t.labelledBy } : {}, t.title),
      ),
      h('div', { class: 'hz-tile-meta' }, ...(t.meta ?? [])),
    ),
    h('div', { class: 'hz-tile-body' }, ...t.body),
    t.footer ? h('footer', { class: 'hz-tile-foot' }, ...t.footer) : null,
  );
}

const LEVEL = { ok: 'OK', warn: 'WARN', crit: 'CRIT', info: 'INFO' } as const;

export function alertBox(tone: keyof typeof LEVEL, title: string, text?: string): HTMLDivElement {
  return h(
    'div',
    { class: `hz-alert hz-alert-${tone}`, role: tone === 'crit' ? 'alert' : 'status' },
    h('span', { class: 'hz-alert-lvl' }, LEVEL[tone]),
    h(
      'div',
      { class: 'hz-alert-main' },
      h('span', { class: 'hz-alert-title' }, title),
      text ? h('span', { class: 'hz-alert-body' }, text) : null,
    ),
  );
}

export interface FieldParts {
  root: HTMLDivElement;
  input: HTMLInputElement;
  setError: (text: string | null) => void;
}

let fieldN = 0;

/** Same markup as Field in apps/web (hz-field, hz-input). */
export function field(label: string, attrs: Record<string, Attr>, hint?: string): FieldParts {
  const id = `sh-f${++fieldN}`;
  const input = h('input', { ...attrs, id, class: 'hz-input hz-input-mono' });
  const err = h('span', { class: 'hz-field-error', id: `${id}-err`, hidden: true });
  const hintEl = hint ? h('span', { class: 'hz-field-hint', id: `${id}-hint` }, hint) : null;
  if (hintEl) input.setAttribute('aria-describedby', hintEl.id);
  const root = h(
    'div',
    { class: 'hz-field' },
    h('label', { class: 'hz-field-label', for: id }, label),
    input,
    hintEl,
    err,
  );
  return {
    root,
    input,
    setError(text) {
      err.textContent = text ?? '';
      err.hidden = !text;
      if (text) {
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', [hintEl?.id, err.id].filter(Boolean).join(' '));
      } else {
        input.removeAttribute('aria-invalid');
        if (hintEl) input.setAttribute('aria-describedby', hintEl.id);
        else input.removeAttribute('aria-describedby');
      }
    },
  };
}
