import {
  MESSAGE_REACTIONS,
  type ConversationInfo,
  type FriendEntry,
  type GameSummary,
  type MessageInfo,
  type Paginated,
} from '@gameblade/shared';
import { useQuery } from '@tanstack/react-query';
import { open } from '@tauri-apps/plugin-dialog';
import clsx from 'clsx';
import {
  BellOff,
  Check,
  Copy,
  CornerUpLeft,
  Gamepad2,
  Paperclip,
  Search,
  Send,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { ContextMenu, useContextMenu, type MenuItem } from '../components/ContextMenu.js';
import { MediaViewer, type MediaItem } from '../components/MediaViewer.js';
import {
  Artwork,
  Avatar,
  Empty,
  ErrorNote,
  Loading,
  Modal,
  ListSkeleton,
} from '../components/ui.js';
import { useConnectivity } from '../hooks/useConnectivity.js';
import {
  useConversationMessages,
  useConversations,
  useMessageMutations,
  useMuteMutations,
  type PastedImage,
} from '../hooks/useMessages.js';
import { useArtwork } from '../hooks/useArtwork.js';
import { useSession } from '../hooks/useSession.js';
import { formatRelative } from '../lib/format.js';
import { errorMessage, ipc, queryString } from '../lib/ipc.js';

/**
 * Direct messages and group chats.
 *
 * The layout fills the app rather than flowing down the page: a chat whose
 * composer sits wherever the last message left it is one where the box moves
 * every time somebody types. The list and the thread each scroll inside
 * themselves, the composer is pinned to the bottom edge, and an empty
 * conversation looks the same as a full one.
 */
export function MessagesTab({ onOpenProfile }: { onOpenProfile: (userId: string) => void }) {
  const { session } = useSession();
  const { online } = useConnectivity();
  const [openId, setOpenId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const conversationsQuery = useConversations(Boolean(session));
  const conversations = conversationsQuery.data ?? [];
  const active = conversations.find((entry) => entry.id === openId) ?? null;

  // Opening the newest conversation on arrival, rather than an empty pane
  // beside a list the reader then has to be told to click.
  useEffect(() => {
    if (!openId && conversations.length > 0) setOpenId(conversations[0]?.id ?? null);
  }, [conversations, openId]);

  if (!online) {
    return (
      <div className="messages-tab messages-offline">
        <Empty
          title="Messages need a connection"
          message="Conversations live on the server, so they are the one thing that cannot work offline. Everything already downloaded still does."
        />
      </div>
    );
  }

  return (
    <div className="messages-tab">
      <aside className="messages-sidebar">
        <div className="messages-sidebar-head">
          <h1>Messages</h1>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setStarting(true)}
            title="Start a conversation"
          >
            <UserPlus size={15} aria-hidden />
            New
          </button>
        </div>

        <div className="messages-sidebar-list">
          {conversationsQuery.isLoading ? (
            <ListSkeleton rows={4} />
          ) : conversations.length === 0 ? (
            <p className="muted small messages-sidebar-empty">
              Nothing yet. Start one with a friend — messaging is friends-only, so nobody can write
              to you out of nowhere.
            </p>
          ) : (
            <ul className="conversation-list">
              {conversations.map((conversation) => (
                <ConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  selfId={session?.userId ?? ''}
                  active={conversation.id === openId}
                  onOpen={() => setOpenId(conversation.id)}
                />
              ))}
            </ul>
          )}
        </div>
      </aside>

      <section className="messages-thread">
        {error ? (
          <div className="messages-error">
            <ErrorNote message={error} />
          </div>
        ) : null}

        {active ? (
          <Thread
            key={active.id}
            conversation={active}
            onError={setError}
            onOpenProfile={onOpenProfile}
          />
        ) : (
          <Empty title="No conversation open" message="Pick one on the left, or start a new one." />
        )}
      </section>

      {starting ? (
        <StartConversation
          onClose={() => setStarting(false)}
          onStarted={(id) => {
            setOpenId(id);
            setStarting(false);
          }}
          onError={setError}
        />
      ) : null}
    </div>
  );
}

/** How a conversation is named, which depends on what kind it is. */
function conversationTitle(conversation: ConversationInfo, selfId: string): string {
  if (conversation.title) return conversation.title;

  const others = conversation.members.filter((member) => member.userId !== selfId);
  if (others.length === 0) return 'Just you';
  if (conversation.kind === 'direct') return others[0]?.displayName ?? 'Someone';
  return others.map((member) => member.displayName).join(', ');
}

function ConversationRow({
  conversation,
  selfId,
  active,
  onOpen,
}: {
  conversation: ConversationInfo;
  selfId: string;
  active: boolean;
  onOpen: () => void;
}) {
  const others = conversation.members.filter((member) => member.userId !== selfId);
  const face = others[0];

  return (
    <li>
      <button
        type="button"
        className={clsx('conversation-row', active && 'active')}
        onClick={onOpen}
      >
        {conversation.kind === 'group' ? (
          <span className="conversation-group-icon" aria-hidden>
            <Users size={18} />
          </span>
        ) : (
          <Avatar
            url={face?.avatarUrl ?? null}
            name={face?.displayName ?? '?'}
            accent={face?.accentColor}
            size={36}
          />
        )}

        <span className="conversation-row-text">
          <strong>{conversationTitle(conversation, selfId)}</strong>
          {/* The preview travels on the conversation itself, so the sidebar
              draws without fetching a single thread. */}
          <span className="muted small">
            {conversation.lastMessagePreview ?? 'No messages yet'}
          </span>
        </span>

        {conversation.unreadCount > 0 ? (
          <span className="pill">{conversation.unreadCount}</span>
        ) : null}
      </button>
    </li>
  );
}

/** One open conversation: its history, its composer and who is in it. */
function Thread({
  conversation,
  onError,
  onOpenProfile,
}: {
  conversation: ConversationInfo;
  onError: (message: string | null) => void;
  onOpenProfile: (userId: string) => void;
}) {
  const { session } = useSession();
  const messagesQuery = useConversationMessages(conversation.id);
  const { send, react, withdraw, markRead, leave } = useMessageMutations(conversation.id);
  const mute = useMuteMutations();
  const [showMembers, setShowMembers] = useState(false);
  const [replyingTo, setReplyingTo] = useState<MessageInfo | null>(null);
  const [sharing, setSharing] = useState(false);
  // Muted messages are collapsed rather than hidden; this is which ones the
  // reader has chosen to unfold, and it resets when the thread changes.
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const bottomRef = useRef<HTMLDivElement>(null);

  const menu = useContextMenu<MessageInfo>();
  const messages = messagesQuery.data ?? [];

  // Opening a thread is reading it, and the badge should go the moment it does
  // rather than after the next refetch.
  useEffect(() => {
    if (conversation.unreadCount > 0) markRead.mutate();
    // Only when the conversation changes; re-running on every mutation would
    // mark read in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  const others = conversation.members.filter(
    (member) => member.userId !== session?.userId && member.leftAt === null,
  );

  /**
   * What right-clicking a message offers.
   *
   * Reply, copy and delete are the three things people reach for, and until now
   * the only one available was a bin icon on your own messages. Muting lives
   * here too rather than only on a profile: the moment you want it is the
   * moment you are looking at what they wrote.
   */
  const menuItems = (message: MessageInfo): MenuItem[] => {
    const isMine = message.senderId === session?.userId;
    const author = conversation.members.find((member) => member.userId === message.senderId);
    const items: MenuItem[] = [];

    if (!message.deleted) {
      items.push({
        label: 'Reply',
        icon: <CornerUpLeft size={14} />,
        onSelect: () => setReplyingTo(message),
      });

      if (message.body) {
        items.push({
          label: 'Copy text',
          icon: <Copy size={14} />,
          onSelect: () => void navigator.clipboard.writeText(message.body),
        });
      }
    }

    if (isMine && !message.deleted) {
      items.push({ kind: 'separator' });
      items.push({
        label: 'Delete',
        icon: <Trash2 size={14} />,
        danger: true,
        onSelect: () => {
          // Withdrawing clears the body everywhere, but anyone who already read
          // it still has — worth being asked about rather than one stray click.
          if (confirm('Withdraw this message? Anybody who already read it still has.')) {
            withdraw.mutate(message.id);
          }
        },
      });
    }

    if (!isMine && author) {
      items.push({ kind: 'separator' });
      items.push({
        label: message.muted ? `Unmute ${author.displayName}` : `Mute ${author.displayName}`,
        icon: <BellOff size={14} />,
        onSelect: () => mute.mutate({ userId: author.userId, muted: !message.muted }),
      });
    }

    return items;
  };

  return (
    <>
      <header className="thread-head">
        <div className="thread-head-text">
          <h2>{conversationTitle(conversation, session?.userId ?? '')}</h2>
          <p className="muted small">
            {conversation.kind === 'group'
              ? `${conversation.members.filter((m) => m.leftAt === null).length} people`
              : (others[0]?.displayName ?? 'Direct message')}
          </p>
        </div>

        <button type="button" className="btn btn-ghost" onClick={() => setShowMembers(true)}>
          <Users size={15} aria-hidden />
          {conversation.kind === 'group' ? 'Members' : 'Details'}
        </button>
      </header>

      <div className="thread-scroll">
        {messagesQuery.isLoading ? (
          <Loading label="Loading messages" />
        ) : messages.length === 0 ? (
          <p className="muted small thread-empty">No messages yet. Say something.</p>
        ) : (
          messages.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              conversation={conversation}
              isMine={message.senderId === session?.userId}
              revealed={Boolean(revealed[message.id])}
              onReveal={() => setRevealed((current) => ({ ...current, [message.id]: true }))}
              onOpenProfile={onOpenProfile}
              onContextMenu={menu.open}
              onReact={(emoji) => react.mutate({ messageId: message.id, emoji })}
            />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <Composer
        sending={send.isPending}
        replyingTo={
          replyingTo
            ? {
                name:
                  conversation.members.find((member) => member.userId === replyingTo.senderId)
                    ?.displayName ?? 'someone',
                excerpt: replyingTo.body.replace(/\s+/g, ' ').trim() || 'an attachment',
              }
            : null
        }
        onCancelReply={() => setReplyingTo(null)}
        onShareGame={() => setSharing(true)}
        onSend={(body, attachments, pasted, gameId) => {
          onError(null);
          send.mutate(
            { body, attachments, pasted, gameId, replyToId: replyingTo?.id ?? null },
            {
              onSuccess: () => setReplyingTo(null),
              onError: (caught) => onError(errorMessage(caught)),
            },
          );
        }}
      />

      {showMembers ? (
        <MemberList
          conversation={conversation}
          onClose={() => setShowMembers(false)}
          onOpenProfile={onOpenProfile}
          onLeave={() => {
            const me = conversation.members.find((member) => member.userId === session?.userId);
            if (me) leave.mutate(me.userId);
            setShowMembers(false);
          }}
        />
      ) : null}

      {sharing ? (
        <ShareGame
          onClose={() => setSharing(false)}
          onPick={(game) => {
            setSharing(false);
            onError(null);
            send.mutate(
              { body: '', gameId: game.id, replyToId: replyingTo?.id ?? null },
              {
                onSuccess: () => setReplyingTo(null),
                onError: (caught) => onError(errorMessage(caught)),
              },
            );
          }}
        />
      ) : null}

      {menu.state ? (
        <ContextMenu
          position={menu.state.position}
          onClose={menu.close}
          // The emoji row sits above the items rather than inside them: it
          // reads across, and one click on it is the whole interaction.
          header={
            menu.state.target.deleted ? undefined : (
              <ReactionPicker
                message={menu.state.target}
                onPick={(emoji) => {
                  const messageId = menu.state?.target.id;
                  menu.close();
                  if (messageId) react.mutate({ messageId, emoji });
                }}
              />
            )
          }
          items={menuItems(menu.state.target)}
        />
      ) : null}
    </>
  );
}

/** The strip of emoji at the top of a message's right-click menu. */
function ReactionPicker({
  message,
  onPick,
}: {
  message: MessageInfo;
  onPick: (emoji: string) => void;
}) {
  return (
    <div className="reaction-picker">
      {MESSAGE_REACTIONS.map((emoji) => {
        const mine = message.reactions.some(
          (reaction) => reaction.emoji === emoji && reaction.mine,
        );
        return (
          <button
            key={emoji}
            type="button"
            className={clsx('reaction-pick', mine && 'mine')}
            aria-label={`React with ${emoji}`}
            aria-pressed={mine}
            onClick={() => onPick(emoji)}
          >
            {emoji}
          </button>
        );
      })}
    </div>
  );
}

function MessageRow({
  message,
  conversation,
  isMine,
  revealed,
  onReveal,
  onOpenProfile,
  onContextMenu,
  onReact,
}: {
  message: MessageInfo;
  conversation: ConversationInfo;
  isMine: boolean;
  revealed: boolean;
  onReveal: () => void;
  onOpenProfile: (userId: string) => void;
  onContextMenu: (event: ReactMouseEvent, message: MessageInfo) => void;
  onReact: (emoji: string) => void;
}) {
  const author = conversation.members.find((member) => member.userId === message.senderId);
  const [viewing, setViewing] = useState<number | null>(null);

  const items: MediaItem[] = message.attachments.map((attachment, index) => ({
    kind: attachment.kind === 'clip' ? 'video' : 'image',
    path: attachment.url,
    label: `${author?.displayName ?? 'Someone'} — ${index + 1}`,
  }));

  /*
   * A muted person's message is folded away, not dropped.
   *
   * A thread with silent holes in it reads as a bug, and the reply above the
   * hole stops making sense. One line saying who it was — and one click to
   * read it anyway — keeps the conversation legible without putting the words
   * in front of somebody who asked not to see them.
   */
  if (message.muted && !revealed && !message.deleted) {
    return (
      <article className="message-row muted-row">
        <button type="button" className="message-muted" onClick={onReveal}>
          <BellOff size={12} aria-hidden />
          Message from {author?.displayName ?? 'someone you muted'} — show it
        </button>
      </article>
    );
  }

  return (
    <article
      className={clsx('message-row', isMine && 'mine')}
      onContextMenu={(event) => onContextMenu(event, message)}
    >
      {!isMine ? (
        <button
          type="button"
          className="message-avatar"
          onClick={() => author && onOpenProfile(author.userId)}
          aria-label={author?.displayName ?? 'Someone'}
        >
          <Avatar
            url={author?.avatarUrl ?? null}
            name={author?.displayName ?? '?'}
            accent={author?.accentColor}
            size={28}
          />
        </button>
      ) : null}

      <div className="message-bubble">
        {conversation.kind === 'group' && !isMine ? (
          <span className="message-author">{author?.displayName ?? 'Someone'}</span>
        ) : null}

        {/* The quote above a reply, so an answer arriving twenty lines later
            still says what it is answering. */}
        {message.replyTo ? (
          <span className="message-quote">
            <CornerUpLeft size={11} aria-hidden />
            <strong>{message.replyTo.senderName}</strong>
            <span className="muted">{message.replyTo.excerpt}</span>
          </span>
        ) : null}

        {message.deleted ? (
          <span className="muted small message-withdrawn">This message was withdrawn.</span>
        ) : message.body ? (
          <span className="message-text">{message.body}</span>
        ) : null}

        {message.game && !message.deleted ? <SharedGameCard game={message.game} /> : null}

        {message.attachments.length > 0 && !message.deleted ? (
          <div className="message-media">
            {message.attachments.map((attachment, index) => (
              <button
                key={attachment.mediaId}
                type="button"
                className="message-media-thumb"
                onClick={() => setViewing(index)}
                aria-label="Open this attachment"
              >
                <Attachment attachment={attachment} />
              </button>
            ))}
          </div>
        ) : null}

        {message.reactions.length > 0 ? (
          <div className="message-reactions">
            {message.reactions.map((reaction) => (
              <button
                key={reaction.emoji}
                type="button"
                className={clsx('reaction-chip', reaction.mine && 'mine')}
                aria-pressed={reaction.mine}
                onClick={() => onReact(reaction.emoji)}
              >
                <span aria-hidden>{reaction.emoji}</span>
                {reaction.count}
              </button>
            ))}
          </div>
        ) : null}

        <span className="message-meta muted small">{formatRelative(message.createdAt)}</span>
      </div>

      {viewing !== null ? (
        <MediaViewer items={items} startIndex={viewing} onClose={() => setViewing(null)} />
      ) : null}
    </article>
  );
}

/** A game somebody recommended, rendered as a card rather than a pasted name. */
function SharedGameCard({ game }: { game: NonNullable<MessageInfo['game']> }) {
  return (
    <div className="message-game">
      <Artwork
        path={game.coverUrl}
        alt=""
        className="message-game-cover"
        fallbackText={game.title}
      />
      <div className="message-game-text">
        <strong>{game.title}</strong>
        <span className="muted small">
          {[game.releaseYear, ...game.genres].filter(Boolean).join(' · ') || 'In the archive'}
        </span>
      </div>
    </div>
  );
}

/** One attachment's thumbnail, resolved the same way any other artwork is. */
function Attachment({ attachment }: { attachment: MessageInfo['attachments'][number] }) {
  const url = useArtwork(attachment.url);
  if (!url) return <span className="skeleton message-media-pending" aria-hidden />;

  return attachment.kind === 'clip' ? (
    <video src={url} muted preload="metadata" />
  ) : (
    <img src={url} alt="" loading="lazy" />
  );
}

function Composer({
  sending,
  replyingTo,
  onCancelReply,
  onShareGame,
  onSend,
}: {
  sending: boolean;
  /** Who is being answered and what they said, already resolved by the thread. */
  replyingTo: { name: string; excerpt: string } | null;
  onCancelReply: () => void;
  onShareGame: () => void;
  onSend: (
    body: string,
    attachments: string[],
    pasted: PastedImage[],
    gameId: string | null,
  ) => void;
}) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<string[]>([]);
  const [pasted, setPasted] = useState<PastedImage[]>([]);

  // Object URLs are the only thing here that has to be cleaned up by hand; a
  // long chat session would otherwise leak one per pasted image.
  useEffect(
    () => () => {
      for (const image of pasted) URL.revokeObjectURL(image.previewUrl);
    },
    [pasted],
  );

  const attach = async () => {
    const selected = await open({
      multiple: false,
      filters: [
        {
          name: 'Images and clips',
          extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm'],
        },
      ],
    });
    if (typeof selected === 'string') setAttachments((current) => [...current, selected]);
  };

  /**
   * Takes an image off the clipboard without it ever reaching the disk.
   *
   * Pasting used to mean saving the picture somewhere, picking it in the file
   * dialog and remembering to delete it — which nobody does, so a folder fills
   * up with screenshots of whatever was on the clipboard.
   */
  const onPaste = async (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.items]
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);

    if (files.length === 0) return;
    // Only once there is definitely an image: otherwise this would swallow a
    // perfectly ordinary paste of text.
    event.preventDefault();

    const read = await Promise.all(
      files.map(async (file) => ({
        previewUrl: URL.createObjectURL(file),
        bytes: [...new Uint8Array(await file.arrayBuffer())],
        contentType: file.type,
      })),
    );
    setPasted((current) => [...current, ...read]);
  };

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0 && pasted.length === 0) return;
    onSend(trimmed, attachments, pasted, null);
    setText('');
    setAttachments([]);
    // Not revoked here: the effect above owns those URLs and will clear them
    // when this list is replaced.
    setPasted([]);
  };

  return (
    <form
      className="message-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {replyingTo ? (
        <div className="composer-reply">
          <CornerUpLeft size={12} aria-hidden />
          <span className="muted small">
            Replying to <strong>{replyingTo.name}</strong>: {replyingTo.excerpt.slice(0, 80)}
          </span>
          <button
            type="button"
            className="icon-btn small-icon-btn"
            aria-label="Cancel the reply"
            onClick={onCancelReply}
          >
            <X size={12} aria-hidden />
          </button>
        </div>
      ) : null}

      {attachments.length > 0 || pasted.length > 0 ? (
        <ul className="composer-attachments">
          {attachments.map((path) => (
            <li key={path}>
              <Paperclip size={12} aria-hidden />
              {path.split(/[\\/]/).pop()}
              <button
                type="button"
                className="icon-btn small-icon-btn"
                aria-label="Remove this attachment"
                onClick={() => setAttachments((current) => current.filter((p) => p !== path))}
              >
                <X size={12} aria-hidden />
              </button>
            </li>
          ))}
          {pasted.map((image) => (
            <li key={image.previewUrl} className="composer-pasted">
              <img src={image.previewUrl} alt="" />
              Pasted image
              <button
                type="button"
                className="icon-btn small-icon-btn"
                aria-label="Remove this pasted image"
                onClick={() => {
                  URL.revokeObjectURL(image.previewUrl);
                  setPasted((current) =>
                    current.filter((entry) => entry.previewUrl !== image.previewUrl),
                  );
                }}
              >
                <X size={12} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="composer-row">
        <button
          type="button"
          className="icon-btn"
          onClick={() => void attach()}
          aria-label="Attach a picture or clip"
          title="Attach a picture or clip"
        >
          <Paperclip size={16} aria-hidden />
        </button>

        <button
          type="button"
          className="icon-btn"
          onClick={onShareGame}
          aria-label="Share a game"
          title="Share a game from the archive"
        >
          <Gamepad2 size={16} aria-hidden />
        </button>

        <textarea
          className="composer-input"
          rows={1}
          value={text}
          maxLength={4000}
          placeholder="Write a message, or paste a picture…"
          aria-label="Message"
          onChange={(event) => setText(event.target.value)}
          onPaste={(event) => void onPaste(event)}
          onKeyDown={(event) => {
            // Enter sends, shift+enter breaks the line — the convention every
            // other chat uses, and the one people's hands already know.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
            // Escape drops the reply rather than the whole draft, which is the
            // half somebody actually wants back.
            if (event.key === 'Escape' && replyingTo) onCancelReply();
          }}
        />

        <button
          type="submit"
          className="btn btn-primary"
          disabled={sending || (!text.trim() && attachments.length === 0 && pasted.length === 0)}
        >
          <Send size={15} aria-hidden />
          Send
        </button>
      </div>
    </form>
  );
}

/**
 * Picking a game to recommend.
 *
 * Searching the archive rather than listing a library: the whole point of
 * sending somebody a game is that it is one they have not played, so a picker
 * limited to what the sender owns would exclude most of the good ones.
 */
function ShareGame({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (game: GameSummary) => void;
}) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const gamesQuery = useQuery({
    queryKey: ['games', 'share', debounced],
    queryFn: () =>
      ipc.get<Paginated<GameSummary>>(
        `/games${queryString({ search: debounced, sort: 'rating', order: 'desc', limit: 24 })}`,
      ),
  });

  const games = gamesQuery.data?.items ?? [];

  return (
    <Modal title="Share a game" onClose={onClose}>
      <div className="search-box">
        <Search size={15} aria-hidden />
        <input
          type="search"
          autoFocus
          placeholder="Search the archive…"
          value={search}
          aria-label="Search the archive"
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      {gamesQuery.isLoading ? (
        <ListSkeleton rows={4} />
      ) : games.length === 0 ? (
        <Empty title="Nothing matches" message="Try a different search." />
      ) : (
        <ul className="share-game-list">
          {games.map((game) => (
            <li key={game.id}>
              <button type="button" className="share-game-option" onClick={() => onPick(game)}>
                <Artwork
                  path={game.art.icon ?? game.art.cover}
                  alt=""
                  className="share-game-cover"
                  fallbackText={game.title}
                />
                <span>
                  <strong>{game.title}</strong>
                  <span className="muted small">
                    {game.genres.slice(0, 3).join(' · ') || 'In the archive'}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

/** Who is in this conversation. */
function MemberList({
  conversation,
  onClose,
  onOpenProfile,
  onLeave,
}: {
  conversation: ConversationInfo;
  onClose: () => void;
  onOpenProfile: (userId: string) => void;
  onLeave: () => void;
}) {
  return (
    <Modal title="Who is in this conversation" onClose={onClose}>
      <ul className="member-verify-list">
        {conversation.members.map((member) => (
          <li key={member.userId}>
            <button
              type="button"
              className="person-link"
              onClick={() => onOpenProfile(member.userId)}
            >
              <Avatar
                url={member.avatarUrl}
                name={member.displayName}
                accent={member.accentColor}
                size={28}
              />
              <span>
                <strong>{member.displayName}</strong>
                <span className="muted small">
                  {member.leftAt ? 'Left this conversation' : `@${member.username}`}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      <div className="modal-actions">
        {conversation.kind === 'group' ? (
          <button type="button" className="btn btn-danger" onClick={onLeave}>
            Leave this group
          </button>
        ) : null}
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

/** Picking who a new conversation is with. */
function StartConversation({
  onClose,
  onStarted,
  onError,
}: {
  onClose: () => void;
  onStarted: (conversationId: string) => void;
  onError: (message: string) => void;
}) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const { start } = useMessageMutations(null);

  const friendsQuery = useQuery({
    queryKey: ['friends'],
    queryFn: () => ipc.get<FriendEntry[]>('/friends'),
  });

  const friends = friendsQuery.data ?? [];
  const isGroup = chosen.length > 1;

  return (
    <Modal title="Start a conversation" onClose={onClose}>
      <p className="muted small">
        Friends only — nobody can write to you out of nowhere. Picking more than one person makes a
        group.
      </p>

      {friendsQuery.isLoading ? (
        <ListSkeleton rows={4} />
      ) : friends.length === 0 ? (
        <Empty title="No friends yet" message="Add somebody from the Social tab first." />
      ) : (
        <ul className="start-conversation-list">
          {friends.map((entry) => {
            const picked = chosen.includes(entry.profile.userId);
            return (
              <li key={entry.profile.userId}>
                <button
                  type="button"
                  className={clsx('start-conversation-option', picked && 'picked')}
                  onClick={() =>
                    setChosen((current) =>
                      picked
                        ? current.filter((id) => id !== entry.profile.userId)
                        : [...current, entry.profile.userId],
                    )
                  }
                >
                  <Avatar
                    url={entry.profile.avatarUrl}
                    name={entry.profile.displayName}
                    accent={entry.profile.accentColor}
                    size={32}
                  />
                  <span>{entry.profile.displayName}</span>
                  {picked ? <Check size={14} aria-hidden /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {isGroup ? (
        <label className="field">
          <span>Group name</span>
          <input
            className="input"
            value={title}
            maxLength={80}
            placeholder="Raid night"
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
      ) : null}

      <div className="modal-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={chosen.length === 0 || start.isPending}
          onClick={() =>
            start.mutate(
              {
                kind: isGroup ? 'group' : 'direct',
                memberIds: chosen,
                title: isGroup ? title.trim() || null : null,
              },
              {
                onSuccess: (conversation) => onStarted(conversation.id),
                onError: (caught) => onError(errorMessage(caught)),
              },
            )
          }
        >
          {isGroup ? 'Create group' : 'Start'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
