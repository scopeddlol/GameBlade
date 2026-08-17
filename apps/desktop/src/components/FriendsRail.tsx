import type { FriendEntry } from '@gameblade/shared';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronsRight, Users } from 'lucide-react';
import { Avatar } from './ui.js';
import { ipc } from '../lib/ipc.js';

/**
 * A persistent friends list down the right edge, in the same spirit as a
 * Steam-style buddy list: always there, sorted by who is actually reachable
 * right now, and reusing the same `['friends', 'list']` cache the Social tab
 * keeps warm so opening this panel is never a first load.
 */
export function FriendsRail({
  collapsed,
  onToggle,
  onOpenSocial,
  onOpenProfile,
}: {
  collapsed: boolean;
  onToggle: () => void;
  onOpenSocial: () => void;
  onOpenProfile: (userId: string) => void;
}) {
  const friendsQuery = useQuery({
    queryKey: ['friends', 'list'],
    queryFn: () => ipc.get<FriendEntry[]>('/friends'),
  });

  const friends = friendsQuery.data ?? [];
  const online = friends.filter((f) => f.profile.presence !== 'offline');
  const offline = friends.filter((f) => f.profile.presence === 'offline');

  if (collapsed) {
    return (
      <div className="friends-rail collapsed">
        <button
          type="button"
          className="icon-btn"
          onClick={onToggle}
          aria-label="Show friends list"
          title="Show friends"
        >
          <Users size={17} aria-hidden />
          {online.length > 0 ? <span className="dot-badge">{online.length}</span> : null}
        </button>
      </div>
    );
  }

  return (
    <aside className="friends-rail" aria-label="Friends">
      <div className="friends-rail-head">
        <strong>Friends</strong>
        <span className="muted small">{online.length} online</span>
        <button
          type="button"
          className="icon-btn"
          onClick={onToggle}
          aria-label="Hide friends list"
          title="Hide friends"
        >
          <ChevronsRight size={16} aria-hidden />
        </button>
      </div>

      <div className="friends-rail-list">
        {friends.length === 0 ? (
          <button type="button" className="friends-rail-empty" onClick={onOpenSocial}>
            No friends yet — find someone in Social.
          </button>
        ) : (
          <>
            {online.map((entry) => (
              <FriendRow
                key={entry.profile.userId}
                entry={entry}
                onClick={() => onOpenProfile(entry.profile.userId)}
              />
            ))}
            {offline.length > 0 ? (
              <p className="friends-rail-divider muted small">Offline — {offline.length}</p>
            ) : null}
            {offline.map((entry) => (
              <FriendRow
                key={entry.profile.userId}
                entry={entry}
                onClick={() => onOpenProfile(entry.profile.userId)}
              />
            ))}
          </>
        )}
      </div>
    </aside>
  );
}

function FriendRow({ entry, onClick }: { entry: FriendEntry; onClick: () => void }) {
  const { profile } = entry;
  return (
    <button
      type="button"
      className={clsx('friend-row', profile.presence === 'offline' && 'dim')}
      onClick={onClick}
      title={profile.displayName}
    >
      <Avatar
        url={profile.avatarUrl}
        name={profile.displayName}
        accent={profile.accentColor}
        presence={profile.presence}
        size={32}
      />
      <span className="friend-row-text">
        <strong>{profile.displayName}</strong>
        <span className="muted small">
          {profile.presence === 'in-game' && profile.playingGameTitle
            ? profile.playingGameTitle
            : profile.presence === 'online'
              ? 'Online'
              : 'Offline'}
        </span>
      </span>
    </button>
  );
}
