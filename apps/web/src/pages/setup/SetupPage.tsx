import {
  PASSWORD_MIN,
  passwordSchema,
  totpCodeSchema,
  usernameSchema,
  type SetupStartResponse,
} from '@hz/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { Button, Tile } from '@hz/ui';
import { Brand } from '../../components/Brand.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { RecoveryCodes } from '../../components/RecoveryCodes.js';
import { isApiError } from '../../lib/api.js';
import { authStateKey, fetchAuthState, setupConfirm, setupStart } from '../../lib/auth.js';
import { errorText } from '../../lib/errors.js';
import { groupSecret, setupTokenFromHash, svgDataUrl } from './token.js';

type Step = { n: 1 } | { n: 2; totp: SetupStartResponse } | { n: 3; codes: string[] };

export function SetupPage(): ReactElement {
  const [token] = useState(() => setupTokenFromHash(window.location.hash));
  const [step, setStep] = useState<Step>({ n: 1 });

  useEffect(() => {
    // Keep the one-time token out of the address bar and history.
    if (window.location.hash) {
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }
  }, []);

  return (
    <div className="app-auth">
      <div className="app-auth-col app-auth-wide">
        <Brand />
        <div>
          <div className="app-steps">Einrichtung · Schritt {step.n} von 3</div>
          <h1 className="hz-page-title app-auth-title">
            {step.n === 1
              ? 'Admin-Konto anlegen.'
              : step.n === 2
                ? 'Zweiten Faktor einrichten.'
                : 'Wiederherstellungscodes sichern.'}
          </h1>
        </div>
        {!token ? (
          <FormError
            title="Setup-Link fehlt oder ist unvollständig."
            text="Den vollständigen Link mit #token=… findest du im Log des Core-Containers."
          />
        ) : step.n === 1 ? (
          <AccountStep token={token} onDone={(totp) => setStep({ n: 2, totp })} />
        ) : step.n === 2 ? (
          <TotpStep token={token} totp={step.totp} onDone={(codes) => setStep({ n: 3, codes })} />
        ) : (
          <CodesStep codes={step.codes} />
        )}
      </div>
    </div>
  );
}

function AccountStep({
  token,
  onDone,
}: {
  token: string;
  onDone: (totp: SetupStartResponse) => void;
}): ReactElement {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [errors, setErrors] = useState<{
    username?: string | undefined;
    password?: string | undefined;
    repeat?: string | undefined;
  }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const u = usernameSchema.safeParse(username);
    const p = passwordSchema.safeParse(password);
    const next = {
      username: u.success ? undefined : 'Klein, 2–32 Zeichen: a–z, 0–9, Punkt, Strich.',
      password: p.success ? undefined : `Zu kurz: mindestens ${PASSWORD_MIN} Zeichen.`,
      repeat: password === repeat ? undefined : 'Passwörter stimmen nicht überein.',
    };
    setErrors(next);
    if (!u.success || !p.success || next.repeat) return;
    setBusy(true);
    setFailure(null);
    try {
      onDone(await setupStart({ setupToken: token, username: u.data, password: p.data }));
    } catch (err) {
      setFailure(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Tile title="Konto">
      <form className="hz-form" onSubmit={(e) => void submit(e)} noValidate>
        <Field
          label="Benutzername"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          error={errors.username}
          required
        />
        <Field
          label="Passwort"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint={`Mindestens ${PASSWORD_MIN} Zeichen. Ein Satz aus mehreren Wörtern ist ideal.`}
          error={errors.password}
          required
        />
        <Field
          label="Passwort wiederholen"
          type="password"
          autoComplete="new-password"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
          error={errors.repeat}
          required
        />
        {failure ? <FormError title={failure} /> : null}
        <div className="hz-form-actions">
          <Button variant="primary" type="submit" disabled={busy}>
            Weiter
          </Button>
        </div>
      </form>
    </Tile>
  );
}

function TotpStep({
  token,
  totp,
  onDone,
}: {
  token: string;
  totp: SetupStartResponse;
  onDone: (codes: string[]) => void;
}): ReactElement {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const c = totpCodeSchema.safeParse(code.replace(/\s/g, ''));
    if (!c.success) {
      setError('Code hat 6 Ziffern.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await setupConfirm({ setupToken: token, code: c.data });
      onDone(res.recoveryCodes);
    } catch (err) {
      setError(
        isApiError(err, 'invalid_credentials') || isApiError(err, 'invalid_input')
          ? 'Code stimmt nicht. Uhrzeit am Handy prüfen und den nächsten Code nehmen.'
          : errorText(err),
      );
      setBusy(false);
    }
  }

  return (
    <Tile title="Authenticator-App">
      <p className="app-text">
        QR-Code mit der Authenticator-App scannen (z. B. Aegis, 2FAS, 1Password). Ohne Kamera den
        Schlüssel von Hand eingeben.
      </p>
      <div className="app-qr" data-theme="light">
        <img src={svgDataUrl(totp.qrSvg)} alt="QR-Code für die Authenticator-App" />
      </div>
      <div className="hz-field">
        <span className="hz-field-label">Schlüssel</span>
        <div className="app-secret">
          <code data-testid="totp-secret" data-secret={totp.secret}>
            {groupSecret(totp.secret)}
          </code>
        </div>
      </div>
      <form className="hz-form" onSubmit={(e) => void submit(e)} noValidate>
        <Field
          label="Code aus der App"
          mono
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          error={error}
          required
        />
        <div className="hz-form-actions">
          <Button variant="primary" type="submit" disabled={busy}>
            Bestätigen
          </Button>
        </div>
      </form>
    </Tile>
  );
}

function CodesStep({ codes }: { codes: string[] }): ReactElement {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  async function done(): Promise<void> {
    setBusy(true);
    const state = await queryClient.fetchQuery({
      queryKey: authStateKey,
      queryFn: ({ signal }) => fetchAuthState(signal),
      staleTime: 0,
    });
    await navigate(state.authenticated ? '/' : '/login', { replace: true });
  }

  return (
    <Tile title="Wiederherstellungscodes" count={codes.length}>
      <p className="app-text">
        Jeder Code funktioniert einmal statt des Codes aus der App. Sie werden nur jetzt angezeigt.
        Speichere sie im Passwortmanager oder drucke sie aus.
      </p>
      <RecoveryCodes codes={codes} />
      <div className="hz-form-actions">
        <Button variant="primary" onClick={() => void done()} disabled={busy}>
          Ich habe sie gesichert
        </Button>
      </div>
    </Tile>
  );
}
