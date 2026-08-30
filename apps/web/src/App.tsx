import type { PublicServerInfo } from '@gameblade/shared';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AdminSection } from './components/AdminSection.js';
import { ADMIN_REDIRECTS } from './components/adminNav.js';
import { Layout } from './components/Layout.js';
import { PageLoader } from './components/ui.js';
import { useServerRole } from './hooks/useServerRole.js';
import { useSession } from './hooks/useSession.js';
import { useApplyTheme } from './hooks/useTheme.js';
import { api } from './lib/api.js';
import { AdminAchievementsPage } from './pages/admin/AdminAchievementsPage.js';
import { AdminCatalogPage } from './pages/admin/AdminCatalogPage.js';
import { AdminAnalyticsPage } from './pages/admin/AdminAnalyticsPage.js';
import { AdminLandingPage } from './pages/admin/AdminLandingPage.js';
import { AdminThemePage } from './pages/admin/AdminThemePage.js';
import { AdminApiPage } from './pages/admin/AdminApiPage.js';
import { AdminDiscordPage } from './pages/admin/AdminDiscordPage.js';
import { AdminBugsPage } from './pages/admin/AdminBugsPage.js';
import { AdminHealthPage } from './pages/admin/AdminHealthPage.js';
import { AdminLaunchRulesPage } from './pages/admin/AdminLaunchRulesPage.js';
import { AdminSavePathsPage } from './pages/admin/AdminSavePathsPage.js';
import { AdminClientPage } from './pages/admin/AdminClientPage.js';
import { AdminFeaturedPage } from './pages/admin/AdminFeaturedPage.js';
import { AdminInvitesPage } from './pages/admin/AdminInvitesPage.js';
import { AdminLibrariesPage } from './pages/admin/AdminLibrariesPage.js';
import { AdminNodesPage } from './pages/admin/AdminNodesPage.js';
import { AdminNodeAnalyticsPage } from './pages/admin/AdminNodeAnalyticsPage.js';
import { AdminNodeEnrolmentPage } from './pages/admin/AdminNodeEnrolmentPage.js';
import { AdminNodeMapPage } from './pages/admin/AdminNodeMapPage.js';
import { AdminOverviewPage } from './pages/admin/AdminOverviewPage.js';
import { AdminRequestsPage } from './pages/admin/AdminRequestsPage.js';
import { AdminSettingsPage } from './pages/admin/AdminSettingsPage.js';
import { AdminUsersPage } from './pages/admin/AdminUsersPage.js';
import { AccountPage } from './pages/AccountPage.js';
import { LandingPage } from './pages/LandingPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { RegisterPage } from './pages/RegisterPage.js';
import { ResetPasswordPage } from './pages/ResetPasswordPage.js';
import { SetupPage } from './pages/SetupPage.js';

/**
 * The admin routes stay administrators-only. A signed-in player has no pages
 * to visit under /admin, so they are sent back to the landing page rather
 * than shown an empty shell.
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

/** Any signed-in account — the guard for pages about your own account rather than the server. */
function RequireUser({ children }: { children: ReactElement }) {
  const { user, isLoading } = useSession();
  const location = useLocation();

  if (isLoading) return <PageLoader label="Signing in" />;
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return children;
}

/**
 * Reads the server's theme once and applies it to the document.
 *
 * Mounted here rather than per page so a signed-in admin, the sign-in screen
 * and the landing page all agree — the endpoint is public, so it works before
 * anyone has logged in.
 */
function useServerTheme() {
  const infoQuery = useQuery({
    queryKey: ['public', 'info'],
    queryFn: () => api.get<PublicServerInfo>('/public/info'),
    staleTime: 60_000,
  });
  useApplyTheme(infoQuery.data?.theme.tokens);
}

export function App() {
  useServerTheme();
  const role = useServerRole();

  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route
        path="/account"
        element={
          <RequireUser>
            <AccountPage />
          </RequireUser>
        }
      />

      <Route
        path="/admin"
        element={
          <RequireAdmin>
            <Layout />
          </RequireAdmin>
        }
      >
        <Route index element={<AdminOverviewPage />} />

        {/* Six sections rather than fifteen, each a shell with its own
            sub-tabs. The grouping and the sub-tab strip both come from
            `adminNav`, so the sidebar and the page can never disagree about
            where something lives. */}
        <Route element={<AdminSection />}>
          <Route path="catalog">
            <Route index element={<AdminCatalogPage />} />
            <Route path="achievements" element={<AdminAchievementsPage />} />
            <Route path="featured" element={<AdminFeaturedPage />} />
            <Route path="save-paths" element={<AdminSavePathsPage />} />
            <Route path="launch-rules" element={<AdminLaunchRulesPage />} />
            {/* A coordinator holds no game files, so there is no folder to add
                and no disk to scan — and scanning an absent one used to flag
                its nodes' entire catalog as missing. The server refuses those
                routes on a coordinator too; this is so a bookmark lands
                somewhere useful rather than on a page of dead buttons. */}
            <Route
              path="libraries"
              element={
                role === 'coordinator' ? (
                  <Navigate to="/admin/nodes" replace />
                ) : (
                  <AdminLibrariesPage />
                )
              }
            />
          </Route>

          <Route path="players">
            <Route index element={<AdminUsersPage />} />
            <Route path="invites" element={<AdminInvitesPage />} />
            <Route path="requests" element={<AdminRequestsPage />} />
            <Route path="bugs" element={<AdminBugsPage />} />
          </Route>

          <Route path="insights">
            <Route index element={<AdminAnalyticsPage />} />
            <Route path="health" element={<AdminHealthPage />} />
          </Route>

          <Route path="appearance">
            <Route index element={<AdminThemePage />} />
            <Route path="landing" element={<AdminLandingPage />} />
            <Route path="client" element={<AdminClientPage />} />
          </Route>

          {/* Nodes was a tab inside Settings, which put "is my archive being
              served" next to the Discord token. It is the thing an operator
              checks, so it is a section. */}
          <Route path="nodes">
            <Route index element={<AdminNodesPage />} />
            <Route path="map" element={<AdminNodeMapPage />} />
            <Route path="analytics" element={<AdminNodeAnalyticsPage />} />
            <Route path="enrolment" element={<AdminNodeEnrolmentPage />} />
          </Route>

          <Route path="settings">
            <Route index element={<AdminSettingsPage />} />
            <Route path="discord" element={<AdminDiscordPage />} />
            <Route path="api" element={<AdminApiPage />} />
          </Route>
        </Route>

        {/* Where the old flat URLs went. Operators bookmark these, and a dead
            bookmark that lands on the landing page reads as "that feature is
            gone" rather than "it moved". */}
        {Object.entries(ADMIN_REDIRECTS).map(([from, to]) => (
          <Route key={from} path={from} element={<Navigate to={to} replace />} />
        ))}
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
