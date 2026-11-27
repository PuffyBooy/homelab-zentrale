import type { Task, TaskRun } from '@hz/shared';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { Button, StatusDot } from '@hz/ui';
import { CopyBlock } from '../../components/CopyBlock.js';
import { Dialog } from '../../components/Dialog.js';
import { FormError } from '../../components/FormError.js';
import { errorText } from '../../lib/errors.js';
import { formatDateTime, formatWhen } from '../../lib/format.js';
import {
  RUN_STATE_STATUS,
  RUN_STATE_TEXT,
  TRIGGER_TEXT,
  durationText,
  fetchTaskRuns,
  taskRunsKey,
} from '../../lib/tasks.js';

/** Last runs of a task (newest first); picking one shows its details and output. */
export function TaskRunsDialog({
  task,
  now,
  onClose,
}: {
  task: Task;
  now: Date;
  onClose: () => void;
}): ReactElement {
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Läufe von ${task.name}`}
      className="app-dialog-wide hz-dialog-sheet"
    >
      <RunsBody task={task} now={now} onClose={onClose} />
    </Dialog>
  );
}

export function RunsBody({
  task,
  now,
  onClose,
}: {
  task: Task;
  now: Date;
  onClose: () => void;
}): ReactElement {
  const q = useQuery({
    queryKey: taskRunsKey(task.id),
    queryFn: ({ signal }) => fetchTaskRuns(task.id, signal),
    refetchInterval: (s) => (s.state.data?.some((r) => r.state === 'running') ? 3_000 : false),
  });
  const runs = [...(q.data ?? [])].sort((a, b) => b.startedAt - a.startedAt);
  const [picked, setPicked] = useState<string | null>(null);
  const current = runs.find((r) => r.id === picked) ?? runs[0];

  return (
    <div className="hz-dialog-body">
      {q.error ? <FormError title={errorText(q.error)} /> : null}
      {q.data && runs.length === 0 ? (
        <p className="hz-dialog-text">Noch kein Lauf. „Jetzt ausführen“ startet einen.</p>
      ) : null}
      {runs.length ? (
        <div className="app-pick-list" role="group" aria-label="Läufe">
          {runs.map((r) => (
            <RunRow
              key={r.id}
              run={r}
              now={now}
              selected={r.id === current?.id}
              onPick={() => setPicked(r.id)}
            />
          ))}
        </div>
      ) : null}
      {current ? <RunDetail run={current} command={task.action.kind === 'command'} /> : null}
      <div className="hz-dialog-foot">
        <Button onClick={onClose}>Schließen</Button>
      </div>
    </div>
  );
}

function RunRow({
  run: r,
  now,
  selected,
  onPick,
}: {
  run: TaskRun;
  now: Date;
  selected: boolean;
  onPick: () => void;
}): ReactElement {
  return (
    <button type="button" aria-pressed={selected} className="hz-row app-run-row" onClick={onPick}>
      <StatusDot status={RUN_STATE_STATUS[r.state]} />
      <span className="hz-row-main">
        <span className="hz-row-name">{formatWhen(new Date(r.startedAt), now)}</span>
        <span className="hz-row-sub">
          {TRIGGER_TEXT[r.trigger]} · {r.summary || RUN_STATE_TEXT[r.state]}
        </span>
      </span>
      <span className="hz-row-meta">{durationText(r.durationMs)}</span>
    </button>
  );
}

export function RunDetail({ run: r, command }: { run: TaskRun; command: boolean }): ReactElement {
  return (
    <div className="app-stack" data-testid="run-detail">
      <dl className="app-kv">
        <dt>Status</dt>
        <dd>{RUN_STATE_TEXT[r.state]}</dd>
        <dt>Start</dt>
        <dd>{formatDateTime(new Date(r.startedAt))}</dd>
        <dt>Dauer</dt>
        <dd>{durationText(r.durationMs)}</dd>
        <dt>Auslöser</dt>
        <dd>{TRIGGER_TEXT[r.trigger]}</dd>
        {r.exitCode != null ? (
          <>
            <dt>Exit-Code</dt>
            <dd>{r.exitCode}</dd>
          </>
        ) : null}
        <dt>Ergebnis</dt>
        <dd>{r.summary || '—'}</dd>
      </dl>
      {command ? (
        r.output ? (
          <CopyBlock label="Ausgabe (Ende)" text={r.output} />
        ) : (
          <p className="app-text">Keine Ausgabe.</p>
        )
      ) : null}
    </div>
  );
}
