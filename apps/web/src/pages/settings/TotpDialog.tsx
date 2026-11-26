import { totpCodeSchema } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { Button } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { isApiError } from '../../lib/api.js';
import { sessionsKey } from '../../lib/auth.js';
import { errorText } from '../../lib/errors.js';
import { confirmTotpSetup, startTotpSetup } from '../../lib/settings.js';
import { groupSecret, svgDataUrl } from '../setup/token.js';

/**
 * Konto → TOTP neu einrichten: new secret, scan, confirm with a code of the NEW secret.
 * The old secret stays valid until the confirm. Both steps need step-up (api() asks).
 */
export function TotpDialog({ onClose }: { onClose: (changed: boolean) => void }): ReactElement {
  const qc = useQueryClient();
  const start = useMutation({ mutationFn: startTotpSetup });
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const confirm = useMutation({
    mutationFn: confirmTotpSetup,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: sessionsKey });
      onClose(true);
    },
  });
  const started = useRef(false);
  const begin = start.mutate;
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    begin();
  }, [begin]);

  function submit(e: FormEvent): void {
    e.preventDefault();
    const parsed = totpCodeSchema.safeParse(code.replace(/\s/g, ''));
    if (!parsed.success) {
      setCodeError('Code hat 6 Ziffern.');
      return;
    }
    setCodeError(null);
    confirm.mutate(parsed.data);
  }

  const startError =
    start.error && !isApiError(start.error, 'step_up_required') ? errorText(start.error) : null;
  const confirmError = confirm.error
    ? isApiError(confirm.error, 'invalid_credentials')
      ? 'Code stimmt nicht. Den Code des neuen Eintrags in der App nehmen.'
      : isApiError(confirm.error, 'step_up_required')
        ? null
        : errorText(confirm.error)
    : null;
  const t = start.data;

  return (
    <Dialog open onClose={() => onClose(false)} title="TOTP neu einrichten" dismissable={false}>
      <div className="hz-dialog-body">
        {startError ? <FormError title={startError} /> : null}
        {start.isError && !startError ? (
          <p className="hz-dialog-text">Ohne Code aus der App geht das nicht.</p>
        ) : null}
        {!t && start.isPending ? (
          <p className="hz-dialog-text" role="status">
            Erzeuge neuen Schlüssel …
          </p>
        ) : null}
        {t ? (
          <>
            <p className="hz-dialog-text">
              Neuen Eintrag in der Authenticator-App anlegen. Der alte Code gilt, bis du hier
              bestätigst. Danach sind alle anderen Sitzungen abgemeldet.
            </p>
            <div className="app-qr" data-theme="light">
              <img src={svgDataUrl(t.qrSvg)} alt="QR-Code für die Authenticator-App" />
            </div>
            <div className="hz-field">
              <span className="hz-field-label">Schlüssel</span>
              <div className="app-secret">
                <code>{groupSecret(t.secret)}</code>
              </div>
            </div>
            <form className="hz-form" onSubmit={submit} noValidate>
              <Field
                label="Code aus dem neuen Eintrag"
                mono
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                error={codeError}
                data-autofocus=""
              />
              {confirmError ? <FormError title={confirmError} /> : null}
              <div className="hz-dialog-foot">
                <Button onClick={() => onClose(false)}>Abbrechen</Button>
                <Button variant="primary" type="submit" disabled={confirm.isPending}>
                  Bestätigen
                </Button>
              </div>
            </form>
          </>
        ) : (
          <div className="hz-dialog-foot">
            <Button onClick={() => onClose(false)} data-autofocus="">
              Schließen
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
