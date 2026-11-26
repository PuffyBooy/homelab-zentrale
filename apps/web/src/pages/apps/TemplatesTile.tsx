import type { AppCategory, AppTemplateSummary } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent, type ReactElement } from 'react';
import { Button, ServiceRow, Tile, Toggle, cx } from '@hz/ui';
import { ConfirmDialog, shownError } from '../../components/ConfirmDialog.js';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { SelectField } from '../../components/SelectField.js';
import {
  APP_CATEGORIES,
  APP_CATEGORY_LABELS,
  appErrorText,
  appTemplateKey,
  appTemplatesKey,
  createAppTemplate,
  deleteAppTemplate,
  draftToTemplate,
  emptyTemplateDraft,
  fetchAppTemplate,
  templateMeta,
  templateToDraft,
  updateAppTemplate,
  type TemplateDraft,
  type TemplateErrors,
} from '../../lib/apps.js';
import { errorText } from '../../lib/errors.js';

const text = (err: unknown): string => appErrorText(err, errorText);

/** Own stack templates: list, editor, remove (custom only; 409 while installed). */
export function TemplatesTile({
  templates,
}: {
  templates: readonly AppTemplateSummary[];
}): ReactElement {
  const own = templates
    .filter((t) => t.source === 'custom')
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [removing, setRemoving] = useState<AppTemplateSummary | null>(null);
  return (
    <Tile
      title="Eigene Vorlagen"
      className="app-wrap-tile"
      icon="plus"
      count={String(own.length)}
      span={4}
      flush
      actions={
        <Button size="sm" icon="plus" onClick={() => setEditing('new')}>
          Vorlage anlegen
        </Button>
      }
      footer={
        <span className="app-foot-text">
          Gleiche Sicherheitsprüfung wie die eingebauten: kein privileged, kein Docker-Socket, Ports
          nur über $&#123;BIND&#125;
        </span>
      }
    >
      {own.length === 0 ? (
        <p className="app-empty app-pad">
          Noch keine eigene Vorlage. Eine compose.yml mit Platzhaltern wie $&#123;WEB_PORT&#125;
          wird zur Vorlage.
        </p>
      ) : (
        own.map((t) => (
          <ServiceRow
            key={t.id}
            name={t.name}
            host={`${t.id} · ${APP_CATEGORY_LABELS[t.category]} · ${templateMeta(t)}`}
            status="info"
            meta={t.installed ? `${t.installed}× installiert` : 'nicht installiert'}
            actions={
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`${t.name} bearbeiten`}
                  onClick={() => setEditing(t.id)}
                >
                  Bearbeiten
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`${t.name} löschen`}
                  disabled={t.installed > 0}
                  title={t.installed > 0 ? 'Erst die Installationen entfernen' : undefined}
                  onClick={() => setRemoving(t)}
                >
                  Löschen
                </Button>
              </>
            }
          />
        ))
      )}
      {editing ? (
        <TemplateEditorDialog
          id={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {removing ? <RemoveTemplate t={removing} onClose={() => setRemoving(null)} /> : null}
    </Tile>
  );
}

function RemoveTemplate({
  t,
  onClose,
}: {
  t: AppTemplateSummary;
  onClose: () => void;
}): ReactElement {
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: () => deleteAppTemplate(t.id),
    onSuccess: () => {
      qc.setQueryData<AppTemplateSummary[]>(appTemplatesKey, (old) =>
        old?.filter((x) => x.id !== t.id),
      );
      onClose();
    },
  });
  return (
    <ConfirmDialog
      title={`Vorlage ${t.name} löschen?`}
      action="Löschen"
      busy={del.isPending}
      error={del.error}
      errorTextOf={text}
      onConfirm={() => del.mutate()}
      onClose={onClose}
    >
      Installierte Apps sind nicht betroffen, aber ohne Vorlage geht kein Update mehr.
    </ConfirmDialog>
  );
}

export function TemplateEditorDialog({
  id,
  onClose,
}: {
  id?: string | undefined;
  onClose: () => void;
}): ReactElement {
  const q = useQuery({
    queryKey: appTemplateKey(id ?? ''),
    queryFn: ({ signal }) => fetchAppTemplate(id ?? '', signal),
    enabled: !!id,
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={id ? `Vorlage ${q.data?.meta.name ?? id} bearbeiten` : 'Eigene Vorlage anlegen'}
      className="app-dialog-wide hz-dialog-sheet"
      dismissable={false}
    >
      {!id ? (
        <TemplateForm onClose={onClose} />
      ) : q.data ? (
        <TemplateForm id={id} initial={templateToDraft(q.data)} onClose={onClose} />
      ) : (
        <div className="hz-dialog-body">
          {q.error ? (
            <FormError title={errorText(q.error)} />
          ) : (
            <p className="hz-dialog-text">Lade Vorlage …</p>
          )}
          <div className="hz-dialog-foot">
            <Button onClick={onClose}>Abbrechen</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function TemplateForm({
  id,
  initial,
  onClose,
}: {
  id?: string | undefined;
  initial?: TemplateDraft | undefined;
  onClose: () => void;
}): ReactElement {
  const qc = useQueryClient();
  const composeId = useId();
  const paramsId = useId();
  const hintsId = useId();
  const [d, setD] = useState<TemplateDraft>(() => initial ?? emptyTemplateDraft());
  const [errors, setErrors] = useState<TemplateErrors>({});
  const save = useMutation({
    mutationFn: (body: Parameters<typeof createAppTemplate>[0]) =>
      id ? updateAppTemplate(id, body) : createAppTemplate(body),
    onSuccess: (detail) => {
      qc.setQueryData(appTemplateKey(detail.meta.id), detail);
      void qc.invalidateQueries({ queryKey: appTemplatesKey });
      onClose();
    },
  });

  function set<K extends keyof TemplateDraft>(key: K, value: TemplateDraft[K]): void {
    setD((x) => ({ ...x, [key]: value }));
    setErrors((e) => ({ ...e, [key === 'amd64' || key === 'arm64' ? 'arch' : key]: undefined }));
    save.reset();
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    const res = draftToTemplate(d);
    if (!res.ok) {
      setErrors(res.errors);
      return;
    }
    setErrors({});
    save.mutate(res.body);
  }

  const err = shownError(save.error, text);

  return (
    <form className="hz-dialog-body" onSubmit={submit} noValidate>
      <div className="app-fields">
        <Field
          label="Kennung"
          mono
          value={d.id}
          onChange={(e) => set('id', e.target.value.trim().toLowerCase())}
          placeholder="meine-app"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          disabled={!!id}
          hint={id ? 'Lässt sich nicht ändern.' : 'Auch Vorschlag für den App-Ordner.'}
          error={errors.id}
          data-autofocus=""
        />
        <Field
          label="Name"
          value={d.name}
          onChange={(e) => set('name', e.target.value)}
          maxLength={40}
          autoComplete="off"
          error={errors.name}
        />
        <Field
          className="app-fields-wide"
          label="Beschreibung"
          value={d.description}
          onChange={(e) => set('description', e.target.value)}
          maxLength={300}
          autoComplete="off"
          error={errors.description}
        />
        <SelectField
          label="Kategorie"
          value={d.category}
          options={APP_CATEGORIES.map((c) => ({ value: c, label: APP_CATEGORY_LABELS[c] }))}
          onChange={(e) => set('category', e.target.value as AppCategory)}
        />
        <Field
          label="Version"
          mono
          value={d.version}
          onChange={(e) => set('version', e.target.value)}
          placeholder="1.27.3"
          autoComplete="off"
          hint="Version, zu der die gepinnten Images gehören."
          error={errors.version}
        />
        <Field
          label="Website (optional)"
          type="url"
          value={d.website}
          onChange={(e) => set('website', e.target.value)}
          placeholder="https://"
          autoComplete="off"
          error={errors.website}
        />
        <Field
          label="RAM mindestens in MB"
          mono
          inputMode="numeric"
          value={d.minRamMb}
          onChange={(e) => set('minRamMb', e.target.value)}
          error={errors.minRamMb}
        />
        <div className="hz-field">
          <span className="hz-field-label">Architektur</span>
          <Toggle label="amd64" checked={d.amd64} onChange={(on) => set('amd64', on)} />
          <Toggle label="arm64" checked={d.arm64} onChange={(on) => set('arm64', on)} />
          {errors.arch ? <span className="hz-field-error">{errors.arch}</span> : null}
        </div>
      </div>
      <TextArea
        id={hintsId}
        label="Hinweise vor dem Installieren (optional)"
        value={d.hints}
        rows={2}
        onChange={(v) => set('hints', v)}
        hint="Eine Zeile pro Hinweis, höchstens 6."
        error={errors.hints}
      />
      <TextArea
        id={paramsId}
        label="Parameter (JSON)"
        value={d.params}
        rows={6}
        mono
        onChange={(v) => set('params', v)}
        hint="Typen: string, password, port, number, select, bool. Die Zentrale setzt selbst APP_ID, APP_DIR, BIND, TZ, PUID, PGID."
        error={errors.params}
      />
      <TextArea
        id={composeId}
        label="compose.yml"
        value={d.compose}
        rows={14}
        mono
        onChange={(v) => set('compose', v)}
        hint="Ports immer als ${BIND}:${PORT}:…, Daten nur unter ./data/. Kein privileged, kein cap_add, keine devices, kein docker.sock, kein host-Netz."
        error={errors.compose}
      />
      {err ? <FormError title={err} /> : null}
      <div className="hz-dialog-foot">
        <Button onClick={onClose}>Abbrechen</Button>
        <Button variant="primary" type="submit" disabled={save.isPending}>
          {save.isPending ? 'Prüft …' : 'Speichern'}
        </Button>
      </div>
    </form>
  );
}

/** Labelled <textarea> with the Field markup (hz-field + hz-input). */
function TextArea({
  id,
  label,
  value,
  rows,
  mono,
  hint,
  error,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  rows: number;
  mono?: boolean;
  hint?: string;
  error?: string | undefined;
  onChange: (v: string) => void;
}): ReactElement {
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(' ');
  return (
    <div className="hz-field">
      <label className="hz-field-label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className={cx('hz-input', 'app-textarea-raw', mono && 'hz-input-mono')}
        value={value}
        rows={rows}
        spellCheck={false}
        autoCapitalize="none"
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? (
        <span className="hz-field-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="hz-field-error" id={errId}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
