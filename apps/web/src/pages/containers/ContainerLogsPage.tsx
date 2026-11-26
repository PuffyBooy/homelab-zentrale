import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { Link, useParams } from 'react-router';
import { Alert, Button, StatusDot, Terminal, Tile } from '@hz/ui';
import { containerSub } from '../../lib/containers.js';
import { useContainers } from '../../lib/data.js';
import { formatNumber, plural } from '../../lib/format.js';
import { useLiveState, useLiveTopic } from '../../lib/live.js';
import {
  MAX_LOG_LINES,
  containerLogsKey,
  findMatches,
  stepMatch,
  toTerminalLines,
  type LogBuffer,
  type LogMatch,
} from '../../lib/logs.js';

/** Distance from the bottom (px) that still counts as "at the end". */
const BOTTOM_SLACK = 24;
const HL_MATCH = 'hz-log-match';
const HL_CURRENT = 'hz-log-current';

function highlightsSupported(): boolean {
  return typeof Highlight !== 'undefined' && typeof CSS !== 'undefined' && 'highlights' in CSS;
}

/**
 * Marks search matches with the CSS Custom Highlight API: no extra DOM, the Terminal
 * stays the 1:1 port, the colours come from tokens in app.css (::highlight()).
 */
function paintMatches(body: HTMLElement | null, matches: LogMatch[], current: number): void {
  if (!highlightsSupported()) return;
  CSS.highlights.delete(HL_MATCH);
  CSS.highlights.delete(HL_CURRENT);
  if (!body || !matches.length) return;
  const rows = body.querySelectorAll<HTMLElement>('.hz-term-line');
  const all = new Highlight();
  const cur = new Highlight();
  matches.forEach((m, i) => {
    const text = rows[m.line]?.firstChild;
    if (!text || text.nodeType !== Node.TEXT_NODE) return;
    const len = text.textContent?.length ?? 0;
    if (m.end > len) return;
    const r = new Range();
    r.setStart(text, m.start);
    r.setEnd(text, m.end);
    (i === current ? cur : all).add(r);
  });
  CSS.highlights.set(HL_MATCH, all);
  CSS.highlights.set(HL_CURRENT, cur);
}

/** /containers/:id/logs (SPEC 6.1): last 500 lines plus follow, pause and search. */
export function ContainerLogsPage(): ReactElement | null {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const live = useLiveState();
  const topic = id ? `container-logs:${id}` : null;
  useLiveTopic('containers');
  useLiveTopic(topic);
  const containers = useContainers();
  const c = containers.data?.find((x) => x.id === id);

  // Fed only by the live socket (lib/live.ts); dropped when the page closes.
  const logs = useQuery<LogBuffer>({ queryKey: containerLogsKey(id), queryFn: skipToken });
  useEffect(
    () => () => qc.removeQueries({ queryKey: containerLogsKey(id), exact: true }),
    [qc, id],
  );

  const [follow, setFollow] = useState(true);
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(-1);
  const wrap = useRef<HTMLDivElement>(null);
  const searchId = useId();

  const all = useMemo(() => logs.data?.lines ?? [], [logs.data]);
  const shown = useMemo(
    () => (pausedAt == null ? all : all.filter((l) => l.seq <= pausedAt)),
    [all, pausedAt],
  );
  const waiting = pausedAt == null ? 0 : all.length - shown.length;
  const lines = useMemo(() => toTerminalLines(shown), [shown]);
  const matches = useMemo(() => findMatches(shown, query), [shown, query]);
  const cur = current >= matches.length ? matches.length - 1 : current;

  const body = useCallback(
    () => wrap.current?.querySelector<HTMLElement>('.hz-term-body') ?? null,
    [],
  );

  // Follow: stay at the end while new lines arrive.
  useLayoutEffect(() => {
    const el = body();
    if (el && follow && pausedAt == null) el.scrollTop = el.scrollHeight;
  }, [lines, follow, pausedAt, body]);

  // Scrolling up stops following; scrolling back to the end starts it again.
  useEffect(() => {
    const el = body();
    if (!el) return;
    // The log box scrolls on its own, so it must be reachable with the keyboard.
    el.tabIndex = 0;
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Log-Ausgabe');
    const onScroll = (): void => {
      const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
      setFollow(atEnd);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [body, c]);

  useEffect(() => {
    paintMatches(body(), matches, cur);
  }, [matches, cur, lines, body]);
  useEffect(
    () => () => {
      if (highlightsSupported()) {
        CSS.highlights.delete(HL_MATCH);
        CSS.highlights.delete(HL_CURRENT);
      }
    },
    [],
  );

  function jump(dir: 1 | -1): void {
    const next = stepMatch(cur, matches.length, dir);
    setCurrent(next);
    const m = matches[next];
    const el = body();
    const row = m && el ? el.querySelectorAll<HTMLElement>('.hz-term-line')[m.line] : undefined;
    if (!row || !el) return;
    setFollow(false);
    el.scrollTop = row.offsetTop - el.clientHeight / 2;
  }

  function onSearchKey(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      jump(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape' && query) {
      e.preventDefault();
      setQuery('');
      setCurrent(-1);
    }
  }

  function togglePause(): void {
    if (pausedAt == null) {
      setPausedAt(all[all.length - 1]?.seq ?? -1);
    } else {
      setPausedAt(null);
      setFollow(true);
    }
  }

  if (containers.error && !c) {
    return <Alert tone="crit" title="Container-Liste nicht lesbar." />;
  }
  if (!containers.data) return null;
  if (!c) {
    return (
      <Alert
        tone="info"
        title="Diesen Container gibt es nicht (mehr)."
        action={
          <Link className="hz-btn hz-btn-secondary hz-btn-sm" to="/containers">
            Zu den Containern
          </Link>
        }
      />
    );
  }

  const paused = pausedAt != null;
  const ended = logs.data?.ended ?? false;
  const loading = !logs.data;
  const status = loading
    ? live === 'open'
      ? 'verbindet mit dem Log …'
      : 'Live-Verbindung getrennt · neuer Versuch läuft'
    : paused
      ? waiting
        ? `pausiert · ${plural(waiting, 'neue Zeile', 'neue Zeilen')}`
        : 'pausiert'
      : ended
        ? 'Stream beendet'
        : follow
          ? 'folgt'
          : 'angehalten beim Scrollen';

  return (
    <Tile
      title={c.name}
      icon="terminal"
      count={containerSub(c)}
      status={c.status}
      span={4}
      actions={
        <Link className="hz-btn hz-btn-ghost hz-btn-sm" to={`/containers?server=${c.serverId}`}>
          Alle Container
        </Link>
      }
      footer={
        <>
          <span className="app-foot-text">
            {formatNumber(shown.length, 0)} Zeilen · höchstens {formatNumber(MAX_LOG_LINES, 0)} im
            Fenster
          </span>
          <span className="app-foot-text">{c.statusText}</span>
        </>
      }
    >
      <div className="app-logbar" role="toolbar" aria-label="Log-Steuerung">
        <Button
          size="sm"
          variant={follow && !paused ? 'secondary' : 'ghost'}
          aria-pressed={follow && !paused}
          disabled={paused}
          onClick={() => setFollow((f) => !f)}
        >
          Folgen
        </Button>
        <Button
          size="sm"
          variant={paused ? 'secondary' : 'ghost'}
          aria-pressed={paused}
          onClick={togglePause}
        >
          {paused ? 'Weiter' : 'Pause'}
        </Button>
        <div className="app-logsearch">
          <label className="hz-sr" htmlFor={searchId}>
            Suche im Log
          </label>
          <input
            id={searchId}
            className="hz-input hz-input-mono"
            type="search"
            placeholder="Suchen"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCurrent(-1);
            }}
            onKeyDown={onSearchKey}
          />
          <span className="app-logsearch-n" aria-live="polite">
            {query
              ? matches.length
                ? cur >= 0
                  ? `${formatNumber(cur + 1, 0)} von ${formatNumber(matches.length, 0)}`
                  : plural(matches.length, 'Treffer', 'Treffer')
                : 'kein Treffer'
              : ''}
          </span>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Vorheriger Treffer"
            disabled={!matches.length}
            onClick={() => jump(-1)}
          >
            ↑
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Nächster Treffer"
            disabled={!matches.length}
            onClick={() => jump(1)}
          >
            ↓
          </Button>
        </div>
        <span className="app-logstate" aria-live="polite">
          <StatusDot
            status={loading ? 'busy' : paused || ended ? 'off' : 'ok'}
            label={status}
            pulse={false}
          />
        </span>
      </div>
      <div className="app-term" ref={wrap}>
        <div className="app-term-scope" data-theme="dark">
          <Terminal
            title={`docker logs ${c.name}`}
            host={c.serverName}
            lines={lines}
            height="min(64vh, 640px)"
            cursor={false}
          />
        </div>
      </div>
    </Tile>
  );
}
