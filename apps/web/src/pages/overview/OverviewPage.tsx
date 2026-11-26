import type { ReactElement } from 'react';
import { Tile } from '@hz/ui';

/** Empty overview until agents report in (M2). The Statussatz lives in the shell header. */
export function OverviewPage(): ReactElement {
  return (
    <Tile title="Server" icon="server" count="0">
      <p className="app-empty">
        Noch kein Server verbunden. Sobald ein Agent sich meldet, steht er hier mit CPU, RAM und
        Speicher.
      </p>
    </Tile>
  );
}
