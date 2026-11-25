import { STEP_UP_MINUTES, totpCodeSchema } from '@hz/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { Button } from '@hz/ui';
import { Dialog } from '../components/Dialog.js';
import { Field } from '../components/Field.js';
import { FormError } from '../components/FormError.js';
import { configureApi, isApiError } from '../lib/api.js';
import { authStateKey, stepUp } from '../lib/auth.js';
import { errorText } from '../lib/errors.js';

type Resolve = (ok: boolean) => void;

/** Registers the global API handlers: 401 -> login, step_up_required -> TOTP dialog. */
export function ApiHandlers(): ReactElement {
  const queryClient = useQueryClient();
  const [resolve, setResolve] = useState<Resolve | null>(null);

  const onUnauthorized = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: authStateKey });
  }, [queryClient]);

  const onStepUp = useCallback(() => new Promise<boolean>((r) => setResolve(() => r)), []);

  useEffect(() => configureApi({ onUnauthorized, onStepUp }), [onUnauthorized, onStepUp]);

  const finish = (ok: boolean): void => {
    resolve?.(ok);
    setResolve(null);
    if (ok) void queryClient.invalidateQueries({ queryKey: authStateKey });
  };

  return <StepUpDialog open={resolve !== null} onDone={finish} />;
}

function StepUpDialog({
  open,
  onDone,
}: {
  open: boolean;
  onDone: (ok: boolean) => void;
}): ReactElement {
  return (
    <Dialog
      open={open}
      onClose={() => onDone(false)}
      title="Mit Code bestätigen"
      dismissable={false}
    >
      <StepUpForm onDone={onDone} />
    </Dialog>
  );
}

function StepUpForm({ onDone }: { onDone: (ok: boolean) => void }): ReactElement {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const parsed = totpCodeSchema.safeParse(code.replace(/\s/g, ''));
    if (!parsed.success) {
      setError('Code hat 6 Ziffern.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await stepUp(parsed.data);
      onDone(true);
    } catch (err) {
      setError(isApiError(err, 'invalid_credentials') ? 'Code stimmt nicht.' : errorText(err));
      setBusy(false);
    }
  }

  return (
    <form className="hz-dialog-body" onSubmit={(e) => void submit(e)} noValidate>
      <p className="hz-dialog-text">
        Diese Aktion braucht einen frischen Code aus der Authenticator-App. Danach gilt die
        Bestätigung {STEP_UP_MINUTES} Min.
      </p>
      <Field
        label="Code"
        mono
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={7}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        data-autofocus=""
        required
      />
      {error ? <FormError title={error} /> : null}
      <div className="hz-dialog-foot">
        <Button onClick={() => onDone(false)}>Abbrechen</Button>
        <Button variant="primary" type="submit" disabled={busy}>
          Bestätigen
        </Button>
      </div>
    </form>
  );
}
