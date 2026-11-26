import type { CloudMachine } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Button } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { isApiError } from '../../lib/api.js';
import { cloudKey, deleteMachine } from '../../lib/cloud.js';
import { errorText } from '../../lib/errors.js';
import { deleteConfirmed } from '../../lib/games.js';

/**
 * Danger, confirmed by typing the machine name; the core asks for a code (step-up) and
 * removes every Azure resource of the machine (VM, disk, IP, NIC, NSG).
 */
export function DeleteMachineDialog({
  machine,
  onClose,
}: {
  machine: CloudMachine;
  onClose: () => void;
}): ReactElement {
  const qc = useQueryClient();
  const [typed, setTyped] = useState('');
  const match = deleteConfirmed(typed, machine.name);
  const del = useMutation({
    mutationFn: () => deleteMachine(machine.id, typed.trim()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: cloudKey });
      onClose();
    },
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (match && !del.isPending) del.mutate();
  }

  const err = del.error && !isApiError(del.error, 'step_up_required') ? errorText(del.error) : null;

  return (
    <Dialog open onClose={onClose} title={`${machine.name} löschen`} dismissable={false}>
      <form className="hz-dialog-body" onSubmit={submit} noValidate>
        <p className="hz-dialog-text">
          Die Zentrale löscht bei Azure die VM {machine.name} mit Disk, öffentlicher IP,
          Netzwerkkarte und Firewall-Regeln. Daten auf der Disk sind danach weg. Zum Bestätigen den
          Namen eintippen, danach fragt die Zentrale nach einem Code.
        </p>
        <Field
          label="Name des Servers"
          mono
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={machine.name}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          data-autofocus=""
        />
        {err ? <FormError title={err} /> : null}
        <div className="hz-dialog-foot">
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="danger" type="submit" disabled={!match || del.isPending}>
            {del.isPending ? 'Wird gelöscht …' : 'Löschen'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
