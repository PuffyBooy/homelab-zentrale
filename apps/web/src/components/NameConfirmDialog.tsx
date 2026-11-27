import { useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import { Alert, Button } from '@hz/ui';
import { shownError } from './ConfirmDialog.js';
import { Dialog } from './Dialog.js';
import { Field } from './Field.js';
import { FormError } from './FormError.js';

export interface NameConfirmDialogProps {
  /** Status first: "nginx entfernen". */
  title: string;
  /** The name to type, exactly. */
  name: string;
  /** Label of the input ("Containername", "Projektname"). */
  label: string;
  children?: ReactNode;
  /** Extra inputs (e.g. a checkbox) below the text. */
  extra?: ReactNode;
  /** Danger button label. */
  action: string;
  busy: boolean;
  error: unknown;
  errorTextOf?: (err: unknown) => string;
  /** Shown instead of the form once the action ran. */
  done?: string | null | undefined;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Danger dialog confirmed by typing a name (like the reboot of a server). A step-up
 * comes from lib/api; a cancelled step-up shows no error.
 */
export function NameConfirmDialog(props: NameConfirmDialogProps): ReactElement {
  return (
    <Dialog open onClose={props.onClose} title={props.title} dismissable={false}>
      <NameConfirmBody {...props} />
    </Dialog>
  );
}

export function NameConfirmBody({
  name,
  label,
  children,
  extra,
  action,
  busy,
  error,
  errorTextOf,
  done,
  onConfirm,
  onClose,
}: NameConfirmDialogProps): ReactElement {
  const [typed, setTyped] = useState('');
  const match = typed.trim() === name;

  if (done) {
    return (
      <div className="hz-dialog-body">
        <Alert tone="ok" title={done} />
        <div className="hz-dialog-foot">
          <Button variant="primary" onClick={onClose} data-autofocus="">
            Fertig
          </Button>
        </div>
      </div>
    );
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (match && !busy) onConfirm();
  }

  const shown = shownError(error, errorTextOf);
  return (
    <form className="hz-dialog-body" onSubmit={submit} noValidate>
      {children ? <div className="hz-dialog-text">{children}</div> : null}
      <Field
        label={label}
        mono
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={name}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        data-autofocus=""
      />
      {extra}
      {shown ? <FormError title={shown} /> : null}
      <div className="hz-dialog-foot">
        <Button onClick={onClose} disabled={busy}>
          Abbrechen
        </Button>
        <Button variant="danger" type="submit" disabled={!match || busy}>
          {busy ? 'Läuft …' : action}
        </Button>
      </div>
    </form>
  );
}
