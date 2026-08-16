import type { ReactElement } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout.js';
import { PageLoader } from './components/ui.js';
import { useSession } from './hooks/useSession.js';
import { AdminPage } from './pages/AdminPage.js';
import { GamePage } from './pages/GamePage.js';
import { LibraryPage } from './pages/LibraryPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { RegisterPage } from './pages/RegisterPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { SetupPage } from './pages/SetupPage.js';

function RequireAuth({ children }: { children: ReactElement }) {
  const { user, isLoading, status } = useSession();
  const location = useLocation();

  if (isLoading) return <PageLoader label="Signing in" />;

  // A brand-new server sends everyone to first-run setup instead of a login box.
  if (!user && status?.needsSetup) {
    return <Navigate to="/setup" replace />;
  }
  if (!user) {
    // Remember where they were headed so login can send them back.
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return children;
}

function RequireAdmin({ children }: { children: ReactElement }) {
  const { isAdmin, isLoading } = useSession();
  if (isLoading) return <PageLoader />;
  if (!isAdmin) return <Navigate to="/" replace />;
  return children;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/register" element={<RegisterPage />} />

      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<LibraryPage />} />
        <Route path="/game/:id" element={<GamePage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route
          path="/admin"
          element={
            <RequireAdmin>
              <AdminPage />
            </RequireAdmin>
          }
        />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
