import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Badge, Button, StatusDot, Tile } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { SelectField } from '../../components/SelectField.js';
import { requestStepUp } from '../../lib/api.js';
import {
  closeReasonText,
  consoleSessionsKey,
  consoleTargets,
  consoleUrl,
  containerCloseText,
  containerTargets,
  ConsoleSocket,
  fetchConsoleSessions,
  formatSessionDuration,
  type ConsoleCloseReason,
  type ConsoleSession,
} from '../../lib/console.js';
import { useContainers, useServers } from '../../lib/data.js';
import { errorText } from '../../lib/errors.js';
import { formatBytes, formatDateTime } from '../../lib/format.js';
import { useAuthState } from '../../lib/useAuthState.js';
import { useNow } from '../../lib/useNow.js';
import { useTheme } from '../../lib/theme.js';
import type { TermHandle } from './xterm.js';

type Phase =
  | { kind: 'idle' }
  | { kind: 'stepup' }
  | { kind: 'connecting' }
  | { kind: 'open'; since: number }
  | { kind: 'closed'; text: string; reason: ConsoleCloseReason | 'cancelled' };

function stepUpActive(until: string | undefined): boolean {
  return !!until && new Date(until).getTime() - Date.now() > 5_000;
}

/**
 * /console (SPEC 11): web terminal to one server through its agent (PTY). M23: the
 * target is the host or one running container of that server (docker exec).
 * /console?server=<id>[&container=<core container id>] connects right away.
 */
export function ConsolePage(): ReactElement {
  const servers = useServers();
  const containers = useContainers();
  const auth = useAuthState();
  const [theme] = useTheme();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const targets = useMemo(() => consoleTargets(servers.data ?? []), [servers.data]);
  const wanted = params.get('server');
  const wantedContainer = params.get('container');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [serverId, setServerId] = useState<string | null>(() => params.get('server'));
  /** Core container id of the shell target; null = the host. */
  const [target, setTarget] = useState<string | null>(() => params.get('container'));
  /** Target of the current or last session (for the header and "Neu verbinden"). */
  const [session, setSession] = useState<{ serverId: string; container: string | null } | null>(
    null,
  );
  const [termError, setTermError] = useState<string | null>(null);
  const [termReady, setTermReady] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<TermHandle | null>(null);
  const socketRef = useRef<ConsoleSocket | null>(null);
  const autoRef = useRef<string | null>(null);
  const connectRef = useRef<
    ((id: string, container: string | null, retried: boolean) => Promise<void>) | null
  >(null);

  const server = targets.find((t) => t.server.id === serverId)?.server ?? null;
  // The picker works on the chosen server, else on the first usable one.
  const pickServer = server ?? targets.find((t) => t.usable)?.server ?? null;
  const pickUsable = !!targets.find((t) => t.server.id === pickServer?.id)?.usable;
  const shells = useMemo(
    () => containerTargets(containers.data ?? [], pickServer?.id ?? null),
    [containers.data, pickServer?.id],
  );
  const nameOf = useCallback(
    (id: string | null): string | null =>
      id ? (containers.data?.find((c) => c.id === id)?.name ?? 'Container') : null,
    [containers.data],
  );
  const sessionServer = targets.find((t) => t.server.id === session?.serverId)?.server ?? server;
  const sessionContainer = nameOf(session?.container ?? null);

  const ensureTerm = useCallback(async (): Promise<TermHandle | null> => {
    if (termRef.current) return termRef.current;
    const el = hostRef.current;
    if (!el) return null;
    try {
      const [{ createTerm }] = await Promise.all([import('./xterm.js'), document.fonts.ready]);
      if (termRef.current) return termRef.current;
      termRef.current = createTerm(el, {
        onData: (d) => socketRef.current?.input(d),
        onResize: (cols, rows) => socketRef.current?.resize(cols, rows),
        onLeave: () => document.querySelector<HTMLElement>('[data-console-leave]')?.focus(),
      });
      setTermReady(true);
      return termRef.current;
    } catch {
      setTermError('Konsole konnte nicht geladen werden. Seite neu laden.');
      return null;
    }
  }, []);

  const connect = useCallback(
    async (id: string, container: string | null = null, retried = false): Promise<void> => {
      socketRef.current?.close();
      socketRef.current = null;
      setServerId(id);
      setTarget(container);
      setSession({ serverId: id, container });
      setTermError(null);
      const ctrName = nameOf(container);
      if (!retried && !stepUpActive(auth.data?.stepUpUntil)) {
        setPhase({ kind: 'stepup' });
        if (!(await requestStepUp())) {
          setPhase({
            kind: 'closed',
            reason: 'cancelled',
            text: 'Abgebrochen. Ohne Code aus der App keine Konsole.',
          });
          return;
        }
      }
      setPhase({ kind: 'connecting' });
      const term = await ensureTerm();
      if (!term) {
        setPhase({ kind: 'idle' });
        return;
      }
      term.reset();
      term.fit();
      const socket = new ConsoleSocket({
        url: consoleUrl(id, window.location, container),
        cols: term.cols,
        rows: term.rows,
        onEvent: (e) => {
          if (socketRef.current !== socket) return;
          if (e.type === 'ready') {
            setPhase({ kind: 'open', since: Date.now() });
            term.focus();
          } else if (e.type === 'output') {
            term.write(e.data);
          } else {
            socketRef.current = null;
            void qc.invalidateQueries({ queryKey: consoleSessionsKey });
            if (e.reason === 'step_up_required' && !retried) {
              setPhase({ kind: 'stepup' });
              void requestStepUp().then((ok) => {
                if (ok) void connectRef.current?.(id, container, true);
                else
                  setPhase({
                    kind: 'closed',
                    reason: 'cancelled',
                    text: 'Abgebrochen. Ohne Code aus der App keine Konsole.',
                  });
              });
              return;
            }
            const text = ctrName
              ? containerCloseText(e.reason, e.exitCode, ctrName)
              : closeReasonText(e.reason, e.exitCode);
            term.writeNote(text);
            setPhase({ kind: 'closed', reason: e.reason, text });
          }
        },
      });
      socketRef.current = socket;
    },
    [auth.data?.stepUpUntil, ensureTerm, qc, nameOf],
  );

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  // /console?server=<id> (command palette "Konsole <server>") connects right away;
  // with &container=<id> (container row "Shell") into that container.
  useEffect(() => {
    const key = `${wanted ?? ''}/${wantedContainer ?? ''}`;
    if (!wanted || autoRef.current === key) return;
    const t = targets.find((x) => x.server.id === wanted);
    if (!t) return;
    if (wantedContainer && !containers.data) return;
    autoRef.current = key;
    setParams({}, { replace: true });
    const ctr = wantedContainer
      ? (containerTargets(containers.data ?? [], wanted).find((c) => c.id === wantedContainer) ??
        null)
      : null;
    // Out of the effect body: connect() and setState.
    queueMicrotask(() => {
      setServerId(wanted);
      if (wantedContainer && !ctr) {
        setTarget(null);
        setTermError(
          'Dieser Container ist nicht wählbar: er läuft nicht oder ist geschützt. Ziel wählen.',
        );
        return;
      }
      setTarget(ctr?.id ?? null);
      if (t.usable) void connect(wanted, ctr?.id ?? null);
    });
  }, [wanted, wantedContainer, targets, containers.data, connect, setParams]);

  useEffect(
    () => () => {
      socketRef.current?.close();
      socketRef.current = null;
      termRef.current?.dispose();
      termRef.current = null;
    },
    [],
  );

  const disconnect = (): void => {
    const s = socketRef.current;
    if (s) s.close();
  };

  const usable = targets.filter((t) => t.usable).length;
  const active = phase.kind === 'open' || phase.kind === 'connecting';

  return (
    <div className="app-console">
      <Tile
        title="Server"
        icon="server"
        count={servers.data ? `${usable}/${targets.length}` : undefined}
        flush
      >
        {servers.isPending ? <p className="app-empty app-pad">Lade Server …</p> : null}
        {servers.isError ? (
          <div className="app-pad">
            <FormError title={errorText(servers.error)} />
          </div>
        ) : null}
        {servers.data && targets.length === 0 ? (
          <p className="app-empty app-pad">
            Noch kein Server verbunden. <Link to="/servers">Server hinzufügen</Link>
          </p>
        ) : null}
        <ul className="app-console-list" aria-label="Server für die Konsole">
          {targets.map((t) => {
            const current = t.server.id === serverId && active;
            return (
              <li key={t.server.id} className="hz-row" data-testid="console-target">
                <StatusDot status={t.usable ? 'ok' : 'off'} />
                <div className="hz-row-main">
                  <span className="hz-row-name">{t.server.name}</span>
                  <span className="hz-row-sub">
                    {t.usable ? t.server.location || 'Konsole bereit' : t.reason}
                  </span>
                </div>
                <div className="hz-row-actions">
                  <Button
                    size="sm"
                    variant={current ? 'ghost' : 'secondary'}
                    icon="terminal"
                    disabled={!t.usable || current}
                    aria-label={`Konsole ${t.server.name} ${current ? 'verbunden' : 'verbinden'}`}
                    onClick={() => void connect(t.server.id, null)}
                  >
                    {current ? 'Verbunden' : 'Verbinden'}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </Tile>

      <div className="app-console-term" data-hz-terminal="">
        {pickServer ? (
          <TargetPicker
            serverName={pickServer.name}
            shells={shells.map((c) => ({ id: c.id, name: c.name }))}
            value={
              pickServer.id === serverId && target && shells.some((c) => c.id === target)
                ? target
                : ''
            }
            disabled={!pickUsable}
            onChange={(v) => {
              setServerId(pickServer.id);
              setTarget(v || null);
            }}
            onConnect={(v) => void connect(pickServer.id, v || null)}
          />
        ) : null}
        {/* The terminal stays dark (design/README.md): in the light theme its subtree uses the
            dark tokens, so ANSI and status colours keep their contrast on terminal-bg. */}
        <div className="hz-term" data-theme={theme === 'light' ? 'dark' : undefined}>
          <div className="hz-term-head">
            <span data-testid="console-target-head">
              {sessionContainer ? `Shell in ${sessionContainer}` : 'konsole · Host'}
            </span>
            <span className="hz-term-host">
              {sessionServer ? sessionServer.name : 'kein Server'}
            </span>
          </div>
          <div ref={hostRef} className="app-xterm" hidden={phase.kind === 'idle' && !termReady} />
          {phase.kind === 'idle' && !termReady ? (
            <p className="hz-term-body app-xterm-empty">
              Server wählen und verbinden. Jede Sitzung wird protokolliert (wer, wann, Dauer),
              Tastenanschläge nicht.
            </p>
          ) : null}
        </div>
        <StatusLine
          phase={phase}
          serverName={
            sessionServer
              ? sessionContainer
                ? `${sessionContainer} auf ${sessionServer.name}`
                : sessionServer.name
              : null
          }
          onDisconnect={disconnect}
          onReconnect={
            session ? () => void connect(session.serverId, session.container) : undefined
          }
          canReconnect={!!targets.find((t) => t.server.id === session?.serverId)?.usable}
        />
        {termError ? <FormError title={termError} /> : null}
      </div>

      <SessionsTile />
    </div>
  );
}

/** Target of the next session: the host or one running container of the server (M23). */
export function TargetPicker({
  serverName,
  shells,
  value,
  disabled,
  onChange,
  onConnect,
}: {
  serverName: string;
  shells: readonly { id: string; name: string }[];
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
  onConnect: (v: string) => void;
}): ReactElement {
  return (
    <div className="app-console-pick">
      <SelectField
        label={`Ziel auf ${serverName}`}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        options={[
          { value: '', label: `Host · ${serverName}` },
          ...shells.map((c) => ({ value: c.id, label: `Container · ${c.name}` })),
        ]}
        hint={
          shells.length
            ? 'Shell im Container mit bash, sonst sh. Geschützte Container fehlen in der Liste.'
            : 'Kein laufender Container für eine Shell.'
        }
      />
      <Button
        size="sm"
        variant="secondary"
        icon="terminal"
        disabled={disabled}
        onClick={() => onConnect(value)}
      >
        {value ? 'Shell öffnen' : 'Verbinden'}
      </Button>
    </div>
  );
}

function StatusLine({
  phase,
  serverName,
  onDisconnect,
  onReconnect,
  canReconnect,
}: {
  phase: Phase;
  serverName: string | null;
  onDisconnect: () => void;
  onReconnect: (() => void) | undefined;
  canReconnect: boolean;
}): ReactElement {
  const now = useNow(15_000);
  let text: string;
  let status: 'ok' | 'busy' | 'off' | 'warn' = 'off';
  if (phase.kind === 'open') {
    status = 'ok';
    const sec = Math.max(0, (now.getTime() - phase.since) / 1000);
    text = `verbunden mit ${serverName ?? 'Server'} · ${sec < 60 ? 'gerade eben' : formatSessionDuration(sec)}`;
  } else if (phase.kind === 'connecting') {
    status = 'busy';
    text = `verbinde mit ${serverName ?? 'Server'} …`;
  } else if (phase.kind === 'stepup') {
    status = 'busy';
    text = 'Warte auf den Code aus der App …';
  } else if (phase.kind === 'closed') {
    status = phase.reason === 'closed' || phase.reason === 'exit' ? 'off' : 'warn';
    text = `Getrennt. ${phase.text}`;
  } else {
    text = 'Nicht verbunden.';
  }
  return (
    <div className="app-console-status">
      <span role="status" className="app-console-status-text" data-testid="console-status">
        <StatusDot status={status} />
        <span>{text}</span>
      </span>
      <span className="app-console-actions">
        {phase.kind === 'open' ? (
          <span className="app-foot-text">F6 verlässt die Konsole</span>
        ) : null}
        {phase.kind === 'open' || phase.kind === 'connecting' ? (
          <Button data-console-leave="" size="sm" icon="door" onClick={onDisconnect}>
            Trennen
          </Button>
        ) : phase.kind === 'closed' && onReconnect && canReconnect ? (
          <Button size="sm" icon="refresh" onClick={onReconnect}>
            Neu verbinden
          </Button>
        ) : null}
      </span>
    </div>
  );
}

function SessionsTile(): ReactElement {
  const sessions = useQuery({
    queryKey: consoleSessionsKey,
    queryFn: ({ signal }) => fetchConsoleSessions(signal),
    refetchInterval: 60_000,
  });
  const list = sessions.data ?? [];
  return (
    <Tile
      title="Letzte Sitzungen"
      icon="lock"
      count={sessions.data ? list.length : undefined}
      flush
      className="app-console-sessions"
    >
      {sessions.isPending ? <p className="app-empty app-pad">Lade Sitzungen …</p> : null}
      {sessions.isError ? (
        <div className="app-pad">
          <FormError title={errorText(sessions.error)} />
        </div>
      ) : null}
      {sessions.data && list.length === 0 ? (
        <p className="app-empty app-pad">Noch keine Konsolen-Sitzung.</p>
      ) : null}
      {list.map((s) => (
        <SessionRow key={s.id} s={s} />
      ))}
    </Tile>
  );
}

function SessionRow({ s }: { s: ConsoleSession }): ReactElement {
  const running = s.endedAt === null;
  const reason =
    s.reason && s.reason !== 'closed' && s.reason !== 'exit'
      ? closeReasonText(s.reason, null)
      : null;
  return (
    <div className="hz-row" data-testid="console-session">
      <StatusDot status={running ? 'ok' : 'off'} />
      <div className="hz-row-main">
        <span className="hz-row-name">{s.serverName}</span>
        <span className="hz-row-sub">
          {formatDateTime(new Date(s.startedAt))}
          {s.ip ? ` · von ${s.ip}` : ''}
          {reason ? ` · ${reason}` : ''}
        </span>
      </div>
      <div className="hz-row-meta app-console-meta">
        {running ? (
          <Badge tone="ok">läuft</Badge>
        ) : (
          <span className="hz-num">
            {s.durationSec !== null ? formatSessionDuration(s.durationSec) : '—'}
          </span>
        )}
        <span className="app-foot-text">
          {formatBytes(s.bytesIn)} rein · {formatBytes(s.bytesOut)} raus
        </span>
      </div>
    </div>
  );
}
