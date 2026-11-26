import { useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';

export const THEME_KEY = 'hz-theme';

export function parseStoredTheme(value: string | null | undefined): Theme | null {
  return value === 'dark' || value === 'light' ? value : null;
}

/** An explicit choice wins, otherwise the system preference. Dark is the default. */
export function resolveTheme(stored: Theme | null, prefersLight: boolean): Theme {
  return stored ?? (prefersLight ? 'light' : 'dark');
}

export function otherTheme(theme: Theme): Theme {
  return theme === 'dark' ? 'light' : 'dark';
}

const LIGHT_QUERY = '(prefers-color-scheme: light)';
const listeners = new Set<() => void>();

function readStored(): Theme | null {
  try {
    return parseStoredTheme(window.localStorage.getItem(THEME_KEY));
  } catch {
    return null;
  }
}

function currentTheme(): Theme {
  return resolveTheme(readStored(), window.matchMedia(LIGHT_QUERY).matches);
}

function apply(): void {
  document.documentElement.dataset.theme = currentTheme();
  for (const l of listeners) l();
}

/** Call once before the first render, so the page does not flash. */
export function initTheme(): void {
  apply();
  window.matchMedia(LIGHT_QUERY).addEventListener('change', apply);
  window.addEventListener('storage', (e) => {
    if (e.key === THEME_KEY) apply();
  });
}

export function setTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Private mode: the choice lasts for this page only.
  }
  apply();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => 'dark' as const);
  return [theme, setTheme];
}
