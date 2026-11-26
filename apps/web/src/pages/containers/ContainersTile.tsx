import type { ContainerSummary } from '@hz/shared';
import { useMemo, type ReactElement } from 'react';
import { Link } from 'react-router';
import { Tile } from '@hz/ui';
import { isProblem, runningCount, sortContainers } from '../../lib/containers.js';
import { plural } from '../../lib/format.js';
import { useNow } from '../../lib/useNow.js';
import { ContainerRow } from './ContainerRow.js';

const MAX_ROWS = 5;

/**
 * Overview tile after design/reference/previews/Dashboard.html: problems first, then
 * the rest by name, at most five rows. The count says "N von M laufen".
 */
export function ContainersTile({
  containers,
  serverId,
}: {
  containers: ContainerSummary[];
  /** ServerSwitch filter, keeps the link on the same server. */
  serverId?: string | undefined;
}): ReactElement {
  const now = useNow(30_000);
  const rows = useMemo(() => sortContainers(containers), [containers]);
  const problems = containers.filter(isProblem).length;
  const shown = rows.slice(0, MAX_ROWS);
  const more = rows.length - shown.length;
  const href = serverId ? `/containers?server=${encodeURIComponent(serverId)}` : '/containers';
  return (
    <Tile
      title="Container"
      icon="container"
      count={
        problems
          ? `${runningCount(containers)} · ${plural(problems, 'Problem', 'Probleme')}`
          : runningCount(containers)
      }
      span={2}
      flush
      footer={
        <Link className="app-more" to={href}>
          {more > 0 ? `+${more} weitere · alle Container` : 'Alle Container'}
        </Link>
      }
    >
      {shown.length ? (
        shown.map((c) => <ContainerRow key={c.id} c={c} now={now} withServer readOnly />)
      ) : (
        <p className="app-empty app-pad">Keine Container gemeldet.</p>
      )}
    </Tile>
  );
}
