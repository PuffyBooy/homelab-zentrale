import type { ContainerSummary, StackAction } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { Alert, Button, StatusDot } from '@hz/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { NameConfirmDialog } from '../../components/NameConfirmDialog.js';
import { containersKey } from '../../lib/containers.js';
import {
  STACK_DONE,
  STACK_LABEL,
  STACK_PENDING,
  dockerErrorText,
  mergeStack,
  runStackAction,
  stackBlocked,
} from '../../lib/docker.js';

export interface StackActionsProps {
  serverId: string;
  serverName: string;
  project: string;
  containers: readonly ContainerSummary[];
  offline: boolean;
}

const ORDER: readonly StackAction[] = ['start', 'stop', 'restart', 'update', 'down'];

/** What the confirm dialog says before an action; start runs right away. */
const CONFIRM: Partial<Record<StackAction, (p: string) => string>> = {
  stop: (p) =>
    `Stoppt alle Container des Projekts ${p}. Sie bleiben erhalten und lassen sich wieder starten.`,
  restart: (p) =>
    `Startet alle Container des Projekts ${p} neu. Sie sind dabei kurz nicht erreichbar.`,
  update: (p) =>
    `Zieht die neuen Images für ${p} und startet geänderte Container neu (docker compose pull && up -d).`,
};

/**
 * Stack actions of one compose project (SPEC 6.1b), also for projects the Zentrale
 * did not create. Hidden with a reason for game projects and projects with a
 * protected container; disabled while the agent is offline.
 */
export function StackActions({
  serverId,
  serverName,
  project,
  containers,
  offline,
}: StackActionsProps): ReactElement {
  const qc = useQueryClient();
  const [ask, setAsk] = useState<StackAction | null>(null);
  const run = useMutation({
    mutationFn: ({ op, confirmName }: { op: StackAction; confirmName?: string }) =>
      runStackAction(serverId, project, op, confirmName),
    onSuccess: (next, { op }) => {
      // After down the group disappears; that waits until the dialog is closed.
      if (op !== 'down') apply(next);
    },
  });

  function apply(next: readonly ContainerSummary[]): void {
    qc.setQueryData<ContainerSummary[]>(containersKey, (old) =>
      old ? mergeStack(old, serverId, project, next) : old,
    );
  }

  function closeDown(): void {
    setAsk(null);
    if (run.isSuccess && run.variables.op === 'down') {
      apply(run.data);
      void qc.invalidateQueries({ queryKey: containersKey });
    }
  }
  const blocked = stackBlocked(containers);
  if (blocked) {
    return (
      <span className="app-stack-note" data-testid="stack-blocked">
        {blocked}
      </span>
    );
  }
  const pending = run.isPending ? run.variables.op : null;
  const disabled = offline || run.isPending;

  function start(op: StackAction): void {
    run.reset();
    if (op === 'start') run.mutate({ op });
    else setAsk(op);
  }

  const confirm = ask && ask !== 'down' ? CONFIRM[ask] : undefined;
  return (
    <>
      <span className="app-stack-actions" role="toolbar" aria-label={`Stack ${project}`}>
        {pending ? (
          <span className="app-foot-text" aria-live="polite">
            <StatusDot status="busy" label={STACK_PENDING[pending]} />
          </span>
        ) : null}
        {ORDER.map((op) => (
          <Button
            key={op}
            size="sm"
            variant="ghost"
            disabled={disabled}
            aria-label={`${STACK_LABEL[op]}: Stack ${project}`}
            onClick={() => start(op)}
          >
            {STACK_LABEL[op]}
          </Button>
        ))}
      </span>
      {run.error && !ask ? (
        <div className="app-ctr-error app-stack-error">
          <Alert tone="crit" title={`${project}: ${dockerErrorText(run.error)}`} />
        </div>
      ) : null}
      {run.isSuccess && !ask && run.variables.op !== 'down' ? (
        <span className="hz-sr" role="status">
          {project} {STACK_DONE[run.variables.op]}
        </span>
      ) : null}
      {ask && confirm ? (
        <ConfirmDialog
          title={`Stack ${project}: ${STACK_LABEL[ask]}?`}
          action={STACK_LABEL[ask]}
          busy={run.isPending}
          error={run.error}
          errorTextOf={dockerErrorText}
          onClose={() => setAsk(null)}
          onConfirm={() => run.mutate({ op: ask }, { onSuccess: () => setAsk(null) })}
        >
          {confirm(project)} Server: {serverName}.
        </ConfirmDialog>
      ) : null}
      {ask === 'down' ? (
        <NameConfirmDialog
          title={`Stack ${project} entfernen`}
          name={project}
          label="Projektname"
          action="Entfernen"
          busy={run.isPending}
          error={run.error}
          errorTextOf={dockerErrorText}
          done={run.isSuccess ? `Stack ${project} ist entfernt. Volumes bleiben erhalten.` : null}
          onConfirm={() => run.mutate({ op: 'down', confirmName: project })}
          onClose={closeDown}
        >
          Stoppt und entfernt alle Container und Netzwerke des Projekts {project} auf {serverName}{' '}
          (docker compose down). Volumes bleiben erhalten. Zum Bestätigen den Projektnamen
          eintippen.
        </NameConfirmDialog>
      ) : null}
    </>
  );
}
