import type { ContainerSummary } from '@hz/shared';
import { useState, type ReactElement } from 'react';
import { Button, StatusDot, Tile } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { isRunning } from '../../lib/containers.js';
import { errorText } from '../../lib/errors.js';
import { formatWhen } from '../../lib/format.js';
import { AUTO_STOPPED_TEXT, BY_TEXT, formatCores } from '../../lib/throttle.js';
import { ThrottleDialog } from './ThrottleDialogs.js';
import { useThrottle } from './useThrottle.js';

/** Container detail (M10): current throttle, "Drosseln …" and "Drosselung aufheben". */
export function ContainerThrottleTile({ c }: { c: ContainerSummary }): ReactElement {
  const [open, setOpen] = useState(false);
  const act = useThrottle();
  const running = isRunning(c);
  const t = c.throttled;

  const label = c.protected
    ? 'nie gedrosselt'
    : t
      ? `gedrosselt auf ${formatCores(t.cpus)}`
      : c.autoStopped
        ? AUTO_STOPPED_TEXT
        : running
          ? 'nicht gedrosselt'
          : 'gestoppt';
  const note = c.protected
    ? 'Zentrale/Agent: wird nie gedrosselt oder gestoppt.'
    : c.autoStopped
      ? 'Die Automatik hat ihn gestoppt. Er startet nicht von selbst wieder.'
      : !running
        ? 'Drosseln geht nur, solange er läuft.'
        : t
          ? null
          : 'Begrenzt die CPU mit docker update --cpus. Das RAM-Limit bleibt gleich.';

  return (
    <Tile title="Drosselung" icon="cpu" span={2}>
      <dl className="app-kv">
        <dt>Zustand</dt>
        <dd>
          <StatusDot
            status={t || c.autoStopped ? 'warn' : running ? 'ok' : 'off'}
            label={label}
            className="app-status-auto"
          />
        </dd>
        {t ? (
          <>
            <dt>Seit</dt>
            <dd>
              {formatWhen(new Date(t.since))} · {BY_TEXT[t.by]}
            </dd>
            {t.reason ? (
              <>
                <dt>Grund</dt>
                <dd className="app-break">{t.reason}</dd>
              </>
            ) : null}
          </>
        ) : null}
      </dl>
      {note ? <p className="app-text">{note}</p> : null}
      {c.protected ? null : (
        <>
          {act.error ? <FormError title={errorText(act.error)} /> : null}
          <div className="hz-form-actions">
            {t ? (
              <Button
                icon="refresh"
                disabled={act.isPending}
                onClick={() => act.mutate({ kind: 'unthrottle', id: c.id })}
              >
                {act.isPending ? 'Hebt auf …' : 'Drosselung aufheben'}
              </Button>
            ) : null}
            <Button
              icon="cpu"
              aria-haspopup="dialog"
              disabled={!running || act.isPending}
              onClick={() => setOpen(true)}
            >
              {t ? 'Anders drosseln …' : 'Drosseln …'}
            </Button>
          </div>
        </>
      )}
      {open ? (
        <ThrottleDialog
          target={{ id: c.id, name: c.name, serverName: c.serverName, priority: c.priority }}
          initialCpus={t?.cpus ?? 1}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </Tile>
  );
}
