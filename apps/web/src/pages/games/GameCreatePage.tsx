import type { GameSummary, ServerSummary } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Alert, Button, GameTemplates, Tile } from '@hz/ui';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { SelectField } from '../../components/SelectField.js';
import { useGames, useServers, useTemplates } from '../../lib/data.js';
import { errorText } from '../../lib/errors.js';
import { formatBytes, plural } from '../../lib/format.js';
import {
  createGame,
  emptyCreateDraft,
  fetchSuggest,
  gamesKey,
  parseNumber,
  portLabel,
  protocolText,
  ramBytesOf,
  ramRange,
  suggestKey,
  suggestName,
  validateCreate,
  withoutError,
  type CreateDraft,
  type CreateErrors,
  type GameCreateBody,
  type TemplateInfo,
} from '../../lib/games.js';
import { mergeById } from '../../lib/live.js';
import { suggestRamText } from '../../lib/throttle.js';
import { ForwardHint } from './ForwardHint.js';
import { TemplateFields } from './TemplateFields.js';
import { gameErrorText } from './useGameAction.js';

const TEMPLATE_PARAM = 'vorlage';

/** /games/new (SPEC 6.2): pick a template, then the generated form, then "Aufsetzen". */
export function GameCreatePage(): ReactElement | null {
  const templates = useTemplates();
  const servers = useServers();
  const [params, setParams] = useSearchParams();
  const picked = params.get(TEMPLATE_PARAM);
  const tpl = templates.data?.find((t) => t.id === picked);

  const pick = (id: string | null): void => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set(TEMPLATE_PARAM, id);
        else next.delete(TEMPLATE_PARAM);
        return next;
      },
      { replace: false },
    );
  };

  if (templates.isError && !templates.data) return <FormError title={errorText(templates.error)} />;
  if (!templates.data || !servers.data) return null;

  if (!tpl) {
    return (
      <div className="hz-grid app-grid">
        <Tile
          title="Vorlage wählen"
          icon="gamepad"
          count={String(templates.data.length)}
          span={4}
          footer={
            <span className="app-foot-text">
              Vorlagen liegen in templates/games/. Ein neuer Ordner ist eine neue Vorlage.
            </span>
          }
        >
          {templates.data.length ? (
            <GameTemplates
              templates={templates.data.map((t) => ({
                id: t.id,
                name: t.name,
                image: t.image,
                ram: ramRange(t.ram),
                port: t.ports[0]?.default ?? 0,
              }))}
              onPick={pick}
            />
          ) : (
            <p className="app-empty">Keine Vorlagen gefunden. templates/games/ im Core prüfen.</p>
          )}
          <div className="hz-form-actions">
            <Link className="app-more" to="/games">
              Abbrechen, zurück zu den Gameservern
            </Link>
          </div>
        </Tile>
      </div>
    );
  }

  return <CreateForm key={tpl.id} tpl={tpl} servers={servers.data} onBack={() => pick(null)} />;
}

function serverLabel(s: ServerSummary): string {
  return s.connected ? s.name : `${s.name} (offline)`;
}

function CreateForm({
  tpl,
  servers,
  onBack,
}: {
  tpl: TemplateInfo;
  servers: ServerSummary[];
  onBack: () => void;
}): ReactElement {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const games = useGames();
  const online = servers.filter((s) => s.connected);
  const wanted = params.get('server');
  const initialServer =
    servers.find((s) => s.id === wanted)?.id ?? (online.length === 1 ? (online[0]?.id ?? '') : '');

  const [draft, setDraft] = useState<CreateDraft>(() => emptyCreateDraft(tpl, initialServer));
  const [errors, setErrors] = useState<CreateErrors>({});
  /** Port inputs the admin changed; those are not overwritten by the suggestion. */
  const touchedPorts = useRef(new Set<string>());
  const nameTouched = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);

  const taken = useMemo(
    () => (games.data ?? []).filter((g) => g.serverId === draft.serverId).map((g) => g.name),
    [games.data, draft.serverId],
  );

  useEffect(() => {
    if (nameTouched.current) return;
    setDraft((d) => ({ ...d, name: suggestName(tpl, taken) }));
  }, [tpl, taken]);

  const suggest = useQuery({
    queryKey: suggestKey(tpl.id, draft.serverId),
    queryFn: ({ signal }) => fetchSuggest(tpl.id, draft.serverId, signal),
    enabled: !!draft.serverId,
    staleTime: 15_000,
  });

  useEffect(() => {
    const ports = suggest.data?.ports;
    if (!ports) return;
    setDraft((d) => {
      const next = { ...d.ports };
      for (const p of tpl.ports) {
        const v = ports[p.name];
        if (v !== undefined && !touchedPorts.current.has(p.name)) next[p.name] = String(v);
      }
      return { ...d, ports: next };
    });
  }, [suggest.data, tpl.ports]);

  const create = useMutation({
    mutationFn: (body: GameCreateBody) => createGame(body),
    onSuccess: (game) => {
      qc.setQueryData<GameSummary[]>(gamesKey, (old) => mergeById(old, [game]));
      void navigate(`/games/${game.id}?setup=1`);
    },
  });

  function setErr(key: string): void {
    setErrors((e) => withoutError(e, key));
  }

  function set<K extends 'name' | 'serverId' | 'autoStopMinutes' | 'externalAddress'>(
    key: K,
    value: string,
  ): void {
    if (key === 'name') nameTouched.current = true;
    setDraft((d) => ({ ...d, [key]: value }));
    setErr(key);
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    const res = validateCreate(tpl, draft, taken);
    if (!res.ok) {
      setErrors(res.errors);
      // Focus the first field with an error (after React painted the messages).
      requestAnimationFrame(() =>
        formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
      return;
    }
    create.mutate(res.body);
  }

  const server = servers.find((s) => s.id === draft.serverId);
  const errorCount = Object.keys(errors).length;
  const fieldErrors: Record<string, string> = {};
  for (const [k, v] of Object.entries(errors)) {
    if (k.startsWith('field:')) fieldErrors[k.slice(6)] = v;
  }
  const freeRam = suggest.data?.freeRamBytes;
  const ramHint = draft.serverId
    ? suggest.isPending
      ? 'freier RAM wird geprüft …'
      : freeRam != null
        ? suggestRamText(freeRam, suggest.data?.ramReserveBytes, ramBytesOf(tpl.ram.recommended))
        : `empfohlen ${formatBytes(ramBytesOf(tpl.ram.recommended))} RAM`
    : `empfohlen ${formatBytes(ramBytesOf(tpl.ram.recommended))} RAM`;

  const previewPorts = tpl.ports.map((p) => {
    const n = parseNumber(draft.ports[p.name] ?? '');
    return {
      name: p.name,
      port: Number.isInteger(n) ? n : p.default,
      protocol: p.protocol,
      count: p.count,
    };
  });

  return (
    <div className="hz-grid app-grid">
      <Tile
        title={`${tpl.name} aufsetzen`}
        icon="gamepad"
        count={tpl.image}
        span={4}
        actions={
          <Button size="sm" variant="ghost" onClick={onBack}>
            Andere Vorlage
          </Button>
        }
      >
        <form ref={formRef} className="hz-form app-game-form" onSubmit={submit} noValidate>
          <div className="app-form-row">
            <Field
              label="Name"
              mono
              value={draft.name}
              onChange={(e) => set('name', e.target.value)}
              hint="Ordner /opt/homelab/games/<name>/ und Containername"
              error={errors.name}
              maxLength={32}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              data-autofocus=""
            />
            <SelectField
              label="Zielserver"
              value={draft.serverId}
              onChange={(e) => set('serverId', e.target.value)}
              options={[
                ...(draft.serverId ? [] : [{ value: '', label: 'Server auswählen' }]),
                ...servers.map((s) => ({ value: s.id, label: serverLabel(s) })),
              ]}
              hint={ramHint}
              error={errors.serverId}
            />
          </div>
          {suggest.data?.ramWarning ? (
            <Alert tone="warn" title={suggest.data.ramWarning}>
              Aufsetzen geht trotzdem. Der Gameserver kann dann langsam laufen oder abstürzen.
            </Alert>
          ) : null}
          {server && !server.connected ? (
            <Alert tone="warn" title={`${server.name} ist offline.`}>
              Aufsetzen geht erst, wenn sich der Agent wieder meldet.
            </Alert>
          ) : null}
          {suggest.error ? <FormError title={errorText(suggest.error)} /> : null}

          <fieldset className="app-fieldset">
            <legend className="hz-label">Ports</legend>
            <div className="app-fields">
              {tpl.ports.map((p) => (
                <Field
                  key={p.name}
                  label={`Port ${p.name} (${protocolText(p.protocol)})`}
                  mono
                  inputMode="numeric"
                  value={draft.ports[p.name] ?? ''}
                  onChange={(e) => {
                    touchedPorts.current.add(p.name);
                    const value = e.target.value;
                    setDraft((d) => ({ ...d, ports: { ...d.ports, [p.name]: value } }));
                    setErr(`port:${p.name}`);
                  }}
                  hint={
                    p.count > 1
                      ? `belegt ${portLabel(parseNumber(draft.ports[p.name] ?? '') || p.default, p.protocol, p.count)}`
                      : suggest.data?.ports[p.name] !== undefined
                        ? 'Vorschlag: nächster freier Port'
                        : `Standard ${p.default}`
                  }
                  error={errors[`port:${p.name}`]}
                  autoComplete="off"
                />
              ))}
            </div>
          </fieldset>

          <fieldset className="app-fieldset">
            <legend className="hz-label">Einstellungen von {tpl.name}</legend>
            <TemplateFields
              fields={tpl.fields}
              draft={draft.fields}
              errors={fieldErrors}
              onChange={(key, value) => {
                setDraft((d) => ({ ...d, fields: { ...d.fields, [key]: value } }));
                setErr(`field:${key}`);
              }}
            />
          </fieldset>

          <div className="app-form-row">
            <Field
              label="Auto-Stopp (Minuten ohne Spieler)"
              mono
              inputMode="numeric"
              value={draft.autoStopMinutes}
              onChange={(e) => set('autoStopMinutes', e.target.value)}
              hint="0 = nie automatisch stoppen"
              error={errors.autoStopMinutes}
              autoComplete="off"
            />
            <Field
              label="Externe Adresse"
              mono
              value={draft.externalAddress}
              onChange={(e) => set('externalAddress', e.target.value)}
              placeholder="mc.example.org"
              hint="DDNS-Name oder öffentliche IP für Freunde. Leer: Tailscale-IP."
              error={errors.externalAddress}
              maxLength={253}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </div>

          {errorCount ? (
            <FormError
              title={`${plural(errorCount, 'Feld', 'Felder')} prüfen.`}
              text="Die Hinweise stehen direkt unter den Feldern."
            />
          ) : null}
          {create.error ? <FormError title={gameErrorText(create.error)} /> : null}
          <div className="hz-form-actions">
            <Button onClick={() => void navigate('/games')}>Abbrechen</Button>
            <Button variant="primary" type="submit" icon="play" disabled={create.isPending}>
              {create.isPending ? 'Wird gestartet …' : 'Aufsetzen'}
            </Button>
          </div>
        </form>
      </Tile>
      <Tile title="Von außen erreichbar" icon="globe" span={4}>
        <ForwardHint ports={previewPorts} server={server} />
      </Tile>
    </div>
  );
}
