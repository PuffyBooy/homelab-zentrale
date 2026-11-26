import type { ProxmoxAction, ProxmoxGuest } from '@hz/shared';
import type { ReactElement } from 'react';
import { Button } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { FormError } from '../../components/FormError.js';
import { ACTION_LABEL, TYPE_LABEL, confirmText } from '../../lib/proxmox.js';

export interface GuestActionDialogProps {
  guest: ProxmoxGuest;
  action: Exclude<ProxmoxAction, 'start'>;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

const QUESTION: Record<GuestActionDialogProps['action'], string> = {
  shutdown: 'herunterfahren',
  stop: 'hart stoppen',
  reboot: 'neu starten',
};

/**
 * Herunterfahren, Stoppen, Neu starten (SPEC 16): confirm first, then the request goes
 * out with `confirm: true`. Step-up comes from lib/api (the code dialog of the shell).
 */
export function GuestActionDialog({
  guest,
  action,
  busy,
  error,
  onConfirm,
  onClose,
}: GuestActionDialogProps): ReactElement {
  return (
    <Dialog open onClose={onClose} title={`${guest.name} ${QUESTION[action]}?`} dismissable={!busy}>
      <div className="hz-dialog-body">
        <p className="hz-dialog-text">{confirmText(guest, action)}</p>
        <dl className="app-kv">
          <dt>VMID</dt>
          <dd>{guest.vmid}</dd>
          <dt>Typ</dt>
          <dd>{TYPE_LABEL[guest.type]}</dd>
          <dt>Knoten</dt>
          <dd>{guest.node}</dd>
        </dl>
        <p className="hz-dialog-text">Dafür ist ein frischer Code aus der App nötig.</p>
        {error ? <FormError title={error} /> : null}
        <div className="hz-dialog-foot">
          <Button onClick={onClose} data-autofocus="">
            Abbrechen
          </Button>
          <Button
            variant="danger"
            icon={action === 'reboot' ? 'refresh' : action === 'stop' ? 'stop' : 'power'}
            disabled={busy}
            onClick={onConfirm}
          >
            {ACTION_LABEL[action]}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
