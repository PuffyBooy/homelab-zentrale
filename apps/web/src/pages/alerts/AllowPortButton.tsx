import type { Alert as AlertData } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { Button } from '@hz/ui';
import { alertsKey } from '../../lib/alerts.js';
import { allowPort, portAlertTarget, portAuditKey, portText } from '../../lib/ports.js';

/**
 * "Erlauben" on a "Neuer offener Port" alert (ROADMAP M11): adds the port to the
 * allowed list of the server; the core resolves the alert at once.
 */
export function AllowPortButton({
  alert,
  onError,
}: {
  alert: Pick<AlertData, 'key' | 'state'>;
  /** Called with the error, or with null when a new attempt begins. */
  onError: (err: unknown) => void;
}): ReactElement | null {
  const qc = useQueryClient();
  const target = portAlertTarget(alert.key);
  const allow = useMutation({
    mutationFn: (t: NonNullable<typeof target>) =>
      allowPort(t.serverId, { port: t.port, proto: t.proto }),
    onSuccess: (res, t) => {
      qc.setQueryData(portAuditKey(t.serverId), res);
      void qc.invalidateQueries({ queryKey: alertsKey });
    },
    onError,
  });
  if (!target || alert.state === 'resolved') return null;
  return (
    <Button
      size="sm"
      icon="check"
      disabled={allow.isPending}
      aria-label={`Port ${portText(target)} erlauben`}
      onClick={() => {
        onError(null);
        allow.mutate(target);
      }}
    >
      {allow.isPending ? 'Erlaubt …' : 'Erlauben'}
    </Button>
  );
}
