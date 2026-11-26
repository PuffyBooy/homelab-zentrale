import type { SessionInfo } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { Badge, Button, Tile } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { RecoveryCodes } from '../../components/RecoveryCodes.js';
import { isApiError } from '../../lib/api.js';
import {
  authStateKey,
  fetchSessions,
  logout,
  regenerateRecoveryCodes,
  revokeSession,
  sessionsKey,
} from '../../lib/auth.js';
import { errorText } from '../../lib/errors.js';
import { describeUserAgent, formatAgo, formatDateTime, formatTime } from '../../lib/format.js';
import { useAuthState } from '../../lib/useAuthState.js';
import { GithubTile } from './GithubTiles.js';
import { NotifyTile, PushTile } from './PushTiles.js';

export function SettingsPage(): ReactElement {
  return (
    <div className="app-settings">
      <AccountTile />
      <SessionsTile />
      <RecoveryTile />
      <PushTile />
      <NotifyTile />
      <GithubTile />
    </div>
  );
}

function AccountTile(): ReactElement {
  const { data } = useAuthState();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const out = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
      queryClient.setQueryData(authStateKey, { setupRequired: false, authenticated: false });
    },
    onError: (err) => setError(errorText(err)),
  });
  // The core only sends stepUpUntil while step-up is active.
  const stepUpUntil = data?.stepUpUntil ? new Date(data.stepUpUntil) : null;

  return (
    <Tile title="Konto" icon="users">
      <dl className="app-kv">
        <dt>Benutzer</dt>
        <dd>{data?.username ?? '—'}</dd>
        <dt>Zweiter Faktor</dt>
        <dd>TOTP aktiv</dd>
        <dt>Bestätigung</dt>
        <dd>{stepUpUntil ? `gültig bis ${formatTime(stepUpUntil)}` : 'keine aktiv'}</dd>
      </dl>
      {error ? <FormError title={error} /> : null}
      <div className="hz-form-actions">
        <Button icon="door" onClick={() => out.mutate()} disabled={out.isPending}>
          Abmelden
        </Button>
      </div>
    </Tile>
  );
}

function SessionsTile(): ReactElement {
  const queryClient = useQueryClient();
  const sessions = useQuery({
    queryKey: sessionsKey,
    queryFn: ({ signal }) => fetchSessions(signal),
  });
  const [error, setError] = useState<string | null>(null);
  const revoke = useMutation({
    mutationFn: revokeSession,
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: sessionsKey });
    },
    onError: (err) => {
      if (!isApiError(err, 'step_up_required')) setError(errorText(err));
    },
  });
  const list = sessions.data?.sessions ?? [];

  return (
    <Tile
      title="Aktive Sitzungen"
      icon="lock"
      count={sessions.data ? list.length : undefined}
      flush
    >
      {sessions.isError ? (
        <div className="app-pad">
          <FormError title={errorText(sessions.error)} />
        </div>
      ) : sessions.isPending ? (
        <p className="app-empty app-pad">Lade Sitzungen …</p>
      ) : (
        list.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            busy={revoke.isPending && revoke.variables === s.id}
            onRevoke={() => revoke.mutate(s.id)}
          />
        ))
      )}
      {error ? (
        <div className="app-pad">
          <FormError title={error} />
        </div>
      ) : null}
    </Tile>
  );
}

function SessionRow({
  session,
  busy,
  onRevoke,
}: {
  session: SessionInfo;
  busy: boolean;
  onRevoke: () => void;
}): ReactElement {
  const name = describeUserAgent(session.userAgent);
  return (
    <div className="hz-row" data-testid="session-row">
      <div className="hz-row-main">
        <span className="hz-row-name">{name}</span>
        <span className="hz-row-sub">
          seit {formatDateTime(new Date(session.createdAt))} · zuletzt{' '}
          {formatAgo(new Date(session.lastSeen))}
        </span>
      </div>
      <div className="hz-row-meta">{session.current ? <Badge>diese Sitzung</Badge> : null}</div>
      <div className="hz-row-actions">
        {session.current ? null : (
          <Button size="sm" variant="ghost" onClick={onRevoke} disabled={busy}>
            Widerrufen
          </Button>
        )}
      </div>
    </div>
  );
}

function RecoveryTile(): ReactElement {
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const regen = useMutation({
    mutationFn: regenerateRecoveryCodes,
    onSuccess: (res) => {
      setError(null);
      setCodes(res.recoveryCodes);
    },
    onError: (err) => setError(errorText(err)),
  });

  return (
    <Tile title="Wiederherstellungscodes" icon="refresh">
      {codes ? (
        <>
          <p className="app-text">
            Neue Codes. Die alten gelten ab sofort nicht mehr. Sie werden nur jetzt angezeigt.
          </p>
          <RecoveryCodes codes={codes} />
          <div className="hz-form-actions">
            <Button variant="primary" onClick={() => setCodes(null)}>
              Ich habe sie gesichert
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="app-text">
            Neue Codes ersetzen alle bisherigen. Dafür ist ein frischer Code aus der App nötig.
          </p>
          {error ? <FormError title={error} /> : null}
          <div className="hz-form-actions">
            <Button onClick={() => regen.mutate()} disabled={regen.isPending}>
              Neu erzeugen
            </Button>
          </div>
        </>
      )}
    </Tile>
  );
}
