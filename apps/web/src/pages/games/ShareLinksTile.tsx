import type { GameSummary, ShareLink } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { Link } from 'react-router';
import { Button, StatusDot, Tile } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { FormError } from '../../components/FormError.js';
import { errorText } from '../../lib/errors.js';
import { plural } from '../../lib/format.js';
import {
  auditIsWarning,
  auditSub,
  AUDIT_TEXT,
  fetchShareAudit,
  fetchShares,
  permsText,
  removeShare,
  revokeShare,
  shareAuditKey,
  shareGatewayKey,
  fetchShareGateway,
  sharesKey,
  shareState,
  shareSub,
  sortShares,
} from '../../lib/shares.js';
import { ShareCreateDialog } from './ShareCreateDialog.js';

const REFRESH_MS = 30_000;

export interface ShareTilesProps {
  game: GameSummary;
  now: Date;
}

/** "Benutzerlinks" on the game detail page (SPEC 6.4). */
export function ShareLinksTile({ game, now }: ShareTilesProps): ReactElement {
  const qc = useQueryClient();
  const shares = useQuery({
    queryKey: sharesKey(game.id),
    queryFn: ({ signal }) => fetchShares(game.id, signal),
    refetchInterval: REFRESH_MS,
  });
  const gateway = useQuery({
    queryKey: shareGatewayKey,
    queryFn: ({ signal }) => fetchShareGateway(signal),
  });
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ShareLink | null>(null);

  const replace = (share: ShareLink): void => {
    qc.setQueryData<ShareLink[]>(sharesKey(game.id), (old) =>
      old?.map((s) => (s.id === share.id ? share : s)),
    );
  };
  const revoke = useMutation({
    mutationFn: (id: string) => revokeShare(id),
    onSuccess: (share) => {
      replace(share);
      setRevoking(null);
      void qc.invalidateQueries({ queryKey: sharesKey(game.id) });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => removeShare(id),
    onSuccess: (_r, id) => {
      qc.setQueryData<ShareLink[]>(sharesKey(game.id), (old) => old?.filter((s) => s.id !== id));
    },
  });

  const list = sortShares(shares.data ?? []);
  const active = list.filter((s) => s.state === 'active').length;
  const gw = gateway.data;

  return (
    <>
      <Tile
        title="Benutzerlinks"
        icon="link"
        count={shares.data ? String(active) : undefined}
        span={2}
        flush
        actions={
          <Button size="sm" icon="plus" onClick={() => setCreating(true)}>
            Link erstellen
          </Button>
        }
        footer={
          <span className="app-foot-text">
            {gw?.enabled ? (
              <>Share-Gateway an · Links gehen auch von außen</>
            ) : (
              <>
                Share-Gateway aus · Links gehen nur im Tailnet ·{' '}
                <Link to="/settings#share-gateway">Einstellungen</Link>
              </>
            )}
          </span>
        }
      >
        {shares.error && !shares.data ? (
          <div className="app-pad">
            <FormError title={errorText(shares.error)} />
          </div>
        ) : null}
        {remove.error ? (
          <div className="app-pad">
            <FormError title={errorText(remove.error)} />
          </div>
        ) : null}
        {shares.isPending ? <p className="app-empty app-pad">Lade Benutzerlinks …</p> : null}
        {shares.data && list.length === 0 ? (
          <p className="app-empty app-pad">
            Noch kein Link. Mit „Link erstellen“ bekommt ein Freund Zugriff nur auf {game.name}.
          </p>
        ) : null}
        {list.map((s) => {
          const st = shareState(s, now);
          return (
            <div key={s.id} className="hz-row" data-testid="share-row">
              <div className="hz-row-main">
                <span className="hz-row-name">{s.person}</span>
                <div className="hz-row-sub">{permsText(s.perms)}</div>
                <div className="hz-row-sub">
                  {st.when} · {shareSub(s, now)}
                </div>
              </div>
              <div className="hz-row-meta">
                <StatusDot status={st.status} label={st.tag} />
              </div>
              <div className="hz-row-actions">
                {s.state === 'active' ? (
                  <Button size="sm" variant="danger" onClick={() => setRevoking(s)}>
                    Widerrufen
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={remove.isPending && remove.variables === s.id}
                    onClick={() => remove.mutate(s.id)}
                    aria-label={`Link von ${s.person} entfernen`}
                  >
                    Entfernen
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </Tile>
      {creating ? <ShareCreateDialog game={game} onClose={() => setCreating(false)} /> : null}
      {revoking ? (
        <Dialog
          open
          onClose={() => setRevoking(null)}
          title={`Link von ${revoking.person} widerrufen`}
          dismissable={false}
        >
          <div className="hz-dialog-body">
            <p className="hz-dialog-text">
              Der Link hört sofort auf zu funktionieren. {revoking.person} sieht dann „Link
              widerrufen“. Das Protokoll bleibt.
            </p>
            {revoke.error ? <FormError title={errorText(revoke.error)} /> : null}
            <div className="hz-dialog-foot">
              <Button onClick={() => setRevoking(null)} data-autofocus="">
                Abbrechen
              </Button>
              <Button
                variant="danger"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(revoking.id)}
              >
                Widerrufen
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

/** "Wer hat was gemacht": share_audit of this game, newest first. */
export function ShareAuditTile({ game, now }: ShareTilesProps): ReactElement {
  const audit = useQuery({
    queryKey: shareAuditKey(game.id),
    queryFn: ({ signal }) => fetchShareAudit(game.id, signal),
    refetchInterval: REFRESH_MS,
  });
  const list = audit.data ?? [];
  return (
    <Tile
      title="Wer hat was gemacht"
      icon="users"
      count={audit.data ? plural(list.length, 'Eintrag', 'Einträge') : undefined}
      span={2}
      flush
    >
      {audit.error && !audit.data ? (
        <div className="app-pad">
          <FormError title={errorText(audit.error)} />
        </div>
      ) : null}
      {audit.data && list.length === 0 ? (
        <p className="app-empty app-pad">Noch nichts. Aktionen über Benutzerlinks stehen hier.</p>
      ) : null}
      {list.map((e) => (
        <div key={e.id} className="hz-row" data-testid="share-audit-row">
          <div className="hz-row-main">
            <span className="hz-row-name">
              {e.person} {AUDIT_TEXT[e.action]}
            </span>
            {e.detail ? <div className="hz-row-sub hz-mono">{e.detail}</div> : null}
            <div className="hz-row-sub">{auditSub(e, now)}</div>
          </div>
          {auditIsWarning(e.action) ? (
            <div className="hz-row-meta">
              <StatusDot
                status="warn"
                label={e.action === 'pin_locked' ? 'GESPERRT' : 'ABGEWIESEN'}
              />
            </div>
          ) : null}
        </div>
      ))}
    </Tile>
  );
}
