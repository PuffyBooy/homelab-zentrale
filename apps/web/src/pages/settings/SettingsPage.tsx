import type { ModuleId, SessionInfo } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { PASSWORD_MIN } from '@hz/shared';
import { Alert, Badge, Button, Tile } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
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
import { changePassword } from '../../lib/settings.js';
import { useAuthState } from '../../lib/useAuthState.js';
import { BackupTile } from './BackupTile.js';
import { ChecksSettingsTile } from './ChecksSettingsTile.js';
import { AgentsSettingsTile, ServersSettingsTile } from './ServerSettingsTiles.js';
import { TotpDialog } from './TotpDialog.js';
import { WallDevicesTile } from './WallDevicesTile.js';
import { GithubTile } from './GithubTiles.js';
import { HaEntitiesTile, HaSettingsTile } from './HaTiles.js';
import { NotifyTile, PushTile } from './PushTiles.js';
import { ShareGatewayTile } from './ShareGatewayTile.js';
import { ModulesTile } from './ModulesTile.js';
import { UpdatesSettingsTile } from './UpdatesSettingsTile.js';
import { DiscordBotTile } from './DiscordBotTile.js';
import { VoiceTile } from './VoiceTile.js';
import { enabledIntegrations, IntegrationTiles } from './IntegrationTiles.js';
import { NotifyChannelsTile } from './NotifyChannelsTile.js';
import { useModules } from '../../lib/useModules.js';

/** Sections of SPEC 13, in that order. Ids are the anchors (`/settings#server`). */
export const SETTINGS_SECTIONS: readonly {
  id: string;
  label: string;
  module?: ModuleId;
  /** Shown while at least one of these modules is on. */
  anyModule?: readonly ModuleId[];
}[] = [
  { id: 'konto', label: 'Konto' },
  { id: 'module', label: 'Module' },
  { id: 'server', label: 'Server' },
  { id: 'agents', label: 'Agents' },
  { id: 'updates', label: 'Updates' },
  { id: 'github', label: 'GitHub', module: 'github' },
  { id: 'checks', label: 'Checks' },
  { id: 'push', label: 'Push' },
  { id: 'meldungskanaele', label: 'Meldungskanäle' },
  { id: 'ha', label: 'Home Assistant', module: 'homeassistant' },
  { id: 'sprachsteuerung', label: 'Sprachsteuerung', module: 'voice' },
  {
    id: 'anbindungen',
    label: 'Anbindungen',
    anyModule: ['proxmox', 'dnsfilter', 'fritzbox', 'uptimekuma'],
  },
  { id: 'wandmodus', label: 'Wandmodus' },
  { id: 'share-gateway', label: 'Share-Gateway', module: 'games' },
  { id: 'discord-bot', label: 'Discord-Bot', module: 'discordbot' },
  { id: 'backup', label: 'Backup' },
];

function Anchor({
  id,
  wide = false,
  children,
}: {
  id: string;
  wide?: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <div id={id} className={wide ? 'app-anchor app-settings-wide' : 'app-anchor'}>
      {children}
    </div>
  );
}

export function SettingsPage(): ReactElement {
  const { hash } = useLocation();
  const modules = useModules();
  // Tiles with their own anchor (github, ha, share-gateway) scroll themselves once loaded.
  useEffect(() => {
    const id = decodeURIComponent(hash.slice(1));
    if (!id || id.startsWith('anbindung-')) return;
    const section = SETTINGS_SECTIONS.find((s) => s.id === id);
    if (section?.module && modules[section.module]) return;
    document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, [hash, modules]);

  return (
    <>
      <nav className="app-settings-nav" aria-label="Bereiche der Einstellungen">
        {SETTINGS_SECTIONS.filter(
          (s) =>
            (!s.module || modules[s.module]) &&
            (!s.anyModule || s.anyModule.some((m) => modules[m])),
        ).map((s) => (
          <a key={s.id} href={`#${s.id}`} className="app-settings-link">
            {s.label}
          </a>
        ))}
      </nav>
      <div className="app-settings">
        <Anchor id="konto">
          <AccountTile />
        </Anchor>
        <SessionsTile />
        <RecoveryTile />
        <Anchor id="module">
          <ModulesTile />
        </Anchor>
        <Anchor id="server">
          <ServersSettingsTile />
        </Anchor>
        <Anchor id="agents">
          <AgentsSettingsTile />
        </Anchor>
        <Anchor id="updates" wide>
          <UpdatesSettingsTile />
        </Anchor>
        {modules.github ? <GithubTile /> : null}
        <Anchor id="checks">
          <ChecksSettingsTile />
        </Anchor>
        <Anchor id="push">
          <PushTile />
        </Anchor>
        <NotifyTile />
        <Anchor id="meldungskanaele">
          <NotifyChannelsTile />
        </Anchor>
        {modules.homeassistant ? (
          <>
            <HaSettingsTile />
            <HaEntitiesTile />
          </>
        ) : null}
        {modules.voice ? <VoiceTile /> : null}
        {enabledIntegrations(modules).length ? (
          <>
            <div id="anbindungen" className="app-anchor app-settings-wide app-settings-group">
              <h2 className="hz-label">Anbindungen</h2>
              <p className="app-text">
                Systeme im LAN oder Tailnet. Zugangsdaten werden verschlüsselt gespeichert und nie
                wieder angezeigt. Ändern braucht einen Code.
              </p>
            </div>
            <IntegrationTiles modules={modules} />
          </>
        ) : null}
        {/* Wide: each device row has a pairing badge and two actions. */}
        <Anchor id="wandmodus" wide>
          <WallDevicesTile />
        </Anchor>
        {modules.games ? <ShareGatewayTile /> : null}
        {modules.discordbot ? <DiscordBotTile /> : null}
        <Anchor id="backup">
          <BackupTile />
        </Anchor>
      </div>
    </>
  );
}

function AccountTile(): ReactElement {
  const { data } = useAuthState();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pwOpen, setPwOpen] = useState(false);
  const [pwDone, setPwDone] = useState(false);
  const [totpOpen, setTotpOpen] = useState(false);
  const [totpDone, setTotpDone] = useState(false);
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
      {pwDone ? (
        <Alert tone="ok" title="Passwort geändert.">
          Alle anderen Sitzungen sind abgemeldet.
        </Alert>
      ) : null}
      {totpDone ? (
        <Alert tone="ok" title="TOTP neu eingerichtet.">
          Ab jetzt gilt nur noch der neue Eintrag in der App. Alle anderen Sitzungen sind
          abgemeldet.
        </Alert>
      ) : null}
      <div className="hz-form-actions">
        <Button icon="door" onClick={() => out.mutate()} disabled={out.isPending}>
          Abmelden
        </Button>
        <Button icon="lock" onClick={() => setPwOpen(true)}>
          Passwort ändern
        </Button>
        <Button icon="refresh" onClick={() => setTotpOpen(true)}>
          TOTP neu einrichten
        </Button>
      </div>
      {totpOpen ? (
        <TotpDialog
          onClose={(changed) => {
            setTotpOpen(false);
            if (changed) setTotpDone(true);
          }}
        />
      ) : null}
      {pwOpen ? (
        <PasswordDialog
          onClose={(changed) => {
            setPwOpen(false);
            if (changed) setPwDone(true);
          }}
        />
      ) : null}
    </Tile>
  );
}

function PasswordDialog({ onClose }: { onClose: (changed: boolean) => void }): ReactElement {
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: () => changePassword(current, next),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sessionsKey });
      onClose(true);
    },
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (next.length < PASSWORD_MIN) {
      setFieldError(`Mindestens ${PASSWORD_MIN} Zeichen.`);
      return;
    }
    if (next !== repeat) {
      setFieldError('Die beiden Passwörter sind nicht gleich.');
      return;
    }
    setFieldError(null);
    change.mutate();
  }

  const err =
    change.error && !isApiError(change.error, 'step_up_required')
      ? isApiError(change.error, 'invalid_credentials')
        ? 'Aktuelles Passwort stimmt nicht.'
        : errorText(change.error)
      : null;

  return (
    <Dialog open onClose={() => onClose(false)} title="Passwort ändern">
      <form className="hz-dialog-body" onSubmit={submit} noValidate>
        <p className="hz-dialog-text">
          Danach sind alle anderen Sitzungen abgemeldet. Dafür ist ein frischer Code aus der App
          nötig.
        </p>
        <Field
          label="Aktuelles Passwort"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          data-autofocus=""
        />
        <Field
          label="Neues Passwort"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          hint={`Mindestens ${PASSWORD_MIN} Zeichen.`}
        />
        <Field
          label="Neues Passwort wiederholen"
          type="password"
          autoComplete="new-password"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
          error={fieldError}
        />
        {err ? <FormError title={err} /> : null}
        <div className="hz-dialog-foot">
          <Button onClick={() => onClose(false)}>Abbrechen</Button>
          <Button variant="primary" type="submit" disabled={change.isPending || !current || !next}>
            Ändern
          </Button>
        </div>
      </form>
    </Dialog>
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
