import type { ProfileShowcase } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Clock, Gamepad2, MessageCircle, Trophy, UserPlus, UserX, X } from 'lucide-react';
import { formatDate, formatPlaytime, formatRelative } from '../lib/format.js';
import { errorMessage, ipc } from '../lib/ipc.js';
import { PostCard } from '../tabs/SocialTab.js';
import { Artwork, Avatar, ErrorNote, Loading } from './ui.js';

/**
 * A public-facing showcase of someone's account — bio, stats, favorite games
 * and recent posts — opened from anywhere a person's name or avatar appears
 * (a post, a friend row, the member list) rather than living on its own tab.
 */
export function ProfileDrawer({ userId, onClose }: { userId: string; onClose: () => void }) {
  const queryClient = useQueryClient();

  const showcaseQuery = useQuery({
    queryKey: ['profiles', userId, 'showcase'],
    queryFn: () => ipc.get<ProfileShowcase>(`/profiles/${userId}/showcase`),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['profiles', userId] });
    void queryClient.invalidateQueries({ queryKey: ['friends'] });
    void queryClient.invalidateQueries({ queryKey: ['members'] });
  };

  const requestMutation = useMutation({
    mutationFn: () => ipc.post('/friends/requests', { userId }),
    onSuccess: refresh,
  });
  const acceptMutation = useMutation({
    mutationFn: () => ipc.post(`/friends/${userId}/accept`),
    onSuccess: refresh,
  });
  const removeMutation = useMutation({
    mutationFn: () => ipc.del(`/friends/${userId}`),
    onSuccess: refresh,
  });

  const profile = showcaseQuery.data?.profile;

  return (
    <div className="drawer-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="drawer narrow" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
          <X size={18} aria-hidden />
        </button>

        {showcaseQuery.isLoading || !showcaseQuery.data || !profile ? (
          <Loading label="Loading profile" />
        ) : (
          <>
            <div className="profile-banner">
              {profile.bannerUrl ? <Artwork path={profile.bannerUrl} alt="" /> : null}
              <div className="profile-banner-overlay" />
            </div>

            <div className="detail-body profile-body">
              <div className="profile-head">
                <Avatar
                  url={profile.avatarUrl}
                  name={profile.displayName}
                  accent={profile.accentColor}
                  presence={profile.presence}
                  size={64}
                />
                <div>
                  <h1>{profile.displayName}</h1>
                  <p className="muted small">
                    @{profile.username}
                    {profile.presence === 'in-game' && profile.playingGameTitle
                      ? ` · Playing ${profile.playingGameTitle}`
                      : profile.presence === 'online'
                        ? ' · Online'
                        : profile.lastSeenAt
                          ? ` · Last seen ${formatRelative(profile.lastSeenAt)}`
                          : ''}
                  </p>
                  {/* Only ever present when they turned it on themselves. */}
                  {profile.discordUsername ? (
                    <p className="muted small discord-handle">
                      <MessageCircle size={12} aria-hidden />
                      {profile.discordUsername}
                    </p>
                  ) : null}
                </div>
              </div>

              {!profile.isSelf ? (
                <div className="detail-actions">
                  {profile.friendship === null ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => requestMutation.mutate()}
                      disabled={requestMutation.isPending}
                    >
                      <UserPlus size={15} aria-hidden />
                      Add friend
                    </button>
                  ) : profile.friendship.status === 'accepted' ? (
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={() => {
                        if (confirm(`Remove ${profile.displayName} from your friends?`)) {
                          removeMutation.mutate();
                        }
                      }}
                      disabled={removeMutation.isPending}
                    >
                      <UserX size={15} aria-hidden />
                      Remove friend
                    </button>
                  ) : profile.friendship.outgoing ? (
                    <button type="button" className="btn btn-ghost" disabled>
                      Request sent
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => acceptMutation.mutate()}
                      disabled={acceptMutation.isPending}
                    >
                      <Check size={15} aria-hidden />
                      Accept request
                    </button>
                  )}
                </div>
              ) : null}

              <ErrorNote
                message={
                  requestMutation.error
                    ? errorMessage(requestMutation.error)
                    : removeMutation.error
                      ? errorMessage(removeMutation.error)
                      : acceptMutation.error
                        ? errorMessage(acceptMutation.error)
                        : null
                }
              />

              {!profile.canViewDetail ? (
                <p className="muted">
                  {profile.visibility === 'private'
                    ? 'This profile is private.'
                    : 'This profile is only visible to friends.'}
                </p>
              ) : (
                <>
                  {profile.bio ? <p className="detail-summary">{profile.bio}</p> : null}

                  <div className="detail-stats">
                    <Stat label="Games" value={profile.gameCount.toLocaleString()} />
                    <Stat label="Hours played" value={formatPlaytime(profile.totalPlaySeconds)} />
                    <Stat label="Achievements" value={profile.achievementCount.toLocaleString()} />
                    <Stat label="Friends" value={profile.friendCount.toLocaleString()} />
                  </div>
                  <p className="muted small">Joined {formatDate(profile.createdAt)}</p>

                  {showcaseQuery.data.topGames.length > 0 ? (
                    <section className="detail-section">
                      <h3>
                        <Gamepad2 size={16} aria-hidden /> Favorite games
                      </h3>
                      <ul className="profile-game-list">
                        {showcaseQuery.data.topGames.map((entry) => (
                          <li key={entry.game.id}>
                            <Artwork
                              path={entry.game.coverUrl}
                              alt={entry.game.title}
                              className="profile-game-cover"
                              fallbackText={entry.game.title}
                            />
                            <span>
                              <strong>{entry.game.title}</strong>
                              <span className="muted small">
                                {formatPlaytime(entry.totalSeconds)}
                              </span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}

                  {showcaseQuery.data.recentAchievements.length > 0 ? (
                    <section className="detail-section">
                      <h3>
                        <Trophy size={16} aria-hidden /> Recent achievements
                      </h3>
                      <ul className="achievement-list">
                        {showcaseQuery.data.recentAchievements.map((achievement) => (
                          <li key={achievement.id} className="achievement">
                            <span className="achievement-icon">
                              {achievement.iconUrl ? (
                                <img src={achievement.iconUrl} alt="" loading="lazy" />
                              ) : (
                                <Trophy size={16} aria-hidden />
                              )}
                            </span>
                            <span className="achievement-text">
                              <strong>{achievement.name}</strong>
                            </span>
                            <span className="achievement-meta muted small">
                              <Clock size={11} aria-hidden />
                              {achievement.unlockedAt ? formatRelative(achievement.unlockedAt) : ''}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}

                  {showcaseQuery.data.posts.length > 0 ? (
                    <section className="detail-section">
                      <h3>Posts</h3>
                      <div className="feed">
                        {showcaseQuery.data.posts.map((post) => (
                          <PostCard
                            key={post.id}
                            post={post}
                            onChanged={() =>
                              void queryClient.invalidateQueries({
                                queryKey: ['profiles', userId, 'showcase'],
                              })
                            }
                            onError={() => {}}
                          />
                        ))}
                      </div>
                    </section>
                  ) : (
                    <p className="muted small">No posts yet.</p>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="muted small">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
