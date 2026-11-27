import type { ServerSummary, Task } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent, type ReactElement } from 'react';
import { Alert, Button, Toggle } from '@hz/ui';
import { ConfirmDialog, shownError } from '../../components/ConfirmDialog.js';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { SelectField, type SelectOption } from '../../components/SelectField.js';
import { useContainers } from '../../lib/data.js';
import { DAY_LONG, DAY_SHORT, toggleDay } from '../../lib/gameFeatures.js';
import {
  TASK_KINDS,
  TASK_KIND_LABELS,
  TASK_MIN_INTERVAL_MINUTES,
  createTask,
  defaultTaskName,
  deleteTask,
  draftToCreate,
  draftToUpdate,
  emptyTaskDraft,
  fetchTaskCommand,
  needsStepUp,
  taskContainers,
  taskToDraft,
  tasksKey,
  updateTask,
  type TaskDraft,
  type TaskDraftErrors,
  type TasksResponse,
} from '../../lib/tasks.js';

export interface TaskDialogProps {
  servers: readonly ServerSummary[];
  /** Servers whose agent runs with HZ_AGENT_ALLOW_TASKS=1. */
  commandServers: readonly string[];
  /** Edit this task; create a new one without. */
  task?: Task | undefined;
  onClose: () => void;
}

/** Create or edit a scheduled task (M20). Command tasks need step-up (api() asks). */
export function TaskDialog(props: TaskDialogProps): ReactElement {
  const { task, onClose } = props;
  const qc = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const del = useMutation({
    mutationFn: () => (task ? deleteTask(task.id) : Promise.resolve()),
    onSuccess: () => {
      qc.setQueryData<TasksResponse>(tasksKey, (old) =>
        old ? { ...old, tasks: old.tasks.filter((t) => t.id !== task?.id) } : old,
      );
      onClose();
    },
  });
  return (
    <>
      <Dialog
        open
        onClose={onClose}
        title={task ? `${task.name} bearbeiten` : 'Aufgabe anlegen'}
        className="app-dialog-wide hz-dialog-sheet"
        dismissable={false}
      >
        <TaskForm {...props} onDelete={task ? () => setConfirmDelete(true) : undefined} />
      </Dialog>
      {confirmDelete && task ? (
        <ConfirmDialog
          title={`${task.name} löschen?`}
          action="Löschen"
          busy={del.isPending}
          error={del.error}
          onConfirm={() => del.mutate()}
          onClose={() => setConfirmDelete(false)}
        >
          Die Aufgabe und ihre letzten Läufe verschwinden. Der Container bleibt, wie er ist.
        </ConfirmDialog>
      ) : null}
    </>
  );
}

export function TaskForm({
  servers,
  commandServers,
  task,
  onClose,
  onDelete,
}: TaskDialogProps & { onDelete?: (() => void) | undefined }): ReactElement {
  const qc = useQueryClient();
  const containers = useContainers();
  const daysId = useId();
  const [draft, setDraft] = useState<TaskDraft>(() =>
    task ? taskToDraft(task) : emptyTaskDraft(servers[0]?.id ?? ''),
  );
  const [errors, setErrors] = useState<TaskDraftErrors>({});
  const serverName = servers.find((s) => s.id === draft.serverId)?.name ?? '';
  const canCommand = commandServers.includes(draft.serverId);

  const save = useMutation({
    mutationFn: (d: TaskDraft) => {
      if (task) {
        const res = draftToUpdate(d, task, serverName);
        if (!res.ok) throw new DraftError(res.errors);
        return updateTask(task.id, res.body);
      }
      const res = draftToCreate(d, serverName);
      if (!res.ok) throw new DraftError(res.errors);
      return createTask(res.body);
    },
    onSuccess: (saved) => {
      qc.setQueryData<TasksResponse>(tasksKey, (old) =>
        old
          ? {
              ...old,
              tasks: old.tasks.some((t) => t.id === saved.id)
                ? old.tasks.map((t) => (t.id === saved.id ? saved : t))
                : [...old.tasks, saved],
            }
          : old,
      );
      void qc.invalidateQueries({ queryKey: tasksKey });
      onClose();
    },
    onError: (err) => {
      if (err instanceof DraftError) setErrors(err.errors);
    },
  });

  const loadCommand = useMutation({
    mutationFn: () => (task ? fetchTaskCommand(task.id) : Promise.resolve('')),
    onSuccess: (command) => set('command', command),
  });

  function set<K extends keyof TaskDraft>(key: K, value: TaskDraft[K]): void {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    const res = task ? draftToUpdate(draft, task, serverName) : draftToCreate(draft, serverName);
    if (!res.ok) {
      setErrors(res.errors);
      return;
    }
    setErrors({});
    save.mutate(draft);
  }

  const serverOptions: SelectOption[] = servers.map((s) => ({
    value: s.id,
    label: s.connected ? s.name : `${s.name} · offline`,
  }));
  const kindOptions: SelectOption[] = TASK_KINDS.map((k) => ({
    value: k,
    label:
      k === 'command' && !canCommand
        ? `${TASK_KIND_LABELS[k]} · nur mit Agent --tasks`
        : TASK_KIND_LABELS[k],
    disabled: k === 'command' && !canCommand && draft.kind !== 'command',
  }));
  const ctrList = taskContainers(containers.data ?? [], draft.serverId);
  const ctrOptions: SelectOption[] = [
    { value: '', label: ctrList.length ? 'Container wählen' : 'Keine Container auf dem Server' },
    ...ctrList.map((c) => ({ value: c.name, label: `${c.name} · ${c.image}` })),
    // Keep a saved container that is gone right now (recreated, server offline).
    ...(draft.container && !ctrList.some((c) => c.name === draft.container)
      ? [{ value: draft.container, label: `${draft.container} · gerade nicht gefunden` }]
      : []),
  ];
  const isContainer = draft.kind.startsWith('container.');
  const stepUp = needsStepUp(draft, task);
  const editingCommand = task?.action.kind === 'command' && draft.kind === 'command';
  const formError = save.error instanceof DraftError ? null : shownError(save.error);

  return (
    <form className="hz-dialog-body" onSubmit={submit} noValidate>
      <div className="app-form-row">
        <SelectField
          label="Server"
          value={draft.serverId}
          options={serverOptions}
          onChange={(e) => {
            set('serverId', e.target.value);
            set('container', '');
          }}
          disabled={!!task}
          hint={task ? 'Der Server lässt sich nachträglich nicht ändern.' : undefined}
          error={errors.serverId}
          data-autofocus=""
        />
        <SelectField
          label="Art"
          value={draft.kind}
          options={kindOptions}
          onChange={(e) => set('kind', e.target.value as TaskDraft['kind'])}
        />
      </div>

      {isContainer ? (
        <SelectField
          label="Container"
          value={draft.container}
          options={ctrOptions}
          onChange={(e) => set('container', e.target.value)}
          error={errors.container}
          hint="Zentrale und Agent (hz.role) stehen nicht zur Wahl."
        />
      ) : null}

      {draft.kind === 'compose.update' ? (
        <Field
          label="Ordner des Stacks"
          mono
          value={draft.dir}
          onChange={(e) => set('dir', e.target.value)}
          placeholder="/opt/homelab/apps/nextcloud"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          hint="Ordner mit compose.yml unter /opt/homelab/. Erst pull, dann up -d."
          error={errors.dir}
        />
      ) : null}

      {draft.kind === 'system.cleanup' ? (
        <p className="app-text">
          Entfernt gestoppte Container, ungenutzte Images und den Build-Cache, wie „Aufräumen“ im
          Serverdetail. Volumes bleiben.
        </p>
      ) : null}

      {draft.kind === 'command' ? (
        <>
          <Alert tone="warn" title="Befehl läuft als Shell auf dem Host.">
            Mit den Rechten des Agents, ohne Rückfrage, zur eingestellten Zeit. Nur auf Servern,
            deren Agent mit --tasks läuft. Speichern und „Jetzt ausführen“ brauchen einen Code.
          </Alert>
          {!canCommand ? (
            <FormError title="Der Agent dieses Servers erlaubt keine Befehle (HZ_AGENT_ALLOW_TASKS)." />
          ) : null}
          <Field
            label="Befehl"
            mono
            value={draft.command}
            onChange={(e) => set('command', e.target.value)}
            placeholder={editingCommand ? 'leer lassen: gespeicherter Befehl bleibt' : 'df -h /'}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={2000}
            hint={
              editingCommand
                ? `Gespeichert als #${task.action.kind === 'command' ? task.action.commandHash : ''}. Ein neuer Timeout gilt nur mit neuem Befehl.`
                : 'Eine Zeile. Wird verschlüsselt gespeichert und nie ins Log geschrieben.'
            }
            error={errors.command}
          />
          {editingCommand && !draft.command ? (
            <div>
              <Button
                size="sm"
                icon="lock"
                disabled={loadCommand.isPending}
                onClick={() => loadCommand.mutate()}
              >
                Befehl anzeigen
              </Button>
            </div>
          ) : null}
          {shownError(loadCommand.error) ? (
            <FormError title={shownError(loadCommand.error) ?? ''} />
          ) : null}
          <Field
            label="Zeitlimit in s"
            mono
            inputMode="numeric"
            value={draft.timeoutSec}
            onChange={(e) => set('timeoutSec', e.target.value)}
            hint="5 bis 1800, danach wird der Befehl beendet."
            error={errors.timeoutSec}
          />
        </>
      ) : null}

      <fieldset className="app-fieldset">
        <legend className="hz-field-label">Zeitplan</legend>
        <div className="app-range" role="group" aria-label="Art des Zeitplans">
          <Button
            size="sm"
            variant={draft.scheduleType === 'weekly' ? 'secondary' : 'ghost'}
            aria-pressed={draft.scheduleType === 'weekly'}
            onClick={() => set('scheduleType', 'weekly')}
          >
            Wochentage und Uhrzeiten
          </Button>
          <Button
            size="sm"
            variant={draft.scheduleType === 'interval' ? 'secondary' : 'ghost'}
            aria-pressed={draft.scheduleType === 'interval'}
            onClick={() => set('scheduleType', 'interval')}
          >
            Alle N Minuten
          </Button>
        </div>
        {draft.scheduleType === 'weekly' ? (
          <>
            <div className="hz-field">
              <span className="hz-field-label" id={daysId}>
                Wochentage
              </span>
              <div className="app-days" role="group" aria-labelledby={daysId}>
                {DAY_SHORT.map((label, i) => {
                  const day = i + 1;
                  const on = draft.days.includes(day);
                  return (
                    <Button
                      key={label}
                      size="sm"
                      variant={on ? 'secondary' : 'ghost'}
                      aria-pressed={on}
                      title={DAY_LONG[i]}
                      onClick={() => set('days', toggleDay(draft.days, day, !on))}
                    >
                      {label}
                    </Button>
                  );
                })}
              </div>
              {errors.days ? <span className="hz-field-error">{errors.days}</span> : null}
            </div>
            <Field
              label="Uhrzeiten"
              mono
              value={draft.times}
              onChange={(e) => set('times', e.target.value)}
              placeholder="04:00, 16:00"
              autoComplete="off"
              hint="24-h-Format, bis zu 6, mit Komma getrennt. Zeitzone der Zentrale."
              error={errors.times}
            />
          </>
        ) : (
          <Field
            label="Alle … Minuten"
            mono
            inputMode="numeric"
            value={draft.minutes}
            onChange={(e) => set('minutes', e.target.value)}
            hint={`Ab ${TASK_MIN_INTERVAL_MINUTES} Min. Gezählt ab dem letzten Start, der erste Lauf kommt nach dem Speichern.`}
            error={errors.minutes}
          />
        )}
      </fieldset>

      <Field
        label="Name"
        value={draft.name}
        onChange={(e) => set('name', e.target.value)}
        placeholder={defaultTaskName(draft, serverName)}
        maxLength={60}
        autoComplete="off"
        hint="Leer lassen, dann gilt der Vorschlag. Steht in Meldungen und Push."
        error={errors.name}
      />
      <Toggle label="Aktiv" checked={draft.enabled} onChange={(on) => set('enabled', on)} />
      <Toggle
        label="Meldung bei Fehler"
        hint="WARN-Meldung mit Push, der nächste erfolgreiche Lauf schließt sie."
        checked={draft.notifyOnFailure}
        onChange={(on) => set('notifyOnFailure', on)}
      />

      {formError ? <FormError title={formError} /> : null}
      <div className="hz-dialog-foot">
        {onDelete ? (
          <Button variant="danger" onClick={onDelete}>
            Löschen
          </Button>
        ) : null}
        <Button onClick={onClose}>Abbrechen</Button>
        <Button
          variant="primary"
          type="submit"
          icon={stepUp ? 'lock' : undefined}
          disabled={save.isPending || (draft.kind === 'command' && !canCommand)}
        >
          {save.isPending ? 'Speichert …' : stepUp ? 'Mit Code speichern' : 'Speichern'}
        </Button>
      </div>
    </form>
  );
}

/** Validation errors found right before sending (mutation path). */
class DraftError extends Error {
  readonly errors: TaskDraftErrors;
  constructor(errors: TaskDraftErrors) {
    super('invalid task draft');
    this.errors = errors;
  }
}
