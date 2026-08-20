import type { GameSummary, HomeFeed } from '@gameblade/shared';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Gamepad2,
  HardDrive,
  Sparkles,
  Trophy,
  Users,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { GameShelf } from '../components/GameCard.js';
import { REQUEST_ICONS, RequestPanel } from '../components/GameRequests.js';
import { Artwork, Avatar, Empty, Loading, SectionHeader } from '../components/ui.js';
import { useSession } from '../hooks/useSession.js';
import { formatBytes, formatPlaytime, formatRelative } from '../lib/format.js';
import { ipc } from '../lib/ipc.js';
import { useArtwork } from '../hooks/useArtwork.js';

/**
 * How long the featured hero rests on one entry before advancing.
 *
 * Seven seconds read as broken — long enough that the first slide looked like
 * the only slide. Four and a half is enough to take in a title and a line of
 * copy without the shelf feeling stalled, and the pointer still pauses it.
 */
const CAROUSEL_MS = 4500;

/**
 * The landing screen. Everything here comes from a single `/home` request —
 * the app opens on this tab, so its cold-start latency is what the client's
 * speed is judged on, and eight parallel fetches would each pay their own.
 */
export function HomeTab({
  onOpenGame,
  onOpenGameId,
}: {
  onOpenGame: (game: GameSummary) => void;
  onOpenGameId?: (gameId: string) => void;
}) {
  const { session } = useSession();
  const homeQuery = useQuery({
    queryKey: ['home'],
    queryFn: () => ipc.get<HomeFeed>('/home'),
    staleTime: 30_000,
  });

  if (homeQuery.isLoading) return <Loading label="Loading your library" />;
  const home = homeQuery.data;
  if (!home) return <Empty title="Could not reach the server" message="Check Settings." />;

  const { requests, you, stats } = home;

  return (
    <div className="tab-content">
      <header className="home-greeting">
        <div>
          <h1>
            {greeting()}, {session?.username ?? 'player'}.
          </h1>
          <p className="muted">{summaryLine(home)}</p>
        </div>

        <div className="home-you">
          <YouStat label="In your library" value={you.libraryCount.toLocaleString()} />
          <YouStat
            label="You have played"
            value={you.playSeconds > 0 ? formatPlaytime(you.playSeconds) : '—'}
          />
          <YouStat label="Achievements" value={you.unlockedCount.toLocaleString()} />
          <YouStat label="Friends" value={you.friendCount.toLocaleString()} />
        </div>
      </header>

      {home.featured.length > 0 ? (
        <FeaturedCarousel entries={home.featured} onOpenGame={onOpenGame} />
      ) : null}

      {home.continuePlaying.length > 0 ? (
        <section>
          <SectionHeader title="Jump back in" subtitle="Where you left off" />
          <GameShelf games={home.continuePlaying} onOpen={onOpenGame} />
        </section>
      ) : null}

      {home.friendsPlaying.length > 0 ? (
        <section>
          <SectionHeader title="Friends are playing" />
          <div className="friend-playing-row">
            {home.friendsPlaying.map(({ profile, game }) => (
              <button
                key={profile.userId}
                type="button"
                className="friend-playing"
                onClick={() => onOpenGame(game)}
              >
                <Artwork path={game.art.cover} alt={game.title} className="mini-cover" />
                <span>
                  <strong>{profile.displayName}</strong>
                  <span className="muted small">{game.title}</span>
                  {profile.playingSince ? (
                    <span className="muted small">
                      since {formatRelative(profile.playingSince)}
                    </span>
                  ) : null}
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <SectionHeader
          title="Recently added"
          subtitle={
            stats.newThisWeek > 0
              ? `${stats.newThisWeek} arrived in the last week`
              : 'New arrivals in the archive'
          }
        />
        <GameShelf
          games={home.recentlyAdded}
          onOpen={onOpenGame}
          emptyMessage="Nothing has been added yet."
        />
      </section>

      {/* What the operator has promised and what people are asking for. Both
          are empty on a server nobody has used the request queue on, and the
          whole strip disappears rather than showing two empty boxes. */}
      {requests.comingSoon.length > 0 || requests.mostRequested.length > 0 ? (
        <div className="home-columns">
          {requests.comingSoon.length > 0 ? (
            <RequestPanel
              title="Coming soon"
              hint="Asked for, and on the way"
              icon={REQUEST_ICONS.comingSoon}
              requests={requests.comingSoon}
              emptyMessage="Nothing announced."
              onOpenGame={onOpenGameId}
            />
          ) : null}

          {requests.mostRequested.length > 0 ? (
            <RequestPanel
              title="Most requested"
              hint="Back one and it moves up the list"
              icon={REQUEST_ICONS.mostRequested}
              requests={requests.mostRequested}
              emptyMessage="Nobody has asked for anything yet."
              onOpenGame={onOpenGameId}
            />
          ) : null}
        </div>
      ) : null}

      {requests.recentlyAdded.length > 0 ? (
        <RequestPanel
          title="Recently granted"
          hint="Requests that made it into the archive"
          icon={REQUEST_ICONS.added}
          requests={requests.recentlyAdded}
          emptyMessage="Nothing yet."
          onOpenGame={onOpenGameId}
        />
      ) : null}

      <div className="home-columns">
        <section>
          <SectionHeader title="Friend activity" subtitle="The last few things they did" />
          {home.friendActivity.length === 0 ? (
            <p className="muted">
              Nothing yet. Add some friends from the Social tab and their activity shows up here.
            </p>
          ) : (
            // Capped by the server and again by a scroll box here: this panel
            // used to grow without limit and push everything below it off the
            // screen.
            <ul className="activity-list capped">
              {home.friendActivity.map((entry) => (
                <li key={entry.id}>
                  <Avatar
                    url={entry.actor.avatarUrl}
                    name={entry.actor.displayName}
                    accent={entry.actor.accentColor}
                    presence={entry.actor.presence}
                    size={30}
                  />
                  <span className="activity-text">
                    <strong>{entry.actor.displayName}</strong> {describeActivity(entry)}
                    <span className="muted small"> · {formatRelative(entry.createdAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <SectionHeader title="Recent unlocks" />
          {home.recentAchievements.length === 0 ? (
            <p className="muted">No achievements unlocked yet.</p>
          ) : (
            <ul className="activity-list capped">
              {home.recentAchievements.map((achievement) => (
                <li key={achievement.id}>
                  <span className="achievement-icon small">
                    {achievement.iconUrl ? (
                      <img src={achievement.iconUrl} alt="" loading="lazy" />
                    ) : (
                      <Trophy size={14} aria-hidden />
                    )}
                  </span>
                  <span className="activity-text">
                    <strong>{achievement.name}</strong>
                    <span className="muted small"> · {formatRelative(achievement.unlockedAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <footer className="home-stats">
        <span>
          <Gamepad2 size={14} aria-hidden /> {stats.games.toLocaleString()} games archived
        </span>
        <span>
          <HardDrive size={14} aria-hidden /> {formatBytes(stats.archiveBytes)} on the shelves
        </span>
        <span>
          <Users size={14} aria-hidden /> {stats.users} members
        </span>
        <span>
          <Clock size={14} aria-hidden /> {stats.totalPlayHours.toLocaleString()} hours played
        </span>
        {stats.newThisWeek > 0 ? (
          <span>
            <Sparkles size={14} aria-hidden /> {stats.newThisWeek} added this week
          </span>
        ) : null}
      </footer>
    </div>
  );
}

function YouStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="you-stat">
      <span className="you-stat-value">{value}</span>
      <span className="muted small">{label}</span>
    </div>
  );
}

/** Local clock, not the server's: this is about the person reading it. */
function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/**
 * One line that says something specific about the archive today.
 *
 * Picked in priority order rather than concatenated: three clauses of numbers
 * reads as a status page, and only the most recent thing is actually news.
 */
function summaryLine(home: HomeFeed): string {
  if (home.friendsPlaying.length > 0) {
    const [first] = home.friendsPlaying;
    return home.friendsPlaying.length === 1
      ? `${first?.profile.displayName} is playing ${first?.game.title}.`
      : `${home.friendsPlaying.length} friends are playing right now.`;
  }
  if (home.stats.newThisWeek > 0) {
    return `${home.stats.newThisWeek} new ${
      home.stats.newThisWeek === 1 ? 'game' : 'games'
    } in the archive this week.`;
  }
  if (home.continuePlaying.length > 0) {
    return `Pick up ${home.continuePlaying[0]?.title} where you left it.`;
  }
  return `${home.stats.games.toLocaleString()} games waiting for you.`;
}

function describeActivity(entry: HomeFeed['friendActivity'][number]): string {
  switch (entry.kind) {
    case 'played':
      return `played ${entry.game?.title ?? 'a game'} for ${formatPlaytime(entry.seconds ?? 0)}`;
    case 'added-game':
      return `added ${entry.game?.title ?? 'a game'} to their library`;
    case 'unlocked-achievement':
      return `unlocked ${entry.achievement?.name ?? 'an achievement'}${
        entry.game ? ` in ${entry.game.title}` : ''
      }`;
    case 'posted':
      return entry.post?.title ? `posted "${entry.post.title}"` : 'shared a post';
    case 'friended':
      return 'made a new friend';
    default:
      return 'did something';
  }
}

function FeaturedCarousel({
  entries,
  onOpenGame,
}: {
  entries: HomeFeed['featured'];
  onOpenGame: (game: GameSummary) => void;
}) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const count = entries.length;

  // Advances on its own, because a carousel nobody clicks shows one game
  // forever. Pauses under the pointer so it cannot slide out from under a
  // click that is about to land.
  useEffect(() => {
    if (count < 2 || paused) return;
    const timer = setInterval(() => setIndex((current) => (current + 1) % count), CAROUSEL_MS);
    return () => clearInterval(timer);
  }, [count, paused]);

  // The next slide's artwork is fetched while the current one is still up, so
  // advancing swaps a decoded image instead of showing the placeholder for as
  // long as the download takes. Chasing the same URL the <img> will ask for
  // means the browser serves the second request from cache.
  const upcoming = entries[(index + 1) % Math.max(count, 1)];
  const nextUrl = useArtwork(upcoming ? (upcoming.heroUrl ?? upcoming.game.art.cover) : null);
  useEffect(() => {
    if (!nextUrl) return;
    const image = new Image();
    image.src = nextUrl;
  }, [nextUrl]);

  const current = entries[Math.min(index, count - 1)];
  if (!current) return null;

  const step = (delta: number) => setIndex((current) => (current + delta + count) % count);

  return (
    <section
      className="featured"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* The hero is a button, so the arrows cannot live inside it — nesting
          buttons is invalid and the inner one would swallow the click. They
          share this wrapper instead, which is what they are positioned against. */}
      <div className="featured-frame">
        <button
          type="button"
          className="featured-hero"
          onClick={() => onOpenGame(current.game)}
          aria-label={`Open ${current.game.title}`}
        >
          <Artwork
            key={current.game.id}
            path={current.heroUrl ?? current.game.art.cover}
            alt=""
            className="featured-img"
            fallbackText={current.game.title}
          />
          <span className="featured-overlay" />
          <span className="featured-text">
            {current.headline ? <span className="featured-kicker">{current.headline}</span> : null}
            {/* A wordmark where the game has one; its title otherwise. The logo
                is the artwork the publisher drew for exactly this job. */}
            {current.game.art.logo ? (
              <Artwork
                path={current.game.art.logo}
                alt={current.game.title}
                className="featured-logo"
              />
            ) : (
              <span className="featured-title">{current.game.title}</span>
            )}
            {current.blurb ? <span className="featured-blurb">{current.blurb}</span> : null}
          </span>
        </button>

        {count > 1 ? (
          <>
            <button
              type="button"
              className="featured-arrow left"
              aria-label="Previous"
              onClick={() => step(-1)}
            >
              <ChevronLeft size={18} aria-hidden />
            </button>
            <button
              type="button"
              className="featured-arrow right"
              aria-label="Next"
              onClick={() => step(1)}
            >
              <ChevronRight size={18} aria-hidden />
            </button>
          </>
        ) : null}
      </div>

      {count > 1 ? (
        <div className="featured-dots" role="tablist">
          {entries.map((entry, position) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={position === index}
              aria-label={entry.game.title}
              className={position === index ? 'dot active' : 'dot'}
              onClick={() => setIndex(position)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
