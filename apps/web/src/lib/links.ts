import type { MouseEvent } from 'react';

/**
 * Click handler for containers with plain <a href> links (NavRail from @hz/ui):
 * same-origin left clicks become client-side navigation, everything else stays native.
 */
export function interceptLinks(navigate: (to: string) => void) {
  return (e: MouseEvent<HTMLElement>): void => {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const target = e.target instanceof Element ? e.target.closest('a') : null;
    if (!target || target.target || target.hasAttribute('download')) return;
    const url = new URL(target.href, window.location.href);
    if (url.origin !== window.location.origin) return;
    e.preventDefault();
    navigate(url.pathname + url.search + url.hash);
  };
}
