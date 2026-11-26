import type { GameSummary, ShareLink } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Alert, Button, Toggle } from '@hz/ui';
import { CopyBlock } from '../../components/CopyBlock.js';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { SelectField } from '../../components/SelectField.js';
import { isApiError } from '../../lib/api.js';
import { errorText } from '../../lib/errors.js';
import {
  createShare,
  emptyDraft,
  EXPIRY_OPTIONS,
  PERM_HINT,
  PERM_TEXT,
  permsFor,
  permsText,
  sharesKey,
  shareState,
  togglePerm,
  validateDraft,
  type ShareCreated,
  type ShareDraft,
  type ShareDraftErrors,
  type ShareExpiry,
} from '../../lib/shares.js';

export interface ShareCreateDialogProps {
  game: GameSummary;
  onClose: () => void;
}

/**
 * "Link erstellen" (SPEC 6.4): person, rights, expiry, optional PIN. After creating, the
 * link is shown exactly once (only its hash is stored), with copy buttons.
 */
export function ShareCreateDialog({ game, onClose }: ShareCreateDialogProps): ReactElement {
  const [created, setCreated] = useState<ShareCreated | null>(null);
  return (
    <Dialog
      open
      onClose={onClose}
      title={created ? `Link für ${created.share.person}` : `${game.name} teilen`}
      className="app-dialog-wide"
      dismissable={false}
    >
      {created ? (
        <CreatedLink created={created} onClose={onClose} />
      ) : (
        <CreateForm game={game} onClose={onClose} onCreated={setCreated} />
      )}
    </Dialog>
  );
}

function CreateForm({
  game,
  onClose,
  onCreated,
}: {
  game: GameSummary;
  onClose: () => void;
  onCreated: (c: ShareCreated) => void;
}): ReactElement {
  const qc = useQueryClient();
  // Whitelist requests are approved over RCON: only offered when the game has it.
  const allowed = permsFor(game.templateId).filter((p) => p !== 'whitelist_request' || game.rcon);
  const [draft, setDraft] = useState<ShareDraft>(emptyDraft);
  const [errors, setErrors] = useState<ShareDraftErrors>({});
  const create = useMutation({
    mutationFn: (body: Parameters<typeof createShare>[1]) => createShare(game.id, body),
    onSuccess: (res) => {
      qc.setQueryData<ShareLink[]>(sharesKey(game.id), (old) =>
        old ? [res.share, ...old.filter((s) => s.id !== res.share.id)] : old,
      );
      void qc.invalidateQueries({ queryKey: sharesKey(game.id) });
      onCreated(res);
    },
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    const { errors: errs, body } = validateDraft(draft, allowed);
    setErrors(errs);
    if (body && !create.isPending) create.mutate(body);
  }

  const set = <K extends keyof ShareDraft>(key: K, value: ShareDraft[K]): void => {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  return (
    <form className="hz-dialog-body" onSubmit={submit} noValidate>
      <p className="hz-dialog-text">
        Der Link zeigt nur {game.name} und nur die Knöpfe, die du hier einschaltest. Jede Aktion
        wird mit dem Namen protokolliert. Erstellen und Widerrufen brauchen einen frischen Code aus
        der App.
      </p>
      <Field
        label="Person"
        value={draft.person}
        onChange={(e) => set('person', e.target.value)}
        placeholder="z. B. Lena"
        maxLength={40}
        autoComplete="off"
        error={errors.person}
        data-autofocus=""
      />
      <fieldset
        className="app-fieldset"
        aria-describedby={errors.perms ? 'share-perms-err' : undefined}
      >
        <legend className="hz-label">Rechte</legend>
        {allowed.map((p) => (
          <Toggle
            key={p}
            label={PERM_TEXT[p]}
            hint={PERM_HINT[p]}
            checked={draft.perms.includes(p)}
            onChange={(on) => set('perms', togglePerm(draft.perms, p, on))}
          />
        ))}
        {errors.perms ? (
          <span className="hz-field-error" id="share-perms-err" role="alert">
            {errors.perms}
          </span>
        ) : null}
      </fieldset>
      {draft.perms.includes('console_write') ? (
        <Alert tone="warn" title="Konsole schreiben erlaubt jeden RCON-Befehl, auch stop und op." />
      ) : null}
      <div className="app-form-row">
        <SelectField
          label="Läuft ab nach"
          value={draft.expires}
          onChange={(e) => set('expires', e.target.value as ShareExpiry)}
          options={EXPIRY_OPTIONS}
        />
        <Field
          label="PIN (optional)"
          mono
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          value={draft.pin}
          onChange={(e) => set('pin', e.target.value.replace(/\s/g, ''))}
          placeholder="4 Ziffern"
          hint="Nach 5 falschen Versuchen 15 Min gesperrt."
          error={errors.pin}
        />
      </div>
      {/* A cancelled step-up is not an error the form has to repeat. */}
      {create.error && !isApiError(create.error, 'step_up_required') ? (
        <FormError title={errorText(create.error)} />
      ) : null}
      <div className="hz-dialog-foot">
        <Button onClick={onClose}>Abbrechen</Button>
        <Button variant="primary" type="submit" icon="link" disabled={create.isPending}>
          {create.isPending ? 'Erstellt …' : 'Link erstellen'}
        </Button>
      </div>
    </form>
  );
}

function CreatedLink({
  created,
  onClose,
}: {
  created: ShareCreated;
  onClose: () => void;
}): ReactElement {
  const { share, urls } = created;
  return (
    <div className="hz-dialog-body">
      <Alert tone="warn" title="Der Link wird nur jetzt angezeigt.">
        Gespeichert ist nur ein Hash. Kopier ihn jetzt und schick ihn {share.person}. Verloren? Dann
        widerrufen und neu erstellen.
      </Alert>
      {urls.public ? (
        <CopyBlock label="Link (öffentlich, über das Gateway)" text={urls.public} inline />
      ) : null}
      <CopyBlock
        label={urls.public ? 'Link im Tailnet' : 'Link (nur im Tailnet)'}
        text={urls.tailnet}
        inline
      />
      <dl className="app-kv">
        <dt>Rechte</dt>
        <dd>{permsText(share.perms)}</dd>
        <dt>Ablauf</dt>
        <dd>{shareState(share).when}</dd>
        <dt>PIN</dt>
        <dd>{share.hasPin ? 'ja, separat mitteilen' : 'nein'}</dd>
      </dl>
      {urls.public ? null : (
        <p className="hz-dialog-text">
          Das Share-Gateway ist aus. Der Link funktioniert nur für Geräte im Tailnet.
        </p>
      )}
      <div className="hz-dialog-foot">
        <Button variant="primary" onClick={onClose} data-autofocus="">
          Fertig
        </Button>
      </div>
    </div>
  );
}
