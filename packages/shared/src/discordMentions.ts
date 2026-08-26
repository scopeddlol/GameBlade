/**
 * Tagging people, roles and channels in what the bot posts.
 *
 * Two things have to be true for a mention to work, and they are easy to
 * confuse. The first is that Discord recognises the token: `<@id>` for a
 * person, `<@&id>` for a role, `<#id>` for a channel. The second is that
 * Discord is *willing* to notify — which it decides from the message's
 * `allowed_mentions`, and which it will not do for anything inside an embed at
 * all, however the token is written.
 *
 * So an embed with `<@&12345>` in its description renders a blue role pill
 * that notifies nobody. That is not a bug in the embed; it is Discord's rule,
 * and the only way round it is to repeat the mentions in the message content
 * that carries the embed. `pingLine` builds that.
 */

/** A mention token, as it appears in text Discord will render. */
export type MentionKind = 'user' | 'role' | 'channel';

export interface DiscordMentions {
  users: string[];
  roles: string[];
  channels: string[];
  /** Whether the text asks for `@everyone` or `@here`. */
  everyone: boolean;
}

const EMPTY: DiscordMentions = { users: [], roles: [], channels: [], everyone: false };

/** Writes the token for one mention, which is what gets inserted into text. */
export function mentionToken(kind: MentionKind, id: string): string {
  const prefix = kind === 'user' ? '@' : kind === 'role' ? '@&' : '#';
  return `<${prefix}${id}>`;
}

/**
 * Every mention in a piece of text.
 *
 * `<@!id>` is the old nickname form, still produced by some clients and still
 * accepted by Discord, so it is matched too. Ids are de-duplicated because
 * `allowed_mentions` is a permission list, not a count.
 */
export function extractMentions(...texts: Array<string | null | undefined>): DiscordMentions {
  const users = new Set<string>();
  const roles = new Set<string>();
  const channels = new Set<string>();
  let everyone = false;

  for (const text of texts) {
    if (!text) continue;

    for (const match of text.matchAll(/<@!?(\d{15,25})>/g)) {
      if (match[1]) users.add(match[1]);
    }
    for (const match of text.matchAll(/<@&(\d{15,25})>/g)) {
      if (match[1]) roles.add(match[1]);
    }
    for (const match of text.matchAll(/<#(\d{15,25})>/g)) {
      if (match[1]) channels.add(match[1]);
    }
    if (/@everyone|@here/.test(text)) everyone = true;
  }

  return {
    users: [...users],
    roles: [...roles],
    channels: [...channels],
    everyone,
  };
}

/**
 * Discord's `allowed_mentions`, built from what the text actually contains.
 *
 * Deliberately an allow-list rather than an omission. Leaving the field off
 * means "notify whatever you find", which turns a stray `@everyone` in a
 * pasted blurb — or in a game summary pulled from a provider — into a ping to
 * the whole server. Naming the exact ids means a mention the operator wrote
 * notifies, and a string that merely looks like one does not.
 *
 * `@everyone` is opt-in on top of that, because it is the one mention nobody
 * gets to send by accident.
 */
export function allowedMentions(
  mentions: DiscordMentions,
  options: { allowEveryone?: boolean } = {},
): Record<string, unknown> {
  const parse: string[] = [];
  if (mentions.everyone && options.allowEveryone) parse.push('everyone');

  return {
    parse,
    // Channels are links, not notifications, so they need no permission here.
    users: mentions.users,
    roles: mentions.roles,
  };
}

/**
 * The content line that makes an embed's mentions actually notify.
 *
 * Discord will not send a notification for anything inside an embed, so the
 * people an announcement is addressed to see a nicely formatted post and hear
 * nothing about it. Repeating the tokens in the message content — which is
 * where Discord does look — is the whole fix. Channels are left out: they are
 * navigation, they never notify, and listing them here would put a row of
 * duplicate channel links above every embed.
 *
 * Returns null when there is nothing to ping, so the caller sends an embed
 * with no content rather than one with an empty line above it.
 */
export function pingLine(
  mentions: DiscordMentions,
  options: { allowEveryone?: boolean } = {},
): string | null {
  const parts: string[] = [];
  if (mentions.everyone && options.allowEveryone) parts.push('@everyone');
  parts.push(...mentions.roles.map((id) => mentionToken('role', id)));
  parts.push(...mentions.users.map((id) => mentionToken('user', id)));
  return parts.length > 0 ? parts.join(' ') : null;
}

/** Nothing mentioned; the shape callers compare against. */
export function noMentions(): DiscordMentions {
  return { ...EMPTY, users: [], roles: [], channels: [] };
}
