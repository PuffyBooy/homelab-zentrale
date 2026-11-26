import type { NavItem } from '@hz/ui';

/** Order from design/reference/components/NavRail.md and docs/SPEC.md section 3. */
export const navItems: NavItem[] = [
  { id: 'overview', label: 'Übersicht', icon: 'cpu', href: '/' },
  { id: 'servers', label: 'Server', icon: 'server', href: '/servers' },
  { id: 'containers', label: 'Container', icon: 'container', href: '/containers' },
  { id: 'games', label: 'Gameserver', icon: 'gamepad', href: '/games' },
  { id: 'github', label: 'GitHub', icon: 'git', href: '/github' },
  { id: 'websites', label: 'Websites', icon: 'globe', href: '/websites' },
  { id: 'home', label: 'Wohnung', icon: 'home', href: '/home' },
  { id: 'alerts', label: 'Meldungen', icon: 'bell', href: '/alerts' },
  // Optional modules of M20/M21 (off by default). After Meldungen, so 1–8 keep their pages.
  { id: 'apps', label: 'Apps', icon: 'cloud', href: '/apps' },
  { id: 'internet', label: 'Internet', icon: 'wifi', href: '/internet' },
  { id: 'automation', label: 'Automatik', icon: 'refresh', href: '/automation' },
  { id: 'console', label: 'Konsole', icon: 'terminal', href: '/console', key: '`' },
];

/** No gear icon in the design set yet (docs/QUESTIONS.md), so settings is text only. */
export const settingsItem = {
  id: 'settings',
  label: 'Einstellungen',
  href: '/settings',
} as const;

/** Bottom bar on phones (< 700 px), the rest sits behind "Mehr". */
export const bottomBarIds = ['overview', 'servers', 'games', 'alerts'] as const;

function hrefOf(item: NavItem): string {
  return item.href ?? '/';
}

export function activeNavId(pathname: string): string {
  if (pathname === '/') return 'overview';
  if (pathname === settingsItem.href || pathname.startsWith(`${settingsItem.href}/`)) {
    return settingsItem.id;
  }
  const match = navItems.find((it) => {
    const href = hrefOf(it);
    return href !== '/' && (pathname === href || pathname.startsWith(`${href}/`));
  });
  return match?.id ?? 'overview';
}

/** Digits 1–9 address the first nine visible items. */
const MAX_DIGIT_SHORTCUTS = 9;

/** Label shown on the key cap, as NavRail renders it. Empty past the ninth item. */
export function shortcutLabel(item: NavItem, index: number): string {
  if (item.key) return item.key;
  return index < MAX_DIGIT_SHORTCUTS ? String(index + 1) : '';
}

/** Items with their key cap set, so NavRail shows no "10" that no key reaches. */
export function withShortcutKeys<T extends NavItem>(items: readonly T[]): T[] {
  return items.map((it, i) => ({ ...it, key: shortcutLabel(it, i) }));
}

/**
 * Target path for a global shortcut key: 1–9 by position, ` for the console.
 * `items` are the visible nav items (switched-off modules left out), so the digits
 * match the key caps in the NavRail. Returns undefined for any other key.
 */
export function shortcutTarget(
  key: string,
  items: readonly NavItem[] = navItems,
): string | undefined {
  const byLabel = key ? items.find((it, i) => shortcutLabel(it, i) === key) : undefined;
  if (byLabel) return hrefOf(byLabel);
  if (/^[1-9]$/.test(key)) {
    const item = items[Number(key) - 1];
    return item ? hrefOf(item) : undefined;
  }
  return undefined;
}

interface KeyTarget {
  tagName?: string;
  isContentEditable?: boolean;
}

/** True while the user types somewhere, so plain keys must not navigate. */
export function isTypingTarget(target: KeyTarget | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: KeyTarget | null;
}

export type ShortcutAction = { kind: 'palette' } | { kind: 'navigate'; to: string } | null;

/** Maps a keydown to a shell action. Ctrl/⌘+K works everywhere, digits only outside inputs. */
export function shortcutAction(e: KeyLike, items: readonly NavItem[] = navItems): ShortcutAction {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
    return { kind: 'palette' };
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (isTypingTarget(e.target)) return null;
  const to = shortcutTarget(e.key, items);
  return to ? { kind: 'navigate', to } : null;
}
