import type { ReactElement } from 'react';
import { Link } from 'react-router';
import { Tile } from '@hz/ui';
import { useChecks } from '../../lib/data.js';
import { plural } from '../../lib/format.js';

/** Settings → Checks (SPEC 8/13). Checks are managed on the Websites page. */
export function ChecksSettingsTile(): ReactElement {
  const checks = useChecks();
  const list = checks.data ?? [];
  const paused = list.filter((c) => !c.def.enabled).length;
  return (
    <Tile title="Checks" icon="globe" count={checks.data ? list.length : undefined}>
      <p className="app-text">
        {checks.data
          ? `${plural(list.length, 'Check', 'Checks')}${paused ? `, davon ${paused} pausiert` : ''}. Standard-Intervall 60 s, Zertifikat und Domain-Ablauf werden mitgeprüft.`
          : 'Lade Checks …'}
      </p>
      <p className="app-text">
        <Link to="/websites">Checks unter Websites anlegen und bearbeiten</Link>
      </p>
    </Tile>
  );
}
