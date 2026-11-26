import type { ReactElement } from 'react';
import { useServerFilter, useServers } from '../../lib/data.js';
import { ALL_SERVERS } from '../../lib/servers.js';
import { AddServerButton, NoServers, ServerListTile } from './ServerListTile.js';

/** /servers: all servers, a click opens the detail view. */
export function ServersPage(): ReactElement | null {
  const servers = useServers();
  const [filter] = useServerFilter();
  if (!servers.data) return null;
  if (servers.data.length === 0) return <NoServers />;
  const one = filter !== ALL_SERVERS ? filter : undefined;
  const list = one ? servers.data.filter((s) => s.id === one) : servers.data;
  return <ServerListTile servers={list} active={one} actions={<AddServerButton size="sm" />} />;
}
