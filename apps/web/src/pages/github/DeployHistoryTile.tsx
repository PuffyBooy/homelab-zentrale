import type { Deploy, RepoSummary } from '@hz/shared';
import { useQueries } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { Button, StatusDot, Tile } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { errorText } from '../../lib/errors.js';
import { formatWhen } from '../../lib/format.js';
import {
  DEPLOY_STATUS,
  TRIGGER_LABEL,
  deployDuration,
  deploysKey,
  fetchDeploys,
  isDeployRunning,
  shortSha,
} from '../../lib/github.js';

const MAX_ROWS = 20;

/** Newest deploys of all targets of a repo (SPEC 7, "Verlauf"). */
export function useRepoDeploys(repo: RepoSummary): {
  deploys: Deploy[] | undefined;
  error: unknown;
} {
  const results = useQueries({
    queries: repo.targets.map((t) => ({
      queryKey: deploysKey(t.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchDeploys(t.id, MAX_ROWS, signal),
      staleTime: 30_000,
      refetchInterval: t.deploying ? 5000 : false,
    })),
  });
  if (results.some((r) => !r.data)) {
    return { deploys: undefined, error: results.find((r) => r.error)?.error ?? null };
  }
  const all = results.flatMap((r) => r.data ?? []);
  all.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return { deploys: all.slice(0, MAX_ROWS), error: null };
}

export function DeployHistoryTile({
  repo,
  deploys,
  error,
  selected,
  now,
  onSelect,
}: {
  repo: RepoSummary;
  deploys: Deploy[] | undefined;
  error: unknown;
  selected: string | null;
  now: Date;
  onSelect: (id: string) => void;
}): ReactElement {
  const server = (targetId: string): string =>
    repo.targets.find((t) => t.id === targetId)?.serverName ?? 'Ziel gelöscht';
  return (
    <Tile
      title="Deploys"
      icon="refresh"
      count={deploys ? deploys.length : undefined}
      span={2}
      flush
    >
      {error && !deploys ? (
        <div className="app-pad">
          <FormError title={errorText(error)} />
        </div>
      ) : !deploys ? (
        <p className="app-empty app-pad">
          {repo.targets.length ? 'Lade Deploys …' : 'Noch kein Ziel, also noch keine Deploys.'}
        </p>
      ) : deploys.length === 0 ? (
        <p className="app-empty app-pad">Noch nie deployt.</p>
      ) : (
        deploys.map((d) => {
          const st = DEPLOY_STATUS[d.status];
          const dur = deployDuration(d);
          const sub = [
            formatWhen(new Date(d.startedAt), now),
            TRIGGER_LABEL[d.trigger],
            dur ? `nach ${dur}` : isDeployRunning(d) ? 'läuft' : null,
            d.summary,
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <div className="hz-row app-wrap-row" key={d.id} data-testid="deploy-row">
              <code className="hz-hash">{shortSha(d.sha)}</code>
              <div className="hz-row-main">
                <span className="hz-row-name">{server(d.targetId)}</span>
                <span className="hz-row-sub">{sub}</span>
              </div>
              <StatusDot status={st.status} label={st.label} className="app-status-auto" />
              <div className="hz-row-actions">
                <Button
                  size="sm"
                  variant={selected === d.id ? 'secondary' : 'ghost'}
                  aria-pressed={selected === d.id}
                  aria-label={`Log von ${shortSha(d.sha)} auf ${server(d.targetId)}`}
                  onClick={() => onSelect(d.id)}
                >
                  Log
                </Button>
              </div>
            </div>
          );
        })
      )}
    </Tile>
  );
}
