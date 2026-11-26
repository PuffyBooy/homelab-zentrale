import { agentNameSchema, type EnrollResponse } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { Button, StatusDot } from '@hz/ui';
import { CopyBlock } from '../../components/CopyBlock.js';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { isApiError } from '../../lib/api.js';
import { useServers } from '../../lib/data.js';
import { errorText } from '../../lib/errors.js';
import { formatTime } from '../../lib/format.js';
import { enrollServer, serversKey } from '../../lib/servers.js';
import { useNow } from '../../lib/useNow.js';

export interface EnrollDialogProps {
  open: boolean;
  onClose: () => void;
}

/** SPEC 5.3: name -> one-time token (15 min) -> one-liner -> agent connects live. */
export function EnrollDialog({ open, onClose }: EnrollDialogProps): ReactElement {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Server hinzufügen"
      className="app-dialog-wide hz-dialog-sheet"
      dismissable={false}
    >
      <EnrollBody onClose={onClose} />
    </Dialog>
  );
}

const NAME_HINT = 'Kleinbuchstaben, Ziffern und Bindestrich, z. B. heimserver oder oracle-a1.';

function EnrollBody({ onClose }: { onClose: () => void }): ReactElement {
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [result, setResult] = useState<{ name: string; res: EnrollResponse } | null>(null);
  const qc = useQueryClient();

  const enroll = useMutation({
    mutationFn: enrollServer,
    onSuccess: (res, vars) => {
      setResult({ name: vars.name, res });
      void qc.invalidateQueries({ queryKey: serversKey });
    },
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    const parsed = agentNameSchema.safeParse(name.trim());
    if (!parsed.success) {
      setNameError(name.trim() ? `Name ungültig. ${NAME_HINT}` : 'Name fehlt.');
      return;
    }
    setNameError(null);
    enroll.mutate({ name: parsed.data, location: location.trim() });
  }

  if (result) {
    return (
      <TokenStep
        name={result.name}
        res={result.res}
        onClose={onClose}
        onRenew={() => {
          setResult(null);
          enroll.reset();
        }}
      />
    );
  }

  const conflict = isApiError(enroll.error, 'conflict');
  return (
    <form className="hz-dialog-body" onSubmit={submit} noValidate>
      <p className="hz-dialog-text">
        Der Agent läuft als Docker-Container auf dem Server und verbindet sich über Tailscale mit
        der Zentrale. Danach steht der Server live in der Liste. Das Token erzeugen braucht einen
        frischen Code aus der App.
      </p>
      <Field
        label="Name"
        mono
        value={name}
        onChange={(e) => setName(e.target.value)}
        hint={NAME_HINT}
        error={nameError ?? (conflict ? 'Diesen Namen gibt es schon.' : null)}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={63}
        data-autofocus=""
        required
      />
      <Field
        label="Ort"
        value={location}
        onChange={(e) => setLocation(e.target.value)}
        hint="Optional, z. B. Zuhause oder Frankfurt."
        maxLength={60}
      />
      {enroll.error && !conflict && !isApiError(enroll.error, 'step_up_required') ? (
        <FormError title={errorText(enroll.error)} />
      ) : null}
      <div className="hz-dialog-foot">
        <Button onClick={onClose}>Abbrechen</Button>
        <Button variant="primary" type="submit" disabled={enroll.isPending}>
          Token erzeugen
        </Button>
      </div>
    </form>
  );
}

function TokenStep({
  name,
  res,
  onClose,
  onRenew,
}: {
  name: string;
  res: EnrollResponse;
  onClose: () => void;
  onRenew: () => void;
}): ReactElement {
  const now = useNow(1000);
  const navigate = useNavigate();
  const servers = useServers();
  const server = servers.data?.find((s) => s.name === name);
  const connected = server?.connected === true;
  const expires = new Date(res.expiresAt);
  const leftMin = Math.ceil((expires.getTime() - now.getTime()) / 60_000);
  const expired = leftMin <= 0 && !connected;

  return (
    <div className="hz-dialog-body">
      <div className="app-enroll-state" aria-live="polite">
        {connected ? (
          <StatusDot status="ok" label={`${name} ist verbunden`} />
        ) : expired ? (
          <StatusDot status="off" label="Token abgelaufen" />
        ) : (
          <StatusDot status="busy" label={`Warte auf ${name} …`} />
        )}
      </div>
      {connected ? (
        <p className="hz-dialog-text">
          {name} meldet sich und schickt Messwerte. Du findest ihn jetzt in der Serverliste.
        </p>
      ) : expired ? (
        <p className="hz-dialog-text">
          Das Token ist um {formatTime(expires)} abgelaufen. Erzeug ein neues und starte den Agent
          damit.
        </p>
      ) : (
        <>
          <p className="hz-dialog-text">
            Auf {name} ausführen. Das Token gilt einmal, bis {formatTime(expires)} (noch {leftMin}{' '}
            Min). Es wird nur jetzt angezeigt.
          </p>
          <CopyBlock label="Einzeiler (docker run)" text={res.dockerRun} />
          <CopyBlock label="Oder als Compose-Datei" text={res.compose} />
          <CopyBlock label="Token" text={res.token} inline />
        </>
      )}
      <div className="hz-dialog-foot">
        {expired ? (
          <>
            <Button onClick={onClose}>Schließen</Button>
            <Button variant="primary" onClick={onRenew}>
              Neues Token erzeugen
            </Button>
          </>
        ) : connected && server ? (
          <>
            <Button onClick={onClose}>Schließen</Button>
            <Button
              variant="primary"
              onClick={() => {
                onClose();
                void navigate(`/servers/${server.id}`);
              }}
            >
              Server öffnen
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Schließen</Button>
        )}
      </div>
    </div>
  );
}
