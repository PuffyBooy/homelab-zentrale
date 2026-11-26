import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

const BOTTOM_SLACK = 24;

/**
 * Keeps a Terminal scrolled to the end while the reader is at the end, and makes its
 * body reachable with the keyboard (region with a name), like the deploy log.
 */
export function useTerminalFollow(deps: unknown, label: string): RefObject<HTMLDivElement> {
  const wrap = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  useLayoutEffect(() => {
    const el = wrap.current?.querySelector<HTMLElement>('.hz-term-body');
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [deps]);

  useEffect(() => {
    const el = wrap.current?.querySelector<HTMLElement>('.hz-term-body');
    if (!el) return;
    el.tabIndex = 0;
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', label);
    const onScroll = (): void => {
      follow.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [label]);

  return wrap;
}
