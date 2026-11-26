import type { CheckSummary, ServerSummary } from '@hz/shared';
import { useMemo, type ReactElement } from 'react';
import { Link } from 'react-router';
import { Tile } from '@hz/ui';
import { isCheckProblem, sortChecks } from '../../lib/checks.js';
import { plural } from '../../lib/format.js';
import { useNow } from '../../lib/useNow.js';
import { CheckRow } from './CheckRow.js';

const MAX_ROWS = 5;

/** Overview tile after Dashboard.html: problems first, at most five rows, no buttons. */
export function ChecksTile({
  checks,
  servers,
  serverId,
}: {
  checks: CheckSummary[];
  servers: ServerSummary[];
  serverId?: string | undefined;
}): ReactElement {
  const now = useNow(30_000);
  const rows = useMemo(() => sortChecks(checks), [checks]);
  const problems = checks.filter(isCheckProblem).length;
  const shown = rows.slice(0, MAX_ROWS);
  const more = rows.length - shown.length;
  const href = serverId ? `/websites?server=${encodeURIComponent(serverId)}` : '/websites';
  return (
    <Tile
      title="Websites"
      icon="globe"
      count={
        problems
          ? `${checks.length} · ${plural(problems, 'Problem', 'Probleme')}`
          : String(checks.length)
      }
      span={2}
      flush
      footer={
        <Link className="app-more" to={href}>
          {more > 0 ? `+${more} weitere · alle Websites` : 'Alle Websites'}
        </Link>
      }
    >
      {shown.length ? (
        shown.map((c) => <CheckRow key={c.id} check={c} servers={servers} now={now} readOnly />)
      ) : (
        <p className="app-empty app-pad">Noch keine Checks.</p>
      )}
    </Tile>
  );
}
