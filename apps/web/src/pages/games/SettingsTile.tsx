import type { GameSummary } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent, type ReactElement } from 'react';
import { Alert, Button, Tile } from '@hz/ui';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import {
  gamesKey,
  settingsDraft,
  updateGame,
  validateSettings,
  withoutError,
  type CreateErrors,
  type GameUpdateBody,
  type SettingsDraft,
  type TemplateInfo,
} from '../../lib/games.js';
import { mergeById } from '../../lib/live.js';
import { TemplateFields } from './TemplateFields.js';
import { gameErrorText } from './useGameAction.js';

/** Settings (SPEC 6.3): the same generated form as for "Aufsetzen", saved with a restart. */
export function SettingsTile({
  game,
  tpl,
}: {
  game: GameSummary;
  tpl: TemplateInfo | undefined;
}): ReactElement {
  return (
    <Tile title="Einstellungen" icon="cpu" span={2}>
      {tpl ? (
        <SettingsForm key={game.id} game={game} tpl={tpl} />
      ) : (
        <p className="app-empty">
          Vorlage {game.templateId} fehlt in templates/games/. Ohne sie lassen sich die Werte nicht
          ändern.
        </p>
      )}
    </Tile>
  );
}

function SettingsForm({ game, tpl }: { game: GameSummary; tpl: TemplateInfo }): ReactElement {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<SettingsDraft>(() => settingsDraft(game, tpl));
  const [errors, setErrors] = useState<CreateErrors>({});
  const formRef = useRef<HTMLFormElement>(null);
  const save = useMutation({
    mutationFn: (body: GameUpdateBody) => updateGame(game.id, body),
    onSuccess: (saved) => {
      qc.setQueryData<GameSummary[]>(gamesKey, (old) => (old ? mergeById(old, [saved]) : old));
      setDraft((d) => ({ ...d, externalAddress: saved.externalAddress }));
    },
  });

  function clear(key: string): void {
    setErrors((e) => withoutError(e, key));
    save.reset();
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    const res = validateSettings(tpl, draft);
    if (!res.ok) {
      setErrors(res.errors);
      requestAnimationFrame(() =>
        formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
      return;
    }
    save.mutate(res.body);
  }

  const fieldErrors: Record<string, string> = {};
  for (const [k, v] of Object.entries(errors)) {
    if (k.startsWith('field:')) fieldErrors[k.slice(6)] = v;
  }

  return (
    <form ref={formRef} className="hz-form" onSubmit={submit} noValidate>
      <TemplateFields
        fields={tpl.fields}
        draft={draft.fields}
        errors={fieldErrors}
        onChange={(key, value) => {
          setDraft((d) => ({ ...d, fields: { ...d.fields, [key]: value } }));
          clear(`field:${key}`);
        }}
      />
      <div className="app-fields">
        <Field
          label="Auto-Stopp (Minuten ohne Spieler)"
          mono
          inputMode="numeric"
          value={draft.autoStopMinutes}
          onChange={(e) => {
            const v = e.target.value;
            setDraft((d) => ({ ...d, autoStopMinutes: v }));
            clear('autoStopMinutes');
          }}
          hint="0 = nie automatisch stoppen"
          error={errors.autoStopMinutes}
          autoComplete="off"
        />
        <Field
          label="Externe Adresse"
          mono
          value={draft.externalAddress}
          onChange={(e) => {
            const v = e.target.value;
            setDraft((d) => ({ ...d, externalAddress: v }));
            clear('externalAddress');
          }}
          placeholder="mc.hoebe.at"
          hint="Leer: die Tailscale-IP des Servers. Für Freunde: DDNS-Name oder öffentliche IP."
          error={errors.externalAddress}
          maxLength={253}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
      </div>
      {save.error ? <FormError title={gameErrorText(save.error)} /> : null}
      {save.isSuccess ? (
        <Alert tone="ok" title="Gespeichert.">
          {game.name} startet mit den neuen Werten neu.
        </Alert>
      ) : null}
      <div className="hz-form-actions">
        <Button type="submit" icon="refresh" disabled={save.isPending || game.status === 'busy'}>
          {save.isPending ? 'Speichert …' : 'Speichern und neu starten'}
        </Button>
      </div>
    </form>
  );
}
