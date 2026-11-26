import type { CheckSummary, ServerSummary } from '@hz/shared';
import type { ReactElement } from 'react';
import { Button, Sparkline, WebCheckRow } from '@hz/ui';
import { checkCode, checkSubline, checkTarget, daysUntil, rowSpark } from '../../lib/checks.js';

export interface CheckRowProps {
  check: CheckSummary;
  servers: ServerSummary[];
  now: Date;
  /** Overview tile as in Dashboard.html: no buttons, no sparkline, sub line only with a reason. */
  readOnly?: boolean;
  running?: boolean;
  onRun?: () => void;
  onOpen?: () => void;
}

/** WebCheckRow for one check, with the 24 h sparkline and the row buttons in `actions`. */
export function CheckRow({
  check: c,
  servers,
  now,
  readOnly,
  running,
  onRun,
  onOpen,
}: CheckRowProps): ReactElement {
  const target = checkTarget(c.def);
  const spark = rowSpark(c);
  const reason = c.def.enabled && c.status !== 'ok' ? (c.reason ?? undefined) : undefined;
  const status = !c.def.enabled ? 'off' : c.status;
  return (
    <WebCheckRow
      url={target}
      host={readOnly ? reason : checkSubline(c, servers, now)}
      status={status}
      code={checkCode(c)}
      ms={c.lastMs == null ? null : Math.round(c.lastMs)}
      sslDays={c.def.kind === 'http' ? daysUntil(c.sslExpiresAt, now) : undefined}
      actions={
        readOnly ? undefined : (
          <>
            {spark.length >= 2 ? (
              <span className="app-check-spark" title="Antwortzeit 24 h">
                <Sparkline data={spark} width={72} height={20} tone="muted" />
              </span>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              icon="refresh"
              aria-label={`${target} jetzt prüfen`}
              title="Jetzt prüfen"
              disabled={running}
              onClick={onRun}
            />
            <Button size="sm" variant="ghost" aria-label={`Details zu ${target}`} onClick={onOpen}>
              Details
            </Button>
          </>
        )
      }
    />
  );
}
