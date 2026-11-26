import type { ModuleId } from '@hz/shared';
import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router';
import { Tile } from '@hz/ui';
import { anyModuleOn, MODULE_ICON, MODULE_PAGE, moduleLabels } from '../lib/modules.js';
import { useModules } from '../lib/useModules.js';

/**
 * Renders the page only while its module is on (or, for a list, any of them);
 * otherwise a short note with the way back on.
 */
export function ModuleGate({
  module,
  children,
}: {
  module: ModuleId | readonly ModuleId[];
  children: ReactNode;
}): ReactElement {
  const modules = useModules();
  const ids: readonly ModuleId[] = typeof module === 'string' ? [module] : module;
  if (anyModuleOn(modules, ids)) return <>{children}</>;
  return <ModuleOff module={ids} />;
}

export function ModuleOff({ module }: { module: ModuleId | readonly ModuleId[] }): ReactElement {
  const ids: readonly ModuleId[] = typeof module === 'string' ? [module] : module;
  const first = ids[0] ?? 'games';
  return (
    <Tile title={MODULE_PAGE[first]} icon={MODULE_ICON[first]}>
      <div className="app-empty-block" data-testid="module-off">
        <p className="app-empty">
          Modul ausgeschaltet. {moduleLabels(ids)} {ids.length > 1 ? 'sind' : 'ist'} in dieser
          Zentrale nicht aktiv.
        </p>
        <div>
          <Link className="hz-btn hz-btn-secondary hz-btn-sm" to="/settings#module">
            <span>Einstellungen → Module</span>
          </Link>
        </div>
      </div>
    </Tile>
  );
}
