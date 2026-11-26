import type { ReactElement, ReactNode } from 'react';
import { Button } from '@hz/ui';
import { isApiError } from '../lib/api.js';
import { errorText } from '../lib/errors.js';
import { Dialog } from './Dialog.js';
import { FormError } from './FormError.js';

export interface ConfirmDialogProps {
  /** Question, status first: "nightly-restart löschen?" */
  title: string;
  children?: ReactNode;
  /** Button label (verb in the infinitive). */
  action: string;
  busy?: boolean | undefined;
  error?: unknown;
  /** Text for the error; defaults to errorText. */
  errorTextOf?: ((err: unknown) => string) | undefined;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Small "really?" dialog for destructive actions. A cancelled step-up (TOTP) shows no
 * error, like everywhere else: the action simply did not happen.
 */
export function ConfirmDialog({
  title,
  children,
  action,
  busy,
  error,
  errorTextOf = errorText,
  onConfirm,
  onClose,
}: ConfirmDialogProps): ReactElement {
  const shown = error && !isApiError(error, 'step_up_required') ? errorTextOf(error) : null;
  return (
    <Dialog open onClose={onClose} title={title} dismissable={false}>
      <div className="hz-dialog-body">
        {children ? <div className="hz-dialog-text">{children}</div> : null}
        {shown ? <FormError title={shown} /> : null}
        <div className="hz-dialog-foot">
          <Button onClick={onClose} data-autofocus="">
            Abbrechen
          </Button>
          <Button variant="danger" disabled={busy} onClick={onConfirm}>
            {busy ? 'Läuft …' : action}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Error text for forms: null for a cancelled step-up. */
export function shownError(err: unknown, text: (e: unknown) => string = errorText): string | null {
  if (!err || isApiError(err, 'step_up_required')) return null;
  return text(err);
}
