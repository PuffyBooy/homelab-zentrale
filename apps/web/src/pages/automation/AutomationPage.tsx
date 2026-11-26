import type { ReactElement } from 'react';
import { FormError } from '../../components/FormError.js';
import { useChecks, useContainers, useServers } from '../../lib/data.js';
import { errorText } from '../../lib/errors.js';
import { useLiveTopic } from '../../lib/live.js';
import { useSelfheal } from '../../lib/selfheal.js';
import { useModules } from '../../lib/useModules.js';
import { useNow } from '../../lib/useNow.js';
import { ModuleOff } from '../../routes/ModuleGate.js';
import {
  SelfhealEventsTile,
  SelfhealRulesTile,
  SelfhealSettingsTile,
  SelfhealStateTile,
} from './SelfhealTiles.js';
import { TasksTile } from './TasksTile.js';

/**
 * /automation "Automatik" (M20): Geplante Aufgaben (module tasks) and Selbstheilung
 * (module selfheal). The page shows while one of them is on; the other one shows the
 * "Modul ausgeschaltet" note.
 */
export function AutomationPage(): ReactElement {
  const modules = useModules();
  const servers = useServers();
  const now = useNow(30_000);
  const selfheal = useSelfheal(modules.selfheal);
  // Problems first: a container that was given up goes above the tasks.
  const gaveUp = !!selfheal.data?.state.some((s) => s.phase === 'gave_up');
  return (
    <div className="hz-grid app-grid">
      {modules.selfheal && gaveUp && selfheal.data ? (
        <SelfhealStateTile data={selfheal.data} now={now} span={4} />
      ) : null}
      {modules.tasks ? (
        <TasksTile servers={servers.data ?? []} now={now} />
      ) : (
        <ModuleOff module="tasks" title="Geplante Aufgaben" />
      )}
      {modules.selfheal ? (
        <SelfhealSection now={now} stateShown={gaveUp} />
      ) : (
        <ModuleOff module="selfheal" title="Selbstheilung" />
      )}
    </div>
  );
}

function SelfhealSection({
  now,
  stateShown,
}: {
  now: Date;
  stateShown: boolean;
}): ReactElement | null {
  useLiveTopic('containers');
  const q = useSelfheal();
  const containers = useContainers();
  const checks = useChecks();
  if (q.error && !q.data) return <FormError title={errorText(q.error)} />;
  if (!q.data) return null;
  return (
    <>
      {stateShown ? null : <SelfhealStateTile data={q.data} now={now} />}
      <SelfhealSettingsTile data={q.data} span={stateShown ? 4 : 2} />
      <SelfhealRulesTile
        data={q.data}
        containers={containers.data ?? []}
        checks={checks.data ?? []}
      />
      <SelfhealEventsTile data={q.data} now={now} />
    </>
  );
}
