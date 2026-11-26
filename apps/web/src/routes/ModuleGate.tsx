import type { ModuleId } from '@hz/shared';
import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router';
import { Tile } from '@hz/ui';
import { MODULE_ICON, MODULE_LABEL, MODULE_PAGE } from '../lib/modules.js';
import { useModules } from '../lib/useModules.js';

/** Renders the page only while its module is on; otherwise a short note with the way back on. */
export function ModuleGate({
  module,
  children,
}: {
  module: ModuleId;
  children: ReactNode;
}): ReactElement {
  const modules = useModules();
  if (modules[module]) return <>{children}</>;
  return <ModuleOff module={module} />;
}

export function ModuleOff({ module }: { module: ModuleId }): ReactElement {
  return (
    <Tile title={MODULE_PAGE[module]} icon={MODULE_ICON[module]}>
      <div className="app-empty-block" data-testid="module-off">
        <p className="app-empty">
          Modul ausgeschaltet. {MODULE_LABEL[module]} ist in dieser Zentrale nicht aktiv.
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
