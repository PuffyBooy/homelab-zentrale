import type { WallState } from '@hz/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Button, Metric, StatusDot, Tile, cx } from '@hz/ui';
import { Brand } from '../../components/Brand.js';
import { isApiError } from '../../lib/api.js';
import { formatTime } from '../../lib/format.js';
import { forceTheme } from '../../lib/theme.js';
import {
  fetchWallState,
  hasTokenParam,
  sortWallTiles,
  startWallSession,
  wallStateKey,
  wallTokenFrom,
} from '../../lib/wall.js';

type Session = 'pending' | 'ready' | 'invalid';

/**
 * /wall (SPEC 12): read-only tablet view. No navigation, no admin data. A device link
 * /wall?t=<token> is swapped for the `hz_wall` cookie once and the token leaves the URL.
 */
export function WallPage(): ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const [session, setSession] = useState<Session>(() =>
    !hasTokenParam(location.search)
      ? 'ready'
      : wallTokenFrom(location.search)
        ? 'pending'
        : 'invalid',
  );
  const started = useRef(false);

  useEffect(() => {
    forceTheme('wall');
    const prevTitle = document.title;
    document.title = 'Wandmodus · Homelab-Zentrale';
    return () => {
      forceTheme(null);
      document.title = prevTitle;
    };
  }, []);

  useEffect(() => {
    if (started.current || !hasTokenParam(location.search)) return;
    started.current = true;
    const token = wallTokenFrom(location.search);
    // The token leaves the address bar (and history) before anything else happens.
    void navigate('/wall', { replace: true });
    if (!token) return;
    startWallSession(token).then(
      () => setSession('ready'),
      () => setSession('invalid'),
    );
  }, [location.search, navigate]);

  const state = useQuery({
    queryKey: wallStateKey,
    queryFn: ({ signal }) => fetchWallState(signal),
    enabled: session === 'ready',
    refetchInterval: (q) => (isApiError(q.state.error, 'unauthorized') ? false : 15_000),
    refetchIntervalInBackground: true,
    retry: (n, err) => !isApiError(err, 'unauthorized') && n < 2,
  });

  const unauthorized = session === 'invalid' || isApiError(state.error, 'unauthorized');
  const data = state.data;

  return (
    <div className={cx('app-wall', data?.night && 'app-wall-night')} data-testid="wall">
      <header className="app-wall-top">
        {unauthorized ? (
          <h1 className="app-wall-sentence">Gerät nicht verbunden.</h1>
        ) : data ? (
          <h1
            className={cx(
              'app-wall-sentence',
              data.tiles.some((t) => t.tone === 'crit') && 'app-wall-crit',
            )}
          >
            {data.sentence}
          </h1>
        ) : (
          <h1 className="app-wall-sentence">Verbinde mit der Zentrale …</h1>
        )}
        <WallControls updatedAt={data?.updatedAt ?? null} stale={state.isError && !!data} />
      </header>

      <main className="app-wall-main">
        {unauthorized ? (
          <div className="app-wall-note">
            <Brand />
            <p className="app-text">
              Dieser Link ist ungültig, abgelaufen oder widerrufen. In den Einstellungen unter
              Wandmodus-Geräte einen neuen Link erzeugen und hier öffnen.
            </p>
          </div>
        ) : data ? (
          <WallBoard state={data} />
        ) : state.isError ? (
          <p className="app-text" role="status">
            Zentrale nicht erreichbar. Neuer Versuch in 15 s.
          </p>
        ) : null}
      </main>
    </div>
  );
}

function WallBoard({ state }: { state: WallState }): ReactElement {
  const tiles = sortWallTiles(state.tiles);
  return (
    <>
      <div className="app-wall-grid">
        {tiles.map((t) => (
          <Tile
            key={t.id}
            status={t.tone}
            className={cx('app-wall-tile', t.tone === 'warn' && 'app-wall-warn')}
          >
            <div data-testid="wall-tile" data-tile={t.id} data-tone={t.tone}>
              <Metric
                size="wall"
                label={t.label}
                value={t.value}
                unit={t.unit ?? undefined}
                hint={t.hint ?? undefined}
              />
            </div>
          </Tile>
        ))}
      </div>
      {state.alerts.length ? (
        <ul className="app-wall-alerts" aria-label="Offene Meldungen">
          {state.alerts.map((a, i) => (
            <li
              key={`${a.openedAt}-${i}`}
              className={cx('app-wall-alert', a.level === 'crit' && 'app-wall-crit')}
            >
              <span className="app-wall-alert-time">{formatTime(new Date(a.openedAt))}</span>
              <StatusDot status={a.level} />
              <span>{a.title}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function WallControls({
  updatedAt,
  stale,
}: {
  updatedAt: string | null;
  stale: boolean;
}): ReactElement {
  const [full, setFull] = useState(() => !!document.fullscreenElement);
  useEffect(() => {
    const on = (): void => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const canFull = typeof document.documentElement.requestFullscreen === 'function';
  return (
    <div className="app-wall-meta">
      {updatedAt ? (
        <span className="app-wall-time">
          {stale ? 'Stand ' : 'aktualisiert '}
          {formatTime(new Date(updatedAt))}
          {stale ? ' · Zentrale nicht erreichbar' : ''}
        </span>
      ) : null}
      {canFull && !full ? (
        <Button
          size="sm"
          onClick={() => void document.documentElement.requestFullscreen().catch(() => undefined)}
        >
          Vollbild
        </Button>
      ) : null}
    </div>
  );
}
