import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { NavRail, ServerSwitch, cx } from '@hz/ui';
import { openCount } from '../lib/alerts.js';
import { authStateKey } from '../lib/auth.js';
import {
  useActiveAlerts,
  useChecks,
  useGames,
  useHaState,
  useRepos,
  useContainers,
  useServerFilter,
  useServers,
} from '../lib/data.js';
import { interceptLinks } from '../lib/links.js';
import { visibleNavItems } from '../lib/modules.js';
import { useNetworkView } from '../lib/network.js';
import { useProxmoxView } from '../lib/proxmox.js';
import { useModules } from '../lib/useModules.js';
import { LiveClient, LiveProvider, useLiveState, useLiveTopic } from '../lib/live.js';
import { ALL_SERVERS, sentenceText, switchEntries } from '../lib/servers.js';
import { EnrollProvider } from '../pages/servers/enroll.js';
import { activeNavId, navItems, settingsItem, shortcutAction, withShortcutKeys } from '../nav.js';
import { AlertToasts } from './AlertToasts.js';
import { BottomBar } from './BottomBar.js';
import { CommandPalette } from './CommandPalette.js';
import {
  needsChecks,
  needsContainers,
  needsGames,
  needsHa,
  needsNetwork,
  needsProxmox,
  needsRepos,
  pageMeta,
  serverDetailId,
} from './pageMeta.js';
import { ThemeButton } from './ThemeButton.js';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Owns the live socket for the signed-in area. */
export function Shell(): ReactElement {
  const queryClient = useQueryClient();
  const [client] = useState(
    () =>
      new LiveClient(queryClient, {
        onUnauthorized: () => void queryClient.invalidateQueries({ queryKey: authStateKey }),
      }),
  );
  return (
    <LiveProvider client={client}>
      <EnrollProvider>
        <ShellBody />
      </EnrollProvider>
    </LiveProvider>
  );
}

function ShellBody(): ReactElement {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const active = activeNavId(pathname);
  const modules = useModules();
  const visible = useMemo(() => visibleNavItems(navItems, modules), [modules]);

  useLiveTopic('servers');
  useLiveTopic('alerts');
  const live = useLiveState();
  const servers = useServers();
  const alerts = useActiveAlerts();
  const containers = useContainers(needsContainers(pathname));
  const checks = useChecks(needsChecks(pathname));
  const repos = useRepos(needsRepos(pathname) && modules.github);
  const games = useGames(needsGames(pathname) && modules.games);
  const ha = useHaState(needsHa(pathname) && modules.homeassistant);
  const proxmox = useProxmoxView(needsProxmox(pathname) && modules.proxmox);
  const net = useNetworkView(modules, needsNetwork(pathname));
  const [filter, setFilter] = useServerFilter();
  const detailId = serverDetailId(pathname);

  const meta = pageMeta(pathname, {
    servers: servers.data,
    alerts: alerts.data,
    containers: containers.data,
    checks: checks.data,
    repos: repos.data,
    games: games.data,
    ha: ha.data,
    proxmox: modules.proxmox ? proxmox.guests.data : undefined,
    fritz: net.fritzData,
    dns: net.dnsData,
    filter: detailId ?? filter,
    live,
    modules,
    updatedAt: servers.dataUpdatedAt ? new Date(servers.dataUpdatedAt) : null,
  });
  const title = sentenceText(meta.title);

  const items = useMemo(() => {
    const open = openCount(alerts.data ?? []);
    return withShortcutKeys(
      visible.map((it) => (it.id === 'alerts' && open ? { ...it, count: open } : it)),
    );
  }, [alerts.data, visible]);

  const go = useCallback((to: string) => void navigate(to), [navigate]);

  const onSwitch = useCallback(
    (id: string) => {
      // On the detail page the switch jumps between servers.
      if (detailId) {
        go(id === ALL_SERVERS ? '/servers' : `/servers/${id}`);
        return;
      }
      setFilter(id);
    },
    [detailId, go, setFilter],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      // The web console gets every key (Ctrl+K is "kill line" in the shell).
      if (e.target instanceof Element && e.target.closest('[data-hz-terminal]')) return;
      const action = shortcutAction(
        {
          key: e.key,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          altKey: e.altKey,
          target: e.target instanceof HTMLElement ? e.target : null,
        },
        visible,
      );
      if (!action) return;
      if (action.kind === 'palette') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      // Plain keys never act behind an open dialog.
      if (e.repeat || document.querySelector('dialog[open]')) return;
      e.preventDefault();
      go(action.to);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, visible]);

  useEffect(() => {
    document.title = `${title} · Homelab-Zentrale`;
  }, [title]);

  const entries = switchEntries(servers.data ?? []);
  const activeSwitch = detailId ?? (entries.some((e) => e.id === filter) ? filter : ALL_SERVERS);

  return (
    <div className="hz-page app-shell">
      <div className="app-rail" onClick={interceptLinks(go)}>
        <NavRail items={items} active={active} title="homelab" />
        <div className="app-rail-foot">
          <button type="button" className="hz-nav-item" onClick={() => setPaletteOpen(true)}>
            <span className="hz-nav-key" aria-hidden={true} />
            <span>Suchen</span>
            <span className="app-rail-hint" aria-label={isMac ? 'Befehl K' : 'Steuerung K'}>
              {isMac ? '⌘K' : 'Strg K'}
            </span>
          </button>
          <a
            href={settingsItem.href}
            className={cx('hz-nav-item', active === settingsItem.id && 'hz-nav-active')}
            aria-current={active === settingsItem.id ? 'page' : undefined}
          >
            <span className="hz-nav-key" aria-hidden={true} />
            <span>{settingsItem.label}</span>
          </a>
          <ThemeButton />
        </div>
      </div>
      <main className="hz-page-main app-main" id="main">
        <header className="hz-page-top">
          <div>
            <h1 className="hz-page-title">
              {meta.title.em ? <em>{meta.title.em}</em> : null}
              {meta.title.rest}
            </h1>
            <div className="hz-page-sub" aria-live="off">
              {meta.sub}
            </div>
          </div>
          {meta.serverSwitch ? (
            <div className="app-switch">
              <ServerSwitch servers={entries} active={activeSwitch} onChange={onSwitch} />
            </div>
          ) : null}
        </header>
        <Outlet />
      </main>
      <BottomBar
        items={visible}
        active={active}
        onNavigate={go}
        onSearch={() => setPaletteOpen(true)}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onRun={go}
        modules={modules}
      />
      <AlertToasts onOpen={go} />
    </div>
  );
}
