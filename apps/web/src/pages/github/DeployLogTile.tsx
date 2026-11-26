import type { RepoSummary } from '@hz/shared';
import { skipToken, useQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactElement } from 'react';
import { Alert, Button, StatusDot, Terminal, Tile } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { errorText } from '../../lib/errors.js';
import { formatWhen } from '../../lib/format.js';
import {
  DEPLOY_STATUS,
  TRIGGER_LABEL,
  deployKey,
  deployLogKey,
  deployResult,
  fetchDeploy,
  isDeployRunning,
  repoShortName,
  shortSha,
  shownDeployLines,
  type DeployLogBuffer,
} from '../../lib/github.js';
import { useLiveTopic } from '../../lib/live.js';

const BOTTOM_SLACK = 24;

/**
 * Live deploy log (SPEC 7): Terminal fed by the topic `deploy:<id>`, the stored log
 * from REST as start and after the end. The result shows as Alert above the log.
 */
export function DeployLogTile({
  deployId,
  repo,
  now,
  onClose,
}: {
  deployId: string;
  repo: RepoSummary;
  now: Date;
  onClose: () => void;
}): ReactElement {
  const detail = useQuery({
    queryKey: deployKey(deployId),
    queryFn: ({ signal }) => fetchDeploy(deployId, signal),
    // Fallback while the live socket misses the end: poll until the deploy is done.
    refetchInterval: (q) => (q.state.data && !isDeployRunning(q.state.data.deploy) ? false : 3000),
  });
  const running = !detail.data || isDeployRunning(detail.data.deploy);
  useLiveTopic(running ? `deploy:${deployId}` : null);
  const live = useQuery<DeployLogBuffer>({ queryKey: deployLogKey(deployId), queryFn: skipToken });

  const lines = useMemo(() => shownDeployLines(detail.data, live.data), [detail.data, live.data]);
  const wrap = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  useLayoutEffect(() => {
    const el = wrap.current?.querySelector<HTMLElement>('.hz-term-body');
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  useEffect(() => {
    const el = wrap.current?.querySelector<HTMLElement>('.hz-term-body');
    if (!el) return;
    // The log scrolls on its own, so it must be reachable with the keyboard.
    el.tabIndex = 0;
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Deploy-Log');
    const onScroll = (): void => {
      follow.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [detail.data?.deploy.id]);

  const d = detail.data?.deploy;
  const target = d ? repo.targets.find((t) => t.id === d.targetId) : undefined;
  const serverName = target?.serverName ?? 'Ziel';
  const name = repoShortName(repo.fullName);
  const result = d ? deployResult(d, name, serverName) : null;
  const st = d ? DEPLOY_STATUS[d.status] : { status: 'busy' as const, label: 'lädt' };

  return (
    <Tile
      title={d ? `Deploy ${shortSha(d.sha)}` : 'Deploy'}
      icon="terminal"
      span={4}
      actions={
        <>
          <StatusDot status={st.status} label={st.label} />
          <Button size="sm" variant="ghost" onClick={onClose}>
            Schließen
          </Button>
        </>
      }
    >
      {detail.error && !detail.data ? <FormError title={errorText(detail.error)} /> : null}
      {d && result ? (
        <Alert
          tone={result.tone}
          title={result.title}
          time={formatWhen(new Date(d.finishedAt ?? d.startedAt), now)}
        >
          {result.body} · {TRIGGER_LABEL[d.trigger]}
        </Alert>
      ) : null}
      <div className="app-term" ref={wrap}>
        <div className="app-term-scope" data-theme="dark">
          <Terminal
            title={target ? `deploy ${name} · ${target.method}` : `deploy ${name}`}
            host={serverName}
            lines={
              lines.length
                ? lines
                : [{ text: running ? 'Warte auf Ausgabe …' : 'Kein Log gespeichert.', kind: 'dim' }]
            }
            height="min(48vh, 480px)"
            cursor={running}
          />
        </div>
      </div>
    </Tile>
  );
}
