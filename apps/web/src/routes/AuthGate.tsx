import { useState, type ReactElement, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { Button } from '@hz/ui';
import { Brand } from '../components/Brand.js';
import { FormError } from '../components/FormError.js';
import { errorText } from '../lib/errors.js';
import { setDisplayTimeZone } from '../lib/format.js';
import { decideGuard, safeReturnPath, type GuardArea } from '../lib/guard.js';
import { useAuthState } from '../lib/useAuthState.js';

interface FromState {
  from?: unknown;
}

/**
 * Routes by GET /api/auth/state: setup required -> /setup, guest -> /login.
 * `sticky` keeps a page once shown (setup must not jump away while codes are on screen).
 */
export function AuthGate({
  area,
  sticky = false,
  children,
}: {
  area: GuardArea;
  sticky?: boolean;
  children: ReactNode;
}): ReactElement {
  const state = useAuthState();
  const location = useLocation();
  const [stuck, setStuck] = useState(false);
  const decision = decideGuard(state.data, area);
  // Before the children render, so every time on the page uses the zone of the core.
  if (state.data?.authenticated) setDisplayTimeZone(state.data.timeZone);

  if (sticky && decision.kind === 'render' && !stuck) setStuck(true);
  if (stuck) return <>{children}</>;

  if (decision.kind === 'render') return <>{children}</>;

  if (decision.kind === 'redirect') {
    if (area === 'login' && decision.to === '/') {
      const from = (location.state as FromState | null)?.from;
      return <Navigate to={safeReturnPath(from)} replace />;
    }
    const keep = area === 'protected' && decision.to === '/login';
    return (
      <Navigate
        to={decision.to}
        replace
        state={keep ? { from: location.pathname + location.search } : undefined}
      />
    );
  }

  if (state.isError) {
    return (
      <div className="app-auth">
        <div className="app-auth-col">
          <Brand />
          <FormError title={errorText(state.error)} />
          <div className="hz-form-actions">
            <Button onClick={() => void state.refetch()}>Erneut versuchen</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-auth" aria-busy={true}>
      <div className="app-auth-col">
        <Brand />
        <p className="app-text" role="status">
          Verbinde mit der Zentrale …
        </p>
      </div>
    </div>
  );
}
