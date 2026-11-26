import { lazy, Suspense, type ComponentType, type ReactElement } from 'react';
import { Route, Routes } from 'react-router';
import { navItems } from '../nav.js';
import { AlertsPage } from '../pages/alerts/AlertsPage.js';
import { ContainerLogsPage } from '../pages/containers/ContainerLogsPage.js';
import { ContainersPage } from '../pages/containers/ContainersPage.js';
import { EmptyPage, NotFoundPage } from '../pages/empty/EmptyPage.js';
import { HomePage } from '../pages/home/HomePage.js';
import { LoginPage } from '../pages/login/LoginPage.js';
import { OverviewPage } from '../pages/overview/OverviewPage.js';
import { ServerDetailPage } from '../pages/servers/ServerDetailPage.js';
import { ServersPage } from '../pages/servers/ServersPage.js';
import { SetupPage } from '../pages/setup/SetupPage.js';
import { CheckDetailPage } from '../pages/websites/CheckDetailPage.js';
import { WebsitesPage } from '../pages/websites/WebsitesPage.js';
import { Shell } from '../shell/Shell.js';
import { AuthGate } from './AuthGate.js';

/** Code-split page: `pick` names the export, so pages keep their named exports. */
function page<M>(load: () => Promise<M>, pick: (m: M) => ComponentType): ComponentType {
  return lazy(() => load().then((m) => ({ default: pick(m) })));
}

// Heavy or rarely used pages load on demand (bundle budget, docs/ROADMAP.md M9).
const ConsolePage = page(
  () => import('../pages/console/ConsolePage.js'),
  (m) => m.ConsolePage,
);
const WallPage = page(
  () => import('../pages/wall/WallPage.js'),
  (m) => m.WallPage,
);
const SettingsPage = page(
  () => import('../pages/settings/SettingsPage.js'),
  (m) => m.SettingsPage,
);
const GithubPage = page(
  () => import('../pages/github/GithubPage.js'),
  (m) => m.GithubPage,
);
const RepoDetailPage = page(
  () => import('../pages/github/RepoDetailPage.js'),
  (m) => m.RepoDetailPage,
);
const GamesPage = page(
  () => import('../pages/games/GamesPage.js'),
  (m) => m.GamesPage,
);
const GameCreatePage = page(
  () => import('../pages/games/GameCreatePage.js'),
  (m) => m.GameCreatePage,
);
const GameDetailPage = page(
  () => import('../pages/games/GameDetailPage.js'),
  (m) => m.GameDetailPage,
);

function Loading(): ReactElement {
  return (
    <p className="app-empty" role="status">
      Lade …
    </p>
  );
}

function L({ c: C }: { c: ComponentType }): ReactElement {
  return (
    <Suspense fallback={<Loading />}>
      <C />
    </Suspense>
  );
}

/** Dev-only component gallery. Dead code in production builds. */
const DevUiPage = import.meta.env.DEV
  ? lazy(() => import('../pages/dev-ui/DevUiPage.js').then((m) => ({ default: m.DevUiPage })))
  : null;

/** Nav targets with their own page; the rest shows the empty placeholder. */
const BUILT = new Set([
  '/',
  '/servers',
  '/containers',
  '/games',
  '/github',
  '/websites',
  '/home',
  '/alerts',
  '/console',
]);

export function AppRoutes(): ReactElement {
  return (
    <Routes>
      {DevUiPage ? (
        <Route
          path="/dev/ui"
          element={
            <Suspense fallback={null}>
              <DevUiPage />
            </Suspense>
          }
        />
      ) : null}
      <Route
        path="/setup"
        element={
          <AuthGate area="setup" sticky>
            <SetupPage />
          </AuthGate>
        }
      />
      {/* No AuthGate: the tablet has only the wall cookie, never an admin session. */}
      <Route
        path="/wall"
        element={
          <Suspense fallback={null}>
            <WallPage />
          </Suspense>
        }
      />
      <Route
        path="/login"
        element={
          <AuthGate area="login">
            <LoginPage />
          </AuthGate>
        }
      />
      <Route
        element={
          <AuthGate area="protected">
            <Shell />
          </AuthGate>
        }
      >
        <Route index element={<OverviewPage />} />
        <Route path="servers" element={<ServersPage />} />
        <Route path="servers/:id" element={<ServerDetailPage />} />
        <Route path="containers" element={<ContainersPage />} />
        <Route path="containers/:id/logs" element={<ContainerLogsPage />} />
        <Route path="games" element={<L c={GamesPage} />} />
        <Route path="games/new" element={<L c={GameCreatePage} />} />
        <Route path="games/:id" element={<L c={GameDetailPage} />} />
        <Route path="github" element={<L c={GithubPage} />} />
        <Route path="github/:id" element={<L c={RepoDetailPage} />} />
        <Route path="websites" element={<WebsitesPage />} />
        <Route path="websites/:id" element={<CheckDetailPage />} />
        <Route path="home" element={<HomePage />} />
        <Route path="alerts" element={<AlertsPage />} />
        <Route path="console" element={<L c={ConsolePage} />} />
        {navItems
          .filter((it) => it.href && !BUILT.has(it.href))
          .map((it) => (
            <Route key={it.id} path={it.href?.slice(1)} element={<EmptyPage />} />
          ))}
        <Route path="settings" element={<L c={SettingsPage} />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
