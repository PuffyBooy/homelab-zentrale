import type { GameSummary } from '@hz/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { Button, Sparkline, Tile } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { errorText } from '../../lib/errors.js';
import { formatWhen, plural } from '../../lib/format.js';
import {
  displayHour,
  fetchStats,
  hoursSummary,
  hoursUntilNow,
  peakHourText,
  peakText,
  playtimeText,
  sortPlayers,
  statsKey,
} from '../../lib/gameFeatures.js';

const RANGES = [7, 30] as const;
const MAX_ROWS = 20;

/**
 * Spielerstatistik (M12, SPEC 6.5): play time per player, sessions, last seen, the
 * average players per hour of day as bars (Sparkline, ending at the current hour) and
 * the peak. 7 or 30 days.
 */
export function StatsTile({ game, now }: { game: GameSummary; now: Date }): ReactElement {
  const [days, setDays] = useState<7 | 30>(7);
  const q = useQuery({
    queryKey: statsKey(game.id, days),
    queryFn: ({ signal }) => fetchStats(game.id, days, signal),
    placeholderData: keepPreviousData,
  });
  const data = q.data;
  const players = data ? sortPlayers(data.players) : [];
  const bars = data ? hoursUntilNow(data.hours, displayHour(now)) : null;
  const peakHour = data ? peakHourText(data.hours) : null;

  return (
    <Tile
      title="Statistik"
      icon="users"
      count={data ? String(data.players.length) : undefined}
      span={2}
      flush
      actions={
        <div className="app-range" role="group" aria-label="Zeitraum">
          {RANGES.map((r) => (
            <Button
              key={r}
              size="sm"
              variant={r === days ? 'secondary' : 'ghost'}
              aria-pressed={r === days}
              onClick={() => setDays(r)}
            >
              {r} Tage
            </Button>
          ))}
        </div>
      }
      footer={
        <span className="app-foot-text">Daten der letzten 90 Tage · Abfrage jede Minute</span>
      }
    >
      {q.error && !data ? (
        <div className="app-pad">
          <FormError title={errorText(q.error)} />
        </div>
      ) : null}
      {data && bars ? (
        <div className="app-pad hz-form">
          <div className="app-stats-hours">
            <span className="hz-label">Ø Spieler pro Stunde</span>
            <Sparkline data={bars.data} width={240} height={40} tone="muted" />
            <span className="app-stats-axis">
              <span>{String(bars.first).padStart(2, '0')} Uhr</span>
              <span>jetzt</span>
            </span>
            <span className="hz-sr">{hoursSummary(data.hours)}</span>
          </div>
          <dl className="app-kv">
            <dt>Spitzenzeit</dt>
            <dd>{peakHour ?? 'noch keine Spieler'}</dd>
            <dt>Höchststand</dt>
            <dd>{peakText(data.peak, now)}</dd>
          </dl>
        </div>
      ) : null}
      {data && !data.names ? (
        <p className="app-empty app-pad">
          {game.game} meldet keine Spielernamen, nur die Zahl. Deshalb keine Liste pro Spieler.
        </p>
      ) : null}
      {data && data.names && players.length === 0 ? (
        <p className="app-empty app-pad">In den letzten {days} Tagen hat niemand gespielt.</p>
      ) : null}
      {players.slice(0, MAX_ROWS).map((p) => (
        <div key={p.name} className="hz-row" data-testid="stats-player">
          <div className="hz-row-main">
            <span className="hz-row-name app-break">{p.name}</span>
            <span className="hz-row-sub">
              {plural(p.sessions, 'Sitzung', 'Sitzungen')} · zuletzt{' '}
              {formatWhen(new Date(p.lastSeen), now)}
            </span>
          </div>
          <div className="hz-row-meta">{playtimeText(p.seconds)}</div>
        </div>
      ))}
      {players.length > MAX_ROWS ? (
        <p className="app-empty app-pad">+{players.length - MAX_ROWS} weitere Spieler</p>
      ) : null}
    </Tile>
  );
}
