import {
  agentNameSchema,
  ONBOARDING_TTL_MINUTES,
  type EnrollRequest,
  type EnrollResponse,
  type OnboardingCreateResponse,
  type OnboardingState,
} from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button, Metric, StatusDot } from '@hz/ui';
import { CopyBlock } from '../../components/CopyBlock.js';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { isApiError } from '../../lib/api.js';
import { useServers } from '../../lib/data.js';
import { errorText } from '../../lib/errors.js';
import { formatTime } from '../../lib/format.js';
import {
  cancelOnboarding,
  countdown,
  createOnboarding,
  effectiveState,
  fetchOnboarding,
  ONBOARDING_POLL_MS,
  onboardingFinal,
  onboardingKey,
  onboardingView,
} from '../../lib/onboarding.js';
import { enrollServer, serversKey } from '../../lib/servers.js';
import { useNow } from '../../lib/useNow.js';

export interface EnrollDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * "Server hinzufügen" (ROADMAP M11, SPEC 5.3): name -> code (8 characters, 15 Min,
 * one-time) and one-liner -> install.sh starts the agent -> the dialog shows
 * "Verbunden" live. The manual token (M2) stays available as "Manuell (Token)".
 */
export function EnrollDialog({ open, onClose }: EnrollDialogProps): ReactElement {
  // The unused code of the open dialog; closing it (button or Escape) cancels the code.
  const pending = useRef<string | null>(null);
  const close = (): void => {
    const id = pending.current;
    pending.current = null;
    if (id) void cancelOnboarding(id).catch(() => undefined);
    onClose();
  };
  const track = useCallback((id: string | null): void => {
    pending.current = id;
  }, []);
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Server hinzufügen"
      className="app-dialog-wide hz-dialog-sheet"
      dismissable={false}
    >
      <EnrollBody onClose={close} track={track} />
    </Dialog>
  );
}

type Track = (onboardingId: string | null) => void;

const NAME_HINT = 'Kleinbuchstaben, Ziffern und Bindestrich, z. B. heimserver oder oracle-a1.';

function EnrollBody({ onClose, track }: { onClose: () => void; track: Track }): ReactElement {
  const [mode, setMode] = useState<'code' | 'manual'>('code');
  return mode === 'code' ? (
    <CodeFlow onClose={onClose} track={track} onManual={() => setMode('manual')} />
  ) : (
    <ManualFlow onClose={onClose} onCode={() => setMode('code')} />
  );
}

/** Name + location with the same rules for both ways. */
function ServerNameForm({
  intro,
  submitLabel,
  pending,
  error,
  onSubmit,
  onClose,
  switchLabel,
  onSwitch,
}: {
  intro: string;
  submitLabel: string;
  pending: boolean;
  error: unknown;
  onSubmit: (body: EnrollRequest) => void;
  onClose: () => void;
  switchLabel: string;
  onSwitch: () => void;
}): ReactElement {
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);

  function submit(e: FormEvent): void {
    e.preventDefault();
    const parsed = agentNameSchema.safeParse(name.trim());
    if (!parsed.success) {
      setNameError(name.trim() ? `Name ungültig. ${NAME_HINT}` : 'Name fehlt.');
      return;
    }
    setNameError(null);
    onSubmit({ name: parsed.data, location: location.trim() });
  }

  const conflict = isApiError(error, 'conflict');
  return (
    <form className="hz-dialog-body" onSubmit={submit} noValidate>
      <p className="hz-dialog-text">{intro}</p>
      <Field
        label="Name"
        mono
        value={name}
        onChange={(e) => setName(e.target.value)}
        hint={NAME_HINT}
        error={nameError ?? (conflict ? enrollConflictText(error) : null)}
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
      {error && !conflict && !isApiError(error, 'step_up_required') ? (
        <FormError title={errorText(error)} />
      ) : null}
      <div className="hz-dialog-foot">
        <Button variant="ghost" onClick={onSwitch}>
          {switchLabel}
        </Button>
        <Button onClick={onClose}>Abbrechen</Button>
        <Button variant="primary" type="submit" disabled={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** 409: name taken, or (code flow) too many open codes; the core sends the hint then. */
function enrollConflictText(err: unknown): string {
  if (isApiError(err) && err.hint) return err.hint;
  return 'Diesen Namen gibt es schon.';
}

// ---------------------------------------------------------------------------
// Code flow (M11)

function CodeFlow({
  onClose,
  track,
  onManual,
}: {
  onClose: () => void;
  track: Track;
  onManual: () => void;
}): ReactElement {
  const [result, setResult] = useState<OnboardingCreateResponse | null>(null);
  const create = useMutation({ mutationFn: createOnboarding, onSuccess: setResult });

  if (result) {
    return (
      <CodeStep
        key={result.id}
        res={result}
        track={track}
        onClose={onClose}
        onRenew={() => {
          setResult(null);
          create.reset();
        }}
      />
    );
  }
  return (
    <ServerNameForm
      intro={`Die Zentrale zeigt einen Code und einen Einzeiler. Auf dem neuen Server ausgeführt, startet er den Agent, der sich über Tailscale verbindet. Der Code gilt einmal und ${ONBOARDING_TTL_MINUTES} Min. Code erzeugen braucht einen frischen Code aus der App.`}
      submitLabel="Code erzeugen"
      pending={create.isPending}
      error={create.error}
      onSubmit={(body) => create.mutate(body)}
      onClose={onClose}
      switchLabel="Manuell (Token)"
      onSwitch={onManual}
    />
  );
}

/** Polls GET /api/servers/onboarding/:id; a waiting code is cancelled when the dialog closes. */
function CodeStep({
  res,
  track,
  onClose,
  onRenew,
}: {
  res: OnboardingCreateResponse;
  track: Track;
  onClose: () => void;
  onRenew: () => void;
}): ReactElement {
  const now = useNow(1000);
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: onboardingKey(res.id),
    queryFn: ({ signal }) => fetchOnboarding(res.id, signal),
    refetchInterval: (q) =>
      q.state.data && onboardingFinal(q.state.data.state) ? false : ONBOARDING_POLL_MS,
    retry: false,
  });
  const gone = isApiError(status.error, 'not_found');
  const raw: OnboardingState = gone ? 'expired' : (status.data?.state ?? 'waiting');
  const expiresAt = status.data?.expiresAt ?? res.expiresAt;
  const state = effectiveState(raw, expiresAt, now);

  useEffect(() => {
    if (state === 'connected') void qc.invalidateQueries({ queryKey: serversKey });
  }, [state, qc]);

  // While the code is unused, closing the dialog cancels it (see EnrollDialog).
  useEffect(() => track(state === 'waiting' ? res.id : null), [state, res.id, track]);

  return (
    <CodeStepView
      res={res}
      state={state}
      expiresAt={expiresAt}
      serverId={status.data?.serverId ?? null}
      now={now}
      pollError={status.error && !gone ? errorText(status.error) : null}
      onCancel={onClose}
      onClose={onClose}
      onRenew={onRenew}
    />
  );
}

export interface CodeStepViewProps {
  res: OnboardingCreateResponse;
  state: OnboardingState;
  expiresAt: string;
  serverId: string | null;
  now: Date;
  pollError?: string | null;
  onCancel: () => void;
  onClose: () => void;
  onRenew: () => void;
}

/** The four states of the code step (pure, rendered in the unit tests). */
export function CodeStepView({
  res,
  state,
  expiresAt,
  serverId,
  now,
  pollError,
  onCancel,
  onClose,
  onRenew,
}: CodeStepViewProps): ReactElement {
  const view = onboardingView(state);
  const until = formatTime(new Date(expiresAt));
  return (
    <div className="hz-dialog-body" data-testid="onboarding" data-state={state}>
      <div className="app-enroll-state" aria-live="polite">
        <StatusDot status={view.status} label={view.label} />
      </div>
      {state === 'waiting' ? (
        <>
          <Metric
            label={`Code für ${res.name}`}
            value={res.code}
            hint={`noch ${countdown(expiresAt, now)} · gilt einmal, bis ${until}`}
            className="app-onboard-code"
          />
          <CopyBlock label="Auf dem neuen Server ausführen" text={res.oneLiner} />
          <p className="hz-dialog-text">
            Braucht Docker und Tailscale am neuen Server. Der Code wird nur jetzt angezeigt;
            Abbrechen verwirft ihn.
          </p>
        </>
      ) : state === 'installing' ? (
        <p className="hz-dialog-text">
          Code eingelöst. Das Skript holt das Agent-Image und startet den Agent auf {res.name}. Das
          dauert meist unter einer Minute.
        </p>
      ) : state === 'connected' ? (
        <p className="hz-dialog-text">
          {res.name} ist verbunden und schickt Messwerte. Du findest ihn jetzt in der Serverliste.
        </p>
      ) : (
        <p className="hz-dialog-text">
          Der Code für {res.name} ist um {until} abgelaufen oder wurde verworfen. Erzeug einen neuen
          und führ den Einzeiler damit aus.
        </p>
      )}
      {pollError ? <FormError title={pollError} /> : null}
      <div className="hz-dialog-foot">
        {state === 'waiting' ? (
          <Button onClick={onCancel}>Abbrechen</Button>
        ) : state === 'installing' ? (
          <Button onClick={onClose}>Schließen</Button>
        ) : state === 'connected' ? (
          <>
            <Button onClick={onClose}>Schließen</Button>
            {serverId ? (
              <Link
                className="hz-btn hz-btn-primary hz-btn-md"
                to={`/servers/${encodeURIComponent(serverId)}`}
                onClick={onClose}
              >
                <span>Server öffnen</span>
              </Link>
            ) : null}
          </>
        ) : (
          <>
            <Button onClick={onClose}>Schließen</Button>
            <Button variant="primary" onClick={onRenew}>
              Neuen Code
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Manual token (M2), secondary way

function ManualFlow({
  onClose,
  onCode,
}: {
  onClose: () => void;
  onCode: () => void;
}): ReactElement {
  const [result, setResult] = useState<{ name: string; res: EnrollResponse } | null>(null);
  const qc = useQueryClient();

  const enroll = useMutation({
    mutationFn: enrollServer,
    onSuccess: (res, vars) => {
      setResult({ name: vars.name, res });
      void qc.invalidateQueries({ queryKey: serversKey });
    },
  });

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

  return (
    <ServerNameForm
      intro="Manuell: Die Zentrale erzeugt ein Einmal-Token, und du startest den Agent selbst mit docker run oder Compose. Das Token erzeugen braucht einen frischen Code aus der App."
      submitLabel="Token erzeugen"
      pending={enroll.isPending}
      error={enroll.error}
      onSubmit={(body) => enroll.mutate(body)}
      onClose={onClose}
      switchLabel="Mit Code"
      onSwitch={onCode}
    />
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
