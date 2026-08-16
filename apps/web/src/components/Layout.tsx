import clsx from 'clsx';
import { LibraryBig, LogOut, Settings, Shield, Swords } from 'lucide-react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useSession } from '../hooks/useSession.js';

export function Layout() {
  const { user, isAdmin, status, signOut } = useSession();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate('/login', { replace: true });
  };

  const navClass = ({ isActive }: { isActive: boolean }) =>
    clsx(
      'inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
      isActive ? 'bg-ink-700 text-white' : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100',
    );

  return (
    <div className="min-h-screen">
      <header className="border-ink-700/70 bg-ink-950/80 sticky top-0 z-30 border-b backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-3 px-4 sm:px-6">
          <NavLink to="/" className="mr-2 inline-flex items-center gap-2">
            <Swords className="text-blade-400 h-6 w-6" aria-hidden />
            <span className="text-base font-semibold tracking-tight">
              {status?.serverName ?? 'GameBlade'}
            </span>
          </NavLink>

          <nav className="flex items-center gap-1">
            <NavLink to="/" end className={navClass}>
              <LibraryBig className="h-4 w-4" aria-hidden />
              <span className="hidden sm:inline">Library</span>
            </NavLink>
            {isAdmin ? (
              <NavLink to="/admin" className={navClass}>
                <Shield className="h-4 w-4" aria-hidden />
                <span className="hidden sm:inline">Admin</span>
              </NavLink>
            ) : null}
          </nav>

          <div className="ml-auto flex items-center gap-1">
            <NavLink to="/settings" className={navClass}>
              <Settings className="h-4 w-4" aria-hidden />
              <span className="hidden sm:inline">{user?.username}</span>
            </NavLink>
            <button type="button" onClick={handleSignOut} className={navClass({ isActive: false })}>
              <LogOut className="h-4 w-4" aria-hidden />
              <span className="sr-only">Sign out</span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}
