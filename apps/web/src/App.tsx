import type { ReactElement } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout.js';
import { PageLoader } from './components/ui.js';
import { useSession } from './hooks/useSession.js';
import { AdminCatalogPage } from './pages/admin/AdminCatalogPage.js';
import { AdminFeaturedPage } from './pages/admin/AdminFeaturedPage.js';
import { AdminInvitesPage } from './pages/admin/AdminInvitesPage.js';
import { AdminLibrariesPage } from './pages/admin/AdminLibrariesPage.js';
import { AdminOverviewPage } from './pages/admin/AdminOverviewPage.js';
import { AdminSettingsPage } from './pages/admin/AdminSettingsPage.js';
import { AdminUsersPage } from './pages/admin/AdminUsersPage.js';
import { LandingPage } from './pages/LandingPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { RegisterPage } from './pages/RegisterPage.js';
import { SetupPage } from './pages/SetupPage.js';

/**
 * The web surface is administrators only. A signed-in player has no pages to
 * visit here, so they are sent back to the landing page rather than shown an
 * empty shell.
 */
function RequireAdmin({ children }: { children: ReactElement }) {
  const { user, isAdmin, isLoading, status } = useSession();
  const location = useLocation();

  if (isLoading) return <PageLoader label="Signing in" />;

  // A brand-new server sends the first visitor to setup instead of a login box.
  if (!user && status?.needsSetup) {
    return <Navigate to="/setup" replace />;
  }
  if (!user) {
    // Remember where they were headed so login can send them back.
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }
  return children;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/register" element={<RegisterPage />} />

      <Route
        path="/admin"
        element={
          <RequireAdmin>
            <Layout />
          </RequireAdmin>
        }
      >
        <Route index element={<AdminOverviewPage />} />
        <Route path="catalog" element={<AdminCatalogPage />} />
        <Route path="featured" element={<AdminFeaturedPage />} />
        <Route path="libraries" element={<AdminLibrariesPage />} />
        <Route path="users" element={<AdminUsersPage />} />
        <Route path="invites" element={<AdminInvitesPage />} />
        <Route path="settings" element={<AdminSettingsPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
