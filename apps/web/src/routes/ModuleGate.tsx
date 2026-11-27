import type { ModuleId } from '@hz/shared';
import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router';
import { Tile } from '@hz/ui';
import { anyModuleOn, MODULE_ICON, MODULE_PAGE, moduleLabels } from '../lib/modules.js';
import { useModules } from '../lib/useModules.js';

type ModuleRef = ModuleId | readonly ModuleId[];

const asList = (m: ModuleRef): readonly ModuleId[] => (typeof m === 'string' ? [m] : m);

/**
 * Renders the page only while its module is on (or, for a list, at least one of them);
 * otherwise a short note with the way back on.
 */
export function ModuleGate({
  module,
  children,
}: {
  module: ModuleRef;
  children: ReactNode;
}): ReactElement {
  const modules = useModules();
  if (anyModuleOn(modules, asList(module))) return <>{children}</>;
  return <ModuleOff module={module} />;
}

export function ModuleOff({
  module,
  title,
}: {
  module: ModuleRef;
  /** Tile title; defaults to the page of the module. */
  title?: string | undefined;
}): ReactElement {
  const list = asList(module);
  const first = list[0] ?? 'games';
  const verb = list.length > 1 ? 'sind' : 'ist';
  return (
    <Tile title={title ?? MODULE_PAGE[first]} icon={MODULE_ICON[first]}>
      <div className="app-empty-block" data-testid="module-off">
        <p className="app-empty">
          Modul ausgeschaltet. {moduleLabels(list)} {verb} in dieser Zentrale nicht aktiv.
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
