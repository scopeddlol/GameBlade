import clsx from 'clsx';
import {
  Gamepad2,
  Home,
  LayoutDashboard,
  LogOut,
  Mail,
  Server,
  Sliders,
  Sparkles,
  Swords,
  Users,
} from 'lucide-react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useSession } from '../hooks/useSession.js';

const SECTIONS = [
  { to: '/admin', end: true, icon: LayoutDashboard, label: 'Overview' },
  { to: '/admin/catalog', end: false, icon: Gamepad2, label: 'Catalogue' },
  { to: '/admin/featured', end: false, icon: Sparkles, label: 'Featured' },
  { to: '/admin/libraries', end: false, icon: Server, label: 'Libraries' },
  { to: '/admin/users', end: false, icon: Users, label: 'Users' },
  { to: '/admin/invites', end: false, icon: Mail, label: 'Invites' },
  { to: '/admin/settings', end: false, icon: Sliders, label: 'Settings' },
] as const;

/**
 * Shell for the admin panel — the only authenticated surface left on the web.
 *
 * Players never come here: browsing, installing and everything social happen in
 * the desktop client, so this is laid out as an operator console rather than as
 * a storefront.
 */
export function Layout() {
  const { user, status, signOut } = useSession();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate('/', { replace: true });
  };

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    clsx(
      'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
      isActive ? 'bg-ink-700 text-white' : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100',
    );

  return (
    <div className="min-h-screen lg:flex">
      <aside className="border-ink-800 bg-ink-950 lg:sticky lg:top-0 lg:h-screen lg:w-60 lg:shrink-0 lg:border-r">
        <div className="flex h-16 items-center gap-2 px-5">
          <Swords className="text-blade-400 h-6 w-6" aria-hidden />
          <span className="truncate text-base font-semibold tracking-tight">
            {status?.serverName ?? 'GameBlade'}
          </span>
        </div>

        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:overflow-visible">
          {SECTIONS.map((section) => (
            <NavLink key={section.to} to={section.to} end={section.end} className={linkClass}>
              <section.icon className="h-4 w-4 shrink-0" aria-hidden />
              <span className="whitespace-nowrap">{section.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="border-ink-800 mt-auto hidden border-t p-3 lg:block">
          <NavLink to="/" className={linkClass({ isActive: false })}>
            <Home className="h-4 w-4" aria-hidden />
            Landing page
          </NavLink>
          <button
            type="button"
            onClick={handleSignOut}
            className={clsx(linkClass({ isActive: false }), 'w-full')}
          >
            <LogOut className="h-4 w-4" aria-hidden />
            Sign out {user ? `(${user.username})` : ''}
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-5 py-6 lg:px-8">
        <Outlet />
      </main>
    </div>
  );
}
