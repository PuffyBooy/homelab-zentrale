import { useState, type FormEvent, type ReactElement } from 'react';
import { Button } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { errorText } from '../../lib/errors.js';
import { cpusInput, parseCpus } from '../../lib/throttle.js';
import { useThrottle } from './useThrottle.js';

export interface ThrottleTarget {
  /** Core container id. */
  id: string;
  name: string;
  serverName: string;
}

/** "Drosseln …": CPU share 0,1–64 cores (docker update --cpus). RAM stays as it is. */
export function ThrottleDialog({
  target,
  initialCpus = 1,
  onClose,
}: {
  target: ThrottleTarget;
  initialCpus?: number;
  onClose: () => void;
}): ReactElement {
  return (
    <Dialog open onClose={onClose} title={`${target.name} drosseln`}>
      <ThrottleForm target={target} initialCpus={initialCpus} onClose={onClose} />
    </Dialog>
  );
}

export function ThrottleForm({
  target,
  initialCpus,
  onClose,
}: {
  target: ThrottleTarget;
  initialCpus: number;
  onClose: () => void;
}): ReactElement {
  const [raw, setRaw] = useState(() => cpusInput(initialCpus));
  const [error, setError] = useState<string | null>(null);
  const act = useThrottle();

  function submit(e: FormEvent): void {
    e.preventDefault();
    const res = parseCpus(raw);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    act.mutate({ kind: 'throttle', id: target.id, cpus: res.value }, { onSuccess: onClose });
  }

  return (
    <form className="hz-dialog-body" onSubmit={submit} noValidate>
      <p className="hz-dialog-text">
        Begrenzt die CPU von {target.name} auf {target.serverName}. Das RAM-Limit bleibt gleich. Die
        Drosselung bleibt, bis du sie aufhebst.
      </p>
      <Field
        label="CPU-Anteil (Kerne)"
        mono
        inputMode="decimal"
        value={raw}
        onChange={(e) => {
          setRaw(e.target.value);
          setError(null);
        }}
        hint="0,1 bis 64, z. B. 1 oder 0,5"
        error={error}
        autoComplete="off"
        data-autofocus=""
      />
      {act.error ? <FormError title={errorText(act.error)} /> : null}
      <div className="hz-dialog-foot">
        <Button onClick={onClose}>Abbrechen</Button>
        <Button variant="primary" type="submit" icon="cpu" disabled={act.isPending}>
          {act.isPending ? 'Drosselt …' : 'Drosseln'}
        </Button>
      </div>
    </form>
  );
}

/** "Stoppen" from "Wer frisst gerade?" always asks first (ROADMAP M10). */
export function StopConfirmDialog({
  target,
  isGame,
  onClose,
}: {
  target: ThrottleTarget;
  isGame: boolean;
  onClose: () => void;
}): ReactElement {
  const act = useThrottle();
  return (
    <Dialog open onClose={onClose} title={`${target.name} stoppen?`}>
      <div className="hz-dialog-body">
        <p className="hz-dialog-text">
          {target.name} auf {target.serverName} wird gestoppt und startet nicht von selbst wieder.
          {isGame ? ' Spieler, die gerade online sind, werden getrennt.' : ''}
        </p>
        {act.error ? <FormError title={errorText(act.error)} /> : null}
        <div className="hz-dialog-foot">
          <Button onClick={onClose} data-autofocus="">
            Abbrechen
          </Button>
          <Button
            variant="danger"
            icon="stop"
            disabled={act.isPending}
            onClick={() => act.mutate({ kind: 'stop', id: target.id }, { onSuccess: onClose })}
          >
            {act.isPending ? 'Stoppt …' : 'Stoppen'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
