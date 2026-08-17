import type { GameSummary, HomeFeed } from '@gameblade/shared';
import { useQuery } from '@tanstack/react-query';
import { Clock, Trophy, Users } from 'lucide-react';
import { useState } from 'react';
import { GameShelf } from '../components/GameCard.js';
import { Artwork, Avatar, Empty, Loading, SectionHeader } from '../components/ui.js';
import { formatPlaytime, formatRelative } from '../lib/format.js';
import { ipc } from '../lib/ipc.js';

/**
 * The landing screen. Everything here comes from a single `/home` request —
 * the app opens on this tab, so its cold-start latency is what the client's
 * speed is judged on, and six parallel fetches would each pay their own.
 */
export function HomeTab({ onOpenGame }: { onOpenGame: (game: GameSummary) => void }) {
  const homeQuery = useQuery({
    queryKey: ['home'],
    queryFn: () => ipc.get<HomeFeed>('/home'),
    staleTime: 30_000,
  });

  if (homeQuery.isLoading) return <Loading label="Loading your library" />;
  const home = homeQuery.data;
  if (!home) return <Empty title="Could not reach the server" message="Check Settings." />;

  return (
    <div className="tab-content">
      {home.featured.length > 0 ? (
        <FeaturedCarousel entries={home.featured} onOpenGame={onOpenGame} />
      ) : null}

      {home.continuePlaying.length > 0 ? (
        <section>
          <SectionHeader title="Jump back in" />
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
        <SectionHeader title="Recently added" subtitle="New arrivals in the archive" />
        <GameShelf
          games={home.recentlyAdded}
          onOpen={onOpenGame}
          emptyMessage="Nothing has been added yet."
        />
      </section>

      <div className="home-columns">
        <section>
          <SectionHeader title="Friend activity" />
          {home.friendActivity.length === 0 ? (
            <p className="muted">
              Nothing yet. Add some friends from the Social tab and their activity shows up here.
            </p>
          ) : (
            <ul className="activity-list">
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
            <ul className="activity-list">
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
          <Trophy size={14} aria-hidden /> {home.stats.games.toLocaleString()} games archived
        </span>
        <span>
          <Users size={14} aria-hidden /> {home.stats.users} members
        </span>
        <span>
          <Clock size={14} aria-hidden /> {home.stats.totalPlayHours.toLocaleString()} hours played
        </span>
      </footer>
    </div>
  );
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
  const current = entries[Math.min(index, entries.length - 1)];
  if (!current) return null;

  return (
    <section className="featured">
      <button
        type="button"
        className="featured-hero"
        onClick={() => onOpenGame(current.game)}
        aria-label={`Open ${current.game.title}`}
      >
        <Artwork
          path={current.heroUrl ?? current.game.art.cover}
          alt=""
          className="featured-img"
          fallbackText={current.game.title}
        />
        <span className="featured-overlay" />
        <span className="featured-text">
          {current.headline ? <span className="featured-kicker">{current.headline}</span> : null}
          <span className="featured-title">{current.game.title}</span>
          {current.blurb ? <span className="featured-blurb">{current.blurb}</span> : null}
        </span>
      </button>

      {entries.length > 1 ? (
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
