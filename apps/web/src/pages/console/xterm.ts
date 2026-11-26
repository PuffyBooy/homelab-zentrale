import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { terminalTheme } from '../../lib/console.js';

/**
 * xterm.js behind a small handle. Loaded with a dynamic import from the console page, so
 * neither the library nor its CSS ends up in the main bundle. Colours and font come from
 * the design tokens of the current theme (read from the computed style, never hard-coded).
 */
export interface TermHandle {
  readonly cols: number;
  readonly rows: number;
  write(data: string): void;
  writeNote(text: string): void;
  focus(): void;
  fit(): void;
  reset(): void;
  dispose(): void;
}

export interface TermOptions {
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  /** Keyboard way out of the terminal (xterm keeps Tab for the shell). */
  onLeave: () => void;
}

/**
 * xterm writes its theme, font and cell sizes into <style> elements inside the terminal.
 * The CSP (style-src 'self', no 'unsafe-inline') blocks those, so the same rules are
 * mirrored into constructable stylesheets (CSSOM, allowed by CSP) and kept in sync.
 */
function mirrorStyles(root: HTMLElement): () => void {
  const sheets = new Map<HTMLStyleElement, CSSStyleSheet>();
  const sync = (): void => {
    const live = new Set(root.querySelectorAll('style'));
    for (const [el, sheet] of sheets) {
      if (!live.has(el)) sheets.delete(el);
      else sheet.replaceSync(el.textContent ?? '');
    }
    for (const el of live) {
      if (sheets.has(el)) continue;
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(el.textContent ?? '');
      sheets.set(el, sheet);
    }
    const ours = new Set(sheets.values());
    document.adoptedStyleSheets = [
      ...document.adoptedStyleSheets.filter((s) => !ours.has(s) && !mirrored.has(s)),
      ...ours,
    ];
    mirrored.clear();
    for (const s of ours) mirrored.add(s);
  };
  const mirrored = new Set<CSSStyleSheet>();
  const observer = new MutationObserver(sync);
  observer.observe(root, { subtree: true, childList: true, characterData: true });
  sync();
  return () => {
    observer.disconnect();
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => !mirrored.has(s));
  };
}

function readToken(el: Element): (token: string) => string {
  const style = getComputedStyle(el);
  return (token) => style.getPropertyValue(token);
}

export function createTerm(el: HTMLElement, o: TermOptions): TermHandle {
  const read = readToken(el);
  const term = new Terminal({
    fontFamily: read('--font-mono').trim() || 'monospace',
    fontSize: 13,
    lineHeight: 1.35,
    cursorBlink: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    cursorStyle: 'block',
    scrollback: 5000,
    allowProposedApi: false,
    screenReaderMode: false,
    theme: terminalTheme(read),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.key === 'F6') {
      e.preventDefault();
      o.onLeave();
      return false;
    }
    return true;
  });
  const unmirror = mirrorStyles(el);
  term.open(el);
  term.textarea?.setAttribute('aria-label', 'Konsole: Eingabe an den Server');
  safeFit(fit);

  const data = term.onData(o.onData);
  const size = term.onResize(({ cols, rows }) => o.onResize(cols, rows));

  // Theme switch (dark/light/wall) changes the tokens on <html>.
  const themeObserver = new MutationObserver(() => {
    term.options.theme = terminalTheme(readToken(el));
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    subtree: true,
    attributeFilter: ['data-theme'],
  });
  const resizeObserver = new ResizeObserver(() => safeFit(fit));
  resizeObserver.observe(el);

  return {
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    write: (d) => term.write(d),
    writeNote: (text) => term.write(`\r\n\x1b[2m${text}\x1b[0m\r\n`),
    focus: () => term.focus(),
    fit: () => safeFit(fit),
    reset: () => term.reset(),
    dispose: () => {
      themeObserver.disconnect();
      unmirror();
      resizeObserver.disconnect();
      data.dispose();
      size.dispose();
      term.dispose();
    },
  };
}

/** fit() throws while the element is hidden (0×0). */
function safeFit(fit: FitAddon): void {
  try {
    fit.fit();
  } catch {
    // Not visible yet; the ResizeObserver fits again later.
  }
}
