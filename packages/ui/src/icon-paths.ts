import type { IconName } from './types.js';

/**
 * SVG path data of the 25 icons (24er grid, 1.75 stroke), from design/reference/bundle.js.
 * No React here, so the share mini UI (apps/share/ui) can draw the same icons.
 */
export const ICON_PATHS: Record<IconName, string> = {
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  container: 'M3 8l9-5 9 5v8l-9 5-9-5zM3 8l9 5 9-5M12 13v8',
  git: 'M6 3v12M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  home: 'M3 11l9-7 9 7M5 10v10h14V10M10 20v-6h4v6',
  globe:
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 21h4',
  power: 'M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0',
  terminal: 'M4 5h16v14H4zM8 10l3 2-3 2M13 15h3',
  refresh: 'M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4',
  cpu: 'M7 7h10v10H7zM10 10h4v4h-4zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
  thermo: 'M14 14V5a2 2 0 1 0-4 0v9a4 4 0 1 0 4 0z',
  plug: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4',
  lock: 'M6 11h12v10H6zM8 11V8a4 4 0 1 1 8 0v3',
  wifi: 'M2 9a15 15 0 0 1 20 0M5 13a10 10 0 0 1 14 0M8.5 16.5a5 5 0 0 1 7 0M12 20h.01',
  play: 'M7 4l13 8-13 8z',
  stop: 'M6 6h12v12H6z',
  check: 'M4 12l5 5L20 6',
  alert: 'M12 3l10 18H2zM12 10v5M12 18h.01',
  door: 'M6 3h12v18H6zM14 12h.01',
  cloud: 'M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19.5 10 4 4 0 0 1 18 18z',
  gamepad:
    'M6 9h12a4 4 0 0 1 4 4v1a3 3 0 0 1-5.4 1.8L15 14H9l-1.6 1.8A3 3 0 0 1 2 14v-1a4 4 0 0 1 4-4zM7 11v3M5.5 12.5h3M16 12h.01M18 13h.01',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  users:
    'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 12 0v1M16 3.5a4 4 0 0 1 0 7.5M22 21v-1a6 6 0 0 0-4-5.6',
  plus: 'M12 5v14M5 12h14',
};
