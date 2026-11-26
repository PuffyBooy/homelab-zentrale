import { lazy, Suspense, type ReactElement } from 'react';
import { Route, Routes } from 'react-router';
import { navItems } from '../nav.js';
import { AlertsPage } from '../pages/alerts/AlertsPage.js';
import { ContainerLogsPage } from '../pages/containers/ContainerLogsPage.js';
import { ContainersPage } from '../pages/containers/ContainersPage.js';
import { EmptyPage, NotFoundPage } from '../pages/empty/EmptyPage.js';
import { GameCreatePage } from '../pages/games/GameCreatePage.js';
import { GameDetailPage } from '../pages/games/GameDetailPage.js';
import { GamesPage } from '../pages/games/GamesPage.js';
import { GithubPage } from '../pages/github/GithubPage.js';
import { RepoDetailPage } from '../pages/github/RepoDetailPage.js';
import { LoginPage } from '../pages/login/LoginPage.js';
import { OverviewPage } from '../pages/overview/OverviewPage.js';
import { ServerDetailPage } from '../pages/servers/ServerDetailPage.js';
import { ServersPage } from '../pages/servers/ServersPage.js';
import { SettingsPage } from '../pages/settings/SettingsPage.js';
import { SetupPage } from '../pages/setup/SetupPage.js';
import { CheckDetailPage } from '../pages/websites/CheckDetailPage.js';
import { WebsitesPage } from '../pages/websites/WebsitesPage.js';
import { Shell } from '../shell/Shell.js';
import { AuthGate } from './AuthGate.js';

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
  '/alerts',
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
        <Route path="games" element={<GamesPage />} />
        <Route path="games/new" element={<GameCreatePage />} />
        <Route path="games/:id" element={<GameDetailPage />} />
        <Route path="github" element={<GithubPage />} />
        <Route path="github/:id" element={<RepoDetailPage />} />
        <Route path="websites" element={<WebsitesPage />} />
        <Route path="websites/:id" element={<CheckDetailPage />} />
        <Route path="alerts" element={<AlertsPage />} />
        {navItems
          .filter((it) => it.href && !BUILT.has(it.href))
          .map((it) => (
            <Route key={it.id} path={it.href?.slice(1)} element={<EmptyPage />} />
          ))}
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
