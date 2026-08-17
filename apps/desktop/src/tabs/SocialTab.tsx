import type {
  CommentInfo,
  FriendEntry,
  FriendRequests,
  MediaInfo,
  PostInfo,
  ProfileSummary,
  ReactionKind,
} from '@gameblade/shared';
import { REACTIONS } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { open } from '@tauri-apps/plugin-dialog';
import clsx from 'clsx';
import { Check, ImagePlus, MessageSquare, Search, Send, UserPlus, X } from 'lucide-react';
import { useState } from 'react';
import { Avatar, Badge, Empty, ErrorNote, Loading, SectionHeader } from '../components/ui.js';
import { useArtwork } from '../hooks/useArtwork.js';
import { formatRelative } from '../lib/format.js';
import { errorMessage, ipc, queryString } from '../lib/ipc.js';

const REACTION_GLYPHS: Record<ReactionKind, string> = {
  like: '👍',
  love: '❤️',
  fire: '🔥',
  laugh: '😄',
  wow: '😮',
  sad: '😢',
};

type Pane = 'feed' | 'friends';

export function SocialTab() {
  const [pane, setPane] = useState<Pane>('feed');

  return (
    <div className="tab-content social">
      <div className="segmented standalone" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={pane === 'feed'}
          className={clsx('segment', pane === 'feed' && 'active')}
          onClick={() => setPane('feed')}
        >
          Feed
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={pane === 'friends'}
          className={clsx('segment', pane === 'friends' && 'active')}
          onClick={() => setPane('friends')}
        >
          Friends
        </button>
      </div>

      {pane === 'feed' ? <Feed /> : <Friends />}
    </div>
  );
}

/* --------------------------------------------------------------------- feed */

function Feed() {
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<'friends' | 'everyone' | 'mine'>('friends');
  const [error, setError] = useState<string | null>(null);

  const feedQuery = useQuery({
    queryKey: ['feed', scope],
    queryFn: () => ipc.get<PostInfo[]>(`/feed${queryString({ scope, limit: 30 })}`),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['feed'] });
    void queryClient.invalidateQueries({ queryKey: ['home'] });
  };

  return (
    <>
      <Composer onPosted={refresh} onError={setError} />
      <ErrorNote message={error} />

      <div className="segmented standalone small-segmented" role="tablist">
        {(['friends', 'everyone', 'mine'] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={scope === option}
            className={clsx('segment', scope === option && 'active')}
            onClick={() => setScope(option)}
          >
            {option === 'friends' ? 'Friends' : option === 'everyone' ? 'Everyone' : 'Mine'}
          </button>
        ))}
      </div>

      {feedQuery.isLoading ? (
        <Loading label="Loading the feed" />
      ) : (feedQuery.data ?? []).length === 0 ? (
        <Empty
          title="Nothing here yet"
          message={
            scope === 'friends'
              ? 'Posts from you and your friends appear here. Add someone from the Friends tab.'
              : 'Be the first to post something.'
          }
        />
      ) : (
        <div className="feed">
          {(feedQuery.data ?? []).map((post) => (
            <PostCard key={post.id} post={post} onChanged={refresh} onError={setError} />
          ))}
        </div>
      )}
    </>
  );
}

function Composer({
  onPosted,
  onError,
}: {
  onPosted: () => void;
  onError: (message: string) => void;
}) {
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<'friends' | 'public'>('friends');
  const [mediaIds, setMediaIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

  const postMutation = useMutation({
    mutationFn: () => ipc.post<PostInfo>('/posts', { body, visibility, mediaIds }),
    onSuccess: () => {
      setBody('');
      setMediaIds([]);
      onPosted();
    },
    onError: (caught) => onError(errorMessage(caught)),
  });

  /**
   * Attachments upload immediately rather than on submit, so a large clip is
   * already on the server by the time the user finishes writing. Anything
   * abandoned is swept by the server's orphan collector.
   */
  const attach = async () => {
    const selected = await open({
      multiple: false,
      filters: [
        {
          name: 'Screenshots and clips',
          extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm'],
        },
      ],
    });
    if (typeof selected !== 'string') return;

    const isClip = /\.(mp4|webm)$/i.test(selected);
    setUploading(true);
    try {
      const media = await ipc.uploadMedia(selected, isClip ? 'clip' : 'image');
      setMediaIds((current) => [...current, media.id]);
    } catch (caught) {
      onError(errorMessage(caught));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="composer">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Share a screenshot, a clip, or what you have been playing…"
        rows={3}
        aria-label="Write a post"
      />

      <div className="composer-actions">
        <button type="button" className="btn btn-ghost" onClick={attach} disabled={uploading}>
          <ImagePlus size={15} aria-hidden />
          {uploading ? 'Uploading…' : 'Attach'}
        </button>

        {mediaIds.length > 0 ? (
          <Badge tone="info">
            {mediaIds.length} attachment{mediaIds.length === 1 ? '' : 's'}
          </Badge>
        ) : null}

        <select
          className="select"
          value={visibility}
          onChange={(e) => setVisibility(e.target.value as 'friends' | 'public')}
          aria-label="Who can see this"
        >
          <option value="friends">Friends only</option>
          <option value="public">Everyone</option>
        </select>

        <button
          type="button"
          className="btn btn-primary"
          onClick={() => postMutation.mutate()}
          disabled={(!body.trim() && mediaIds.length === 0) || postMutation.isPending}
        >
          <Send size={15} aria-hidden />
          Post
        </button>
      </div>
    </div>
  );
}

function PostCard({
  post,
  onChanged,
  onError,
}: {
  post: PostInfo;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [showComments, setShowComments] = useState(false);

  const reactMutation = useMutation({
    mutationFn: (reaction: ReactionKind | null) =>
      ipc.put(`/posts/${post.id}/reaction`, { reaction }),
    onSuccess: onChanged,
    onError: (caught) => onError(errorMessage(caught)),
  });

  const deleteMutation = useMutation({
    mutationFn: () => ipc.del(`/posts/${post.id}`),
    onSuccess: onChanged,
    onError: (caught) => onError(errorMessage(caught)),
  });

  return (
    <article className="post">
      <header>
        <Avatar
          url={post.author.avatarUrl}
          name={post.author.displayName}
          accent={post.author.accentColor}
          presence={post.author.presence}
          size={38}
        />
        <div>
          <strong>{post.author.displayName}</strong>
          <span className="muted small">
            {formatRelative(post.createdAt)}
            {post.editedAt ? ' · edited' : ''}
            {post.visibility === 'friends' ? ' · friends only' : ''}
          </span>
        </div>
        {post.canEdit ? (
          <button
            type="button"
            className="icon-btn"
            onClick={() => deleteMutation.mutate()}
            aria-label="Delete post"
          >
            <X size={15} aria-hidden />
          </button>
        ) : null}
      </header>

      {post.title ? <h3>{post.title}</h3> : null}
      {post.body ? <p className="post-body">{post.body}</p> : null}

      {post.media.length > 0 ? (
        <div className={clsx('post-media', post.media.length > 1 && 'multi')}>
          {post.media.map((media) => (
            <Attachment key={media.id} media={media} />
          ))}
        </div>
      ) : null}

      {post.game ? <p className="post-game muted small">Playing {post.game.title}</p> : null}

      <footer>
        <div className="reactions">
          {REACTIONS.map((reaction) => {
            const count = post.reactions[reaction] ?? 0;
            const mine = post.myReaction === reaction;
            // Only show a reaction that someone has used, or the one you left.
            if (count === 0 && !mine) return null;
            return (
              <button
                key={reaction}
                type="button"
                className={clsx('reaction', mine && 'active')}
                onClick={() => reactMutation.mutate(mine ? null : reaction)}
              >
                {REACTION_GLYPHS[reaction]} {count}
              </button>
            );
          })}

          <div className="reaction-picker">
            <button type="button" className="reaction add">
              +
            </button>
            <div className="reaction-menu">
              {REACTIONS.map((reaction) => (
                <button
                  key={reaction}
                  type="button"
                  onClick={() => reactMutation.mutate(reaction)}
                  aria-label={reaction}
                >
                  {REACTION_GLYPHS[reaction]}
                </button>
              ))}
            </div>
          </div>
        </div>

        <button
          type="button"
          className="btn btn-ghost small-btn"
          onClick={() => setShowComments(!showComments)}
        >
          <MessageSquare size={14} aria-hidden />
          {post.commentCount}
        </button>
      </footer>

      {showComments ? <Comments postId={post.id} onError={onError} /> : null}
    </article>
  );
}

/**
 * The server hands back a server-relative media path. Inside the webview that
 * would resolve against the app's own origin, and an `<img>` or `<video>` tag
 * cannot send the device token either — so both are fixed by resolving the URL
 * on the Rust side, where the server address and the token live.
 */
function Attachment({ media }: { media: MediaInfo }) {
  const url = useArtwork(media.url);
  if (!url) return <div className="post-media-pending" aria-hidden />;

  return media.kind === 'clip' ? (
    <video src={url} controls preload="metadata" />
  ) : (
    <img src={url} alt="" loading="lazy" />
  );
}

function Comments({ postId, onError }: { postId: string; onError: (message: string) => void }) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState('');

  const commentsQuery = useQuery({
    queryKey: ['comments', postId],
    queryFn: () => ipc.get<CommentInfo[]>(`/posts/${postId}/comments`),
  });

  const addMutation = useMutation({
    mutationFn: () => ipc.post(`/posts/${postId}/comments`, { body }),
    onSuccess: () => {
      setBody('');
      void queryClient.invalidateQueries({ queryKey: ['comments', postId] });
      void queryClient.invalidateQueries({ queryKey: ['feed'] });
    },
    onError: (caught) => onError(errorMessage(caught)),
  });

  return (
    <div className="comments">
      {commentsQuery.isLoading ? (
        <Loading label="Loading comments" />
      ) : (
        (commentsQuery.data ?? []).map((comment) => (
          <div key={comment.id} className="comment">
            <Avatar
              url={comment.author.avatarUrl}
              name={comment.author.displayName}
              accent={comment.author.accentColor}
              size={26}
            />
            <span>
              <strong>{comment.author.displayName}</strong> {comment.body}
              <span className="muted small"> · {formatRelative(comment.createdAt)}</span>
            </span>
          </div>
        ))
      )}

      <div className="comment-box">
        <input
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write a comment…"
          aria-label="Write a comment"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && body.trim()) addMutation.mutate();
          }}
        />
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => addMutation.mutate()}
          disabled={!body.trim() || addMutation.isPending}
        >
          <Send size={14} aria-hidden />
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ friends */

function Friends() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  const friendsQuery = useQuery({
    queryKey: ['friends', 'list'],
    queryFn: () => ipc.get<FriendEntry[]>('/friends'),
  });

  const requestsQuery = useQuery({
    queryKey: ['friends', 'requests'],
    queryFn: () => ipc.get<FriendRequests>('/friends/requests'),
  });

  const searchQuery = useQuery({
    queryKey: ['friends', 'search', search],
    queryFn: () => ipc.get<ProfileSummary[]>(`/profiles${queryString({ query: search })}`),
    enabled: search.trim().length > 1,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['friends'] });

  const requestMutation = useMutation({
    mutationFn: (userId: string) => ipc.post('/friends/requests', { userId }),
    onSuccess: () => {
      setError(null);
      setSearch('');
      refresh();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const acceptMutation = useMutation({
    mutationFn: (userId: string) => ipc.post(`/friends/${userId}/accept`),
    onSuccess: refresh,
    onError: (caught) => setError(errorMessage(caught)),
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) => ipc.del(`/friends/${userId}`),
    onSuccess: refresh,
    onError: (caught) => setError(errorMessage(caught)),
  });

  const incoming = requestsQuery.data?.incoming ?? [];

  return (
    <>
      <ErrorNote message={error} />

      <div className="search-box wide">
        <Search size={15} aria-hidden />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Find someone by username…"
          aria-label="Find someone by username"
        />
      </div>

      {search.trim().length > 1 ? (
        <section>
          <SectionHeader title="Search results" />
          {searchQuery.isLoading ? (
            <Loading label="Searching" />
          ) : (searchQuery.data ?? []).length === 0 ? (
            <p className="muted">Nobody by that name.</p>
          ) : (
            <ul className="people">
              {(searchQuery.data ?? []).map((profile) => (
                <li key={profile.userId}>
                  <Avatar
                    url={profile.avatarUrl}
                    name={profile.displayName}
                    accent={profile.accentColor}
                    presence={profile.presence}
                  />
                  <span>
                    <strong>{profile.displayName}</strong>
                    <span className="muted small">@{profile.username}</span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => requestMutation.mutate(profile.userId)}
                  >
                    <UserPlus size={14} aria-hidden />
                    Add
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {incoming.length > 0 ? (
        <section>
          <SectionHeader title="Friend requests" />
          <ul className="people">
            {incoming.map(({ profile, requestedAt }) => (
              <li key={profile.userId}>
                <Avatar
                  url={profile.avatarUrl}
                  name={profile.displayName}
                  accent={profile.accentColor}
                  presence={profile.presence}
                />
                <span>
                  <strong>{profile.displayName}</strong>
                  <span className="muted small">asked {formatRelative(requestedAt)}</span>
                </span>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => acceptMutation.mutate(profile.userId)}
                >
                  <Check size={14} aria-hidden />
                  Accept
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => removeMutation.mutate(profile.userId)}
                >
                  Decline
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <SectionHeader title="Friends" />
        {friendsQuery.isLoading ? (
          <Loading label="Loading friends" />
        ) : (friendsQuery.data ?? []).length === 0 ? (
          <Empty
            title="No friends yet"
            message="Search for someone above to send them a request."
          />
        ) : (
          <ul className="people">
            {(friendsQuery.data ?? []).map(({ profile, sharedGameCount }) => (
              <li key={profile.userId}>
                <Avatar
                  url={profile.avatarUrl}
                  name={profile.displayName}
                  accent={profile.accentColor}
                  presence={profile.presence}
                  size={38}
                />
                <span>
                  <strong>{profile.displayName}</strong>
                  <span className="muted small">
                    {profile.presence === 'in-game' && profile.playingGameTitle
                      ? `Playing ${profile.playingGameTitle}`
                      : profile.presence === 'online'
                        ? 'Online'
                        : 'Offline'}
                    {sharedGameCount > 0 ? ` · ${sharedGameCount} games in common` : ''}
                  </span>
                </span>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => {
                    // A declined request costs nothing to undo — send another
                    // one. Losing an established friend is not that casual,
                    // so this one action out of the two sharing this mutation
                    // gets a confirmation.
                    if (confirm(`Remove ${profile.displayName} from your friends?`)) {
                      removeMutation.mutate(profile.userId);
                    }
                  }}
                  aria-label={`Remove ${profile.displayName}`}
                >
                  <X size={15} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
