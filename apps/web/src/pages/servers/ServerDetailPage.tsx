import type { HistoryResponse, ServerDetail } from '@hz/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { Alert, Button, Metric, Sparkline, StatusDot, Tile, UsageBar } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { isApiError } from '../../lib/api.js';
import { errorText } from '../../lib/errors.js';
import {
  formatAgo,
  formatBytesOf,
  formatNumber,
  formatPercent,
  formatRate,
  formatTemp,
  formatUptime,
} from '../../lib/format.js';
import { bucket } from '../../lib/history.js';
import { useContainers, useServers } from '../../lib/data.js';
import { useLiveState, useLiveTopic } from '../../lib/live.js';
import { fetchHistory, fetchServer, historyKey, serverKey } from '../../lib/servers.js';
import { useNow } from '../../lib/useNow.js';
import { ContainerGroups } from '../containers/ContainersPage.js';
import { StorageTile } from '../storage/StorageTile.js';
import { AutomatikTile } from '../throttle/AutomatikTile.js';
import { CleanupDialog } from './CleanupDialog.js';
import { OpenPortsTile } from './OpenPortsTile.js';
import { RebootDialog } from './RebootDialog.js';
import { viaText } from '../../lib/wol.js';
import { WolTile, useWake, useWol, wakeErrorOf } from './WolTile.js';

const SPARK_BARS = 48;

function pctOf(used: number, total: number): number {
  return total > 0 ? (used / total) * 100 : 0;
}

/** /servers/:id (SPEC 5.2). Live over the topic `server:<id>`, REST as first load. */
export function ServerDetailPage(): ReactElement | null {
  const { id = '' } = useParams();
  const live = useLiveState();
  useLiveTopic(id ? `server:${id}` : null);

  const detail = useQuery({
    queryKey: serverKey(id),
    queryFn: ({ signal }) => fetchServer(id, signal),
    enabled: id !== '',
    staleTime: live === 'open' ? Infinity : 10_000,
    refetchInterval: live === 'open' ? false : 15_000,
  });
  const history = useQuery({
    queryKey: historyKey(id, '24h'),
    queryFn: ({ signal }) => fetchHistory(id, '24h', signal),
    enabled: id !== '',
    refetchInterval: 5 * 60_000,
  });

  if (detail.error) {
    return (
      <Alert
        tone={isApiError(detail.error, 'not_found') ? 'info' : 'crit'}
        title={
          isApiError(detail.error, 'not_found')
            ? 'Diesen Server gibt es nicht (mehr).'
            : errorText(detail.error)
        }
        action={
          <Link className="hz-btn hz-btn-secondary hz-btn-sm" to="/servers">
            Zur Serverliste
          </Link>
        }
      />
    );
  }
  if (!detail.data) return null;
  return <Detail d={detail.data} history={history.data} />;
}

function Detail({ d, history }: { d: ServerDetail; history?: HistoryResponse | undefined }) {
  const s = d.server;
  const t = d.thresholds;
  const now = useNow(30_000);
  const [dialog, setDialog] = useState<'cleanup' | 'reboot' | null>(null);
  const { hash } = useLocation();
  const automatik = useRef<HTMLDivElement>(null);
  // Settings → Server links to #automatik.
  useEffect(() => {
    if (hash === '#automatik') automatik.current?.scrollIntoView({ block: 'start' });
  }, [hash]);
  const offline = !s.connected;
  const diskIssue = s.reasons.some((r) => r.code === 'disk_warn' || r.code === 'disk_crit');
  const servers = useServers();
  const wol = useWol(s.id);
  const wake = useWake(s.id);
  // SPEC 16: a server that is off and has a MAC shows "Aufwecken" as the main action.
  const canWake = offline && !!wol.data?.mac;
  const wakeError = wakeErrorOf(wake.error);

  return (
    <>
      {s.reasons.length ? (
        <div className="app-stack" aria-label="Status-Gründe">
          {s.reasons.map((r) => (
            <Alert key={r.code} tone={r.level} title={r.text} />
          ))}
        </div>
      ) : null}

      {canWake ? (
        <div className="app-stack" aria-label="Aufwecken">
          <Alert
            tone="info"
            title={`${s.name} ist aus.`}
            action={
              <Button
                variant="primary"
                icon="power"
                disabled={wake.isPending}
                onClick={() => wake.mutate()}
              >
                Aufwecken
              </Button>
            }
          >
            {wake.isSuccess && !wake.isPending
              ? 'Magic Packet gesendet. Der Server braucht meist 30–90 s, bis sich der Agent wieder meldet.'
              : `Wake-on-LAN an ${wol.data?.mac ?? ''} über ${viaText(
                  wol.data?.via ?? 'core',
                  new Map((servers.data ?? []).map((x) => [x.id, x.name])),
                )}.`}
          </Alert>
          {wakeError ? <FormError title={wakeError} /> : null}
        </div>
      ) : null}

      <div className="hz-grid app-grid">
        <Tile
          title="Auslastung"
          icon="cpu"
          span={2}
          status={s.status}
          footer={
            s.lastSeen ? (
              <span className="app-foot-text">gemeldet {formatAgo(new Date(s.lastSeen), now)}</span>
            ) : (
              <span className="app-foot-text">noch keine Messwerte</span>
            )
          }
        >
          <div className="app-bars">
            <UsageBar
              label="CPU"
              value={s.cpu ?? 0}
              detail={formatPercent(s.cpu)}
              warnAt={t.cpuWarn}
              critAt={Math.max(t.cpuWarn, 95)}
            />
            <UsageBar
              label="RAM"
              value={s.ramPct ?? 0}
              detail={
                d.ram
                  ? `${formatBytesOf(d.ram.usedBytes, d.ram.totalBytes)} · ${formatPercent(s.ramPct)}`
                  : formatPercent(s.ramPct)
              }
              warnAt={t.ramWarn}
              critAt={t.ramCrit}
            />
            {d.swap && d.swap.totalBytes > 0 ? (
              <UsageBar
                label="Swap"
                value={pctOf(d.swap.usedBytes, d.swap.totalBytes)}
                detail={formatBytesOf(d.swap.usedBytes, d.swap.totalBytes)}
              />
            ) : null}
            {d.disks.map((disk) => {
              const p = pctOf(disk.usedBytes, disk.totalBytes);
              return (
                <UsageBar
                  key={disk.mount}
                  label={`Disk ${disk.mount}`}
                  value={p}
                  detail={`${formatBytesOf(disk.usedBytes, disk.totalBytes)} · ${formatPercent(p)}`}
                  warnAt={t.diskWarn}
                  critAt={t.diskCrit}
                />
              );
            })}
            {s.temp != null ? (
              <UsageBar
                label="Temp"
                value={s.temp}
                detail={formatTemp(s.temp)}
                warnAt={t.tempWarn}
                critAt={t.tempWarn + 10}
              />
            ) : null}
          </div>
        </Tile>

        <HistoryTile history={history} net={d.net} cpu={s.cpu} ram={s.ramPct} />

        <Tile title="System" icon="server" span={2}>
          <dl className="app-kv">
            <dt>OS</dt>
            <dd>{d.system?.os ?? s.os ?? '—'}</dd>
            <dt>Kernel</dt>
            <dd>{d.system?.kernel ?? '—'}</dd>
            <dt>Architektur</dt>
            <dd>{d.system?.arch ?? s.arch ?? '—'}</dd>
            {d.system?.cpuModel ? (
              <>
                <dt>CPU</dt>
                <dd>
                  {d.system.cpuModel}
                  {d.system.cpuCores ? ` · ${d.system.cpuCores} Kerne` : ''}
                </dd>
              </>
            ) : null}
            <dt>Uptime</dt>
            <dd>{formatUptime(s.uptimeS)}</dd>
            <dt>Tailscale-IP</dt>
            <dd>{s.tailscaleIp ?? d.system?.tailscaleIp ?? '—'}</dd>
            {(s.publicIp ?? d.system?.publicIp) ? (
              <>
                <dt>Öffentliche IP</dt>
                <dd>{s.publicIp ?? d.system?.publicIp}</dd>
              </>
            ) : null}
            {d.system?.dockerVersion ? (
              <>
                <dt>Docker</dt>
                <dd>{d.system.dockerVersion}</dd>
              </>
            ) : null}
            <dt>Agent</dt>
            <dd>{s.agentVersion ?? '—'}</dd>
            <dt>Ort</dt>
            <dd>{s.location || '—'}</dd>
          </dl>
        </Tile>

        <Tile
          title="Updates"
          icon="refresh"
          status={
            d.updates == null
              ? undefined
              : d.updates.security > 0 || d.rebootRequired
                ? 'warn'
                : 'ok'
          }
        >
          {d.updates ? (
            <div className="app-metrics">
              <Metric label="Offen" value={formatNumber(d.updates.total, 0)} unit="Pakete" />
              <Metric label="Sicherheit" value={formatNumber(d.updates.security, 0)} />
            </div>
          ) : (
            <p className="app-empty">Paketstand nicht lesbar.</p>
          )}
          {d.rebootRequired != null ? (
            <div className="app-line">
              {d.rebootRequired ? (
                <StatusDot status="warn" label="Neustart nötig" />
              ) : (
                <StatusDot status="ok" label="Kein Neustart nötig" />
              )}
            </div>
          ) : null}
        </Tile>

        <Tile
          title="Sicherheit"
          icon="lock"
          count={d.listeningPorts.length ? `${d.listeningPorts.length} Ports` : undefined}
        >
          <div className="app-metrics">
            <Metric
              label="SSH-Fehlversuche 24 h"
              value={d.sshFailed24h == null ? '—' : formatNumber(d.sshFailed24h, 0)}
            />
            <Metric
              label="fail2ban gesperrt"
              value={d.fail2banBanned == null ? '—' : formatNumber(d.fail2banBanned, 0)}
              hint={d.fail2banBanned == null ? 'nicht installiert' : undefined}
            />
          </div>
          {d.listeningPorts.length ? (
            <ul className="app-ports" aria-label="Offene Ports">
              {[...d.listeningPorts]
                .sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto))
                .map((p) => (
                  <li key={`${p.proto}-${p.address}-${p.port}`}>
                    <span className="app-port">
                      {p.port}/{p.proto}
                    </span>
                    <span className="app-port-addr">{p.address}</span>
                    <span className="app-port-proc">{p.process ?? ''}</span>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="app-empty">Keine offenen Ports gemeldet.</p>
          )}
        </Tile>

        <StorageTile serverId={s.id} />

        <OpenPortsTile serverId={s.id} serverName={s.name} />

        <ServerContainers server={s} />

        <div className="hz-span-4 app-anchor" id="automatik" ref={automatik}>
          <AutomatikTile serverId={s.id} serverName={s.name} />
        </div>

        <WolTile serverId={s.id} serverName={s.name} servers={servers.data ?? []} />

        <Tile title="Aktionen" icon="power" span={4}>
          <div className="app-actions">
            <Button
              variant={diskIssue && !offline ? 'primary' : 'secondary'}
              icon="refresh"
              disabled={offline}
              onClick={() => setDialog('cleanup')}
            >
              Aufräumen
            </Button>
            <Button
              variant="danger"
              icon="power"
              disabled={offline}
              onClick={() => setDialog('reboot')}
            >
              Neustart
            </Button>
            <span className="app-text">
              {offline
                ? `Agent offline. Aufräumen und Neustart gehen wieder, sobald ${s.name} sich meldet.`
                : 'Aufräumen zeigt zuerst, wie viel Platz frei wird. Neustart braucht den Servernamen und einen Code.'}
            </span>
          </div>
        </Tile>
      </div>

      <CleanupDialog
        open={dialog === 'cleanup'}
        serverId={s.id}
        serverName={s.name}
        onClose={() => setDialog(null)}
      />
      <RebootDialog
        open={dialog === 'reboot'}
        serverId={s.id}
        serverName={s.name}
        onClose={() => setDialog(null)}
      />
    </>
  );
}

/** SPEC 5.2: "Container dieses Servers", same rows and actions as /containers. */
function ServerContainers({ server }: { server: ServerDetail['server'] }): ReactElement | null {
  useLiveTopic('containers');
  const containers = useContainers();
  const servers = useServers();
  if (!containers.data) return null;
  const list = containers.data.filter((c) => c.serverId === server.id);
  if (!list.length) {
    return (
      <Tile title="Container dieses Servers" icon="container" count="0" span={4}>
        <p className="app-empty">
          {server.name} meldet keine Container. Der Agent zeigt sie, sobald er den Docker-Socket
          lesen darf.
        </p>
      </Tile>
    );
  }
  return (
    <ContainerGroups
      containers={list}
      servers={servers.data ?? [server]}
      title={() => 'Container dieses Servers'}
    />
  );
}

function SparkRow({
  label,
  data,
  value,
  tone,
}: {
  label: string;
  data: number[];
  value: string;
  tone?: 'accent' | 'ok' | 'info' | 'muted';
}): ReactElement {
  return (
    <div className="app-spark-row">
      <span className="hz-usage-label">{label}</span>
      {data.length >= 2 ? (
        <Sparkline data={data} width={192} height={24} tone={tone} />
      ) : (
        <span className="app-spark-empty">zu wenig Daten</span>
      )}
      <span className="hz-usage-val">{value}</span>
    </div>
  );
}

function HistoryTile({
  history,
  net,
  cpu,
  ram,
}: {
  history?: HistoryResponse | undefined;
  net: ServerDetail['net'];
  cpu: number | null;
  ram: number | null;
}): ReactElement {
  const points = history?.points ?? [];
  const series = (pick: (p: HistoryResponse['points'][number]) => number): number[] =>
    bucket(points.map(pick), SPARK_BARS);
  return (
    <Tile title="Verlauf 24 h" icon="cpu" span={2}>
      <div className="app-bars">
        <SparkRow label="CPU" data={series((p) => p.cpu)} value={formatPercent(cpu)} />
        <SparkRow label="RAM" data={series((p) => p.ramPct)} value={formatPercent(ram)} />
        <SparkRow
          label="Netz ein"
          data={series((p) => p.netIn)}
          value={formatRate(net?.rxBps)}
          tone="info"
        />
        <SparkRow
          label="Netz aus"
          data={series((p) => p.netOut)}
          value={formatRate(net?.txBps)}
          tone="muted"
        />
      </div>
    </Tile>
  );
}
