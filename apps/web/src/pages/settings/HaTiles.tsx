import { haUrlSchema, type HaConfig, type HaSettings } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { useLocation } from 'react-router';
import { Alert, Badge, Button, Tile, Toggle } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { SelectField } from '../../components/SelectField.js';
import { isApiError } from '../../lib/api.js';
import { errorText } from '../../lib/errors.js';
import { formatAgo, formatWhen, plural } from '../../lib/format.js';
import {
  KIND_LABEL,
  STATUS_TEXT,
  allowedKinds,
  configProblem,
  deleteHaToken,
  entityFromAvailable,
  fetchHaAvailable,
  fetchHaConfig,
  fetchHaSettings,
  haAvailableKey,
  haConfigKey,
  haSettingsKey,
  haStateKey,
  haTileStatus,
  isEnergySensor,
  isPowerSensor,
  matchesEntity,
  normalizeConfig,
  parsePrice,
  priceToText,
  removeRoom,
  roomIdFor,
  saveHaConfig,
  saveHaSettings,
  type HaAvailableEntity,
  type HaEntityConfig,
  type HaSettingsPatch,
} from '../../lib/ha.js';

/** The user closed the step-up dialog: no error line for that. */
function shownError(err: unknown): string | null {
  if (!err || isApiError(err, 'step_up_required')) return null;
  return errorText(err);
}

const TOKEN_RE = /^[A-Za-z0-9._-]{20,1000}$/;

function useHaSettings() {
  return useQuery({
    queryKey: haSettingsKey,
    queryFn: ({ signal }) => fetchHaSettings(signal),
    // While the core connects, look again soon so status and pickers follow.
    refetchInterval: (q) => (q.state.data?.status === 'connecting' ? 1500 : 30_000),
  });
}

function useAvailable(enabled: boolean) {
  return useQuery({
    queryKey: haAvailableKey,
    queryFn: ({ signal }) => fetchHaAvailable(signal),
    enabled,
    staleTime: 60_000,
  });
}

/**
 * Settings → Home Assistant (SPEC 10): URL, long-lived token (write-only), connection
 * state, price per kWh and the energy/power sensors. Changing URL or token needs step-up.
 */
export function HaSettingsTile(): ReactElement {
  const qc = useQueryClient();
  const settings = useHaSettings();
  const s = settings.data;
  const available = useAvailable(s?.status === 'connected');
  const { hash } = useLocation();
  const anchor = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [price, setPrice] = useState('');
  const [energy, setEnergy] = useState('');
  const [power, setPower] = useState('');
  const [errors, setErrors] = useState<{ url?: string; token?: string; price?: string }>({});
  const [removing, setRemoving] = useState(false);
  const loaded = useRef(false);

  function fill(next: HaSettings): void {
    setUrl(next.url ?? '');
    setPrice(priceToText(next.pricePerKwh));
    setEnergy(next.energyEntityId ?? '');
    setPower(next.powerEntityId ?? '');
  }

  useEffect(() => {
    if (!s || loaded.current) return;
    loaded.current = true;
    fill(s);
  }, [s]);

  useEffect(() => {
    if (hash === '#ha' && s) anchor.current?.scrollIntoView({ block: 'start' });
  }, [hash, s]);

  const save = useMutation({
    mutationFn: saveHaSettings,
    onSuccess: (next) => {
      setToken('');
      qc.setQueryData<HaSettings>(haSettingsKey, next);
      fill(next);
      void qc.invalidateQueries({ queryKey: haStateKey });
      void qc.invalidateQueries({ queryKey: haAvailableKey });
    },
  });
  const remove = useMutation({
    mutationFn: deleteHaToken,
    onSuccess: () => {
      setRemoving(false);
      void qc.invalidateQueries({ queryKey: haSettingsKey });
      void qc.invalidateQueries({ queryKey: haStateKey });
      qc.removeQueries({ queryKey: haAvailableKey });
    },
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (!s) return;
    const next: typeof errors = {};
    const patch: HaSettingsPatch = {};
    const u = url.trim();
    if (u !== (s.url ?? '')) {
      if (!u) next.url = 'Adresse fehlt, z. B. http://192.168.68.20:8123.';
      else if (!haUrlSchema.safeParse(u).success)
        next.url = 'Adresse mit http:// oder https://, ohne Benutzer, Query oder Anker.';
      else patch.url = u;
    } else if (!u && !s.url && token.trim()) {
      next.url = 'Adresse fehlt, z. B. http://192.168.68.20:8123.';
    }
    const t = token.trim();
    if (t) {
      if (!TOKEN_RE.test(t))
        next.token =
          'Das ist kein Long-Lived Access Token (Profil → Sicherheit in Home Assistant).';
      else patch.token = t;
    } else if (!s.tokenSet && u) {
      next.token = 'Token fehlt.';
    }
    const p = parsePrice(price);
    if (p === null) next.price = 'Preis wie 0,25 eintragen (Euro pro kWh, höchstens 5).';
    else if (p !== s.pricePerKwh) patch.pricePerKwh = p;
    if ((energy || null) !== s.energyEntityId) patch.energyEntityId = energy || null;
    if ((power || null) !== s.powerEntityId) patch.powerEntityId = power || null;
    setErrors(next);
    if (Object.keys(next).length) return;
    if (Object.keys(patch).length === 0) return;
    save.mutate(patch);
  }

  const sensorOptions = (pick: (e: HaAvailableEntity) => boolean, current: string) => {
    const list = (available.data ?? []).filter(pick);
    const opts = [{ value: '', label: 'keiner' }];
    if (current && !list.some((e) => e.entityId === current))
      opts.push({ value: current, label: current });
    for (const e of list) {
      opts.push({
        value: e.entityId,
        label: `${e.name} · ${e.state}${e.unit ? ` ${e.unit}` : ''}`,
      });
    }
    return opts;
  };

  const saveError = shownError(save.error);
  const status = haTileStatus(s);

  return (
    <div id="ha" ref={anchor} className="app-anchor">
      <Tile
        title="Home Assistant"
        icon="home"
        status={status}
        statusLabel={s ? STATUS_TEXT[s.status] : undefined}
      >
        {settings.isError && !s ? <FormError title={errorText(settings.error)} /> : null}
        {s ? (
          <>
            <dl className="app-kv">
              <dt>Version</dt>
              <dd>{s.haVersion ?? '—'}</dd>
              <dt>Token</dt>
              <dd>{s.tokenSet ? 'Token gesetzt' : 'kein Token'}</dd>
              <dt>Zuletzt verbunden</dt>
              <dd>
                {s.lastConnectedAt
                  ? `${formatWhen(new Date(s.lastConnectedAt))} · ${formatAgo(new Date(s.lastConnectedAt))}`
                  : 'noch nie'}
              </dd>
            </dl>
            {s.status === 'unreachable' || (s.status !== 'connected' && s.error) ? (
              <Alert tone="crit" title="Home Assistant nicht erreichbar">
                {s.error ? `${s.error}. ` : ''}Adresse und Token prüfen. Die Zentrale versucht es
                weiter.
              </Alert>
            ) : null}
            <form className="hz-form" onSubmit={submit} noValidate>
              <Field
                label="Adresse"
                mono
                value={url}
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                maxLength={200}
                placeholder="http://192.168.68.20:8123"
                onChange={(e) => setUrl(e.target.value)}
                hint="Im LAN oder im Tailnet. http reicht dort."
                error={errors.url}
              />
              <Field
                label={s.tokenSet ? 'Neuer Token' : 'Token'}
                mono
                type="password"
                autoComplete="off"
                spellCheck={false}
                maxLength={1000}
                value={token}
                placeholder={s.tokenSet ? 'Token gesetzt' : 'eyJhbGciOi…'}
                onChange={(e) => setToken(e.target.value)}
                hint={
                  s.tokenSet
                    ? 'Token gesetzt. Leer lassen, um ihn zu behalten. Er wird nie wieder angezeigt.'
                    : 'Long-Lived Access Token aus Home Assistant (Profil → Sicherheit). Er wird verschlüsselt gespeichert.'
                }
                error={errors.token}
              />
              <div className="app-fields">
                <Field
                  label="Strompreis (€/kWh)"
                  mono
                  value={price}
                  inputMode="decimal"
                  autoComplete="off"
                  maxLength={8}
                  placeholder="0,25"
                  onChange={(e) => setPrice(e.target.value)}
                  error={errors.price}
                />
                <span />
                <SelectField
                  label="Energie-Sensor (kWh)"
                  value={energy}
                  onChange={(e) => setEnergy(e.target.value)}
                  options={sensorOptions(isEnergySensor, energy)}
                  disabled={!available.data && !energy}
                  hint="Zählerstand für „kWh im Monat“"
                />
                <SelectField
                  label="Leistungs-Sensor (W)"
                  value={power}
                  onChange={(e) => setPower(e.target.value)}
                  options={sensorOptions(isPowerSensor, power)}
                  disabled={!available.data && !power}
                  hint="Für „Strom jetzt“"
                />
              </div>
              {saveError ? <FormError title={saveError} /> : null}
              {save.isSuccess && !save.isPending ? (
                <Alert tone="ok" title="Gespeichert.">
                  {save.data.status === 'connected'
                    ? `Verbunden mit Home Assistant${save.data.haVersion ? ` ${save.data.haVersion}` : ''}.`
                    : 'Die Zentrale verbindet sich.'}
                </Alert>
              ) : null}
              <div className="hz-form-actions">
                {s.tokenSet ? (
                  <Button variant="danger" onClick={() => setRemoving(true)}>
                    Token entfernen
                  </Button>
                ) : null}
                <Button type="submit" variant="primary" disabled={save.isPending}>
                  Speichern
                </Button>
              </div>
            </form>
          </>
        ) : settings.isPending ? (
          <p className="app-empty">Lade Home Assistant …</p>
        ) : null}
      </Tile>
      {removing ? (
        <Dialog open onClose={() => setRemoving(false)} title="Home-Assistant-Token entfernen">
          <div className="hz-dialog-body">
            <p className="hz-dialog-text">
              Die Zentrale trennt die Verbindung. Räume und gewählte Geräte bleiben gespeichert und
              erscheinen wieder mit einem neuen Token.
            </p>
            {shownError(remove.error) ? <FormError title={shownError(remove.error) ?? ''} /> : null}
            <div className="hz-dialog-foot">
              <Button onClick={() => setRemoving(false)} data-autofocus="">
                Abbrechen
              </Button>
              <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
                Entfernen
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

/**
 * Settings → Home Assistant: rooms and selected entities. The draft is edited locally
 * and saved as a whole (PUT /api/ha/config replaces the config).
 */
export function HaEntitiesTile(): ReactElement | null {
  const qc = useQueryClient();
  const settings = useHaSettings();
  const configured = !!settings.data?.tokenSet;
  const config = useQuery({
    queryKey: haConfigKey,
    queryFn: ({ signal }) => fetchHaConfig(signal),
    enabled: configured,
  });
  const available = useAvailable(settings.data?.status === 'connected');
  const [draft, setDraft] = useState<HaConfig | null>(null);
  const [roomName, setRoomName] = useState('');
  const [roomError, setRoomError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const save = useMutation({
    mutationFn: saveHaConfig,
    onSuccess: (next) => {
      qc.setQueryData<HaConfig>(haConfigKey, next);
      setDraft(next);
      void qc.invalidateQueries({ queryKey: haStateKey });
    },
  });

  const names = useMemo(() => {
    const m = new Map<string, HaAvailableEntity>();
    for (const e of available.data ?? []) m.set(e.entityId, e);
    return m;
  }, [available.data]);

  if (!configured) return null;

  // Untouched: follow the stored config; after the first edit: the local draft.
  const d = draft ?? config.data ?? null;
  const dirty = !!d && !!config.data && JSON.stringify(d) !== JSON.stringify(config.data);

  function update(next: HaConfig): void {
    setDraft(next);
    setProblem(null);
    save.reset();
  }

  function patchEntity(id: string, patch: Partial<HaEntityConfig>): void {
    if (!d) return;
    update({
      ...d,
      entities: d.entities.map((e) => (e.entityId === id ? { ...e, ...patch } : e)),
    });
  }

  function addRoom(e: FormEvent): void {
    e.preventDefault();
    if (!d) return;
    const name = roomName.trim();
    if (!name) return setRoomError('Name fehlt, z. B. Wohnzimmer.');
    if (name.length > 40) return setRoomError('Höchstens 40 Zeichen.');
    if (d.rooms.some((r) => r.name.toLowerCase() === name.toLowerCase()))
      return setRoomError(`Den Raum „${name}“ gibt es schon.`);
    if (d.rooms.length >= 30) return setRoomError('Höchstens 30 Räume.');
    setRoomError(null);
    setRoomName('');
    update({
      ...d,
      rooms: [
        ...d.rooms,
        {
          id: roomIdFor(
            name,
            d.rooms.map((r) => r.id),
          ),
          name,
        },
      ],
    });
  }

  function submit(): void {
    if (!d) return;
    const next = normalizeConfig(d);
    const p = configProblem(next);
    setProblem(p);
    if (!p) save.mutate(next);
  }

  const roomOptions = [
    { value: '', label: 'Ohne Raum' },
    ...(d?.rooms ?? []).map((r) => ({ value: r.id, label: r.name })),
  ];

  return (
    <div id="ha-geraete" className="app-anchor app-settings-wide">
      <Tile
        title="Wohnung: Räume und Geräte"
        icon="home"
        count={
          d
            ? `${plural(d.rooms.length, 'Raum', 'Räume')} · ${plural(d.entities.length, 'Gerät', 'Geräte')}`
            : undefined
        }
        actions={
          <Button size="sm" icon="plus" onClick={() => setPicking(true)} disabled={!d}>
            Gerät hinzufügen
          </Button>
        }
      >
        {config.isError && !d ? <FormError title={errorText(config.error)} /> : null}
        {!d ? (
          config.isPending ? (
            <p className="app-empty">Lade Auswahl …</p>
          ) : null
        ) : (
          <>
            <section className="app-ha-section" aria-label="Räume">
              <h3 className="hz-label">Räume</h3>
              {d.rooms.length === 0 ? (
                <p className="app-empty">
                  Noch keine Räume. Geräte ohne Raum stehen unter „Ohne Raum“.
                </p>
              ) : (
                <div className="app-ha-rooms">
                  {d.rooms.map((r) => (
                    <div
                      className="app-ha-room-row"
                      key={r.id}
                      role="group"
                      aria-label={`Raum ${r.name}`}
                      data-testid="ha-room"
                    >
                      <Field
                        label="Raum"
                        className="app-ha-room-name"
                        value={r.name}
                        maxLength={40}
                        onChange={(e) =>
                          update({
                            ...d,
                            rooms: d.rooms.map((x) =>
                              x.id === r.id ? { ...x, name: e.target.value } : x,
                            ),
                          })
                        }
                      />
                      <span className="app-ha-room-count">
                        {plural(
                          d.entities.filter((e) => e.roomId === r.id).length,
                          'Gerät',
                          'Geräte',
                        )}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Raum ${r.name} löschen`}
                        onClick={() => update(removeRoom(d, r.id))}
                      >
                        Löschen
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <form className="app-ha-room-add" onSubmit={addRoom} noValidate>
                <Field
                  label="Neuer Raum"
                  value={roomName}
                  maxLength={40}
                  placeholder="Wohnzimmer"
                  onChange={(e) => {
                    setRoomName(e.target.value);
                    setRoomError(null);
                  }}
                  error={roomError}
                />
                <Button type="submit" icon="plus">
                  Raum anlegen
                </Button>
              </form>
            </section>

            <section className="app-ha-section" aria-label="Geräte">
              <h3 className="hz-label">Geräte</h3>
              {d.entities.length === 0 ? (
                <p className="app-empty">
                  Noch keine Geräte. „Gerät hinzufügen“ zeigt alle Entitäten aus Home Assistant.
                </p>
              ) : (
                <div className="app-ha-entities">
                  {d.entities.map((e) => {
                    const info = names.get(e.entityId);
                    return (
                      <div
                        className="app-ha-entity"
                        key={e.entityId}
                        role="group"
                        aria-label={e.label ?? info?.name ?? e.entityId}
                        data-testid="ha-entity"
                        data-entity={e.entityId}
                      >
                        <div className="app-ha-entity-id">
                          <span className="hz-row-name">{e.label ?? info?.name ?? e.entityId}</span>
                          <span className="hz-row-sub">
                            {e.entityId}
                            {info ? ` · ${info.state}${info.unit ? ` ${info.unit}` : ''}` : ''}
                          </span>
                        </div>
                        <Field
                          label="Bezeichnung"
                          value={e.label ?? ''}
                          maxLength={60}
                          placeholder={info?.name ?? e.entityId}
                          onChange={(ev) => patchEntity(e.entityId, { label: ev.target.value })}
                        />
                        <SelectField
                          label="Art"
                          value={e.kind}
                          options={allowedKinds(e.entityId).map((k) => ({
                            value: k,
                            label: KIND_LABEL[k],
                          }))}
                          onChange={(ev) =>
                            patchEntity(e.entityId, {
                              kind: ev.target.value as HaEntityConfig['kind'],
                            })
                          }
                        />
                        <SelectField
                          label="Raum"
                          value={e.roomId ?? ''}
                          options={roomOptions}
                          onChange={(ev) =>
                            patchEntity(e.entityId, { roomId: ev.target.value || null })
                          }
                        />
                        <div className="app-ha-entity-overview">
                          <Toggle
                            label="in Übersicht"
                            checked={e.overview}
                            onChange={(on) => patchEntity(e.entityId, { overview: on })}
                          />
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`${e.entityId} entfernen`}
                          onClick={() =>
                            update({
                              ...d,
                              entities: d.entities.filter((x) => x.entityId !== e.entityId),
                            })
                          }
                        >
                          Entfernen
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
            {problem ? <FormError title={problem} /> : null}
            {shownError(save.error) ? <FormError title={shownError(save.error) ?? ''} /> : null}
            {save.isSuccess && !dirty ? <Alert tone="ok" title="Auswahl gespeichert." /> : null}
            <div className="hz-form-actions">
              {dirty ? <Button onClick={() => setDraft(null)}>Verwerfen</Button> : null}
              <Button variant="primary" onClick={submit} disabled={!dirty || save.isPending}>
                Auswahl speichern
              </Button>
            </div>
          </>
        )}
      </Tile>
      {picking && d ? (
        <PickEntityDialog
          available={available}
          chosen={new Set(d.entities.map((e) => e.entityId))}
          onClose={() => setPicking(false)}
          onAdd={(entity) => {
            const entry = entityFromAvailable(d, entity);
            if (!entry || d.entities.length >= 200) return;
            update({ ...d, entities: [...d.entities, entry] });
          }}
        />
      ) : null}
    </div>
  );
}

const MAX_LIST = 60;

function PickEntityDialog({
  available,
  chosen,
  onClose,
  onAdd,
}: {
  available: ReturnType<typeof useAvailable>;
  chosen: ReadonlySet<string>;
  onClose: () => void;
  onAdd: (e: HaAvailableEntity) => void;
}): ReactElement {
  const [query, setQuery] = useState('');
  const list = useMemo(
    () =>
      (available.data ?? [])
        .filter((e) => e.kinds.length > 0 && matchesEntity(e, query))
        .sort(
          (a, b) =>
            Number(chosen.has(a.entityId)) - Number(chosen.has(b.entityId)) ||
            a.entityId.localeCompare(b.entityId),
        ),
    [available.data, query, chosen],
  );
  const shown = list.slice(0, MAX_LIST);

  return (
    <Dialog
      open
      onClose={onClose}
      title="Gerät hinzufügen"
      className="app-dialog-wide hz-dialog-sheet"
    >
      <div className="hz-dialog-body">
        <Field
          label="Suchen"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="wohnzimmer, light., Temperatur"
          autoComplete="off"
          spellCheck={false}
          data-autofocus=""
        />
        {available.isError ? <FormError title={errorText(available.error)} /> : null}
        {!available.data && !available.isPending && !available.isError ? (
          <p className="app-empty">
            Home Assistant ist nicht verbunden. Erst Adresse und Token speichern.
          </p>
        ) : null}
        <div className="app-pick-list" aria-live="polite">
          {available.isPending && available.fetchStatus !== 'idle' ? (
            <p className="app-empty">Lade Entitäten aus Home Assistant …</p>
          ) : available.data && shown.length === 0 ? (
            <p className="app-empty">
              {query
                ? `Keine Entität passt zu „${query}“.`
                : 'Home Assistant meldet keine passenden Entitäten.'}
            </p>
          ) : (
            shown.map((e) => (
              <div
                className="hz-row"
                key={e.entityId}
                data-testid="ha-available"
                data-entity={e.entityId}
              >
                <div className="hz-row-main">
                  <span className="hz-row-name">{e.name}</span>
                  <span className="hz-row-sub">
                    {e.entityId}
                    {e.area ? ` · ${e.area}` : ''} · {e.state}
                    {e.unit ? ` ${e.unit}` : ''}
                  </span>
                </div>
                <div className="hz-row-actions">
                  {chosen.has(e.entityId) ? (
                    <Badge tone="ok">gewählt</Badge>
                  ) : (
                    <Button
                      size="sm"
                      icon="plus"
                      aria-label={`${e.entityId} hinzufügen`}
                      onClick={() => onAdd(e)}
                    >
                      Hinzufügen
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
          {list.length > shown.length ? (
            <p className="app-empty">+{list.length - shown.length} weitere, Suche eingrenzen.</p>
          ) : null}
        </div>
        <div className="hz-dialog-foot">
          <Button variant="primary" onClick={onClose}>
            Fertig
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
