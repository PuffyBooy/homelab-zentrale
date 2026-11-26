import type { Alert as AlertData } from '@hz/shared';
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Alert, Button } from '@hz/ui';
import { formatTime } from '../lib/format.js';
import { useLiveAlerts } from '../lib/live.js';

const MAX = 3;
/** OK messages go away on their own, CRIT stays until it is looked at or closed. */
const OK_MS = 8_000;

function target(a: AlertData): string {
  if (a.source === 'check') return '/websites';
  return a.serverId ? `/servers/${a.serverId}` : '/alerts';
}

/** Floating alerts bottom right for new crit/ok messages from the live topic `alerts`. */
export function AlertToasts({ onOpen }: { onOpen: (to: string) => void }): ReactElement | null {
  const [list, setList] = useState<AlertData[]>([]);

  const dismiss = useCallback((id: string) => {
    setList((l) => l.filter((a) => a.id !== id));
  }, []);

  useLiveAlerts((a) => {
    if (a.level !== 'crit' && a.level !== 'ok') return;
    setList((l) => [a, ...l.filter((x) => x.id !== a.id)].slice(0, MAX));
  });

  useEffect(() => {
    const oks = list.filter((a) => a.level === 'ok');
    if (!oks.length) return;
    const timers = oks.map((a) => setTimeout(() => dismiss(a.id), OK_MS));
    return () => timers.forEach(clearTimeout);
  }, [list, dismiss]);

  if (!list.length) return null;
  return (
    <div className="app-toasts" aria-label="Neue Meldungen">
      {list.map((a) => (
        <Alert
          key={a.id}
          floating
          tone={a.level === 'crit' ? 'crit' : 'ok'}
          time={formatTime(new Date(a.openedAt))}
          title={a.title}
          action={
            <span className="app-toast-actions">
              <Button
                size="sm"
                onClick={() => {
                  dismiss(a.id);
                  onOpen(target(a));
                }}
              >
                Ansehen
              </Button>
              <Button size="sm" variant="ghost" onClick={() => dismiss(a.id)}>
                Schließen
              </Button>
            </span>
          }
        >
          {a.body}
        </Alert>
      ))}
    </div>
  );
}
