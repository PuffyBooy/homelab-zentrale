import { secondFactorSchema, usernameSchema } from '@hz/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Button, Tile } from '@hz/ui';
import { Brand } from '../../components/Brand.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { authStateKey, login } from '../../lib/auth.js';
import { errorText } from '../../lib/errors.js';

interface Errors {
  username?: string | undefined;
  password?: string | undefined;
  code?: string | undefined;
}

export function LoginPage(): ReactElement {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const u = usernameSchema.safeParse(username);
    const c = secondFactorSchema.safeParse(code.replace(/\s/g, ''));
    const next: Errors = {
      username: u.success ? undefined : 'Benutzername prüfen.',
      password: password ? undefined : 'Passwort fehlt.',
      code: c.success
        ? undefined
        : '6 Ziffern aus der App oder ein Wiederherstellungscode (xxxxx-xxxxx).',
    };
    setErrors(next);
    if (!u.success || !c.success || next.password) return;
    setBusy(true);
    setFailure(null);
    try {
      const state = await login({ username: u.data, password, code: c.data });
      // The guard sends us on once the state says "authenticated".
      queryClient.setQueryData(authStateKey, state);
    } catch (err) {
      setFailure(errorText(err));
      setPassword('');
      setCode('');
      setBusy(false);
    }
  }

  return (
    <div className="app-auth">
      <div className="app-auth-col">
        <Brand />
        <h1 className="hz-page-title app-auth-title">Anmelden.</h1>
        <Tile title="Homelab-Zentrale" icon="lock">
          <form className="hz-form" onSubmit={(e) => void submit(e)} noValidate>
            <Field
              label="Benutzername"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              error={errors.username}
              autoFocus
              required
            />
            <Field
              label="Passwort"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={errors.password}
              required
            />
            <Field
              label="Code"
              mono
              autoComplete="one-time-code"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={11}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              hint="Aus der Authenticator-App oder ein Wiederherstellungscode."
              error={errors.code}
              required
            />
            {failure ? <FormError title={failure} /> : null}
            <div className="hz-form-actions">
              <Button variant="primary" type="submit" disabled={busy}>
                Anmelden
              </Button>
            </div>
          </form>
        </Tile>
      </div>
    </div>
  );
}
