import type { ServerSummary } from '@hz/shared';
import { useMemo, type ReactElement, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Button, ServerList, Tile } from '@hz/ui';
import { sortServers, toServerInfo } from '../../lib/servers.js';
import { useOpenEnroll } from './enroll.js';

/** "Server hinzufügen" as primary button; the dialog lives in the shell (enroll.tsx). */
export function AddServerButton({
  variant = 'primary',
  size,
}: {
  variant?: 'primary' | 'secondary';
  size?: 'sm' | 'md';
}): ReactElement {
  const open = useOpenEnroll();
  return (
    <Button variant={variant} size={size} icon="plus" onClick={open}>
      Server hinzufügen
    </Button>
  );
}

/** Empty state: no server yet. */
export function NoServers(): ReactElement {
  return (
    <Tile title="Server" icon="server" count="0">
      <div className="app-empty-block">
        <p className="app-empty">
          Noch kein Server verbunden. Installier den Agent auf einem Server, dann steht er hier mit
          CPU, RAM und Speicher.
        </p>
        <div>
          <AddServerButton />
        </div>
      </div>
    </Tile>
  );
}

export interface ServerListTileProps {
  servers: ServerSummary[];
  active?: string | undefined;
  actions?: ReactNode;
}

/** ServerList over the full width, problems first (SPEC 5.1). */
export function ServerListTile({ servers, active, actions }: ServerListTileProps): ReactElement {
  const navigate = useNavigate();
  const rows = useMemo(() => sortServers(servers).map(toServerInfo), [servers]);
  const bad = servers.filter((s) => s.status === 'crit' || s.status === 'warn').length;
  return (
    <Tile
      title="Server"
      icon="server"
      count={bad ? `${servers.length} · ${bad} mit Problem` : String(servers.length)}
      flush
      actions={actions}
    >
      <div className="app-scroll-x">
        <ServerList
          servers={rows}
          active={active}
          onSelect={(id) => void navigate(`/servers/${id}`)}
        />
      </div>
    </Tile>
  );
}
