import type { PublicServerInfo } from '@gameblade/shared';
import { useQuery } from '@tanstack/react-query';
import {
  Archive,
  CloudUpload,
  Download,
  Gamepad2,
  Github,
  MonitorDown,
  Sparkles,
  Swords,
  Trophy,
  Users,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';

/**
 * The public face of the server.
 *
 * This is the only page an unauthenticated visitor ever sees. It exists to
 * explain what the server is and hand over the Windows client — the library
 * itself lives entirely in the desktop app, so there is deliberately nothing
 * to browse here.
 */
export function LandingPage() {
  const infoQuery = useQuery({
    queryKey: ['public', 'info'],
    queryFn: () => api.get<PublicServerInfo>('/public/info'),
    staleTime: 60_000,
  });

  const info = infoQuery.data;
  const serverName = info?.serverName ?? 'GameBlade';

  return (
    <div className="min-h-screen">
      <header className="border-ink-800/80 sticky top-0 z-30 border-b bg-[#07080c]/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-5">
          <span className="inline-flex items-center gap-2">
            <Swords className="text-blade-400 h-6 w-6" aria-hidden />
            <span className="text-base font-semibold tracking-tight">{serverName}</span>
          </span>

          <nav className="ml-auto flex items-center gap-2">
            <Link to="/login" className="gb-btn-ghost">
              Sign in
            </Link>
            {info?.downloadUrl ? (
              <a href={info.downloadUrl} className="gb-btn-primary">
                <Download className="h-4 w-4" aria-hidden />
                Download
              </a>
            ) : null}
          </nav>
        </div>
      </header>

      <main>
        <Hero info={info} serverName={serverName} />
        <Features />
        <Preservation />
        <GetStarted info={info} />
      </main>

      <footer className="border-ink-800/80 border-t">
        <div className="text-ink-400 mx-auto flex max-w-6xl flex-col gap-2 px-5 py-8 text-sm sm:flex-row sm:items-center">
          <p>
            {serverName} · a private, invite-only archive. Free, and always will be — there is
            nothing here to sell.
          </p>
          <a
            href="https://github.com/scopeddlol/GameBlade"
            className="hover:text-ink-200 inline-flex items-center gap-1.5 sm:ml-auto"
            rel="noreferrer noopener"
            target="_blank"
          >
            <Github className="h-4 w-4" aria-hidden />
            Source
          </a>
        </div>
      </footer>
    </div>
  );
}

function Hero({ info, serverName }: { info?: PublicServerInfo; serverName: string }) {
  return (
    <section className="relative overflow-hidden">
      {/* Two soft radial washes behind the copy, so the near-black page still
          has some depth without pulling attention off the text. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          background:
            'radial-gradient(60rem 30rem at 15% -10%, rgba(43,183,245,0.18), transparent 60%),' +
            'radial-gradient(45rem 25rem at 85% 10%, rgba(124,92,255,0.16), transparent 60%)',
        }}
      />

      <div className="relative mx-auto max-w-6xl px-5 pt-20 pb-24 sm:pt-28">
        <p className="border-ink-700 bg-ink-850/70 text-ink-300 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium">
          <Sparkles className="text-blade-400 h-3.5 w-3.5" aria-hidden />
          Invite-only · self-hosted · no accounts to buy
        </p>

        <h1 className="mt-6 max-w-3xl text-4xl leading-[1.1] font-semibold tracking-tight text-balance sm:text-6xl">
          Your games library,{' '}
          <span className="from-blade-400 bg-gradient-to-r to-violet-400 bg-clip-text text-transparent">
            preserved properly.
          </span>
        </h1>

        <p className="text-ink-300 mt-6 max-w-2xl text-lg leading-relaxed text-pretty">
          {info?.tagline ?? 'A private home for free-to-play and DRM-free games worth keeping.'}{' '}
          {serverName} keeps the files, the artwork, your saves and your achievements — and hands
          them to a desktop app that feels like it belongs on your machine.
        </p>

        <div className="mt-9 flex flex-wrap items-center gap-3">
          {info?.downloadUrl ? (
            <a href={info.downloadUrl} className="gb-btn-primary px-5 py-2.5 text-base">
              <MonitorDown className="h-5 w-5" aria-hidden />
              Download for Windows
              {info.clientVersion ? (
                <span className="text-blade-400/90 text-sm font-normal">{info.clientVersion}</span>
              ) : null}
            </a>
          ) : (
            <span className="border-ink-700 text-ink-400 rounded-lg border border-dashed px-5 py-2.5 text-sm">
              The Windows client download has not been published yet.
            </span>
          )}

          <Link to="/login" className="gb-btn-ghost px-5 py-2.5 text-base">
            Sign in to the admin panel
          </Link>
        </div>

        {info && info.gameCount > 0 ? (
          <dl className="border-ink-800 mt-14 flex flex-wrap gap-x-12 gap-y-6 border-t pt-8">
            <Stat label="Games archived" value={info.gameCount.toLocaleString()} />
            <Stat label="Cost to you" value="Nothing" />
            <Stat label="Ads or tracking" value="None" />
          </dl>
        ) : null}
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-ink-400 text-xs tracking-wide uppercase">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tracking-tight">{value}</dd>
    </div>
  );
}

const FEATURES = [
  {
    icon: Gamepad2,
    title: 'One app for everything',
    body: 'Browse the store, install, launch and track playtime from a native Windows client. No browser tab pretending to be a game launcher.',
  },
  {
    icon: CloudUpload,
    title: 'Saves that follow you',
    body: 'Your save files sync to the server after every session, with version history and a real conflict prompt when two machines disagree.',
  },
  {
    icon: Trophy,
    title: 'Achievements, even here',
    body: 'Achievement sets are pulled from public sources and tracked per account, so a DRM-free copy still earns something.',
  },
  {
    icon: Users,
    title: 'Friends and activity',
    body: 'See what everyone is playing right now, share clips and screenshots, and keep a profile that actually looks like yours.',
  },
  {
    icon: Archive,
    title: 'Metadata worth having',
    body: 'Covers, heroes, logos and descriptions are fetched, cached locally and hand-editable — the archive keeps working if a provider vanishes.',
  },
  {
    icon: Download,
    title: 'Downloads that resume',
    body: 'Parallel, resumable transfers verified against per-file checksums. A dropped connection costs you seconds, not the whole download.',
  },
] as const;

function Features() {
  return (
    <section className="border-ink-800/80 border-t">
      <div className="mx-auto max-w-6xl px-5 py-20">
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Built like a storefront, run like a library
        </h2>
        <p className="text-ink-300 mt-3 max-w-2xl">
          Everything you would expect from a modern game client, pointed at an archive you control
          instead of a shop.
        </p>

        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <Card key={feature.title}>
              <feature.icon className="text-blade-400 h-6 w-6" aria-hidden />
              <h3 className="mt-4 font-semibold">{feature.title}</h3>
              <p className="text-ink-300 mt-2 text-sm leading-relaxed">{feature.body}</p>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className="gb-card hover:border-ink-600 p-6 transition-colors">{children}</div>;
}

function Preservation() {
  return (
    <section className="border-ink-800/80 border-t">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-20 lg:grid-cols-2 lg:gap-16">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            This is about keeping things
          </h2>
          <div className="text-ink-300 mt-5 space-y-4 leading-relaxed">
            <p>
              Free-to-play games get delisted. Servers shut down. Installers disappear from the web
              and take a decade of someone&rsquo;s work with them. DRM-free copies are the ones that
              survive that — but only if somebody is actually keeping them.
            </p>
            <p>
              GameBlade is the software for doing exactly that: a server that holds the files, and a
              client that makes playing them feel current rather than archaeological.
            </p>
            <p className="text-ink-200">
              Nobody is charged for anything. There is no tier, no upsell and no telemetry. The
              server is run by one person for a small number of invited people, and the code is open
              so you can run your own.
            </p>
          </div>
        </div>

        <div className="gb-card space-y-5 p-7">
          <h3 className="text-sm font-semibold tracking-wide uppercase">What is kept here</h3>
          <ul className="space-y-4 text-sm">
            <Bullet title="Free-to-play games">
              Titles that were given away and could be pulled at any time.
            </Bullet>
            <Bullet title="DRM-free releases">
              Copies that run without phoning anything home, so they still work in ten years.
            </Bullet>
            <Bullet title="Freeware and abandonware">
              Small, strange and personal games that never had a storefront to be delisted from.
            </Bullet>
          </ul>
          <p className="text-ink-400 border-ink-800 border-t pt-4 text-xs leading-relaxed">
            Nothing that requires a licence to play belongs on this server, and access is by invite
            only.
          </p>
        </div>
      </div>
    </section>
  );
}

function Bullet({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="bg-blade-500 mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" aria-hidden />
      <span>
        <span className="font-medium">{title}</span>
        <span className="text-ink-400 block">{children}</span>
      </span>
    </li>
  );
}

function GetStarted({ info }: { info?: PublicServerInfo }) {
  return (
    <section className="border-ink-800/80 border-t">
      <div className="mx-auto max-w-3xl px-5 py-20 text-center">
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Getting in</h2>
        <p className="text-ink-300 mt-4">
          {info?.allowSelfRegistration
            ? 'Registration is currently open. Create an account, then install the Windows client and sign in with it.'
            : 'Accounts are created from an invite. Once someone sends you a link, it walks you through the whole thing.'}
        </p>

        <div className="mt-8 flex flex-wrap justify-center gap-3">
          {info?.allowSelfRegistration ? (
            <Link to="/register" className="gb-btn-primary px-5 py-2.5">
              Create an account
            </Link>
          ) : null}
          {info?.downloadUrl ? (
            <a href={info.downloadUrl} className="gb-btn-ghost px-5 py-2.5">
              <MonitorDown className="h-4 w-4" aria-hidden />
              Get the client
            </a>
          ) : null}
        </div>

        {/* The first visitor to a fresh server needs a way in; once an admin
            exists this disappears for good. */}
        {info && !info.isConfigured ? (
          <p className="mt-8 rounded-lg border border-amber-900/60 bg-amber-950/40 px-4 py-3 text-sm text-amber-200">
            This server has no administrator yet.{' '}
            <Link to="/setup" className="underline underline-offset-2">
              Set one up
            </Link>{' '}
            to finish installing it.
          </p>
        ) : null}
      </div>
    </section>
  );
}
