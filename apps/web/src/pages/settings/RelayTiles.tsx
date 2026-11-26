import type { Ingress } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
  type RefObject,
} from 'react';
import { useLocation } from 'react-router';
import { Alert, Button, StatusDot, Tile, Toggle } from '@hz/ui';
import { CopyBlock } from '../../components/CopyBlock.js';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { SelectField } from '../../components/SelectField.js';
import { isApiError } from '../../lib/api.js';
import { errorText } from '../../lib/errors.js';
import { formatAgo, formatWhen } from '../../lib/format.js';
import { gamesKey } from '../../lib/games.js';
import {
  DNS_PROVIDER_TEXT,
  RELAY_ENV_HINT,
  dnsSettingsKey,
  dnsStatus,
  fetchDnsSettings,
  fetchIngresses,
  ingressDirty,
  ingressDraft,
  ingressErrorText,
  ingressStatus,
  ingressSummary,
  ingressesKey,
  parseDnsDraft,
  parseIngressDraft,
  relayedGamesText,
  saveDnsSettings,
  saveIngress,
  type DnsDraft,
  type DnsDraftErrors,
  type DnsProvider,
  type DnsSettings,
  type IngressDraft,
  type IngressDraftErrors,
} from '../../lib/relay.js';

/** The user closed the step-up dialog: no error line for that. */
function shownError(err: unknown): string | null {
  if (!err || isApiError(err, 'step_up_required')) return null;
  return errorText(err);
}

/** Tiles that load their data scroll to `/settings#<id>` once it is there. */
function useScrollAnchor(id: string, ready: boolean): RefObject<HTMLDivElement> {
  const { hash } = useLocation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (hash === `#${id}` && ready) ref.current?.scrollIntoView({ block: 'start' });
  }, [hash, id, ready]);
  return ref;
}

function ingressSub(i: Ingress): string {
  const ip = i.publicIp ?? 'keine öffentliche IPv4';
  if (!i.enabled) return `${ip} · kein Eingang`;
  return `${ip} · Ports ${i.portFrom}–${i.portTo} · Spiele: ${relayedGamesText(i)}`;
}

/**
 * Settings → Eingänge (ROADMAP M15, SPEC 6.6): every server, whether it accepts game ports
 * from outside and relays them through Tailscale. Changing one needs step-up.
 */
export function IngressTile(): ReactElement {
  const list = useQuery({
    queryKey: ingressesKey,
    queryFn: ({ signal }) => fetchIngresses(signal),
  });
  const [editing, setEditing] = useState<Ingress | null>(null);
  const ingresses = [...(list.data ?? [])].sort((a, b) => a.serverName.localeCompare(b.serverName));
  const head = list.data ? ingressSummary(ingresses) : null;
  const anchor = useScrollAnchor('eingaenge', !!list.data);

  return (
    <div id="eingaenge" ref={anchor} className="app-anchor app-settings-wide">
      <Tile title="Eingänge" icon="door" status={head?.status} statusLabel={head?.label} flush>
        <p className="app-text app-pad">
          Ein Eingang ist ein Server mit öffentlicher IPv4. Er nimmt die Spielports an und leitet
          sie über Tailscale zum Server, auf dem das Spiel läuft. Zuhause ist dann keine
          Portweiterleitung nötig.
        </p>
        {list.isPending ? <p className="app-empty app-pad">Lade Eingänge …</p> : null}
        {list.isError && !list.data ? (
          <div className="app-pad">
            <FormError title={errorText(list.error)} />
          </div>
        ) : null}
        {list.data && ingresses.length === 0 ? (
          <p className="app-empty app-pad">Noch kein Server verbunden.</p>
        ) : null}
        {ingresses.map((i) => {
          const st = ingressStatus(i);
          return (
            <div key={i.serverId} data-testid="ingress-row">
              <div className="hz-row">
                <div className="hz-row-main">
                  <span className="hz-row-name">{i.serverName}</span>
                  <span className="hz-row-sub">{ingressSub(i)}</span>
                </div>
                <div className="hz-row-meta">
                  <StatusDot status={st.status} label={st.label} />
                </div>
                <div className="hz-row-actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Eingang ${i.serverName} einstellen`}
                    onClick={() => setEditing(i)}
                  >
                    Einstellen
                  </Button>
                </div>
              </div>
              {i.enabled && i.connected && !i.capable ? (
                <div className="app-pad">
                  <Alert tone="warn" title="Relay am Agent nicht erlaubt.">
                    {RELAY_ENV_HINT}
                  </Alert>
                </div>
              ) : null}
              {i.enabled ? (
                <div className="app-pad">
                  <CopyBlock label={`Firewall ${i.serverName}`} text={i.firewallHint} inline />
                </div>
              ) : null}
            </div>
          );
        })}
      </Tile>
      {editing ? <IngressDialog ingress={editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function IngressDialog({
  ingress,
  onClose,
}: {
  ingress: Ingress;
  onClose: () => void;
}): ReactElement {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<IngressDraft>(() => ingressDraft(ingress));
  const [errors, setErrors] = useState<IngressDraftErrors>({});
  const save = useMutation({
    mutationFn: (body: Parameters<typeof saveIngress>[1]) => saveIngress(ingress.serverId, body),
    onSuccess: (next) => {
      qc.setQueryData<Ingress[]>(ingressesKey, (old) =>
        old?.map((i) => (i.serverId === next.serverId ? next : i)),
      );
      void qc.invalidateQueries({ queryKey: ingressesKey });
      void qc.invalidateQueries({ queryKey: gamesKey });
      onClose();
    },
  });

  function set<K extends keyof IngressDraft>(key: K, value: IngressDraft[K]): void {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors({});
    save.reset();
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    const parsed = parseIngressDraft(draft);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    save.mutate(parsed.body);
  }

  const err = ingressErrorText(save.error);
  const dirty = ingressDirty(ingress, draft);

  return (
    <Dialog open onClose={onClose} title={`Eingang ${ingress.serverName}`}>
      <form className="hz-dialog-body" onSubmit={submit} noValidate data-testid="ingress-dialog">
        <p className="hz-dialog-text">
          Freunde verbinden sich mit der öffentlichen IPv4 dieses Servers. Die Ports im Bereich
          müssen in der Firewall des Anbieters offen sein. Speichern braucht einen Code aus der
          Authenticator-App.
        </p>
        <Toggle
          label="Als Eingang nutzen"
          hint={draft.enabled ? 'Nimmt Spielports an' : 'Aus'}
          checked={draft.enabled}
          onChange={(v) => set('enabled', v)}
        />
        <Field
          label="Öffentliche IPv4"
          mono
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          maxLength={15}
          placeholder={ingress.publicIp ?? '203.0.113.7'}
          value={draft.publicIp}
          onChange={(e) => set('publicIp', e.target.value)}
          hint="Leer lassen: IP aus dem Inventar."
          error={errors.publicIp}
          data-autofocus=""
        />
        <div className="app-form-row">
          <Field
            label="Ports von"
            mono
            inputMode="numeric"
            autoComplete="off"
            value={draft.portFrom}
            onChange={(e) => set('portFrom', e.target.value)}
            error={errors.portFrom}
          />
          <Field
            label="bis"
            mono
            inputMode="numeric"
            autoComplete="off"
            value={draft.portTo}
            onChange={(e) => set('portTo', e.target.value)}
            error={errors.portTo}
          />
        </div>
        <dl className="app-kv">
          <dt>Agent</dt>
          <dd>{ingress.connected ? 'verbunden' : 'getrennt'}</dd>
          <dt>Relay erlaubt</dt>
          <dd>{ingress.capable ? 'ja' : 'nein'}</dd>
          <dt>Spiele darüber</dt>
          <dd>{relayedGamesText(ingress)}</dd>
        </dl>
        {!ingress.capable ? <Alert tone="warn" title={RELAY_ENV_HINT} /> : null}
        {err ? <FormError title={err} /> : null}
        <div className="hz-dialog-foot">
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" type="submit" disabled={!dirty || save.isPending}>
            {save.isPending ? 'Speichert …' : 'Speichern'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const PROVIDERS: readonly DnsProvider[] = ['none', 'cloudflare', 'duckdns'];

function draftOf(s: DnsSettings): DnsDraft {
  return { provider: s.provider, token: '', zoneId: s.zoneId ?? '' };
}

/**
 * Settings → DNS (ROADMAP M15): optional provider for fixed game names. The token is
 * write-only; the core only says whether one is stored. Saving needs step-up.
 */
export function DnsTile(): ReactElement {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: dnsSettingsKey,
    queryFn: ({ signal }) => fetchDnsSettings(signal),
  });
  const [draft, setDraft] = useState<DnsDraft>({ provider: 'none', token: '', zoneId: '' });
  const [errors, setErrors] = useState<DnsDraftErrors>({});
  const loaded = useRef(false);
  const s = settings.data;

  useEffect(() => {
    if (!s || loaded.current) return;
    loaded.current = true;
    setDraft(draftOf(s));
  }, [s]);

  const save = useMutation({
    mutationFn: saveDnsSettings,
    onSuccess: (next) => {
      qc.setQueryData<DnsSettings>(dnsSettingsKey, next);
      setDraft(draftOf(next));
    },
  });

  function set<K extends keyof DnsDraft>(key: K, value: DnsDraft[K]): void {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors({});
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (!s) return;
    const parsed = parseDnsDraft(draft, s);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    save.mutate(parsed.body);
  }

  const head = s ? dnsStatus(s) : null;
  const anchor = useScrollAnchor('dns', !!s);
  const dirty =
    !!s &&
    (draft.provider !== s.provider ||
      draft.token.trim() !== '' ||
      (draft.provider === 'cloudflare' && draft.zoneId.trim() !== (s.zoneId ?? '')));
  const keepsToken = !!s && s.tokenSet && s.provider === draft.provider;

  return (
    <div id="dns" ref={anchor} className="app-anchor">
      <Tile title="DNS" icon="globe" status={head?.status} statusLabel={head?.label}>
        {settings.isError && !s ? <FormError title={errorText(settings.error)} /> : null}
        {settings.isPending ? <p className="app-empty">Lade DNS …</p> : null}
        {s ? (
          <>
            <p className="app-text">
              Optional: feste Namen für Gameserver. Die Zentrale setzt den A-Record auf die IPv4 des
              Eingangs und zieht ihn beim Wechsel mit.
            </p>
            <dl className="app-kv">
              <dt>Token</dt>
              <dd>{s.tokenSet ? 'gesetzt' : 'keiner'}</dd>
              <dt>Zuletzt gesetzt</dt>
              <dd>
                {s.lastUpdateAt
                  ? `${formatWhen(new Date(s.lastUpdateAt))} · ${formatAgo(new Date(s.lastUpdateAt))}`
                  : 'noch nie'}
              </dd>
            </dl>
            {s.lastError ? (
              <Alert tone="crit" title="Letzter Fehler">
                {s.lastError}
              </Alert>
            ) : null}
            <form className="hz-form" onSubmit={submit} noValidate>
              <SelectField
                label="Anbieter"
                value={draft.provider}
                onChange={(e) => set('provider', e.target.value as DnsProvider)}
                options={PROVIDERS.map((p) => ({ value: p, label: DNS_PROVIDER_TEXT[p] }))}
              />
              {draft.provider !== 'none' ? (
                <Field
                  label={draft.provider === 'cloudflare' ? 'API-Token' : 'DuckDNS-Token'}
                  type="password"
                  mono
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={100}
                  placeholder={keepsToken ? 'gesetzt' : ''}
                  value={draft.token}
                  onChange={(e) => set('token', e.target.value)}
                  hint={
                    keepsToken
                      ? 'Gesetzt. Leer lassen, um ihn zu behalten.'
                      : draft.provider === 'cloudflare'
                        ? 'Token mit Recht „Zone.DNS bearbeiten“ für die Domain.'
                        : 'Token von duckdns.org. Namen heißen dann <name>.duckdns.org.'
                  }
                  error={errors.token}
                />
              ) : null}
              {draft.provider === 'cloudflare' ? (
                <Field
                  label="Zone-ID"
                  mono
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={32}
                  value={draft.zoneId}
                  onChange={(e) => set('zoneId', e.target.value)}
                  error={errors.zoneId}
                />
              ) : null}
              {draft.provider === 'none' && s.tokenSet ? (
                <Alert tone="info" title="Speichern löscht den Token." />
              ) : null}
              {shownError(save.error) ? <FormError title={shownError(save.error) ?? ''} /> : null}
              {save.isSuccess && !dirty ? (
                <Alert tone="ok" title="Gespeichert.">
                  {save.data.provider === 'none'
                    ? 'Kein DNS-Anbieter.'
                    : `DNS über ${DNS_PROVIDER_TEXT[save.data.provider]}.`}
                </Alert>
              ) : null}
              <div className="hz-form-actions">
                <Button type="submit" variant="primary" disabled={!dirty || save.isPending}>
                  Speichern
                </Button>
              </div>
            </form>
          </>
        ) : null}
      </Tile>
    </div>
  );
}
