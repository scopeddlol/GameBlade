import type { PostInfo } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Megaphone, Send } from 'lucide-react';
import { useState } from 'react';
import { Empty, ErrorNote, Loading } from '../components/ui.js';
import { useSession } from '../hooks/useSession.js';
import { errorMessage, ipc } from '../lib/ipc.js';
import { PostCard } from './SocialTab.js';

/**
 * Where the operator's announcements live.
 *
 * They used to be notifications and nothing else: seen once in the bell menu,
 * then gone, with nowhere to answer them. An announcement is now an ordinary
 * post underneath, which is what gives this page comments, editing and
 * deletion without a second copy of any of it — and means a player who was
 * offline when it was sent still finds it here.
 */
export function NewsTab({ onOpenProfile }: { onOpenProfile: (userId: string) => void }) {
  const queryClient = useQueryClient();
  const { isAdmin } = useSession();
  const [error, setError] = useState<string | null>(null);

  const newsQuery = useQuery({
    queryKey: ['news'],
    queryFn: () => ipc.get<PostInfo[]>('/feed?scope=everyone&kind=announcement&limit=50'),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['news'] });
    // The bell shows the same announcement from the other side.
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  };

  const posts = newsQuery.data ?? [];

  return (
    <div className="tab-content news">
      <header className="news-head">
        <div>
          <h1>News</h1>
          <p className="muted">Announcements from whoever runs this archive. Anyone can reply.</p>
        </div>
      </header>

      <ErrorNote message={error} />

      {isAdmin ? <Composer onPosted={refresh} onError={setError} /> : null}

      {newsQuery.isLoading ? (
        <Loading label="Loading news" />
      ) : posts.length === 0 ? (
        <Empty
          title="Nothing announced yet"
          message={
            isAdmin
              ? 'Post something above and everyone will see it here and in their notifications.'
              : 'When the archive has news, it turns up here.'
          }
        />
      ) : (
        <div className="feed">
          {posts.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              onChanged={refresh}
              onError={setError}
              onOpenProfile={onOpenProfile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The operator's composer.
 *
 * Goes through the announcement endpoint rather than the ordinary post one, so
 * a notification goes out at the same time — the point is that people hear
 * about it, and the page is where they come back to it.
 */
function Composer({
  onPosted,
  onError,
}: {
  onPosted: () => void;
  onError: (message: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  const post = useMutation({
    mutationFn: () =>
      ipc.post('/admin/announcements', {
        title: title.trim(),
        body: body.trim() || null,
        publish: true,
        // Everyone: an announcement aimed at named accounts is never published.
        userIds: [],
      }),
    onSuccess: () => {
      setTitle('');
      setBody('');
      onPosted();
    },
    onError: (caught) => onError(errorMessage(caught)),
  });

  return (
    <form
      className="card news-composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (!title.trim()) return;
        post.mutate();
      }}
    >
      <label className="field">
        <span>Title</span>
        <input
          className="input"
          value={title}
          maxLength={120}
          placeholder="What's happening?"
          onChange={(event) => setTitle(event.target.value)}
          required
        />
      </label>

      <label className="field">
        <span>Body</span>
        <textarea
          className="input"
          rows={4}
          value={body}
          maxLength={2000}
          placeholder="The details. Blank is fine for a one-liner."
          onChange={(event) => setBody(event.target.value)}
        />
      </label>

      <div className="news-composer-actions">
        <span className="muted small">
          <Megaphone size={13} aria-hidden /> Everyone gets a notification and can reply here.
        </span>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!title.trim() || post.isPending}
        >
          <Send size={14} aria-hidden />
          {post.isPending ? 'Posting…' : 'Announce'}
        </button>
      </div>
    </form>
  );
}
