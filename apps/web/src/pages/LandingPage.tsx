import type { PublicServerInfo } from '@gameblade/shared';
import { useQuery } from '@tanstack/react-query';
import { Download, Menu, Swords, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { LandingBlocks } from '../components/LandingBlocks.js';
import { useSession } from '../hooks/useSession.js';
import { useApplyTheme } from '../hooks/useTheme.js';
import { api } from '../lib/api.js';

/**
 * The public face of the server.
 *
 * Its content is data now: an ordered list of blocks an operator edits in the
 * admin panel, falling back to the page that used to be written here. The
 * chrome — header, footer, first-run prompt — stays in code, because it is
 * structural rather than editorial.
 */
export function LandingPage() {
  const { user, isAdmin } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);

  const infoQuery = useQuery({
    queryKey: ['public', 'info'],
    queryFn: () => api.get<PublicServerInfo>('/public/info'),
    staleTime: 60_000,
  });

  const info = infoQuery.data;
  const serverName = info?.serverName ?? 'GameBlade';
  useApplyTheme(info?.theme.tokens);

  const navLinks = (
    <>
      {user ? (
        <>
          {isAdmin ? (
            <Link to="/admin" className="gb-btn-ghost" onClick={() => setMenuOpen(false)}>
              Admin panel
            </Link>
          ) : null}
          <Link to="/account" className="gb-btn-ghost" onClick={() => setMenuOpen(false)}>
            {user.username}
          </Link>
        </>
      ) : (
        <Link to="/login" className="gb-btn-ghost" onClick={() => setMenuOpen(false)}>
          Sign in
        </Link>
      )}
      {info?.downloadUrl ? (
        <a href={info.downloadUrl} className="gb-btn-primary" onClick={() => setMenuOpen(false)}>
          <Download className="h-4 w-4" aria-hidden />
          Download
        </a>
      ) : null}
    </>
  );

  return (
    <div className="bg-ink-900 min-h-screen">
      <header className="border-ink-800/80 bg-ink-950/80 sticky top-0 z-30 border-b backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-5">
          <Link to="/" className="inline-flex min-w-0 items-center gap-2">
            <Swords className="text-blade-400 h-6 w-6 shrink-0" aria-hidden />
            <span className="truncate text-base font-semibold tracking-tight">{serverName}</span>
          </Link>

          <nav className="ml-auto hidden items-center gap-2 sm:flex">{navLinks}</nav>

          {/* Below the small breakpoint the same links live behind a toggle,
              rather than wrapping into a second row that pushes the page down. */}
          <button
            type="button"
            className="gb-btn-ghost ml-auto sm:hidden"
            aria-expanded={menuOpen}
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? (
              <X className="h-5 w-5" aria-hidden />
            ) : (
              <Menu className="h-5 w-5" aria-hidden />
            )}
          </button>
        </div>

        {menuOpen ? (
          <div className="border-ink-800/80 bg-ink-950 flex flex-col gap-2 border-t px-4 py-3 sm:hidden">
            {navLinks}
          </div>
        ) : null}
      </header>

      <main>
        <LandingBlocks blocks={info?.landingBlocks ?? []} context={{ info }} />

        {/* The first visitor to a fresh server needs a way in; once an admin
            exists this disappears for good. */}
        {info && !info.isConfigured ? (
          <section className="mx-auto max-w-3xl px-5 pb-16">
            <div className="border-blade-700/60 bg-blade-700/10 rounded-xl border p-6 text-center">
              <h2 className="text-lg font-semibold">This server has no administrator yet</h2>
              <p className="text-ink-300 mt-2 text-sm">
                Create the first account to finish setting it up.
              </p>
              <Link to="/setup" className="gb-btn-primary mt-4 inline-flex">
                Set up {serverName}
              </Link>
            </div>
          </section>
        ) : null}
      </main>

      <footer className="border-ink-800/80 border-t">
        <div className="text-ink-400 mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-5 py-8 text-sm">
          <span>
            {serverName}
            {info?.clientVersion ? ` · client ${info.clientVersion}` : ''}
          </span>
          <span className="ml-auto flex gap-4">
            {user ? null : (
              <Link to="/login" className="hover:text-ink-200">
                Sign in
              </Link>
            )}
            {info?.allowSelfRegistration ? (
              <Link to="/register" className="hover:text-ink-200">
                Create an account
              </Link>
            ) : null}
          </span>
        </div>
      </footer>
    </div>
  );
}
