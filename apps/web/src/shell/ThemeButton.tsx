import type { ReactElement } from 'react';
import { otherTheme, useTheme } from '../lib/theme.js';

const NAME = { dark: 'dunkel', light: 'hell' } as const;

/** Switches between dark and light. Styled like a nav item. */
export function ThemeButton(): ReactElement {
  const [theme, setTheme] = useTheme();
  const next = otherTheme(theme);
  return (
    <button
      type="button"
      className="hz-nav-item"
      aria-label={`Theme: ${NAME[theme]}. Umschalten auf ${NAME[next]}`}
      onClick={() => setTheme(next)}
    >
      <span className="hz-nav-key" aria-hidden={true} />
      <span>Theme</span>
      <span className="app-rail-hint">{NAME[theme]}</span>
    </button>
  );
}
