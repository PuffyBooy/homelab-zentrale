import type { ReactElement } from 'react';
import { useModules } from '../../lib/useModules.js';
import { Fail2banSection } from './Fail2banSection.js';
import { VulnscanSection } from './VulnscanSection.js';

/** /security: Schwachstellen (module vulnscan) and Fail2ban (module fail2ban), each when on. */
export function SecurityPage(): ReactElement {
  const modules = useModules();
  return (
    <div className="hz-grid app-grid">
      {modules.vulnscan ? <VulnscanSection /> : null}
      {modules.fail2ban ? <Fail2banSection /> : null}
    </div>
  );
}
