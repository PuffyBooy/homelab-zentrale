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
import { Link, useLocation } from 'react-router';
import { Alert, Button, StatusDot, Tile, Toggle } from '@hz/ui';
import { CopyBlock } from '../../components/CopyBlock.js';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { errorText } from '../../lib/errors.js';
import { gamesKey } from '../../lib/games.js';
import {
  DOMAINS_PATH,
  RELAY_ENV_HINT,
  fetchIngresses,
  ingressDirty,
  ingressDraft,
  ingressErrorText,
  ingressStatus,
  ingressSummary,
  ingressesKey,
  parseIngressDraft,
  relayedGamesText,
  saveIngress,
  type IngressDraft,
  type IngressDraftErrors,
} from '../../lib/relay.js';

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
        <p className="app-text app-pad" data-testid="relay-dns-hint">
          DNS-Namen für Gameserver kommen aus <Link to={DOMAINS_PATH}>Internet → Domains</Link>{' '}
          (Modul „Domains“, Anbieter Cloudflare oder DuckDNS).
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
