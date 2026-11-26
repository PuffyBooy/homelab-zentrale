import type { Fail2banResponse, Fail2banServer } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { Button, Tile } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { FormError } from '../../components/FormError.js';
import { errorText } from '../../lib/errors.js';
import { formatAgo, formatNumber } from '../../lib/format.js';
import {
  FAIL2BAN_STATE,
  fail2banKey,
  fetchFail2ban,
  unbanIp,
  type UnbanTarget,
} from '../../lib/ops.js';

/** Banned IPs shown per jail before "Alle zeigen". */
const IP_PREVIEW = 20;

const STATE_TEXT: Record<Exclude<Fail2banServer['state'], 'ok'>, string> = {
  not_installed: 'fail2ban ist auf diesem Server nicht installiert oder läuft nicht.',
  offline: 'Server offline. Die Sperren erscheinen, sobald sich der Agent meldet.',
  unsupported: 'Agent zu alt für Fail2ban. Agent aktualisieren.',
  failed: 'Abfrage fehlgeschlagen. Log des Agents prüfen.',
};

/** Sicherheit → Fail2ban (module fail2ban): jails and banned IPs per server, unban. */
export function Fail2banSection(): ReactElement {
  const list = useQuery({
    queryKey: fail2banKey,
    queryFn: ({ signal }) => fetchFail2ban(signal),
    refetchInterval: 30_000,
  });
  const [unban, setUnban] = useState<(UnbanTarget & { serverName: string }) | null>(null);

  if (list.isError && !list.data) {
    return (
      <Tile title="Fail2ban" icon="lock" span={4}>
        <FormError title={errorText(list.error)} />
      </Tile>
    );
  }
  if (!list.data) {
    return (
      <Tile title="Fail2ban" icon="lock" span={4}>
        <p className="app-empty">Lade Fail2ban …</p>
      </Tile>
    );
  }
  if (list.data.servers.length === 0) {
    return (
      <Tile title="Fail2ban" icon="lock" span={4}>
        <p className="app-empty">Noch kein Server verbunden.</p>
      </Tile>
    );
  }
  return (
    <>
      {list.data.servers.map((s) => (
        <Fail2banTile
          key={s.serverId}
          server={s}
          onUnban={(jail, ip) => setUnban({ serverId: s.serverId, serverName: s.name, jail, ip })}
        />
      ))}
      {unban ? <UnbanDialog target={unban} onClose={() => setUnban(null)} /> : null}
    </>
  );
}

export function Fail2banTile({
  server,
  onUnban,
}: {
  server: Fail2banServer;
  onUnban: (jail: string, ip: string) => void;
}): ReactElement {
  const st = FAIL2BAN_STATE[server.state];
  const banned = server.jails.reduce((n, j) => n + j.currentlyBanned, 0);
  return (
    <Tile
      title={`Fail2ban · ${server.name}`}
      icon="lock"
      span={2}
      status={st.status}
      statusLabel={st.label}
      count={server.state === 'ok' ? String(banned) : undefined}
      flush
    >
      <div data-testid="fail2ban-server">
        {server.state !== 'ok' ? (
          <p className="app-empty app-pad">{STATE_TEXT[server.state]}</p>
        ) : server.jails.length === 0 ? (
          <p className="app-empty app-pad">Keine Jails aktiv.</p>
        ) : (
          server.jails.map((j) => (
            <JailBlock key={j.name} jail={j} onUnban={(ip) => onUnban(j.name, ip)} />
          ))
        )}
        <p className="app-text app-pad">Stand {formatAgo(new Date(server.fetchedAt))}</p>
      </div>
    </Tile>
  );
}

function JailBlock({
  jail,
  onUnban,
}: {
  jail: Fail2banServer['jails'][number];
  onUnban: (ip: string) => void;
}): ReactElement {
  const [all, setAll] = useState(false);
  const ips = all ? jail.bannedIps : jail.bannedIps.slice(0, IP_PREVIEW);
  return (
    <div data-testid="fail2ban-jail">
      <div className="hz-row">
        <div className="hz-row-main">
          <span className="hz-row-name hz-mono">{jail.name}</span>
          <span className="hz-row-sub">
            {formatNumber(jail.currentlyBanned, 0)} gesperrt (gesamt{' '}
            {formatNumber(jail.totalBanned, 0)}) · {formatNumber(jail.currentlyFailed, 0)}{' '}
            Fehlversuche (gesamt {formatNumber(jail.totalFailed, 0)})
          </span>
        </div>
      </div>
      {ips.map((ip) => (
        <BannedIpRow key={ip} ip={ip} jail={jail.name} onUnban={() => onUnban(ip)} />
      ))}
      {jail.bannedIps.length > IP_PREVIEW ? (
        <div className="app-pad">
          <button type="button" className="app-more" onClick={() => setAll((a) => !a)}>
            {all ? 'Weniger zeigen' : `Alle ${formatNumber(jail.bannedIps.length, 0)} zeigen`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** One banned IP. "Entsperren" only opens the confirm dialog. */
export function BannedIpRow({
  ip,
  jail,
  onUnban,
}: {
  ip: string;
  jail: string;
  onUnban: () => void;
}): ReactElement {
  return (
    <div className="hz-row" data-testid="banned-ip">
      <div className="hz-row-main">
        <span className="hz-row-name hz-mono">{ip}</span>
      </div>
      <div className="hz-row-actions">
        <Button
          size="sm"
          variant="ghost"
          aria-haspopup="dialog"
          aria-label={`${ip} in ${jail} entsperren`}
          onClick={onUnban}
        >
          Entsperren
        </Button>
      </div>
    </div>
  );
}

/** Confirm step, same pattern as "Stoppen?" (ThrottleDialogs). */
export function UnbanDialog({
  target,
  onClose,
}: {
  target: UnbanTarget & { serverName: string };
  onClose: () => void;
}): ReactElement {
  const qc = useQueryClient();
  const act = useMutation({
    mutationFn: () => unbanIp({ serverId: target.serverId, jail: target.jail, ip: target.ip }),
    onSuccess: (next) => {
      qc.setQueryData<Fail2banResponse>(fail2banKey, (old) =>
        old ? { servers: old.servers.map((s) => (s.serverId === next.serverId ? next : s)) } : old,
      );
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={`${target.ip} entsperren?`}>
      <div className="hz-dialog-body">
        <p className="hz-dialog-text">
          {target.ip} darf sich auf {target.serverName} wieder bei {target.jail} anmelden. Bei
          weiteren Fehlversuchen sperrt Fail2ban die Adresse erneut. Wird protokolliert.
        </p>
        {act.error ? <FormError title={errorText(act.error)} /> : null}
        <div className="hz-dialog-foot">
          <Button onClick={onClose} data-autofocus="">
            Abbrechen
          </Button>
          <Button variant="danger" disabled={act.isPending} onClick={() => act.mutate()}>
            {act.isPending ? 'Entsperrt …' : 'Entsperren'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
