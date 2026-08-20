import clsx from 'clsx';
import {
  ChartLine,
  Gamepad2,
  Home,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Inbox,
  Mail,
  Menu,
  MonitorSmartphone,
  Palette,
  Server,
  Sliders,
  Sparkles,
  Swords,
  UserCircle,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '../hooks/useSession.js';

const SECTIONS = [
  { to: '/admin', end: true, icon: LayoutDashboard, label: 'Overview' },
  { to: '/admin/analytics', end: false, icon: ChartLine, label: 'Analytics' },
  { to: '/admin/catalog', end: false, icon: Gamepad2, label: 'Catalog' },
  { to: '/admin/featured', end: false, icon: Sparkles, label: 'Featured' },
  { to: '/admin/requests', end: false, icon: Inbox, label: 'Requests' },
  { to: '/admin/appearance', end: false, icon: Palette, label: 'Appearance' },
  { to: '/admin/client', end: false, icon: MonitorSmartphone, label: 'Desktop client' },
  { to: '/admin/libraries', end: false, icon: Server, label: 'Libraries' },
  { to: '/admin/users', end: false, icon: Users, label: 'Users' },
  { to: '/admin/invites', end: false, icon: Mail, label: 'Invites' },
  { to: '/admin/api', end: false, icon: KeyRound, label: 'API keys' },
  { to: '/admin/settings', end: false, icon: Sliders, label: 'Settings' },
] as const;

/**
 * Shell for the admin panel — the only authenticated surface left on the web.
 *
 * Players never come here: browsing, installing and everything social happen in
 * the desktop client, so this is laid out as an operator console rather than as
 * a storefront. On a phone the sidebar becomes a drawer rather than a
 * horizontally scrolling strip: eleven sections do not fit across a phone, and
 * the account and sign-out controls used to be dropped entirely at that width,
 * which left no way to sign out on a phone at all.
 */
export function Layout() {
  const { user, status, signOut } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Navigating is the end of the drawer's usefulness; leaving it open over the
  // page the user just asked for is the classic mobile-nav bug.
  useEffect(() => setDrawerOpen(false), [location.pathname]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleSignOut = async () => {
    await signOut();
    navigate('/', { replace: true });
  };

  // A flat fill reads the same as a hover state with the pointer nowhere near
  // it — the gradient tint plus accent bar is what makes "this is where you
  // are" and "this is what you're pointing at" look like two different things.
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    clsx(
      'relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
      "before:absolute before:-left-3 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-r-full before:content-['']",
      isActive
        ? [
            'text-white',
            'bg-gradient-to-r from-blade-400/[0.16] to-violet-400/[0.07]',
            'before:bg-gradient-to-b before:from-blade-400 before:to-violet-400',
          ]
        : ['text-ink-300 hover:bg-ink-800 hover:text-ink-100', 'before:bg-transparent'],
    );

  const sidebarBody = (
    <>
      <nav className="flex flex-col gap-1 px-3 pb-3">
        {SECTIONS.map((section) => (
          <NavLink key={section.to} to={section.to} end={section.end} className={linkClass}>
            <section.icon className="h-4 w-4 shrink-0" aria-hidden />
            <span className="whitespace-nowrap">{section.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="border-ink-800 mt-auto border-t p-3">
        <NavLink to="/account" className={linkClass({ isActive: false })}>
          <UserCircle className="h-4 w-4" aria-hidden />
          Your account
        </NavLink>
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
    </>
  );

  return (
    <div className="min-h-screen lg:flex">
      {/* Phone and tablet: a bar with the drawer toggle. */}
      <header className="border-ink-800 bg-ink-950 sticky top-0 z-30 flex h-14 items-center gap-3 border-b px-4 lg:hidden">
        <button
          type="button"
          className="gb-btn-ghost px-2"
          aria-expanded={drawerOpen}
          aria-controls="admin-drawer"
          aria-label={drawerOpen ? 'Close navigation' : 'Open navigation'}
          onClick={() => setDrawerOpen((open) => !open)}
        >
          {drawerOpen ? (
            <X className="h-5 w-5" aria-hidden />
          ) : (
            <Menu className="h-5 w-5" aria-hidden />
          )}
        </button>
        <span className="inline-flex min-w-0 items-center gap-2">
          <Swords className="text-blade-400 h-5 w-5 shrink-0" aria-hidden />
          <span className="truncate text-sm font-semibold tracking-tight">
            {status?.serverName ?? 'GameBlade'}
          </span>
        </span>
      </header>

      {drawerOpen ? (
        <button
          type="button"
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          aria-label="Close navigation"
          onClick={() => setDrawerOpen(false)}
        />
      ) : null}

      <aside
        id="admin-drawer"
        className={clsx(
          'border-ink-800 bg-ink-950 flex flex-col',
          // Off-canvas on small screens, static beside the content on large.
          'fixed inset-y-0 left-0 z-40 w-72 max-w-[85vw] overflow-y-auto border-r transition-transform',
          drawerOpen ? 'translate-x-0' : '-translate-x-full',
          'lg:sticky lg:top-0 lg:h-screen lg:w-60 lg:max-w-none lg:translate-x-0 lg:shrink-0',
        )}
      >
        <div className="flex h-16 items-center gap-2 px-5">
          <Swords className="text-blade-400 h-6 w-6 shrink-0" aria-hidden />
          <span className="truncate text-base font-semibold tracking-tight">
            {status?.serverName ?? 'GameBlade'}
          </span>
          <button
            type="button"
            className="gb-btn-ghost ml-auto px-2 lg:hidden"
            aria-label="Close navigation"
            onClick={() => setDrawerOpen(false)}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        {sidebarBody}
      </aside>

      <main className="min-w-0 flex-1 px-4 py-5 sm:px-5 sm:py-6 lg:px-8">
        <Outlet />
      </main>
    </div>
  );
}
