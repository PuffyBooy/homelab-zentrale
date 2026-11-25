import { lazy, Suspense, type ReactElement } from 'react';
import { Route, Routes } from 'react-router';
import { navItems } from '../nav.js';
import { EmptyPage, NotFoundPage } from '../pages/empty/EmptyPage.js';
import { LoginPage } from '../pages/login/LoginPage.js';
import { OverviewPage } from '../pages/overview/OverviewPage.js';
import { SettingsPage } from '../pages/settings/SettingsPage.js';
import { SetupPage } from '../pages/setup/SetupPage.js';
import { Shell } from '../shell/Shell.js';
import { AuthGate } from './AuthGate.js';

/** Dev-only component gallery. Dead code in production builds. */
const DevUiPage = import.meta.env.DEV
  ? lazy(() => import('../pages/dev-ui/DevUiPage.js').then((m) => ({ default: m.DevUiPage })))
  : null;

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
        {navItems
          .filter((it) => it.href && it.href !== '/')
          .map((it) => (
            <Route key={it.id} path={it.href?.slice(1)} element={<EmptyPage />} />
          ))}
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
