import type { DiscordBinding, DiscordBotState } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { useLocation } from 'react-router';
import { Alert, Badge, Button, Tile } from '@hz/ui';
import { CopyBlock } from '../../components/CopyBlock.js';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import {
  DISCORD_COMMAND_HELP,
  DISCORD_STATUS,
  DISCORD_STATUS_TAG,
  DISCORD_TOKEN_RE,
  discordBotKey,
  discordInviteUrl,
  fetchDiscordBot,
  isSnowflake,
  saveDiscordBinding,
  saveDiscordBot,
  SHARE_STATE_TEXT,
  shownError,
  type DiscordBotPatch,
} from '../../lib/ops.js';

const ID_ERROR = '17 bis 20 Ziffern.';

/**
 * Settings → Discord-Bot (module discordbot): token (write-only), application and guild id,
 * invite link and the Discord user id per share link. Saving the bot settings needs step-up.
 */
export function DiscordBotTile(): ReactElement {
  const bot = useQuery({
    queryKey: discordBotKey,
    queryFn: ({ signal }) => fetchDiscordBot(signal),
    refetchInterval: (q) => (q.state.data?.status === 'connecting' ? 2000 : 30_000),
  });
  const { hash } = useLocation();
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (hash === '#discord-bot' && bot.data) anchor.current?.scrollIntoView({ block: 'start' });
  }, [hash, bot.data]);

  return (
    <div id="discord-bot" ref={anchor} className="app-anchor app-settings-wide">
      {bot.data ? (
        <DiscordBotBody state={bot.data} />
      ) : (
        <Tile title="Discord-Bot" icon="users">
          {bot.isError ? (
            <FormError title={shownError(bot.error) ?? 'Fehler.'} />
          ) : (
            <p className="app-empty">Lade Discord-Bot …</p>
          )}
        </Tile>
      )}
    </div>
  );
}

export function DiscordBotBody({ state }: { state: DiscordBotState }): ReactElement {
  return (
    <div className="app-stack">
      <DiscordSettings state={state} />
      <DiscordBindings bindings={state.bindings} />
    </div>
  );
}

function DiscordSettings({ state }: { state: DiscordBotState }): ReactElement {
  const qc = useQueryClient();
  const [appId, setAppId] = useState(state.applicationId ?? '');
  const [guildId, setGuildId] = useState(state.guildId ?? '');
  const [token, setToken] = useState('');
  const [errors, setErrors] = useState<{ appId?: string; guildId?: string; token?: string }>({});
  const [removing, setRemoving] = useState(false);

  const save = useMutation({
    mutationFn: (body: DiscordBotPatch) => saveDiscordBot(body),
    onSuccess: (next) => {
      setToken('');
      setRemoving(false);
      qc.setQueryData(discordBotKey, next);
      setAppId(next.applicationId ?? '');
      setGuildId(next.guildId ?? '');
    },
  });

  function ids(): { applicationId: string | null; guildId: string | null } | null {
    const next: typeof errors = {};
    const a = appId.trim();
    const g = guildId.trim();
    if (a && !isSnowflake(a)) next.appId = ID_ERROR;
    if (g && !isSnowflake(g)) next.guildId = ID_ERROR;
    setErrors(next);
    if (Object.keys(next).length) return null;
    return { applicationId: a || null, guildId: g || null };
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    const base = ids();
    if (!base) return;
    const t = token.trim();
    if (t && !DISCORD_TOKEN_RE.test(t)) {
      setErrors({ token: 'Das ist kein Bot-Token (Developer Portal → Bot → Reset Token).' });
      return;
    }
    save.mutate(t ? { ...base, token: t } : base);
  }

  const invite = discordInviteUrl(appId);
  const err = shownError(save.error);

  return (
    <Tile
      title="Discord-Bot"
      icon="users"
      status={DISCORD_STATUS[state.status]}
      statusLabel={DISCORD_STATUS_TAG[state.status]}
    >
      <dl className="app-kv">
        <dt>Status</dt>
        <dd data-testid="discord-status">{state.statusText}</dd>
        <dt>Token</dt>
        <dd data-testid="discord-token-state">{state.tokenSet ? 'gespeichert' : 'kein Token'}</dd>
      </dl>
      <ol className="app-howto">
        <li>
          Im Discord Developer Portal eine Application anlegen. Die Application-ID steht unter
          General Information.
        </li>
        <li>Unter Bot einen Token erzeugen (Reset Token) und unten eintragen.</li>
        <li>
          Den Bot mit dem Einladungslink auf deinen Server holen. Die Server-ID bekommst du per
          Rechtsklick auf den Servernamen → Server-ID kopieren (Entwicklermodus nötig).
        </li>
      </ol>
      <form className="hz-form" onSubmit={submit} noValidate>
        <div className="app-fields">
          <Field
            label="Application-ID"
            mono
            inputMode="numeric"
            autoComplete="off"
            maxLength={20}
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            error={errors.appId}
          />
          <Field
            label="Server-ID (Guild)"
            mono
            inputMode="numeric"
            autoComplete="off"
            maxLength={20}
            value={guildId}
            onChange={(e) => setGuildId(e.target.value)}
            hint="Befehle gelten nur auf diesem Server."
            error={errors.guildId}
          />
          <Field
            className="app-fields-wide"
            label={state.tokenSet ? 'Neuer Bot-Token' : 'Bot-Token'}
            mono
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            maxLength={120}
            value={token}
            placeholder={state.tokenSet ? 'gespeichert' : ''}
            onChange={(e) => setToken(e.target.value)}
            hint={
              state.tokenSet
                ? 'Gespeichert. Leer lassen, um ihn zu behalten. Er wird nie wieder angezeigt.'
                : 'Wird verschlüsselt gespeichert und nie wieder angezeigt.'
            }
            error={errors.token}
          />
        </div>
        {invite ? <CopyBlock label="Einladungslink" text={invite} inline /> : null}
        {err && !removing ? <FormError title={err} /> : null}
        {save.isSuccess && !save.isPending ? (
          <Alert tone="ok" title="Gespeichert.">
            Der Bot verbindet sich mit den neuen Einstellungen.
          </Alert>
        ) : null}
        <div className="hz-form-actions">
          {state.tokenSet ? (
            <Button variant="danger" onClick={() => setRemoving(true)}>
              Token löschen
            </Button>
          ) : null}
          <Button type="submit" variant="primary" disabled={save.isPending}>
            Speichern
          </Button>
        </div>
      </form>
      <h3 className="hz-label app-subhead">Befehle</h3>
      <dl className="app-kv" data-testid="discord-commands">
        {DISCORD_COMMAND_HELP.map((c) => (
          <DiscordCommand key={c.cmd} cmd={c.cmd} text={c.text} />
        ))}
      </dl>
      {removing ? (
        <Dialog open onClose={() => setRemoving(false)} title="Bot-Token löschen">
          <div className="hz-dialog-body">
            <p className="hz-dialog-text">
              Der Bot meldet sich von Discord ab. Gebundene Freunde und IDs bleiben gespeichert.
            </p>
            {err ? <FormError title={err} /> : null}
            <div className="hz-dialog-foot">
              <Button onClick={() => setRemoving(false)} data-autofocus="">
                Abbrechen
              </Button>
              <Button
                variant="danger"
                disabled={save.isPending}
                onClick={() =>
                  save.mutate({
                    token: null,
                    applicationId: state.applicationId,
                    guildId: state.guildId,
                  })
                }
              >
                Löschen
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </Tile>
  );
}

function DiscordCommand({ cmd, text }: { cmd: string; text: string }): ReactElement {
  return (
    <>
      <dt className="hz-mono">{cmd}</dt>
      <dd>{text}</dd>
    </>
  );
}

function DiscordBindings({ bindings }: { bindings: DiscordBinding[] }): ReactElement {
  return (
    <Tile title="Freunde" icon="users" count={String(bindings.length)} flush>
      <p className="app-text app-pad">
        Pro Benutzerlink mit Recht Starten/Stoppen oder Neustart. Der Bot erlaubt einem Freund genau
        die Rechte seines Links, solange der Link aktiv ist.
      </p>
      {bindings.length === 0 ? (
        <p className="app-empty app-pad">
          Noch kein passender Benutzerlink. Links legst du beim Gameserver unter „Teilen“ an.
        </p>
      ) : (
        bindings.map((b) => (
          // Keyed by the stored id, so a saved value resets the draft.
          <BindingRow key={`${b.shareId}:${b.discordUserId ?? ''}`} binding={b} />
        ))
      )}
    </Tile>
  );
}

export function BindingRow({ binding }: { binding: DiscordBinding }): ReactElement {
  const qc = useQueryClient();
  const [value, setValue] = useState(binding.discordUserId ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (id: string | null) => saveDiscordBinding(binding.shareId, id),
    onSuccess: (next) => qc.setQueryData(discordBotKey, next),
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    const v = value.trim();
    if (v && !isSnowflake(v)) {
      setError(ID_ERROR);
      return;
    }
    setError(null);
    save.mutate(v || null);
  }

  const dirty = value.trim() !== (binding.discordUserId ?? '');
  const err = error ?? shownError(save.error);
  return (
    <form className="hz-row app-binding" onSubmit={submit} noValidate data-testid="discord-binding">
      <div className="hz-row-main">
        <span className="hz-row-name">{binding.person}</span>
        <span className="hz-row-sub">
          {binding.gameName} · Link {SHARE_STATE_TEXT[binding.shareState]}
        </span>
      </div>
      <div className="hz-row-meta">
        {binding.shareState === 'active' ? (
          binding.discordUserId ? (
            <Badge tone="ok">gebunden</Badge>
          ) : (
            <Badge>nicht gebunden</Badge>
          )
        ) : (
          <Badge tone="warn">wirkt nicht</Badge>
        )}
      </div>
      <div className="app-binding-field">
        <Field
          label={`Discord-User-ID von ${binding.person}`}
          mono
          inputMode="numeric"
          autoComplete="off"
          maxLength={20}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          hint="Rechtsklick auf den Namen → Benutzer-ID kopieren, Entwicklermodus nötig."
          error={err}
        />
      </div>
      <div className="hz-row-actions">
        <Button size="sm" type="submit" disabled={save.isPending || !dirty}>
          Speichern
        </Button>
      </div>
    </form>
  );
}
