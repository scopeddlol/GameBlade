import type { ConversationInfo, FriendEntry, MessageInfo } from '@gameblade/shared';
import { useQuery } from '@tanstack/react-query';
import { open } from '@tauri-apps/plugin-dialog';
import clsx from 'clsx';
import { Check, Paperclip, Send, Trash2, UserPlus, Users, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { MediaViewer, type MediaItem } from '../components/MediaViewer.js';
import { Avatar, Empty, ErrorNote, Loading, Modal, ListSkeleton } from '../components/ui.js';
import { useConnectivity } from '../hooks/useConnectivity.js';
import {
  useConversationMessages,
  useConversations,
  useMessageMutations,
} from '../hooks/useMessages.js';
import { useArtwork } from '../hooks/useArtwork.js';
import { useSession } from '../hooks/useSession.js';
import { formatRelative } from '../lib/format.js';
import { errorMessage, ipc } from '../lib/ipc.js';

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
  const { send, withdraw, markRead, leave } = useMessageMutations(conversation.id);
  const [showMembers, setShowMembers] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

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
              onWithdraw={() => withdraw.mutate(message.id)}
              onOpenProfile={onOpenProfile}
            />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <Composer
        sending={send.isPending}
        onSend={(body, attachments) => {
          onError(null);
          send.mutate(
            { body, attachments },
            { onError: (caught) => onError(errorMessage(caught)) },
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
    </>
  );
}

function MessageRow({
  message,
  conversation,
  isMine,
  onWithdraw,
  onOpenProfile,
}: {
  message: MessageInfo;
  conversation: ConversationInfo;
  isMine: boolean;
  onWithdraw: () => void;
  onOpenProfile: (userId: string) => void;
}) {
  const author = conversation.members.find((member) => member.userId === message.senderId);
  const [viewing, setViewing] = useState<number | null>(null);

  const items: MediaItem[] = message.attachments.map((attachment, index) => ({
    kind: attachment.kind === 'clip' ? 'video' : 'image',
    path: attachment.url,
    label: `${author?.displayName ?? 'Someone'} — ${index + 1}`,
  }));

  return (
    <article className={clsx('message-row', isMine && 'mine')}>
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

        {message.deleted ? (
          <span className="muted small message-withdrawn">This message was withdrawn.</span>
        ) : message.body ? (
          <span className="message-text">{message.body}</span>
        ) : null}

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

        <span className="message-meta muted small">
          {formatRelative(message.createdAt)}
          {isMine && !message.deleted ? (
            <button
              type="button"
              className="icon-btn small-icon-btn"
              aria-label="Withdraw this message"
              title="Withdraw"
              onClick={onWithdraw}
            >
              <Trash2 size={12} aria-hidden />
            </button>
          ) : null}
        </span>
      </div>

      {viewing !== null ? (
        <MediaViewer items={items} startIndex={viewing} onClose={() => setViewing(null)} />
      ) : null}
    </article>
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
  onSend,
}: {
  sending: boolean;
  onSend: (body: string, attachments: string[]) => void;
}) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<string[]>([]);

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

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    onSend(trimmed, attachments);
    setText('');
    setAttachments([]);
  };

  return (
    <form
      className="message-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {attachments.length > 0 ? (
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

        <textarea
          className="composer-input"
          rows={1}
          value={text}
          maxLength={4000}
          placeholder="Write a message…"
          aria-label="Message"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, shift+enter breaks the line — the convention every
            // other chat uses, and the one people's hands already know.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />

        <button
          type="submit"
          className="btn btn-primary"
          disabled={sending || (!text.trim() && attachments.length === 0)}
        >
          <Send size={15} aria-hidden />
          Send
        </button>
      </div>
    </form>
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
