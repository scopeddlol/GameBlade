import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useCallback } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useServerRole } from '../hooks/useServerRole.js';
import { api } from '../lib/api.js';
import { sectionFor, type Prefetch } from './adminNav.js';

/**
 * Starts a page's requests when the pointer reaches its link.
 *
 * The gap between a link being pointed at and being clicked is a few hundred
 * milliseconds of doing nothing, which is most of what a small JSON request
 * costs. Spending it means the page usually has its data by the time it
 * mounts, and renders content instead of a spinner.
 *
 * `prefetchQuery` is a no-op for anything already cached and fresh, so
 * sweeping the pointer across the sidebar costs nothing.
 */
export function usePrefetch(): (hints: Prefetch[] | undefined) => void {
  const queryClient = useQueryClient();

  return useCallback(
    (hints: Prefetch[] | undefined) => {
      for (const hint of hints ?? []) {
        void queryClient.prefetchQuery({
          queryKey: hint.key,
          queryFn: () => api.get(hint.path),
          // Long enough that the click always lands inside it; the page's own
          // query decides how long the answer stays good after that.
          staleTime: 30_000,
        });
      }
    },
    [queryClient],
  );
}

/**
 * The shell every grouped admin section renders inside.
 *
 * The heading and the sub-tab strip come from the shared navigation map rather
 * than from each page, so a page cannot end up under a heading that disagrees
 * with the sidebar entry that got you there. Sections with a single page get
 * the heading and no strip.
 */
export function AdminSection() {
  const location = useLocation();
  const prefetch = usePrefetch();
  const section = sectionFor(location.pathname, useServerRole());

  if (!section) return <Outlet />;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{section.label}</h1>
        <p className="text-ink-400 mt-1 text-sm">{section.hint}</p>
      </header>

      {section.tabs.length > 0 ? (
        // Scrolls rather than wraps: four tabs on a phone would otherwise
        // become two rows and push the page content below the fold.
        <nav
          className="border-ink-800 -mx-1 flex gap-1 overflow-x-auto border-b px-1"
          aria-label={`${section.label} sections`}
        >
          {section.tabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              onMouseEnter={() => prefetch(tab.prefetch)}
              onFocus={() => prefetch(tab.prefetch)}
              className={({ isActive }) =>
                clsx(
                  'relative -mb-px shrink-0 rounded-t-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors',
                  'after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full',
                  isActive
                    ? 'text-ink-100 after:bg-blade-400'
                    : 'text-ink-400 hover:text-ink-100 hover:bg-ink-800/60 after:bg-transparent',
                )
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
      ) : null}

      <Outlet />
    </div>
  );
}
