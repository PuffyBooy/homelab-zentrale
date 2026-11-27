import type { ServerSummary, Task } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactElement } from 'react';
import { Alert, Button, ServiceRow, Tile } from '@hz/ui';
import { shownError } from '../../components/ConfirmDialog.js';
import { FormError } from '../../components/FormError.js';
import { errorText } from '../../lib/errors.js';
import { plural } from '../../lib/format.js';
import {
  actionText,
  lastRunText,
  nextRunText,
  runTask,
  scheduleText,
  sortTasks,
  taskRunsKey,
  taskStatus,
  tasksKey,
  useTasks,
  type TasksResponse,
} from '../../lib/tasks.js';
import { TaskDialog } from './TaskDialog.js';
import { TaskRunsDialog } from './TaskRunsDialog.js';

/**
 * Geplante Aufgaben (M20): one row per task with server, kind, schedule in German,
 * next run and last run with status (shape + text). "Aufgabe anlegen" is the main action.
 */
export function TasksTile({
  servers,
  now,
}: {
  servers: readonly ServerSummary[];
  now: Date;
}): ReactElement {
  const q = useTasks();
  const [editing, setEditing] = useState<Task | 'new' | null>(null);
  const [runsOf, setRunsOf] = useState<Task | null>(null);
  const list = useMemo(() => sortTasks(q.data?.tasks ?? []), [q.data]);
  const failed = list.filter((t) => taskStatus(t) === 'crit').length;

  return (
    <Tile
      title="Geplante Aufgaben"
      className="app-wrap-tile"
      icon="refresh"
      count={
        q.data
          ? failed
            ? `${list.length} · ${plural(failed, 'Fehler', 'Fehler')}`
            : String(list.length)
          : undefined
      }
      span={4}
      flush
      actions={
        <Button
          size="sm"
          variant="primary"
          icon="plus"
          disabled={servers.length === 0}
          onClick={() => setEditing('new')}
        >
          Aufgabe anlegen
        </Button>
      }
      footer={
        <span className="app-foot-text">
          Zeitzone der Zentrale · verpasste Läufe werden nicht nachgeholt · letzte 50 Läufe bleiben
        </span>
      }
    >
      {q.error && !q.data ? (
        <div className="app-pad">
          <FormError title={errorText(q.error)} />
        </div>
      ) : null}
      {q.data && list.length === 0 ? (
        <p className="app-empty app-pad">
          Noch keine Aufgaben. Zum Beispiel jeden Sonntag um 04:00 Docker aufräumen.
        </p>
      ) : null}
      {q.data
        ? list.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              now={now}
              onEdit={() => setEditing(t)}
              onRuns={() => setRunsOf(t)}
            />
          ))
        : null}
      {editing && q.data ? (
        <TaskDialog
          servers={servers}
          commandServers={q.data.commandServers}
          task={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {runsOf ? <TaskRunsDialog task={runsOf} now={now} onClose={() => setRunsOf(null)} /> : null}
    </Tile>
  );
}

export function TaskRow({
  task: t,
  now,
  onEdit,
  onRuns,
}: {
  task: Task;
  now: Date;
  onEdit: () => void;
  onRuns: () => void;
}): ReactElement {
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: () => runTask(t.id),
    onSuccess: (r) => {
      qc.setQueryData<TasksResponse>(tasksKey, (old) =>
        old
          ? { ...old, tasks: old.tasks.map((x) => (x.id === t.id ? { ...x, lastRun: r } : x)) }
          : old,
      );
      void qc.invalidateQueries({ queryKey: taskRunsKey(t.id) });
    },
  });
  const running = run.isPending || t.lastRun?.state === 'running';
  const err = shownError(run.error);
  const command = t.action.kind === 'command';
  return (
    <>
      <ServiceRow
        name={t.name}
        host={`${t.serverName} · ${actionText(t.action)} · ${scheduleText(t.schedule)}`}
        status={running ? 'busy' : taskStatus(t)}
        meta={
          <span data-testid="task-meta">
            {nextRunText(t, now)} · {lastRunText(t.lastRun, now)}
          </span>
        }
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              icon={command ? 'lock' : 'play'}
              aria-label={`${t.name} jetzt ausführen${command ? ' (mit Code)' : ''}`}
              title="Jetzt ausführen"
              disabled={running}
              onClick={() => run.mutate()}
            />
            <Button
              size="sm"
              variant="ghost"
              icon="terminal"
              aria-label={`Läufe von ${t.name}`}
              title="Läufe und Ausgabe"
              onClick={onRuns}
            />
            <Button size="sm" variant="ghost" aria-label={`${t.name} bearbeiten`} onClick={onEdit}>
              Bearbeiten
            </Button>
          </>
        }
      />
      {err ? (
        <div className="app-ctr-error">
          <Alert tone="crit" title={`${t.name}: ${err}`} />
        </div>
      ) : null}
    </>
  );
}
