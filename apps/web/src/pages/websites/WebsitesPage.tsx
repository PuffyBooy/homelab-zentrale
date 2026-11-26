import { useMemo, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { Button, Tile } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { checkMatchesServer, isCheckProblem, sortChecks } from '../../lib/checks.js';
import { useChecks, useServerFilter, useServers } from '../../lib/data.js';
import { errorText } from '../../lib/errors.js';
import { plural } from '../../lib/format.js';
import { useLiveTopic } from '../../lib/live.js';
import { ALL_SERVERS } from '../../lib/servers.js';
import { useNow } from '../../lib/useNow.js';
import { CheckDialog } from './CheckDialog.js';
import { CheckRow } from './CheckRow.js';
import { useRunCheck } from './useRunCheck.js';

/** /websites (SPEC 8): one WebCheckRow per check, problems first, live over `checks`. */
export function WebsitesPage(): ReactElement | null {
  useLiveTopic('checks');
  const checks = useChecks();
  const servers = useServers();
  const [filter] = useServerFilter();
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const run = useRunCheck();
  const now = useNow(30_000);

  const one = filter !== ALL_SERVERS ? filter : undefined;
  const list = useMemo(() => {
    const all = checks.data ?? [];
    return sortChecks(one ? all.filter((c) => checkMatchesServer(c, one)) : all);
  }, [checks.data, one]);

  if (checks.isError && !checks.data) {
    return <FormError title={errorText(checks.error)} />;
  }
  if (!checks.data) return null;

  const serverList = servers.data ?? [];
  const problems = list.filter(isCheckProblem).length;
  const name = one ? serverList.find((s) => s.id === one)?.name : undefined;

  return (
    <div className="hz-grid app-grid">
      <Tile
        title="Websites und Ports"
        icon="globe"
        count={
          problems
            ? `${list.length} · ${plural(problems, 'Problem', 'Probleme')}`
            : String(list.length)
        }
        span={4}
        flush
        actions={
          <Button size="sm" variant="primary" icon="plus" onClick={() => setCreating(true)}>
            Check anlegen
          </Button>
        }
        footer={
          list.length ? (
            <span className="app-foot-text">
              Geprüft jede Minute · DOWN erst nach 2 Fehlschlägen hintereinander
            </span>
          ) : undefined
        }
      >
        {list.length === 0 ? (
          <p className="app-empty app-pad">
            {name
              ? `Kein Check gehört zu ${name}.`
              : 'Noch keine Checks. Leg einen für eine URL, einen Port oder einen Host an.'}
          </p>
        ) : (
          list.map((c) => (
            <CheckRow
              key={c.id}
              check={c}
              servers={serverList}
              now={now}
              running={run.isPending && run.variables === c.id}
              onRun={() => run.mutate(c.id)}
              onOpen={() => void navigate(`/websites/${c.id}`)}
            />
          ))
        )}
        {run.error ? (
          <div className="app-pad">
            <FormError title={errorText(run.error)} />
          </div>
        ) : null}
      </Tile>
      {creating ? (
        <CheckDialog open onClose={() => setCreating(false)} servers={serverList} />
      ) : null}
    </div>
  );
}
