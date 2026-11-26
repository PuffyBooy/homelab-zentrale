import type { VoiceGame } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { Link, useLocation } from 'react-router';
import { Alert, Button, Tile, Toggle } from '@hz/ui';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { formatAgo, formatWhen } from '../../lib/format.js';
import {
  fetchVoice,
  isStatusEntity,
  isSwitchEntity,
  saveVoiceGame,
  shownError,
  voiceKey,
} from '../../lib/ops.js';

/**
 * Settings → Sprachsteuerung (module voice): one HA helper switch (and an optional status
 * text) per game server. The hub only talks to Home Assistant; Alexa reaches HA, never the
 * hub. Changing the switch entity needs step-up (api() asks and retries).
 */
export function VoiceTile(): ReactElement {
  const voice = useQuery({ queryKey: voiceKey, queryFn: ({ signal }) => fetchVoice(signal) });
  const { hash } = useLocation();
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (hash === '#sprachsteuerung' && voice.data)
      anchor.current?.scrollIntoView({ block: 'start' });
  }, [hash, voice.data]);
  const v = voice.data;

  return (
    <div id="sprachsteuerung" ref={anchor} className="app-anchor app-settings-wide">
      <Tile
        title="Sprachsteuerung (Echo Show / Alexa)"
        icon="home"
        status={v ? (v.haReady ? 'ok' : 'off') : undefined}
        statusLabel={v ? (v.haReady ? 'HA verbunden' : 'HA fehlt') : undefined}
        flush
      >
        <div className="app-pad app-stack">
          {voice.isError && !v ? <FormError title={shownError(voice.error) ?? 'Fehler.'} /> : null}
          {v && !v.haReady ? (
            <Alert tone="warn" title="Home Assistant ist nicht verbunden.">
              Die Sprachsteuerung läuft über Home Assistant.{' '}
              <Link to="/settings#ha">Einstellungen → Home Assistant</Link>
            </Alert>
          ) : null}
          <ol className="app-howto">
            <li>
              In Home Assistant pro Gameserver zwei Helfer anlegen: einen Schalter (input_boolean)
              und einen Text (input_text, optional).
            </li>
            <li>
              Den Schalter per Nabu Casa oder emulated_hue an Alexa freigeben. Dann reicht „Alexa,
              schalte Minecraft ein“.
            </li>
            <li>Auf der Echo Show das HA-Dashboard im Silk-Browser öffnen, dort steht der Text.</li>
            <li>
              Die Zentrale selbst bleibt nur über Tailscale erreichbar. Alexa spricht nur mit Home
              Assistant.
            </li>
          </ol>
        </div>
        {v ? (
          v.games.length === 0 ? (
            <p className="app-empty app-pad">Noch kein Gameserver angelegt.</p>
          ) : (
            v.games.map((g) => (
              <VoiceGameRow
                // Keyed by the stored values, so a saved row resets its draft.
                key={`${g.gameId}:${g.switchEntity ?? ''}:${g.statusEntity ?? ''}:${String(g.allowStop)}`}
                game={g}
              />
            ))
          )
        ) : voice.isPending ? (
          <p className="app-empty app-pad">Lade Sprachsteuerung …</p>
        ) : null}
      </Tile>
    </div>
  );
}

/** "Minecraft Java" -> "minecraft_java", for the placeholders. */
export function entitySlug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
  return s || 'spiel';
}

export function VoiceGameRow({
  game,
  disabled = false,
}: {
  game: VoiceGame;
  disabled?: boolean;
}): ReactElement {
  const qc = useQueryClient();
  const [sw, setSw] = useState(game.switchEntity ?? '');
  const [st, setSt] = useState(game.statusEntity ?? '');
  const [allowStop, setAllowStop] = useState(game.allowStop);
  const [errors, setErrors] = useState<{ sw?: string; st?: string }>({});
  const save = useMutation({
    mutationFn: () =>
      saveVoiceGame(game.gameId, {
        switchEntity: sw.trim() || null,
        statusEntity: st.trim() || null,
        allowStop,
      }),
    onSuccess: (next) => qc.setQueryData(voiceKey, next),
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    const next: typeof errors = {};
    if (sw.trim() && !isSwitchEntity(sw.trim()))
      next.sw = 'Nur input_boolean.…, z. B. input_boolean.minecraft.';
    if (st.trim() && !isStatusEntity(st.trim()))
      next.st = 'Nur input_text.…, z. B. input_text.minecraft_status.';
    setErrors(next);
    if (Object.keys(next).length) return;
    save.mutate();
  }

  const dirty =
    sw.trim() !== (game.switchEntity ?? '') ||
    st.trim() !== (game.statusEntity ?? '') ||
    allowStop !== game.allowStop;
  const err = shownError(save.error);
  const slug = entitySlug(game.gameName);

  return (
    <form className="app-voice-game app-pad" onSubmit={submit} noValidate data-testid="voice-game">
      <div className="hz-row-main">
        <span className="hz-row-name">{game.gameName}</span>
        <span className="hz-row-sub">
          zuletzt ausgelöst{' '}
          {game.lastTriggerAt
            ? `${formatWhen(new Date(game.lastTriggerAt))} · ${formatAgo(new Date(game.lastTriggerAt))}`
            : 'noch nie'}
        </span>
      </div>
      <div className="app-fields">
        <Field
          label="Schalter"
          mono
          autoComplete="off"
          spellCheck={false}
          maxLength={80}
          placeholder={`input_boolean.${slug}`}
          value={sw}
          disabled={disabled}
          onChange={(e) => setSw(e.target.value)}
          hint="An startet, aus stoppt. Ändern braucht einen Code."
          error={errors.sw}
        />
        <Field
          label="Status-Text (optional)"
          mono
          autoComplete="off"
          spellCheck={false}
          maxLength={80}
          placeholder={`input_text.${slug}_status`}
          value={st}
          disabled={disabled}
          onChange={(e) => setSt(e.target.value)}
          hint="Die Zentrale schreibt z. B. „Läuft, 3 Spieler“."
          error={errors.st}
        />
      </div>
      <Toggle
        label="Alexa darf stoppen"
        hint={allowStop ? 'an · Schalter aus stoppt den Gameserver' : 'aus · nur starten'}
        checked={allowStop}
        disabled={disabled}
        onChange={setAllowStop}
      />
      {err ? <FormError title={err} /> : null}
      <div className="hz-form-actions">
        <Button type="submit" size="sm" disabled={disabled || save.isPending || !dirty}>
          Speichern
        </Button>
      </div>
    </form>
  );
}
