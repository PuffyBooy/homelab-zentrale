import type { NavItem } from '@hz/ui';

/** Order from design/reference/components/NavRail.md. */
export const navItems: NavItem[] = [
  { id: 'overview', label: 'Übersicht', icon: 'cpu', href: '/' },
  { id: 'servers', label: 'Server', icon: 'server', href: '/servers' },
  { id: 'containers', label: 'Container', icon: 'container', href: '/containers' },
  { id: 'games', label: 'Gameserver', icon: 'gamepad', href: '/games' },
  { id: 'github', label: 'GitHub', icon: 'git', href: '/github' },
  { id: 'websites', label: 'Websites', icon: 'globe', href: '/websites' },
  { id: 'home', label: 'Wohnung', icon: 'home', href: '/home' },
  { id: 'alerts', label: 'Meldungen', icon: 'bell', href: '/alerts' },
  { id: 'console', label: 'Konsole', icon: 'terminal', href: '/console', key: '`' },
];

export function activeNavId(pathname: string): string {
  if (pathname === '/') return 'overview';
  const match = navItems.find((it) => it.href && it.href !== '/' && pathname.startsWith(it.href));
  return match?.id ?? 'overview';
}
