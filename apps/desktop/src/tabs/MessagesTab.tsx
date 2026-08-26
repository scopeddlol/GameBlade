import type { ConversationInfo, FriendEntry, MessageInfo } from '@gameblade/shared';
import { useQuery } from '@tanstack/react-query';
import { open } from '@tauri-apps/plugin-dialog';
import clsx from 'clsx';
import {
  Image as ImageIcon,
  Lock,
  MessageSquare,
  Paperclip,
  Send,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MediaViewer, type MediaItem } from '../components/MediaViewer.js';
import { Avatar, Empty, ErrorNote, Loading, Modal, ListSkeleton } from '../components/ui.js';
import { useConnectivity } from '../hooks/useConnectivity.js';
import {
  useConversationKey,
  useConversationMessages,
  useConversations,
  useEnvelope,
  useKeyBackfill,
  useMessageIdentity,
  useMessageMutations,
} from '../hooks/useMessages.js';
import { useSession } from '../hooks/useSession.js';
import { formatRelative } from '../lib/format.js';
import { errorMessage, ipc } from '../lib/ipc.js';

/**
 * Private conversations, which the server carries and cannot read.
 *
 * The security note at the top is not decoration. Everything here rests on a
 * key the server never sees, and the two limits of that — it hands out the
 * public keys, and there is no forward secrecy — are the sort of thing that
 * should be on the screen rather than buried in a design document. A promise
 * nobody reads is worth nothing.
 */
export function MessagesTab({ onOpenProfile }: { onOpenProfile: (userId: string) => void }) {
  const { session } = useSession();
  const { online } = useConnectivity();
  const [openId, setOpenId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const identityQuery = useMessageIdentity(Boolean(session));
  const conversationsQuery = useConversations(Boolean(session) && Boolean(identityQuery.data));

  const conversations = conversationsQuery.data ?? [];
  const active = conversations.find((entry) => entry.id === openId) ?? null;

  // Opening the newest conversation on arrival, rather than an empty pane with
  // a list beside it that the reader then has to be told to click.
  useEffect(() => {
    if (!openId && conversations.length > 0) setOpenId(conversations[0]?.id ?? null);
  }, [conversations, openId]);

  if (!online) {
    return (
      <div className="tab-content">
        <Empty
          title="Messages need a connection"
          message="Conversations are carried by the server, so they are the one thing that cannot work offline. Everything already downloaded still does."
        />
      </div>
    );
  }

  return (
    <div className="tab-content messages-tab">
      <ErrorNote message={error} />

      <div className="messages-layout">
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

          <p className="messages-privacy">
            <Lock size={12} aria-hidden />
            <span>
              Encrypted on this machine. The server carries these and cannot read them — it holds no
              key that opens one.
            </span>
          </p>

          {conversationsQuery.isLoading ? (
            <ListSkeleton rows={4} />
          ) : conversations.length === 0 ? (
            <p className="muted small">
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
        </aside>

        <section className="messages-thread">
          {active ? (
            <Thread
              key={active.id}
              conversation={active}
              onError={setError}
              onOpenProfile={onOpenProfile}
            />
          ) : (
            <Empty
              title="No conversation open"
              message="Pick one on the left, or start a new one."
            />
          )}
        </section>
      </div>

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
          <span className="muted small">
            {conversation.lastMessageAt
              ? formatRelative(conversation.lastMessageAt)
              : 'No messages yet'}
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
  const { key, state } = useConversationKey(conversation);
  const messagesQuery = useConversationMessages(conversation.id);
  const { send, withdraw, markRead, leave } = useMessageMutations(conversation.id);
  const [showMembers, setShowMembers] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useKeyBackfill(conversation, key);

  const messages = useMemo(() => messagesQuery.data ?? [], [messagesQuery.data]);

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
        <div>
          <h2>{conversationTitle(conversation, session?.userId ?? '')}</h2>
          <p className="muted small">
            {conversation.kind === 'group'
              ? `${conversation.members.filter((m) => m.leftAt === null).length} people`
              : (others[0]?.displayName ?? 'Direct message')}
          </p>
        </div>

        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => setShowMembers(true)}
          title="Who is in this conversation, and their key fingerprints"
        >
          <ShieldCheck size={15} aria-hidden />
          Verify
        </button>
      </header>

      {state === 'no-key' ? (
        <p className="thread-notice">
          <Lock size={14} aria-hidden />
          This conversation has not been unlocked for this machine yet. It happens automatically the
          next time one of the others opens it.
        </p>
      ) : state === 'failed' ? (
        <p className="thread-notice danger">
          <Lock size={14} aria-hidden />
          The key for this conversation would not open. Nothing here can be read on this device.
        </p>
      ) : null}

      <div className="thread-scroll">
        {messagesQuery.isLoading ? (
          <Loading label="Loading messages" />
        ) : messages.length === 0 ? (
          <p className="muted small thread-empty">
            Nothing here yet. Whatever you write is encrypted before it leaves this machine.
          </p>
        ) : (
          messages.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              conversation={conversation}
              conversationKey={key}
              isMine={message.senderId === session?.username}
              onWithdraw={() => withdraw.mutate(message.id)}
              onOpenProfile={onOpenProfile}
            />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <Composer
        disabled={!key}
        onSend={(text, attachments) => {
          if (!key) return;
          onError(null);
          send.mutate(
            { conversationKey: key, text, attachments },
            { onError: (caught) => onError(errorMessage(caught)) },
          );
        }}
        onSeal={(filePath) =>
          key ? ipc.sealFile(key, filePath) : Promise.reject(new Error('No key'))
        }
        onError={onError}
        sending={send.isPending}
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
  conversationKey,
  isMine,
  onWithdraw,
  onOpenProfile,
}: {
  message: MessageInfo;
  conversation: ConversationInfo;
  conversationKey: string | null;
  isMine: boolean;
  onWithdraw: () => void;
  onOpenProfile: (userId: string) => void;
}) {
  const envelope = useEnvelope(message.id, message.body, conversationKey, message.deleted);
  const author = conversation.members.find((member) => member.userId === message.senderId);
  const [viewing, setViewing] = useState<number | null>(null);
  const [opened, setOpened] = useState<MediaItem[]>([]);
  const [opening, setOpening] = useState(false);

  // What an attachment is called and what it *is* both live in the sealed
  // envelope; the server only ever knew there was a file.
  const described = envelope?.attachments ?? [];

  /**
   * Attachments are fetched and decrypted on demand.
   *
   * Not on render: a thread scrolled back through a year of screenshots would
   * otherwise download and decrypt every one of them to draw thumbnails nobody
   * has looked at. Pressing the attachment is the signal that one is wanted.
   */
  const openAttachments = async () => {
    if (!conversationKey || described.length === 0) return;
    setOpening(true);

    const byId = new Map(message.attachments.map((entry) => [entry.mediaId, entry]));
    const items: MediaItem[] = [];

    try {
      for (const attachment of described) {
        const stored = byId.get(attachment.mediaId);
        if (!stored) continue;

        const url = await ipc
          .openAttachment(conversationKey, attachment.mediaId, stored.url, attachment.contentType)
          .catch(() => null);
        if (!url) continue;

        items.push({
          kind: attachment.contentType.startsWith('video/') ? 'video' : 'image',
          path: attachment.mediaId,
          resolvedUrl: url,
          label: attachment.name,
        });
      }
    } finally {
      setOpening(false);
    }

    setOpened(items);
    setViewing(items.length > 0 ? 0 : null);
  };

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
        ) : envelope === null ? (
          <span className="muted small">
            <Lock size={11} aria-hidden /> Cannot be read on this device.
          </span>
        ) : envelope.text ? (
          <span className="message-text">{envelope.text}</span>
        ) : null}

        {described.length > 0 && !message.deleted ? (
          <button
            type="button"
            className="message-attachment"
            onClick={() => void openAttachments()}
            disabled={opening}
          >
            <ImageIcon size={13} aria-hidden />
            {opening
              ? 'Decrypting…'
              : described.length === 1
                ? (described[0]?.name ?? 'View attachment')
                : `View ${described.length} attachments`}
          </button>
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

      {viewing !== null && opened.length > 0 ? (
        <MediaViewer items={opened} startIndex={viewing} onClose={() => setViewing(null)} />
      ) : null}
    </article>
  );
}

interface StagedAttachment {
  /** The staged ciphertext on disk, waiting to be uploaded. */
  path: string;
  name: string;
  sizeBytes: number;
  /** The real type, which travels inside the sealed envelope. */
  contentType: string;
}

function Composer({
  disabled,
  sending,
  onSend,
  onSeal,
  onError,
}: {
  disabled: boolean;
  sending: boolean;
  onSend: (text: string, attachments: StagedAttachment[]) => void;
  onSeal: (filePath: string) => Promise<StagedAttachment>;
  onError: (message: string | null) => void;
}) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const [sealing, setSealing] = useState(false);

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
    if (typeof selected !== 'string') return;

    setSealing(true);
    try {
      // Encrypted here, before it is uploaded — the server receives ciphertext
      // and a content type that deliberately says nothing.
      const staged = await onSeal(selected);
      setAttachments((current) => [...current, staged]);
      onError(null);
    } catch (caught) {
      onError(errorMessage(caught));
    } finally {
      setSealing(false);
    }
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
          {attachments.map((attachment) => (
            <li key={attachment.path}>
              <Paperclip size={12} aria-hidden />
              {attachment.name}
              <button
                type="button"
                className="icon-btn small-icon-btn"
                aria-label={`Remove ${attachment.name}`}
                onClick={() =>
                  setAttachments((current) =>
                    current.filter((entry) => entry.path !== attachment.path),
                  )
                }
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
          disabled={disabled || sealing}
          aria-label="Attach a picture or clip"
          title="Attach a picture or clip"
        >
          <Paperclip size={16} aria-hidden />
        </button>

        <textarea
          className="input composer-input"
          rows={1}
          value={text}
          maxLength={4000}
          placeholder={disabled ? 'This conversation cannot be read here' : 'Write a message…'}
          aria-label="Message"
          disabled={disabled}
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
          disabled={disabled || sending || (!text.trim() && attachments.length === 0)}
        >
          <Send size={15} aria-hidden />
          Send
        </button>
      </div>
    </form>
  );
}

/**
 * Who is here, and the fingerprint of each of their devices.
 *
 * The fingerprints are the only defence against the one attack this design
 * cannot rule out by itself: the server hands out the public keys, so an
 * operator who had replaced it could hand out one of their own. Two people
 * reading the same eight groups to each other have ruled that out. Nothing
 * else can.
 */
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
  const memberIds = conversation.members.map((member) => member.userId);
  const keysQuery = useQuery({
    queryKey: ['messages', 'keys', memberIds.sort().join(',')],
    queryFn: () =>
      ipc.get<{ keys: Array<{ userId: string; fingerprint: string; label: string | null }> }>(
        `/messages/keys?userIds=${memberIds.join(',')}`,
      ),
  });

  const keys = keysQuery.data?.keys ?? [];

  return (
    <Modal title="Who is in this conversation" onClose={onClose}>
      <p className="muted small">
        Read a fingerprint aloud to the person it belongs to. If they match, nobody has substituted
        a key — which is the one thing encryption alone cannot prove.
      </p>

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

            <ul className="fingerprint-list">
              {keys
                .filter((key) => key.userId === member.userId)
                .map((key) => (
                  <li key={key.fingerprint}>
                    <code>{key.fingerprint}</code>
                    {key.label ? <span className="muted small">{key.label}</span> : null}
                  </li>
                ))}
            </ul>
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
                  {picked ? <MessageSquare size={14} aria-hidden /> : null}
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
