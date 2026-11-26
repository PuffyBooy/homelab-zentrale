import type { DeployTarget, RepoSummary, ServerSummary } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Button, Toggle } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { SelectField } from '../../components/SelectField.js';
import { isApiError } from '../../lib/api.js';
import { errorText } from '../../lib/errors.js';
import {
  createTarget,
  emptyTargetForm,
  formToTarget,
  reposKey,
  targetToForm,
  updateTarget,
  type TargetForm,
  type TargetFormErrors,
  type TargetRequest,
} from '../../lib/github.js';
import { mergeById } from '../../lib/live.js';

export interface TargetDialogProps {
  open: boolean;
  onClose: () => void;
  repo: RepoSummary;
  servers: ServerSummary[];
  /** Edit this target; create a new one without. */
  target?: DeployTarget | undefined;
}

/** Create or edit a deploy target (SPEC 7): server, path, branch, method, auto-deploy. */
export function TargetDialog(props: TargetDialogProps): ReactElement {
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={
        props.target ? `Ziel auf ${props.target.serverName} bearbeiten` : 'Deploy-Ziel anlegen'
      }
      className="app-dialog-wide hz-dialog-sheet"
      dismissable={false}
    >
      <TargetFormBody {...props} />
    </Dialog>
  );
}

function TargetFormBody({ onClose, repo, servers, target }: TargetDialogProps): ReactElement {
  const qc = useQueryClient();
  const [form, setForm] = useState<TargetForm>(() => {
    if (target) return targetToForm(target);
    const f = emptyTargetForm(repo);
    return servers.length === 1 && servers[0] ? { ...f, serverId: servers[0].id } : f;
  });
  const [errors, setErrors] = useState<TargetFormErrors>({});
  const save = useMutation({
    mutationFn: (body: TargetRequest) =>
      target ? updateTarget(target.id, body) : createTarget(repo.id, body),
    onSuccess: (saved) => {
      qc.setQueryData<RepoSummary[]>(reposKey, (old) =>
        old?.map((r) => (r.id === repo.id ? { ...r, targets: mergeById(r.targets, [saved]) } : r)),
      );
      void qc.invalidateQueries({ queryKey: ['github', 'commits', repo.id] });
      onClose();
    },
  });

  function set<K extends keyof TargetForm>(key: K, value: TargetForm[K]): void {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    const res = formToTarget(form);
    if (!res.ok) {
      setErrors(res.errors);
      return;
    }
    save.mutate(res.body);
  }

  const serverOptions = [
    ...(form.serverId ? [] : [{ value: '', label: 'Server auswählen' }]),
    ...servers.map((s) => ({ value: s.id, label: s.connected ? s.name : `${s.name} (offline)` })),
  ];

  return (
    <form className="hz-dialog-body" onSubmit={submit} noValidate>
      <p className="hz-dialog-text">
        {repo.fullName} wird auf dem Server in den Ordner geklont und dort gestartet.
      </p>
      <div className="app-form-row">
        <SelectField
          label="Server"
          value={form.serverId}
          onChange={(e) => set('serverId', e.target.value)}
          options={serverOptions}
          error={errors.serverId}
          disabled={!!target}
          hint={target ? 'Der Server lässt sich nachträglich nicht ändern.' : undefined}
          data-autofocus=""
        />
        <Field
          label="Branch"
          mono
          value={form.branch}
          onChange={(e) => set('branch', e.target.value)}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={200}
          hint={`Standard: ${repo.defaultBranch}`}
          error={errors.branch}
        />
      </div>
      <Field
        label="Pfad"
        mono
        value={form.path}
        onChange={(e) => set('path', e.target.value)}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={512}
        hint="Unter /opt/homelab/. Der Agent legt den Ordner beim ersten Deploy an."
        error={errors.path}
      />
      <SelectField
        label="Methode"
        value={form.method}
        onChange={(e) => set('method', e.target.value === 'script' ? 'script' : 'compose')}
        options={[
          { value: 'compose', label: 'compose: git checkout, docker compose up -d --build' },
          { value: 'script', label: 'script: deploy.sh aus dem Repo' },
        ]}
      />
      <Toggle
        label="Automatisch deployen"
        hint="Neuer Commit auf dem Branch und CI grün"
        checked={form.autoDeploy}
        onChange={(v) => set('autoDeploy', v)}
      />
      {save.error ? (
        <FormError
          title={
            isApiError(save.error, 'conflict')
              ? 'Ein anderes Ziel auf diesem Server nutzt den Ordner schon oder einen Ordner darüber oder darin.'
              : errorText(save.error)
          }
        />
      ) : null}
      <div className="hz-dialog-foot">
        <Button onClick={onClose}>Abbrechen</Button>
        <Button variant="primary" type="submit" disabled={save.isPending}>
          {target ? 'Speichern' : 'Anlegen'}
        </Button>
      </div>
    </form>
  );
}
